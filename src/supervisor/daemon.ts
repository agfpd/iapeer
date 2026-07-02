// Supervisor DAEMON — holds the pty + child + headless-xterm model + capability responder
// independent of any terminal; clients attach/detach over a unix socket. It HOSTS tui/router peers
// by default (the pty-host launch path; opt-out per-peer via a `.no-pty-host` marker), and is also
// reachable manually via the `supervisor` CLI verb for throwaway validation. It runs in its OWN
// detached process, dynamic-imported from the launch path (supervisor/index.ts → daemon.ts), so
// @xterm never loads in the central router's delivery path nor in the launch/lifecycle process.
//
// Loads @xterm/headless as the authoritative model (boot-driver reads it; capability queries answered
// off it). The attach catch-up sends a SNAPSHOT of that resolved model (scrollback + viewport as
// committed text rows; see repaint) — NOT a replay of the child's raw frames and NOT a SerializeAddon
// dump, both of which corrupt scrollback for a relative-cursor, no-scroll-region TUI like claude.
// @xterm/headless bundles under `bun build --compile` (pure JS; the Bun-native pty has no native addon).
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  BackpressureWriter,
  FRAME_DATA,
  FRAME_RESIZE,
  capabilityResponses,
  frame,
  makeFramer,
  parseSize,
  splitDanglingEscape,
  stripQueries,
} from './protocol.ts'
import { attachedPath, geometryPath, pidPath, servePath, sockPath, writeGeometry } from './paths.ts'
import { nextBootAction, nextNagAction, type BootPredicates, type NagPredicate } from './boot.ts'
import { modelToPlainText } from './render.ts'
import { codexAdapter } from '../launch/adapters/codex.ts'
import { claudeAdapter } from '../launch/adapters/claude.ts'

/** Resolve a runtime launcher from the host AT CALL TIME — env override (IAPEER_<RT>_BIN, the same
 *  knob the rest of the foundation uses) → PATH lookup — never a baked machine-specific path. Returns
 *  undefined for an unknown runtime, incl. the hermetic `tick` test stream (which uses TICK_CMD, so the
 *  spawn/attach/reattach tests never need a real claude/codex on the box). */
function knownLauncher(runtime: string): string | undefined {
  const override =
    runtime === 'claude' ? process.env.IAPEER_CLAUDE_BIN
    : runtime === 'codex' ? process.env.IAPEER_CODEX_BIN
    : undefined
  if (override?.trim()) return override.trim()
  return Bun.which(runtime) ?? undefined
}
const TICK_CMD = ['sh', '-c', 'i=0; while true; do printf "STREAMTICK_%d\\r\\n" "$i"; i=$((i+1)); sleep 0.3; done']

// Boot-driver (serving slice a): the runtimes whose startup dialogs the supervisor knows how to
// answer off its model. 'tick' (and any unknown runtime) has no entry → no driver → the hermetic
// spawn/attach tests and the bare conduit are untouched.
const BOOT_ADAPTERS: Record<string, BootPredicates> = { codex: codexAdapter, claude: claudeAdapter }

// SCROLLBACK SPINNER STRIP (serve-side, repaint snapshot only). claude's TUI redraws its bottom status
// block WITHOUT a scroll-region (DECSTBM), so as the conversation scrolls, stale spinner frames
// ("✶ Gerund… (Nm Ns · ↓ N tokens)" / "… (esc to interrupt)") get pushed into the @xterm scrollback ring
// and ACCUMULATE — surfacing as repeated/broken lines when a reattaching operator scrolls history UP
// (the live viewport is clean; only the served history is polluted). We drop those lines from the
// SCROLLBACK part of the serialized repaint snapshot, keeping the last `viewportRows` segments (the LIVE
// status block, incl. the current spinner) verbatim. Matched by STRUCTURE — a gerund + … + the
// elapsed/token or esc-to-interrupt tail — NOT a word-list (claude rotates 100+ spinner gerunds). The
// live byte stream, pane-log and transcript are untouched; only the human-attach repaint is filtered.
const SPINNER_STATUS_LINE = /…[^\n]{0,48}\((?:esc to interrupt|\d+m? ?\d*s ?·)/
const ANSI_SEQ = /\x1b\[[0-9;:?]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
export function stripSpinnerScrollback(serialized: string, viewportRows: number): string {
  const segs = serialized.split('\r\n')
  if (segs.length <= viewportRows) return serialized // no scrollback to clean
  const scrollbackEnd = segs.length - viewportRows // keep the last viewportRows (live viewport) verbatim
  const out: string[] = []
  for (let i = 0; i < segs.length; i++) {
    if (i < scrollbackEnd && SPINNER_STATUS_LINE.test(segs[i].replace(ANSI_SEQ, ''))) continue
    out.push(segs[i])
  }
  return out.join('\r\n')
}
// Poll cadence mirrors the launch primitive's proven 2 s boot loop (index.ts:377). The supervisor
// model is strictly FRESHER than capture-pane (bytes land in @xterm synchronously as they arrive),
// so 2 s leaves ample repaint time — the claude resume-picker never over-Downs, since bootDialogKeys
// returns Enter (not another Down) the moment the moved cursor renders '❯ 2.'. A swallowed key
// self-heals on the next tick (re-sent while the dialog is still up), same as the launch loop.
const BOOT_POLL_MS = 2000
// Stop driving after this long even if readiness is never observed (a hung/unknown startup); the
// driver is best-effort and never blocks the conduit, which keeps serving regardless.
const BOOT_DRIVE_MS = 120_000
// MID-SESSION nag-watcher cadence: same 2 s model poll as the boot-driver. After answering a nag, hold
// this long before the next check so a just-dismissed modal (claude repaints it away within a frame) is
// never re-answered — a stray keystroke would land in the now-visible composer. If the modal genuinely
// survives the hold (our key did not take), the next tick re-fires, so retries stay bounded, not lost.
const NAG_POLL_MS = 2000
const NAG_COOLDOWN_MS = 4000
// В25 — cap the attach-snapshot stabilization wait: under saturating output the model never goes quiet,
// so without a budget firstAttach would never complete (frozen attach). On timeout we snapshot the
// current model; live-forward delivers the rest once the gate lifts.
const MODEL_STABLE_BUDGET_MS = 500

// Bun-native PTY (Bun ≥1.3.5) is not yet in @types/bun — type the slice we use.
interface PtyChild {
  terminal: { write(d: Uint8Array | string): void; resize(cols: number, rows: number): void }
  kill(sig?: number | string): void
}

export interface SupervisorDaemonOptions {
  session: string
  runtime: string
  runDir: string
  /** Child working directory (default: runDir — a throwaway scratch for dark validation). */
  cwd?: string
  /** Override the runtime launcher (else resolved from env override / PATH, else the bare name). */
  bin?: string
  /** SERVING SEAM (slice b): the composed runtime argv (buildLaunchInvocation). When set, the daemon
   *  serves THIS verbatim instead of the bare [bin] — the supervisor is a HOST, not a composer
   *  (launch/lifecycle composes argv+env; the supervisor, like tmux, just serves the invocation). */
  argv?: string[]
  /** SERVING SEAM (slice b): the composed child env (buildLaunchInvocation) — base for the child.
   *  The pty-host env (TERM set, TMUX/TMUX_PANE stripped) is layered ON TOP. Unset → process.env. */
  env?: Record<string, string>
  /** PANE-LOG (slice c): absolute path the child's RAW output bytes are appended to — `<logDir>/
   *  <identity>.log`, the SAME file + append semantics tmux `pipe-pane` writes today, so the observer
   *  / shadow / readyGateViewport tail a served session's log identically. Unset → no pane-log
   *  (throwaway/tick). */
  paneLogPath?: string
  /** EXIT-CAUSE (spawn-flip Ф0b resilience-b): exits.log path. On child exit the daemon appends a
   *  `ev=session-exit … dead_status/dead_signal host=supervisor` line (mirroring the tmux pane-died
   *  hook), so the supervise-tick death classification + crash-loop accounting have the cause. */
  exitLogPath?: string
  cols?: number
  rows?: number
}

/** Run the supervisor daemon in THIS process (blocks until the child exits / SIGTERM). Spawn it
 *  detached via startSupervisorDaemon (index.ts) for a real session; call directly in a test that
 *  owns its own process. */
export function runSupervisorDaemon(opts: SupervisorDaemonOptions): void {
  const { session, runtime, runDir } = opts
  let cols = opts.cols ?? 80
  let rows = opts.rows ?? 30
  // The SERVE geometry — the size the session is hosted at (HOST_COLS×HOST_ROWS for a pty-host peer),
  // immutable. `cols`/`rows` above track the CURRENT (client-driven) size. A client attaches at its own
  // terminal size and the pty resizes to match; on LAST detach we restore the serve geometry (below) so
  // the unattached session never sticks at a departed client's size — otherwise the warm-deliver /
  // ready-gate viewport model (built at the fixed serve geometry) mismatches the actually-resized pty.
  const serveCols = cols
  const serveRows = rows
  const sock = sockPath(runDir, session)
  const pid = pidPath(runDir, session)

  const xterm = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 })
  // SerializeAddon turns the resolved model (scrollback + screen + cursor + SGR colour + private modes)
  // into a byte string that recreates it in a fresh terminal — the attach catch-up. This is how tmux /
  // screen / zellij restore state on attach (emulate the VT, re-render on attach). Color comes free here
  // (translateToString was text-only → the monochrome bug); serialize() carries SGR (xterm PR #2369).
  const serializeAddon = new SerializeAddon()
  xterm.loadAddon(serializeAddon)

  const bin = opts.bin ?? knownLauncher(runtime) ?? runtime
  // SERVING SEAM (slice b): opts.argv (launch-composed, carries the system-prompt swap + PEER_START_ARGS)
  // is served verbatim; else the bare conduit ([bin], or the deterministic tick stream for tests).
  const CMD = opts.argv ?? (runtime === 'tick' ? TICK_CMD : [bin])
  // pty-host env layered ON TOP of the composed child env (opts.env, = buildLaunchInvocation): force a
  // real TERM and strip TMUX/TMUX_PANE so a served child never believes it is inside tmux. The identity
  // ABI (PEER_IDENTITY, IAPEER_BEARER, …) rides in opts.env underneath, untouched.
  const env = { ...(opts.env ?? process.env), TERM: 'xterm-256color' } as Record<string, string>
  delete env.TMUX
  delete env.TMUX_PANE

  // PANE-LOG (slice c): append the child's RAW output bytes to <logDir>/<identity>.log, byte-identical
  // to tmux `pipe-pane … 'cat >> <log>'`. The fd is opened once (append); every chunk is written as a
  // raw Buffer (writeSync(fd, buf)) — NEVER via a string (Bun re-encodes a latin1 string to UTF-8 and
  // corrupts multibyte glyphs like ❯/›; the canonical latin1/Buffer grabli). Parent dir 0700, matching
  // launch's mkdir before pipe-pane. Unset paneLogPath → no log (throwaway/tick).
  let paneLogFd = -1
  let paneLogIno = -1 // inode the fd points at — to detect an out-from-under-us unlink/replace
  let paneLogCheckedMs = 0
  const PANELOG_HEAL_MS = 1000 // throttle the path-existence re-check to ≤1/sec regardless of output volume
  const openPaneLog = (): void => {
    if (!opts.paneLogPath) return
    try {
      mkdirSync(dirname(opts.paneLogPath), { recursive: true, mode: 0o700 })
      if (paneLogFd >= 0) try { closeSync(paneLogFd) } catch { /* */ }
      paneLogFd = openSync(opts.paneLogPath, 'a')
      paneLogIno = fstatSync(paneLogFd).ino
    } catch {
      paneLogFd = -1 // best-effort: a log open hiccup never blocks serving the session
      paneLogIno = -1
    }
  }
  // SELF-HEAL (Defect 2): the pane-log path can be unlinked out from under a live session (observed on
  // the fleet: long-lived sessions' lifecycle pane-logs vanished while the supervisor ran). The fd then
  // keeps writing to a now-unlinked inode — the path stays gone and every occupancy reader of
  // `<logDir>/<identity>.log` goes blind: composer-busy delivery detection AND telegram-runtime's
  // mtime-based typing/activity indicator (shared file). Throttled re-check before a write: if the path
  // vanished or now maps to a DIFFERENT inode than the fd, reopen 'a'. capPaneLogs truncates IN PLACE
  // (same inode) so a normal cap never triggers a spurious reopen. Tied to output (no idle wakeups) —
  // exactly when the log matters.
  const healPaneLog = (): void => {
    if (!opts.paneLogPath) return
    const now = Date.now()
    if (now - paneLogCheckedMs < PANELOG_HEAL_MS) return
    paneLogCheckedMs = now
    let ino = -1
    try {
      ino = statSync(opts.paneLogPath).ino
    } catch {
      ino = -1 // path gone
    }
    // В19 — reopen when the fd is DEAD (initial open failed / a prior reopen failed) as well as when the
    // path maps to a DIFFERENT inode (unlinked/replaced). The old `paneLogFd < 0` early-return above made
    // a single failed open PERMANENT — the log stayed blind for the whole session (composer-busy detect,
    // telegram typing, boot ready-gate all read this file). fd<0 with ino=-1 (path also gone) still needs
    // a reopen attempt: openPaneLog recreates the file.
    if (paneLogFd < 0 || ino !== paneLogIno) openPaneLog()
  }
  openPaneLog()

  const clients = new Set<unknown>()
  const writers = new WeakMap<object, BackpressureWriter>()
  const framers = new WeakMap<object, (chunk: Uint8Array) => void>()
  // FIRST-PAINT TRACKING (Bug B fix): a client gets the full scrollback catch-up EXACTLY ONCE — on its
  // first FRAME_RESIZE (which runClient always sends on connect, at the real terminal size). Re-dumping
  // on a later resize STACKS duplicate histories in a terminal that ignores \x1b[3J (Apple Terminal has
  // NO E3 capability) → smeared/overlapping scroll-up history. After the catch-up the supervisor does
  // NOTHING on resize — the child redraws its viewport (SIGWINCH) and the terminal reflows its own
  // scrollback, like a directly-launched claude.
  // В23 — a SET (not a WeakSet) so `.size` gates the .attached marker on INTERACTIVE clients only. A
  // client is painted iff it sent a FRAME_RESIZE (runClient always does on connect; a deliver-client
  // NEVER resizes). Using clients.size counted deliver-clients too → a delivery briefly marked "human
  // attached", falsely holding a concurrent delivery in the composer queue. Kept in sync with removals.
  const painted = new Set<object>()
  // INITIALIZING GATE (scrollback fix): a client is held OUT of live output-forwarding from connect until
  // its one-time attach snapshot has been sent. Without this, live frames (claude's relative-cursor
  // redraws) race ahead of the snapshot and corrupt the fresh terminal. The model still ingests those
  // bytes, so the snapshot (built FROM the model) already contains them; once the snapshot is sent the
  // client leaves this set and live forwarding resumes — no gap, no duplication.
  const initializing = new WeakSet<object>()
  // MODEL-WRITE PARSE BARRIER: @xterm `write` is async (parsed on an internal queue). The attach snapshot
  // must be built only AFTER in-flight writes have parsed AND none arrived during the wait, else it reflects
  // a stale screen / drops bytes that landed while the client was gated. `writeChain` tracks the latest
  // write's parse-callback; `writeSeq` bumps on every write so the drain can detect new arrivals mid-await.
  let writeChain: Promise<void> = Promise.resolve()
  let writeSeq = 0
  // В24 — a trailing INCOMPLETE escape sequence carried from one child-output chunk to the next, so a
  // capability query split across a pty read boundary is detected/stripped as a whole (client-facing only;
  // the model + pane-log always get the raw bytes immediately).
  let queryTail = ''
  // ATTACHED-CLIENT MARKER (spawn-flip Ф0b-3 slice 3c): keep `<runDir>/<session>.attached` in sync with
  // clients.size — present iff ≥1 operator is attached. The warm-deliver path (a DIFFERENT process)
  // reads it to gate the hosted busy-composer hold: hold ONLY when a human is attached (their unfinished
  // composer text), never for the AI's own composer output when no one is attached. Best-effort: a
  // marker fs hiccup must never break the conduit.
  const attachedMarker = attachedPath(runDir, session)
  const syncAttached = (): void => {
    try {
      // В23 — gate on PAINTED (interactive) clients, not raw client count: a deliver-client connection
      // must never read as "a human is attached".
      if (painted.size > 0) writeFileSync(attachedMarker, '')
      else if (existsSync(attachedMarker)) unlinkSync(attachedMarker)
    } catch {
      /* */
    }
  }
  // CRASH-ROBUSTNESS: a crashed predecessor daemon skips shutdown-cleanup, so a STALE
  // `.attached` could survive into this fresh daemon — and a stale-present marker would make the
  // warm-deliver gate believe a human is attached when none is, holding deliveries forever (the
  // anti-bug inverted). A fresh daemon has ZERO clients, so clear the marker on START (idempotent).
  syncAttached()
  const writerFor = (s: { write(b: Buffer): number }): BackpressureWriter => {
    let w = writers.get(s as object)
    if (!w) {
      w = new BackpressureWriter(b => s.write(b))
      writers.set(s as object, w)
    }
    return w
  }
  /** Backpressure-safe send to one client; drop it (and report false) if its socket is dead. */
  const sendClient = (s: { write(b: Buffer): number }, buf: Buffer): boolean => {
    const ok = writerFor(s).send(buf)
    if (!ok) {
      clients.delete(s)
      painted.delete(s as object) // В23 — keep the painted set (marker gate) in sync on every drop
      syncAttached()
    }
    return ok
  }

  const child = Bun.spawn(CMD, {
    cwd: opts.cwd ?? runDir,
    env,
    // Bun-native PTY: a real pty pair, child output arrives via terminal.data(t, bytes).
    terminal: {
      cols,
      rows,
      name: 'xterm-256color',
      data(_t: unknown, d: Uint8Array | string) {
        const buf = Buffer.isBuffer(d) ? d : typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d)
        // PANE-LOG: the RAW child bytes, exactly as pipe-pane writes them (before any query-stripping
        // for clients) — written as a Buffer, never a string. The `s` below is for query DETECTION only.
        if (opts.paneLogPath) {
          healPaneLog() // reopen if never-opened / unlinked / replaced out from under us (Defect 2 + В19)
          if (paneLogFd >= 0) {
            try {
              writeSync(paneLogFd, buf)
            } catch {
              /* best-effort */
            }
          }
        }
        writeSeq++ // a new write arrived (lets the attach drain detect bytes that land mid-await)
        writeChain = new Promise<void>(resolve => xterm.write(buf, () => resolve())) // authoritative model (+ parse barrier) — RAW bytes
        // В24 — run capability detect/strip over the chunk PLUS any carried tail, holding back a trailing
        // INCOMPLETE escape for the next chunk so a query split across a pty read boundary is matched as a
        // whole. The model + pane-log above get the RAW bytes immediately; only the client-facing detect/
        // strip is tail-buffered (the held bytes reach the client next chunk, once complete).
        const [complete, dangling] = splitDanglingEscape(queryTail + buf.toString('latin1'))
        queryTail = dangling
        for (const r of capabilityResponses(complete)) child.terminal.write(r) // answer capability queries
        const fwd = Buffer.from(stripQueries(complete), 'latin1') // forward to clients sans queries (daemon is authoritative)
        if (fwd.length) {
          // Forward live output to every ATTACHED client — but NOT to one still INITIALIZING (its
          // snapshot hasn't been sent; these bytes are already in the model and will be in that snapshot,
          // so forwarding now would duplicate / race ahead of the snapshot).
          for (const c of [...clients]) {
            if (initializing.has(c as object)) continue
            sendClient(c as { write(b: Buffer): number }, frame(FRAME_DATA, fwd))
          }
        }
      },
      exit(_t?: unknown, exitCode?: number | null, signalCode?: number | null) {
        // resilience-b exit-cause (spawn-flip Ф0b): record WHY the hosted child died into exits.log,
        // mirroring the tmux pane-died hook (ev=session-exit dead_status/dead_signal), so the daemon's
        // supervise-tick death classification + crash-loop accounting have the cause. host=supervisor
        // distinguishes the source. The Bun-native pty exit callback passes (exitCode, signalCode) like
        // onExit; fall back to the subprocess props. Best-effort — never blocks shutdown.
        if (opts.exitLogPath) {
          try {
            mkdirSync(dirname(opts.exitLogPath), { recursive: true, mode: 0o700 }) // ensure the exits.log dir exists
            const c = child as { exitCode?: number | null; signalCode?: number | null }
            const status = exitCode ?? c.exitCode ?? ''
            const signal = signalCode ?? c.signalCode ?? ''
            appendFileSync(
              opts.exitLogPath,
              `ts=${new Date().toISOString()} ev=session-exit identity=${session} dead_status=${status} dead_signal=${signal} host=supervisor\n`,
            )
          } catch {
            /* best-effort */
          }
        }
        shutdown()
      },
    },
  } as unknown as Parameters<typeof Bun.spawn>[1]) as unknown as PtyChild
  xterm.onData(resp => child.terminal.write(resp)) // @xterm auto-answers DA1/DSR → back to child

  /** Catch up a (re)attaching client to the current screen + history ONCE by sending a SNAPSHOT of the
   *  resolved @xterm MODEL — scrollback + viewport as committed plain-text rows — NOT a replay of the
   *  child's raw frames. The model has already flattened claude's relative-cursor in-place redraws into
   *  final lines (no DECSTBM / alt-screen — see the census), so the rows render as native scrollback with
   *  NO duplication. Raw-frame replay can't (relative cursor-up can't reach scrolled-off lines on a linear
   *  dump → overlap) and SerializeAddon re-emits escapes that the no-scroll-region redraws turn into
   *  DUPLICATE scrollback — the two prior dead-ends. Awaits the model parse barrier first (write is async),
   *  then builds + sends the snapshot SYNCHRONOUSLY and lifts the INITIALIZING gate; with no await between
   *  build and lift, a live data() event cannot interleave (single-threaded) → no gap, no double-forward.
   *  Scrollback rows are spinner-stripped; the viewport stays verbatim. The child's SIGWINCH redraw (from
   *  applyGeometry) then settles the live viewport at the client's width. Backpressure-safe
   *  (BackpressureWriter) — a large snapshot MUST NOT drop past the socket buffer (port-dep #2). Called
   *  EXACTLY ONCE per client (its first FRAME_RESIZE). NO clears (\x1b[2J/3J): a fresh window needs none,
   *  and Apple Terminal scrolls 2J into scrollback + ignores 3J. */
  // Await until the model has parsed ALL writes AND none arrived during the wait (stable). Awaiting a single
  // write promise is not enough: while the client is gated (initializing, live-forward skipped) new child
  // bytes still land in the model and bump writeSeq — loop until the sequence holds steady so the snapshot
  // reflects every byte received so far (no stale screen, no dropped tail).
  const awaitModelParsedStable = async (): Promise<void> => {
    // В25 — BOUND the stabilization. Under a saturating output stream (a big file dump, a verbose build,
    // a tailing log) every await window sees a new write → seq never holds steady → firstAttach never
    // completes, so the attaching operator sees a FROZEN blank screen while their keystrokes go to the
    // child blind. Cap the wait: on timeout, snapshot the CURRENT model — bytes that land after are
    // delivered by normal live-forward once the gate lifts (the model already ingests them).
    const deadline = Date.now() + MODEL_STABLE_BUDGET_MS
    for (;;) {
      const seq = writeSeq
      try {
        await writeChain
      } catch {
        /* a write parse-callback should not reject */
      }
      if (seq === writeSeq) return
      if (Date.now() > deadline) return // saturating output — snapshot now, live-forward catches the rest
    }
  }
  // Build + send the one-time attach SNAPSHOT (full resolved model: scrollback + screen + cursor + SGR colour
  // + private modes) via SerializeAddon, and LIFT the initializing gate — SYNCHRONOUS (no await), so the live
  // data() handler cannot interleave between serializing and resuming live-forward (single-threaded) → no gap,
  // no double-forward. Called only from firstAttach, which owns the order (drain → model-resize-to-client →
  // THIS → child-resize-if-changed). serialize() recreates the EXACT grid incl. cursor, so claude's live bytes
  // continue seamlessly from the matching state — no separate viewport repaint, no double-paint overlap. The
  // model is clean because the child is NEVER shrunk on detach (the resize-churn that polluted scrollback is
  // gone), so serialize faithfully reports clean coloured history. Trailing \x1b[m guards the wrap bg-bleed
  // artifact (xterm.js #3102). This is the tmux/zellij "re-render the emulated model on attach" architecture.
  const sendSnapshot = (s: { write(b: Buffer): number }): void => {
    const snap = serializeAddon.serialize({ scrollback: xterm.buffer.active.baseY }) // all scrollback + screen, with colour
    const body = snap.length > 0 ? snap + '\x1b[m' : ''
    if (body) sendClient(s, frame(FRAME_DATA, Buffer.from(body, 'utf8')))
    initializing.delete(s as object) // snapshot sent → resume live forwarding
  }

  // Resize the model + child pty to (c, r). Shared by LATER client resizes and the last-detach restore.
  // NO-OP when already at (c,r): a gratuitous resize SIGWINCHes the child → claude reflows its WHOLE
  // transcript, and when that reflow is taller than the viewport the overflow scrolls into the model's
  // scrollback as a DUPLICATE copy (the scrollback-pollution root). One real resize = one SIGWINCH; the
  // old (r-1)→r "nudge" doubled every SIGWINCH and is removed for the same reason.
  const applyGeometry = (c: number, r: number): void => {
    if (c === cols && r === rows) return // unchanged → no SIGWINCH → no reflow → no scrollback pollution
    cols = c
    rows = r
    try {
      xterm.resize(c, r)
      child.terminal.resize(c, r)
    } catch {
      /* transient */
    }
    writeGeometry(runDir, session, c, r) // record current child geometry → sidecar for warm-deliver / ready-gate readers
  }
  // FIRST attach for a client. Order (codex review) for a clean, coloured, correctly-sized snapshot:
  //   1. DRAIN to stability — pending child bytes were generated under the OLD geometry; parse them BEFORE a
  //      model resize (else they rewrap wrong), and capture bytes that land while the client is gated.
  //   2. MODEL resize to the client geometry IF it differs — serialize() round-trips only at matching dims
  //      (xterm.js #3093), so the model must be the client's size before we serialize.
  //   3. SNAPSHOT — serialize + send + lift gate, SYNCHRONOUS (no await), so no live byte interleaves.
  //   4. CHILD resize IF it differs — an honest one-SIGWINCH window-resize (like native). NOT a nudge, NOT a
  //      forced repaint: serialize already recreated screen+cursor, so claude's live bytes continue from the
  //      matching grid. A same-size reattach touches the child ZERO times → pure snapshot, no re-render.
  const firstAttach = async (s: { write(b: Buffer): number }, c: number, r: number): Promise<void> => {
    await awaitModelParsedStable()
    const changed = c !== cols || r !== rows
    if (changed) {
      try {
        xterm.resize(c, r) // MODEL only (for the serialize round-trip) — child resized below, after the snapshot
      } catch {
        /* transient */
      }
      cols = c
      rows = r
    }
    sendSnapshot(s) // serialize the model → send → lift gate (synchronous, no interleave)
    if (changed) {
      try {
        child.terminal.resize(c, r) // honest one-SIGWINCH resize (post-snapshot, forwarded live), like native
      } catch {
        /* transient */
      }
      writeGeometry(runDir, session, c, r) // record the new current child geometry for the warm-deliver readers
    }
  }
  // DETACH = NO RESIZE (emulator invariant). A detached hosted TUI keeps its LAST client geometry — it is
  // NEVER shrunk back to serve. The old FINDING-2 revert shrank the child into a tiny viewport, making claude
  // reflow its live region and scroll DUPLICATE copies into scrollback — the root of the reattach-dup bug.
  // tmux/screen likewise never collapse a detached session's size. Warm-deliver / ready-gate readers follow
  // the actual geometry via the `<session>.geometry.json` sidecar instead of assuming serve. Kept as a no-op
  // (callers in the close/drain/error handlers stay unchanged).
  const restoreServeGeometryIfIdle = (): void => {
    /* intentional no-op: detach must NOT resize the child — see comment above */
  }

  const onClientFrame = (s: { write(b: Buffer): number }, type: number, payload: Buffer): void => {
    if (type === FRAME_DATA) {
      child.terminal.write(payload) // keystrokes → child
    } else if (type === FRAME_RESIZE) {
      const sz = parseSize(payload)
      if (!painted.has(s as object)) {
        painted.add(s as object)
        syncAttached() // В23 — this client is now INTERACTIVE (it resized) → the .attached marker reflects it
        void firstAttach(s, sz.cols, sz.rows) // split-resize: model → snapshot → gate-lift → child (clean frame0)
      } else {
        applyGeometry(sz.cols, sz.rows) // LATER resize: one real resize, no re-snapshot
      }
    }
  }

  try {
    if (existsSync(sock)) unlinkSync(sock)
  } catch {
    /* */
  }
  const server = Bun.listen({
    unix: sock,
    socket: {
      open(s: { write(b: Buffer): number }) {
        framers.set(s as object, makeFramer((t, p) => onClientFrame(s, t, p)))
        clients.add(s)
        initializing.add(s as object) // hold live-forward until this client's snapshot is sent (race guard)
        syncAttached() // ≥1 client now attached → marker present
        // NO repaint here. A viewer's runClient sends its real terminal size as the FIRST FRAME_RESIZE on
        // connect (client.ts open → "repaint at our size"); we paint THEN, ONCE, at the correct geometry.
        // Painting here at the serve geometry (e.g. 220×50) would send a second, wrong-width dump that
        // STACKS in a terminal ignoring \x1b[3J (Apple Terminal) → smeared scroll-up history (Bug B). A
        // deliver client (deliverToHost) never resizes and ignores output → it gets no wasted paint.
      },
      data(s: object, d: Uint8Array) {
        framers.get(s)?.(d)
      },
      drain(s: object) {
        if (!writers.get(s)?.flush()) { clients.delete(s); painted.delete(s); syncAttached() } // writable again → flush queued tail
      },
      close(s: object) {
        clients.delete(s)
        painted.delete(s)
        writers.delete(s)
        syncAttached()
        restoreServeGeometryIfIdle() // last client gone → un-stick the pty from its size
      },
      error(s: object) {
        clients.delete(s)
        painted.delete(s)
        writers.delete(s)
        syncAttached()
        restoreServeGeometryIfIdle()
      },
    },
  })
  writeFileSync(pid, String(process.pid))
  writeGeometry(runDir, session, serveCols, serveRows) // initial geometry sidecar (= serve); updated on every real child resize

  let down = false
  function shutdown(): void {
    if (down) return
    down = true
    if (paneLogFd >= 0)
      try {
        closeSync(paneLogFd)
      } catch {
        /* */
      }
    try {
      child.kill('SIGKILL')
    } catch {
      /* */
    }
    try {
      server.stop(true)
    } catch {
      /* */
    }
    for (const f of [sock, pid, servePath(runDir, session), attachedMarker, geometryPath(runDir, session)]) {
      try {
        unlinkSync(f)
      } catch {
        /* */
      }
    }
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGHUP', () => {
    /* daemon survives client window close */
  })
  process.on('uncaughtException', e => {
    try {
      console.error('[supervisor-daemon] uncaught', (e && (e as Error).stack) || e)
    } catch {
      /* */
    }
  })

  // ── boot-dialog driver (serving slice a) ────────────────────────────────────────
  // For a real runtime, answer the startup dialogs (codex trust/update/hooks, claude trust/resume)
  // off the AUTHORITATIVE @xterm model so the session reaches a ready input surface UNDER the
  // supervisor — exactly what the launch primitive does over `tmux capture-pane` (read) + `send-keys`
  // (write), but model-read (modelToPlainText) + raw pty-byte-write (keysToBytes). The cursor-key
  // byte follows the model's live DECCKM mode (xterm.modes.applicationCursorKeysMode) — tmux keys off
  // the same mode, so hooks-review/resume-picker Downs are byte-identical. DARK: the supervisor
  // serves nothing on the live fleet; this drives only throwaway sessions until the serving flip.
  const bootAdapter = BOOT_ADAPTERS[runtime]
  if (bootAdapter) {
    const driveDeadline = Date.now() + BOOT_DRIVE_MS
    const driver = setInterval(() => {
      if (down) {
        clearInterval(driver)
        return
      }
      let action
      try {
        const enc = { appCursorKeys: xterm.modes.applicationCursorKeysMode }
        action = nextBootAction(bootAdapter, modelToPlainText(xterm, cols, rows), enc)
      } catch {
        return // transient model read — retry next tick
      }
      // В21 — check the deadline FIRST, independent of the action. Previously the clearInterval only
      // fired in the `else` branch, so a boot-dialog predicate that kept returning 'dialog' (a resume-
      // picker whose layout changed after a claude update, a screen matching the dialog pattern) drove
      // keystrokes into the pty EVERY tick for the whole session — the BOOT_DRIVE_MS backstop was dead.
      if (Date.now() > driveDeadline) {
        clearInterval(driver)
        return
      }
      if (action.kind === 'dialog') child.terminal.write(action.bytes)
      else if (action.kind === 'ready') clearInterval(driver)
    }, BOOT_POLL_MS)
    ;(driver as { unref?: () => void }).unref?.()
  }

  // ── mid-session nag-watcher (livability) ────────────────────────────────────────
  // The boot-driver above STOPS at ready. But claude/codex can pop a ONE-TIME upsell modal
  // MID-SESSION (e.g. "Try the new fullscreen renderer?", which appears on the return-to-prompt
  // boundary after a tool result) that BLOCKS the pty on a keypress no headless peer answers — it
  // froze live fleet peers (boris, doc) until a human cleared it by hand. A PERSISTENT watcher answers
  // the curated, verified-safe DECLINE for that class off the SAME authoritative @xterm model, for the
  // WHOLE session lifetime, exactly like the boot-driver answers startup dialogs — model-read
  // (modelToPlainText) + raw pty-byte-write (keysToBytes). Cooldown-guarded: after firing, hold
  // NAG_COOLDOWN_MS so a just-dismissed modal is never double-answered (a stray keystroke would land in
  // the now-visible composer). Only runs for a runtime whose adapter declares nagDismissKeys.
  const nagAdapter = BOOT_ADAPTERS[runtime] as NagPredicate | undefined
  if (nagAdapter?.nagDismissKeys) {
    let nagFiredMs = 0
    const nagWatch = setInterval(() => {
      if (down) {
        clearInterval(nagWatch)
        return
      }
      if (Date.now() - nagFiredMs < NAG_COOLDOWN_MS) return // let a just-answered modal repaint away first
      let action
      try {
        const enc = { appCursorKeys: xterm.modes.applicationCursorKeysMode }
        action = nextNagAction(nagAdapter, modelToPlainText(xterm, cols, rows), enc)
      } catch {
        return // transient model read — retry next tick
      }
      if (action.kind === 'dismiss') {
        child.terminal.write(action.bytes)
        nagFiredMs = Date.now()
      }
    }, NAG_POLL_MS)
    ;(nagWatch as { unref?: () => void }).unref?.()
  }
}
