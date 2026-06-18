// Ф-#8b: cold-wake boot first-message delivery via load-buffer + bracketed
// paste-buffer — the SAME byte-path as warm delivery (transport.deliverViaTmux),
// replacing the old `send-keys -l` retype. Proven hermetically against a REAL
// tmux (gated like sockdir.test.ts) with a fake tui adapter whose "runtime" is
// `cat >> <file>`: whatever the boot path injects into the pane lands verbatim in
// the file, and the ready-gate keys on that file's mtime (the activity proxy).
//
// pty note: `cat` reads the pane pty in CANONICAL mode (line-buffered, ~1 KiB
// line cap on macOS) — real TUIs run raw and have no such cap. The fixture
// message therefore uses many sub-1-KiB LINES to total multi-KiB; what this test
// pins is the INJECTION path (one bracketed paste, no option-parsing traps, no
// key-by-key retype), not the tty discipline.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { launch } from './index.ts'
import type { LaunchConfig, LaunchSpec, RuntimeAdapter } from './types.ts'

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

const dirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-bootdeliver-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** Fake tui adapter: the "runtime" appends its pty input to `recvPath`; the
 *  activity proxy is that file's mtime (absent → null, exactly like a missing
 *  transcript), so the boot baseline is 0 and the ready-gate flips on receipt. */
function catAdapter(recvPath: string): RuntimeAdapter {
  return {
    runtime: 'claude', // any tui Runtime — the adapter object itself is what launch consumes
    kind: 'tui',
    usesDoctrine: false,
    deliveryMarkers: { promptGlyphs: [] },
    buildArgv: () => ['/bin/sh', '-c', `cat >> ${recvPath}`],
    bootDialogKeys: () => null,
    isInputReady: () => true,
    newestActivityMtime: () => {
      try {
        return statSync(recvPath).mtimeMs
      } catch {
        return null
      }
    },
    resolveResume: () => ({ ok: true }),
    executeControl: () => null,
  }
}

describe('boot first-message delivery (load-buffer + bracketed paste)', () => {
  test.if(tmuxAvailable)(
    'a multi-line, dash-leading, multi-KiB first message lands INTACT and launch goes READY',
    async () => {
      const root = mkTmp()
      const recv = join(root, 'received.txt')
      const sock = join(root, 'tmux-iap-claude-bootd.sock')
      // The fixture stresses every historical boot-inject trap at once:
      //   • leading '-'  — the send-keys option-parsing trap (audit #6);
      //   • quotes/$()/; — shell-metachar corruption if anything re-quoted the body;
      //   • multi-KiB    — a size send-keys -l replayed key-by-key (8 × ~700 B lines).
      const firstMessage = [
        '- dash-leading first line (the send-keys option-parsing trap)',
        `quotes "double" 'single' and $dollar \`backtick\` ; semicolon`,
        ...Array.from({ length: 8 }, (_, i) => `${i}:${'x'.repeat(700)}`),
      ].join('\n')
      const spec: LaunchSpec = {
        personality: 'bootd',
        runtime: 'claude',
        cwd: root,
        identity: 'claude-bootd',
        socketPath: sock,
        intelligence: 'artificial',
      }
      const cfg: LaunchConfig = {
        claudeBin: 'unused',
        codexBin: 'unused',
        sockDir: root,
        bootDeadlineSecs: 10,
        readyGateSecs: 8,
        logDir: join(root, 'logs'),
      }
      // pty-supervisor hosting is the DEFAULT now; this fixture exercises the legacy TMUX boot/delivery
      // path (load-buffer + bracketed paste) explicitly, so opt this peer OUT of pty with a .no-pty-host
      // marker (otherwise launch hosts it under the supervisor and the tmux-path assertions never apply).
      mkdirSync(cfg.logDir, { recursive: true })
      writeFileSync(join(cfg.logDir, `${spec.identity}.no-pty-host`), '')
      try {
        const r = await launch(spec, catAdapter(recv), firstMessage, cfg)
        expect(r.status).toBe('READY')
        const got = readFileSync(recv, 'utf8')
        expect(got).toContain('- dash-leading first line (the send-keys option-parsing trap)')
        expect(got).toContain(`quotes "double" 'single' and $dollar \`backtick\` ; semicolon`)
        for (let i = 0; i < 8; i++) expect(got).toContain(`${i}:${'x'.repeat(700)}`)
      } finally {
        spawnSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' })
      }
    },
    60000,
  )
})
