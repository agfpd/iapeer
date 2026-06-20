// Leaf render helper: @xterm model → plain text + composer-occupancy verdict. A shared LIVE leaf used
// by the Ф1 ready-gate flip (launch/readyGateModel) and the supervisor pane model. Type-only @xterm
// import → no runtime dependency beyond the Terminal instance the caller already holds; hermetically
// testable. (Formerly src/shadow/render.ts — kept after the tmux→pty cutover retired the shadow
// burn-in observer; only the observer modules were removed, this leaf survives.)
import type { Terminal } from '@xterm/headless'

/**
 * The model's VISIBLE viewport (baseY..baseY+rows) as PLAIN text — mimics `tmux capture-pane -p`,
 * the surface the runtime adapters' pane predicates (isInputReady / bootDialogKeys) take. Trailing
 * whitespace per line is trimmed (capture-pane does the same), cells coalesced left-to-right.
 *
 * 0-divergence-validated vs capture-pane on READY screens by the ready-gate burn-in; the supervisor
 * boot-driver additionally validated it on BOOT-DIALOG screens (a different screen state the
 * ready-gate observation never saw).
 */
export function modelToPlainText(term: Terminal, cols: number, rows: number): string {
  const b = term.buffer.active,
    lines: string[] = []
  for (let y = b.baseY; y < b.baseY + rows; y++) {
    const l = b.getLine(y)
    if (!l) {
      lines.push('')
      continue
    }
    let s = ''
    for (let x = 0; x < cols; x++) s += l.getCell(x)?.getChars() || ' '
    lines.push(s.replace(/\s+$/, ''))
  }
  return lines.join('\n')
}

// NOTE: the attach catch-up SNAPSHOT is built in the supervisor daemon via SerializeAddon.serialize()
// (scrollback + screen + cursor + SGR colour + private modes, all at once), NOT from this leaf. Earlier
// plain-text attempts here (modelAttachSnapshotRows / terminalModesPrefix) were removed: translateToString
// is text-only (→ monochrome) and a hand-rolled rows dump can't reproduce the grid+cursor the way the
// emulate-then-rerender multiplexers (tmux/zellij) do. See the daemon's sendSnapshot.

const promptGlyph = (rt: string): string => (rt === 'claude' ? '❯' : '›')

/**
 * PTY composer-occupancy verdict: getCell on the model's viewport composer row (the row whose first
 * visible cell is the prompt glyph); human input = a non-ghost (non-dim, non-grey246) visible cell
 * after it. Mirrors the prior tmux capture-pane occupancy check (validated 0-divergence vs it by the
 * burn-in). Lives in this leaf (type-only @xterm) so the warm-deliver hosted occupancy guard can reuse
 * it WITHOUT pulling an @xterm-loading graph into the warm-deliver path; the Terminal instance is built
 * by the caller (paneLogComposerOccupied dynamic-imports @xterm).
 */
export function composerOccupancyFromModel(term: Terminal, cols: number, rows: number, runtime: string): boolean {
  const b = term.buffer.active, top = b.baseY, bot = b.baseY + rows, g = promptGlyph(runtime)
  let py = -1, px = -1
  for (let y = top; y < bot; y++) {
    const l = b.getLine(y); if (!l) continue
    let fx = -1
    for (let x = 0; x < cols; x++) { if ((l.getCell(x)?.getChars() || ' ').trim() !== '') { fx = x; break } }
    if (fx < 0) continue
    if (l.getCell(fx)!.getChars() === g) { py = y; px = fx }
  }
  if (py < 0) return false
  const l = b.getLine(py)!
  for (let x = px + 1; x < cols; x++) {
    const c = l.getCell(x); if ((c?.getChars() || ' ').trim() === '') continue
    // OCCUPIED iff a real human glyph after the prompt: DEFAULT foreground AND non-dim. Verified on BOTH
    // runtimes — typed input renders at the terminal default fg (isFgDefault, fg=-1) and non-dim. Everything
    // else after the prompt is runtime chrome / ghost and must be ignored: claude's dim/palette-246
    // placeholder; codex's DIM default-fg suggestion ("Find and fix a bug in @filename", varies) AND its
    // TRUECOLOR status hint ("<model> <effort> · <cwd>"). The old check (`!dim && !palette-246`) ghosted the
    // dim suggestion but MISSED codex's truecolor status (non-dim, non-palette) → false OCCUPIED → spurious
    // delivery queue ("queuedBy: composer") whenever a human was attached to a codex session.
    if (!c!.isDim() && c!.isFgDefault()) return true
  }
  return false
}
