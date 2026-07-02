import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { modelToPlainText } from './render.ts'
import { killSession, startSupervisorDaemon } from './index.ts'

// Slice c — the supervisor pane-log must be a drop-in for tmux pipe-pane: the SAME raw child bytes to
// <identity>.log (so observer/shadow/readyGateViewport read a served session identically), AND a model
// built from it must render what tmux's capture-pane shows. Live tmux + Bun-native pty → guarded.
const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0
const [maj, min, pat] = (Bun.version || '0.0.0').split('.').map(Number) as [number, number, number]
const bunPty = maj > 1 || (maj === 1 && (min > 3 || (min === 3 && pat >= 5)))
const d = tmuxAvailable && bunPty ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const readBuf = (p: string): Buffer => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0))
const modelOf = (bytes: Buffer, cols: number, rows: number): Promise<string> => {
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 })
  return new Promise<string>(res => t.write(bytes, () => res(modelToPlainText(t, cols, rows))))
}

d('supervisor pane-log ≡ tmux pipe-pane', () => {
  test('RAW-BYTE-IDENTITY: the same child yields byte-identical logs (LF/CRLF + multibyte + ANSI)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'panelog-bp-'))
    const tmuxSock = join(dir, 't.sock')
    const logTmux = join(dir, 'tmux.log')
    const logSup = join(dir, 'sup.log')
    const runDir = join(dir, 'run')
    // bare \n, \r\n, multibyte ❯ › … é (the latin1 grabli), ANSI SGR — the byte classes that diverge
    const child = ['sh', '-c', `sleep 0.5; printf 'L1\\nL2\\r\\ng:❯›…é\\n\\033[31mRED\\033[0m\\nTAB\\tEND\\n'; sleep 1`]
    try {
      spawnSync('tmux', ['-S', tmuxSock, 'new-session', '-d', '-s', 'p', '-x', '80', '-y', '24', ...child], { stdio: 'ignore' })
      spawnSync('tmux', ['-S', tmuxSock, 'pipe-pane', '-o', '-t', 'p', `cat >> '${logTmux}'`], { stdio: 'ignore' })
      await startSupervisorDaemon({ session: 'bp', runtime: 'tick', runDir, serve: { argv: child, env: { PATH: process.env.PATH ?? '' }, cwd: dir, paneLogPath: logSup } })
      await sleep(2300) // both children: sleep .5 + emit + sleep 1 ≈ exit ~1.5s; tmux's cat EOF-flushes
      const a = readBuf(logTmux)
      const b = readBuf(logSup)
      expect(b.length).toBeGreaterThan(0)
      expect(b.equals(a)).toBe(true) // byte-for-byte — raw Buffer passthrough, shared onlcr default
      expect(b.includes(Buffer.from('❯›…é', 'utf8'))).toBe(true) // multibyte survived (no latin1 re-encode)
    } finally {
      spawnSync('tmux', ['-S', tmuxSock, 'kill-server'], { stdio: 'ignore' })
      try {
        killSession(runDir, 'bp')
      } catch {
        /* */
      }
      await sleep(300)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('BINDING: a model from the supervisor pane-log renders what tmux capture-pane shows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'panelog-bind-'))
    const tmuxSock = join(dir, 't.sock')
    const logSup = join(dir, 'sup.log')
    const runDir = join(dir, 'run')
    const COLS = 80,
      ROWS = 24
    // a static frame (clear+home, three lines incl. the ❯ ready glyph), then idle so capture-pane sees it
    const child = ['sh', '-c', `printf '\\033[2J\\033[HLine one\\r\\n  ❯ ready prompt\\r\\nthird line ok\\r\\n'; sleep 30`]
    try {
      spawnSync('tmux', ['-S', tmuxSock, 'new-session', '-d', '-s', 'b', '-x', String(COLS), '-y', String(ROWS), ...child], { stdio: 'ignore' })
      await startSupervisorDaemon({ session: 'bind', runtime: 'tick', runDir, serve: { argv: child, env: { PATH: process.env.PATH ?? '' }, cwd: dir, paneLogPath: logSup } })
      // let the frame render in both
      let cap = ''
      for (let i = 0; i < 30 && !/❯ ready prompt/.test(cap); i++) {
        await sleep(200)
        cap = spawnSync('tmux', ['-S', tmuxSock, 'capture-pane', '-p', '-t', 'b'], { encoding: 'utf8' }).stdout || ''
      }
      const modelSup = await modelOf(readBuf(logSup), COLS, ROWS)
      // tmux capture-pane render (its own emulator) == @xterm model of the SUPERVISOR's pane-log
      const norm = (s: string): string =>
        s
          .split('\n')
          .map(l => l.replace(/\s+$/, ''))
          .join('\n')
          .replace(/\n+$/, '')
      expect(norm(modelSup)).toBe(norm(cap))
      expect(modelSup).toContain('❯ ready prompt') // the ready glyph survived into the model
    } finally {
      spawnSync('tmux', ['-S', tmuxSock, 'kill-server'], { stdio: 'ignore' })
      try {
        killSession(runDir, 'bind')
      } catch {
        /* */
      }
      await sleep(300)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Defect 2 — a pane-log unlinked out from under a LIVE session must self-heal (the supervisor reopens
// it on the next output), else every occupancy reader of <identity>.log goes blind: composer-busy
// delivery detection AND telegram-runtime's mtime typing/activity indicator. No tmux needed → runs in CI.
const dp = bunPty ? describe : describe.skip
dp('supervisor pane-log self-heal (Defect 2)', () => {
  test('a pane-log unlinked mid-session is recreated on the next output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'panelog-heal-'))
    const logSup = join(dir, 'sup.log')
    const runDir = join(dir, 'run')
    // emit AAA once, then CCC repeatedly so a write reliably lands after the 1 s heal throttle window
    const child = ['sh', '-c', `printf 'AAA\\n'; sleep 0.4; i=0; while [ $i -lt 12 ]; do printf 'CCC\\n'; sleep 0.5; i=$((i+1)); done`]
    try {
      await startSupervisorDaemon({ session: 'heal', runtime: 'tick', runDir, serve: { argv: child, env: { PATH: process.env.PATH ?? '' }, cwd: dir, paneLogPath: logSup } })
      for (let i = 0; i < 20 && !readBuf(logSup).includes(Buffer.from('AAA')); i++) await sleep(100)
      expect(readBuf(logSup).includes(Buffer.from('AAA'))).toBe(true)
      // unlink the live pane-log out from under the supervisor (the observed Defect-2 scenario)
      rmSync(logSup, { force: true })
      expect(existsSync(logSup)).toBe(false)
      // subsequent child output must self-heal: path recreated + new bytes land
      for (let i = 0; i < 60 && !readBuf(logSup).includes(Buffer.from('CCC')); i++) await sleep(100)
      expect(existsSync(logSup)).toBe(true)
      expect(readBuf(logSup).includes(Buffer.from('CCC'))).toBe(true)
      // the recreated file is a fresh inode — it holds only post-reopen bytes, not the pre-deletion AAA
      expect(readBuf(logSup).includes(Buffer.from('AAA'))).toBe(false)
    } finally {
      try {
        killSession(runDir, 'heal')
      } catch {
        /* */
      }
      await sleep(300)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
