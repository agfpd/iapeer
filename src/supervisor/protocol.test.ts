import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BackpressureWriter,
  FRAME_DATA,
  FRAME_RESIZE,
  TERM_ATTACH_RESET,
  TERM_RESET,
  capabilityResponses,
  frame,
  keysToBytes,
  makeFramer,
  parseSize,
  sizePayload,
  splitDanglingEscape,
  stripQueries,
} from './protocol.ts'

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

describe('frame protocol', () => {
  test('frame() lays out [type][len:u32be][payload]', () => {
    const f = frame(FRAME_DATA, 'hi')
    expect(f[0]).toBe(FRAME_DATA)
    expect(f.readUInt32BE(1)).toBe(2)
    expect(f.subarray(5).toString()).toBe('hi')
  })

  test('makeFramer reassembles a frame split across chunk boundaries', () => {
    const got: Array<{ t: number; p: string }> = []
    const fr = makeFramer((t, p) => got.push({ t, p: p.toString() }))
    const f = frame(FRAME_DATA, 'hello world')
    fr(f.subarray(0, 3)) // partial header
    fr(f.subarray(3, 8)) // rest of header + part of payload
    expect(got).toHaveLength(0) // nothing complete yet
    fr(f.subarray(8)) // tail
    expect(got).toEqual([{ t: FRAME_DATA, p: 'hello world' }])
  })

  test('makeFramer splits multiple coalesced frames', () => {
    const got: string[] = []
    const fr = makeFramer((_t, p) => got.push(p.toString()))
    fr(Buffer.concat([frame(FRAME_DATA, 'a'), frame(FRAME_DATA, 'bb'), frame(FRAME_DATA, 'ccc')]))
    expect(got).toEqual(['a', 'bb', 'ccc'])
  })

  test('sizePayload/parseSize round-trip', () => {
    expect(parseSize(sizePayload(132, 50))).toEqual({ cols: 132, rows: 50 })
    expect(frame(FRAME_RESIZE, sizePayload(80, 24))[0]).toBe(FRAME_RESIZE)
  })
})

describe('capability responder (the queries @xterm does not auto-answer)', () => {
  test('secondary-DA-style XTVERSION query → version report', () => {
    expect(capabilityResponses('\x1b[>0q')).toEqual(['\x1bP>|iapeer-pts(0.1)\x1b\\'])
  })
  test('OSC-11 theme query → an rgb background report', () => {
    expect(capabilityResponses('\x1b]11;?\x07')[0]).toContain('\x1b]11;rgb:')
  })
  test('secondary DA (>c) → a DA2 report', () => {
    expect(capabilityResponses('\x1b[>0c')).toEqual(['\x1b[>0;276;0c'])
  })
  test('plain output → no responses', () => {
    expect(capabilityResponses('just some text\r\n')).toEqual([])
  })
  test('stripQueries removes DA1/DSR/theme but keeps real output', () => {
    const s = 'before\x1b[0c\x1b[6nmid\x1b]11;?\x07after'
    const out = stripQueries(s)
    expect(out).toBe('beforemidafter')
    expect(out).not.toContain('\x1b[6n')
  })
})

describe('В24 splitDanglingEscape (chunk-boundary query buffering)', () => {
  test('holds an INCOMPLETE trailing CSI so a split query is matched next chunk', () => {
    // XTVERSION `\x1b[>q` split as `...\x1b[>` | `q`
    const [c1, tail1] = splitDanglingEscape('output\x1b[>')
    expect(c1).toBe('output')
    expect(tail1).toBe('\x1b[>')
    // next chunk: prepend the tail → the whole query is now present and answered
    const [c2, tail2] = splitDanglingEscape(tail1 + 'q\r\n')
    expect(tail2).toBe('')
    expect(capabilityResponses(c2)).toEqual(['\x1bP>|iapeer-pts(0.1)\x1b\\'])
    expect(stripQueries(c2)).toBe('\r\n') // the reassembled query is stripped from the client stream
  })
  test('holds an incomplete OSC-11 (no terminator yet)', () => {
    const [c, tail] = splitDanglingEscape('x\x1b]11;?')
    expect(c).toBe('x')
    expect(tail).toBe('\x1b]11;?')
    const [, tail2] = splitDanglingEscape(tail + '\x07')
    expect(tail2).toBe('') // BEL completes it
  })
  test('a COMPLETE trailing escape is NOT held', () => {
    expect(splitDanglingEscape('a\x1b[0mb')).toEqual(['a\x1b[0mb', '']) // SGR complete
    expect(splitDanglingEscape('a\x1b]11;?\x07')).toEqual(['a\x1b]11;?\x07', '']) // OSC complete (BEL)
    expect(splitDanglingEscape('plain text')).toEqual(['plain text', '']) // no ESC
  })
  test('a bare trailing ESC is held; an over-long trailing run is passed through (never stalls)', () => {
    expect(splitDanglingEscape('hi\x1b')).toEqual(['hi', '\x1b'])
    const long = '\x1b' + 'x'.repeat(40) // > MAX_DANGLING and not a real query → pass through
    expect(splitDanglingEscape('z' + long)).toEqual(['z' + long, ''])
  })
})

describe('TERM_RESET (port-dep #1: clean every client exit path)', () => {
  test('resets the leak-prone app-modes', () => {
    expect(TERM_RESET).toContain('\x1b[?1049l') // leave alt-screen
    expect(TERM_RESET).toContain('\x1b[?1000l') // mouse tracking off
    expect(TERM_RESET).toContain('\x1b[?25h') // show cursor
    expect(TERM_RESET).toContain('\x1b[<u') // pop kitty-keyboard
  })
})

describe('TERM_ATTACH_RESET (clean physical viewport before the one-time snapshot)', () => {
  test('uses HOME+ED0, never Apple Terminal clear-to-scrollback ED2/unsupported ED3', () => {
    expect(TERM_ATTACH_RESET).toBe('\x1b[H\x1b[J')
    expect(TERM_ATTACH_RESET).not.toContain('\x1b[2J')
    expect(TERM_ATTACH_RESET).not.toContain('\x1b[3J')
  })
})

describe('BackpressureWriter (port-dep #2: the ~90 KB-over-8 KB truncation that staled reattach)', () => {
  test('a fully-accepted write leaves nothing queued', () => {
    const w = new BackpressureWriter(b => b.length)
    expect(w.send(Buffer.alloc(100))).toBe(true)
    expect(w.queuedBytes).toBe(0)
  })

  test('a heavy frame past the socket buffer is QUEUED, then fully delivered across drains', () => {
    const CAP = 8192
    let delivered = 0
    const w = new BackpressureWriter(b => {
      const n = Math.min(CAP, b.length)
      delivered += n
      return n
    })
    const heavy = Buffer.alloc(89305, 0x41) // the measured heavy-claude serialize size
    expect(w.send(heavy)).toBe(true)
    expect(delivered).toBe(CAP) // first write took only the socket buffer
    expect(w.queuedBytes).toBe(89305 - CAP) // the rest is queued, NOT dropped
    let guard = 0
    while (w.queuedBytes > 0 && guard++ < 1000) w.flush() // drain events
    expect(delivered).toBe(89305) // every byte eventually delivered (no truncation)
    expect(w.queuedBytes).toBe(0)
    expect(w.isDead).toBe(false)
  })

  test('coalesces a new send onto the pending tail (ordering preserved)', () => {
    const CAP = 4
    const chunks: string[] = []
    const w = new BackpressureWriter(b => {
      const n = Math.min(CAP, b.length)
      chunks.push(b.subarray(0, n).toString())
      return n
    })
    w.send(Buffer.from('ABCDEF')) // 'ABCD' written, 'EF' queued
    w.send(Buffer.from('GH')) // coalesced onto 'EF' → 'EFGH'
    let guard = 0
    while (w.queuedBytes > 0 && guard++ < 100) w.flush()
    expect(chunks.join('')).toBe('ABCDEFGH')
  })

  test('a dead socket (write throws) → send returns false and the writer is dead', () => {
    const w = new BackpressureWriter(() => {
      throw new Error('EPIPE')
    })
    expect(w.send(Buffer.alloc(10))).toBe(false)
    expect(w.isDead).toBe(true)
  })

  test('a negative write count → dead', () => {
    const w = new BackpressureWriter(() => -1)
    expect(w.send(Buffer.alloc(10))).toBe(false)
    expect(w.isDead).toBe(true)
  })
})

describe('keysToBytes (tmux send-keys vocabulary → pty bytes, the boot key-set)', () => {
  test('Enter → CR (the trust/proceed dialogs)', () => {
    expect(keysToBytes(['Enter'])).toEqual(Buffer.from('\r'))
  })
  test('codex update-decline [2,Enter] → "2" + CR', () => {
    expect(keysToBytes(['2', 'Enter'])).toEqual(Buffer.from('2\r'))
  })
  test('codex hooks-review [Down,Enter] in NORMAL cursor mode → CSI-B + CR', () => {
    expect(keysToBytes(['Down', 'Enter'])).toEqual(Buffer.from('\x1b[B\r'))
  })
  test('[Down,Enter] under DECCKM application-cursor mode → SS3-B + CR (the mode-sensitivity boris flagged)', () => {
    expect(keysToBytes(['Down', 'Enter'], { appCursorKeys: true })).toEqual(Buffer.from('\x1bOB\r'))
  })
  test('claude resume-picker [Down] → cursor-down only', () => {
    expect(keysToBytes(['Down'])).toEqual(Buffer.from('\x1b[B'))
  })
  test('literal mode -l sends the rest verbatim (executeControl /compact)', () => {
    expect(keysToBytes(['-l', '/compact'])).toEqual(Buffer.from('/compact'))
  })
  test('Escape (interrupt) → ESC', () => {
    expect(keysToBytes(['Escape'])).toEqual(Buffer.from('\x1b'))
  })
  test('an unknown token falls through to literal text', () => {
    expect(keysToBytes(['hello'])).toEqual(Buffer.from('hello'))
  })
})

// boris's acceptance bar: the translator must be BYTE-IDENTICAL to real `tmux send-keys` for the
// key-set the adapters actually return — not a "looks right" table. We capture exactly what tmux
// delivers to a pane (raw mode bypasses the line discipline so no CR↔NL cooking) and compare.
// Guarded by tmuxAvailable (a clean CI runner has no tmux → these skip, per the live-tmux lesson).
function tmuxSendKeysBytes(keys: string[], appCursor: boolean, n: number): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'pts-keys-'))
  const sock = join(dir, 's.sock')
  const out = join(dir, 'out.bin')
  // The pane program: optionally emit DECCKM (CSI ? 1 h) as its OWN output so tmux tracks
  // application-cursor mode; then raw mode (capture send-keys bytes verbatim); then read exactly n
  // bytes and exit (head flushes on exit — a buffered cat would lose the tail on kill).
  const pre = appCursor ? `printf '\\033[?1h'; ` : ''
  const paneCmd = `${pre}stty raw -echo; head -c ${n} > '${out}'`
  try {
    const create = spawnSync(
      'tmux',
      ['-S', sock, 'new-session', '-d', '-s', 'k', '-x', '80', '-y', '24', 'sh', '-c', paneCmd],
      { stdio: 'ignore' },
    )
    if (create.status !== 0) throw new Error('tmux new-session failed')
    Bun.sleepSync(400) // let the pane reach raw mode + tmux process the DECCKM output
    spawnSync('tmux', ['-S', sock, 'send-keys', '-t', 'k', ...keys], { stdio: 'ignore' })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (existsSync(out) && statSync(out).size >= n) break
      Bun.sleepSync(50)
    }
    return existsSync(out) ? readFileSync(out) : Buffer.alloc(0)
  } finally {
    spawnSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' })
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* */
    }
  }
}

describe.if(tmuxAvailable)('keysToBytes byte-identity vs real tmux send-keys (live)', () => {
  test('NORMAL cursor mode: [Down,Enter]', () => {
    const ours = keysToBytes(['Down', 'Enter'])
    expect(tmuxSendKeysBytes(['Down', 'Enter'], false, ours.length)).toEqual(ours)
  })
  test('DECCKM application-cursor mode: [Down,Enter] → SS3', () => {
    const ours = keysToBytes(['Down', 'Enter'], { appCursorKeys: true })
    expect(tmuxSendKeysBytes(['Down', 'Enter'], true, ours.length)).toEqual(ours)
  })
  test('literal digit + Enter: [2,Enter]', () => {
    const ours = keysToBytes(['2', 'Enter'])
    expect(tmuxSendKeysBytes(['2', 'Enter'], false, ours.length)).toEqual(ours)
  })
  test('bare Enter', () => {
    const ours = keysToBytes(['Enter'])
    expect(tmuxSendKeysBytes(['Enter'], false, ours.length)).toEqual(ours)
  })
})
