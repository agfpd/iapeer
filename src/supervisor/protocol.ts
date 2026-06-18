// Supervisor wire/terminal PRIMITIVES — the pure, hermetically-testable core of the
// detach-persistent pty-supervisor (cutover Block 2, ported from the validated PoC pts.mjs).
//
// PURE: no Bun, no @xterm, no socket — frames, the capability responder, the backpressure
// writer (port-dep #2), and the terminal-reset string (port-dep #1) are all data-in/data-out,
// so the two reattach port-deps that bit the PoC are unit-provable without spawning anything.

const EMPTY = Buffer.alloc(0)

// ── client/daemon frame protocol: [type:u8][len:u32be][payload] ──
export const FRAME_DATA = 0
export const FRAME_RESIZE = 1

export function frame(type: number, payload: Buffer | string): Buffer {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const h = Buffer.alloc(5)
  h[0] = type
  h.writeUInt32BE(p.length, 1)
  return Buffer.concat([h, p])
}

/** Streaming frame de-chunker: reassembles frames across arbitrary TCP/unix chunk boundaries
 *  (a frame may arrive split, or several may arrive coalesced). Calls onFrame per complete frame. */
export function makeFramer(onFrame: (type: number, payload: Buffer) => void): (chunk: Uint8Array | Buffer) => void {
  let buf: Buffer = EMPTY
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, Buffer.from(chunk)]) : Buffer.from(chunk)
    while (buf.length >= 5) {
      const type = buf[0]!
      const len = buf.readUInt32BE(1)
      if (buf.length < 5 + len) break
      onFrame(type, buf.subarray(5, 5 + len))
      buf = buf.subarray(5 + len)
    }
  }
}

export function sizePayload(cols: number, rows: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt16BE(cols || 80, 0)
  b.writeUInt16BE(rows || 24, 2)
  return b
}

export function parseSize(payload: Buffer): { cols: number; rows: number } {
  return { cols: payload.readUInt16BE(0), rows: payload.readUInt16BE(2) }
}

// ── capability responder ──────────────────────────────────────────────────────
// The child (claude/codex TUI) emits terminal capability QUERIES (device attributes, cursor
// position, theme) and BLOCKS its first paint until they are answered. tmux answers them; the
// supervisor daemon must too. @xterm/headless auto-answers DA1/DSR via onData; these are the
// ones it does NOT: secondary/tertiary DA (`>q`, `>c`) and the OSC-11 theme query.

export const QUERY_RE = /\x1b\[0?c|\x1b\[>\d*[qc]|\x1b\[6n|\x1b\]11;\?(?:\x07|\x1b\\)/g

/** Supplementary capability answers to write back INTO the child for queries @xterm does not
 *  auto-answer. Returns the response strings (possibly empty). Pure — testable without a pty. */
export function capabilityResponses(s: string): string[] {
  const out: string[] = []
  if (/\x1b\[>\d*q/.test(s)) out.push('\x1bP>|iapeer-pts(0.1)\x1b\\') // XTVERSION (DA2-style)
  if (/\x1b\]11;\?(\x07|\x1b\\)/.test(s)) out.push('\x1b]11;rgb:1e1e/1e1e/1e1e\x07') // OSC-11 theme
  if (/\x1b\[>\d*c/.test(s)) out.push('\x1b[>0;276;0c') // secondary DA
  return out
}

/** Strip capability queries from a child-output chunk before forwarding to clients (the daemon
 *  is the authoritative responder — clients must not see/answer the queries themselves). */
export function stripQueries(s: string): string {
  return s.replace(QUERY_RE, '')
}

// ── key-name → pty bytes (boot-driver, serving slice a) ─────────────────────────
// Translate a tmux send-keys-style key list into the raw bytes a pty expects, so the supervisor
// boot-driver can answer startup dialogs (codex trust/update/hooks, claude trust/resume-picker) off
// the MODEL exactly as the launch primitive answers them via `tmux send-keys`. PURE — the byte
// output is unit-comparable to real `tmux send-keys` (the acceptance bar: byte-identity, not a
// "looks right" table).
//
// tmux semantics mirrored for the vocabulary our RuntimeAdapters actually emit (bootDialogKeys /
// executeControl): a leading `-l` switches to LITERAL mode (every following
// token sent verbatim, no key-name lookup); otherwise each token is a KEY NAME when known, else
// literal text. Cursor keys depend on DECCKM application-cursor-keys mode — `\x1b[B` (normal) vs
// `\x1bOB` (application) — which tmux keys off the terminal mode and the caller reads from the
// @xterm model (term.modes.applicationCursorKeysMode), passing it in `enc`. Both codex hooks-review
// (`['Down','Enter']`) and the claude resume-picker (`['Down']`) put a cursor key in the boot set,
// so the mode is load-bearing — a hardcoded `\x1b[B` would corrupt the key under DECCKM.

export interface KeyEncoding {
  /** DECCKM application-cursor-keys mode (CSI ? 1 h). When set, arrow keys use SS3 (ESC O x)
   *  instead of CSI (ESC [ x), matching what tmux send-keys emits in that mode. */
  appCursorKeys?: boolean
}

const NAMED_KEYS: Record<string, string> = {
  Enter: '\r',
  Escape: '\x1b',
  Tab: '\t',
  Space: ' ',
  BSpace: '\x7f',
}

/** Translate `keys` (tmux send-keys vocabulary) to the pty byte stream. See section header. */
export function keysToBytes(keys: string[], enc: KeyEncoding = {}): Buffer {
  const cur: Record<string, string> = enc.appCursorKeys
    ? { Up: '\x1bOA', Down: '\x1bOB', Right: '\x1bOC', Left: '\x1bOD' }
    : { Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D' }
  let literal = false
  let out = ''
  for (const k of keys) {
    if (!literal && k === '-l') {
      literal = true
      continue
    }
    if (!literal && k in NAMED_KEYS) out += NAMED_KEYS[k]
    else if (!literal && k in cur) out += cur[k]
    else out += k
  }
  return Buffer.from(out, 'utf8')
}

// ── port-dep #1: terminal reset on every client exit path ───────────────────────
// The child sets a STACK of app-modes on the live terminal (alt-screen, bracketed-paste,
// focus-events, theme-update, ALL mouse tracking, kitty-keyboard, scroll-region, hidden cursor).
// They persist in the window after the client goes. A SIGHUP/window-close client that ran NOTHING
// leaked them → broke the NEXT reattach (mouse tracking eats the scroll wheel, kitty garbles keys,
// leftover modes freeze the render). Reset to a clean base on EVERY exit path; the next attach's
// repaint + the child's live re-render re-assert whatever the session actually needs.
export const TERM_RESET =
  '\x1b[?1049l' + // leave alt-screen (normal buffer)
  '\x1b[?2004l' + // bracketed-paste off
  '\x1b[?1004l' + // focus-event reporting off
  '\x1b[?2031l' + // theme/color-scheme-update off
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l' + // ALL mouse tracking off
  '\x1b[<u' + // pop kitty-keyboard flags
  '\x1b[r' + // reset scroll region (DECSTBM) to full
  '\x1b[?25h' + // show cursor
  '\x1b[?7h' // wraparound on (default)

// ── port-dep #2: backpressure-safe socket writer ────────────────────────────────
// Bun's sock.write() of a large buffer accepts only the socket buffer (~8 KB) and RETURNS the
// count actually taken — the rest is DROPPED unless queued and re-sent on `drain`. The PoC's old
// code ignored the return, so a heavy-claude repaint frame (~90 KB serialize) arrived TRUNCATED
// (measured live: len=89305, only 8192 delivered) → the client's framer waited forever for a
// frame that never completed → reattach showed the STALE close-moment frame. This writer queues
// the unwritten tail and flushes it on drain, for BOTH the repaint snapshot and live forward.

export interface SocketWrite {
  /** Write up to buf.length bytes; return the count ACCEPTED (Bun semantics), or <0 on a dead socket. */
  (buf: Buffer): number
}

/** Per-socket backpressure queue. send() coalesces+writes and queues the unaccepted tail;
 *  flush() (call on the socket `drain` event) drains the queue. Dead once write throws / returns <0. */
export class BackpressureWriter {
  private pending: Buffer = EMPTY
  private dead = false
  constructor(private readonly write: SocketWrite) {}

  /** Queue and send `buf`. Returns false iff the socket is dead (caller should drop the client). */
  send(buf: Buffer): boolean {
    if (this.dead) return false
    const data = this.pending.length ? Buffer.concat([this.pending, buf]) : buf
    let n: number
    try {
      n = this.write(data)
    } catch {
      this.dead = true
      return false
    }
    if (n < 0) {
      this.dead = true
      return false
    }
    this.pending = n < data.length ? data.subarray(n) : EMPTY
    return true
  }

  /** Flush the queued tail (call on `drain`). Returns false iff the socket died flushing. */
  flush(): boolean {
    if (this.dead) return false
    if (!this.pending.length) return true
    let n: number
    try {
      n = this.write(this.pending)
    } catch {
      this.dead = true
      return false
    }
    if (n < 0) {
      this.dead = true
      return false
    }
    this.pending = n < this.pending.length ? this.pending.subarray(n) : EMPTY
    return true
  }

  get isDead(): boolean {
    return this.dead
  }
  get queuedBytes(): number {
    return this.pending.length
  }
}
