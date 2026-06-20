// list TUI — the interactive control-panel form of `iapeer list` (contract Примитивы
// §list TUI): a peer overview with per-runtime liveness, ↑/↓ navigation, `/` filter,
// `q` quit, and ENTER = attach to the selected peer. Scriptable `list` (non-tty /
// --json) stays the table in cli/index.ts; this is the tty form.
//
// The RENDER and the KEY state-machine are PURE (unit-testable); only runListTui does
// raw-mode terminal I/O, and on ENTER it hands off to attachPeer + tmux attach — the
// same ensure-live+resume path the `attach` verb uses (so a live session is never torn).

import { attachPeer } from '../lifecycle/index.ts'
import { hostRunDir } from '../launch/ptyHost.ts' // pty-only: attach via the supervisor client
import { runSupervisorClient } from '../supervisor/client.ts'
import { listPeers, type PeerListing } from './index.ts'

const GLYPH: Record<'live' | 'asleep' | 'stopped', string> = { live: '●', asleep: '○', stopped: '✕' }

// ─── pure render ─────────────────────────────────────────────────────────────

/** Rows that match the filter (case-insensitive substring over personality/description). */
export function filterRows(rows: PeerListing[], filter: string): PeerListing[] {
  const f = filter.trim().toLowerCase()
  if (!f) return rows
  return rows.filter(r => r.personality.toLowerCase().includes(f) || r.description.toLowerCase().includes(f))
}

export interface TuiState {
  cursor: number
  filter: string
  filterMode: boolean
}

/** Render the panel frame (ANSI). `cursor` is an index into the FILTERED rows. */
export function renderListPanel(rows: PeerListing[], state: TuiState): string {
  const visible = filterRows(rows, state.filter)
  const lines: string[] = []
  lines.push('\x1b[2J\x1b[H') // clear + home
  lines.push('  iapeer peers  —  ↑/↓ navigate · Enter attach · / filter · q quit')
  lines.push('')
  if (visible.length === 0) {
    lines.push('  (no peers match)')
  }
  visible.forEach((r, i) => {
    const status = r.runtimes.map(s => `${GLYPH[s.status]} ${s.runtime}`).join('  ')
    const la = r.last_active_runtime ? `  ⤳${r.last_active_runtime}` : ''
    const row = `${r.personality.padEnd(16)} ${r.default_runtime.padEnd(9)} ${r.intelligence.padEnd(11)} ${status}${la}`
    // selected row → reverse video + ❯ caret
    lines.push(i === state.cursor ? `\x1b[7m❯ ${row}\x1b[0m` : `  ${row}`)
  })
  lines.push('')
  lines.push(state.filterMode ? `  /filter: ${state.filter}_` : state.filter ? `  filter: ${state.filter}` : '')
  return lines.join('\r\n') + '\r\n'
}

// ─── pure key state-machine ──────────────────────────────────────────────────

export type TuiAction =
  | { type: 'none' }
  | { type: 'redraw' }
  | { type: 'attach'; personality: string }
  | { type: 'quit' }

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ENTER1 = '\r'
const ENTER2 = '\n'
const ESC = '\x1b'
const CTRL_C = '\x03'
const BACKSPACE = /^[\x7f\b]$/

/**
 * Advance the TUI state for a key. Pure: returns the next state + an action the loop
 * performs (attach/quit/redraw). `visible` is the filtered row set (for bounds + the
 * Enter target). In filter-mode, printable keys edit the filter; Enter/Esc leave it.
 */
export function handleListKey(key: string, state: TuiState, visible: PeerListing[]): { state: TuiState; action: TuiAction } {
  if (state.filterMode) {
    if (key === ENTER1 || key === ENTER2 || key === ESC) {
      return { state: { ...state, filterMode: false, cursor: 0 }, action: { type: 'redraw' } }
    }
    if (BACKSPACE.test(key)) {
      return { state: { ...state, filter: state.filter.slice(0, -1), cursor: 0 }, action: { type: 'redraw' } }
    }
    if (key >= ' ' && key.length === 1) {
      return { state: { ...state, filter: state.filter + key, cursor: 0 }, action: { type: 'redraw' } }
    }
    return { state, action: { type: 'none' } }
  }
  if (key === 'q' || key === CTRL_C) return { state, action: { type: 'quit' } }
  if (key === '/') return { state: { ...state, filterMode: true }, action: { type: 'redraw' } }
  if (key === UP) return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, action: { type: 'redraw' } }
  if (key === DOWN) {
    return { state: { ...state, cursor: Math.min(Math.max(0, visible.length - 1), state.cursor + 1) }, action: { type: 'redraw' } }
  }
  if (key === ENTER1 || key === ENTER2) {
    const target = visible[state.cursor]
    return target ? { state, action: { type: 'attach', personality: target.personality } } : { state, action: { type: 'none' } }
  }
  return { state, action: { type: 'none' } }
}

// ─── raw-mode loop (the only impure part) ────────────────────────────────────

/**
 * Run the interactive list panel. Reads the registry once (read-only), renders, and
 * loops on raw-mode key input. ENTER → attachPeer the selected peer (ensure-live +
 * resume, last-active runtime), then exec `tmux attach` (TMUX unset, no nested error);
 * the panel exits raw mode first so the operator drops cleanly into the session. `q` /
 * Ctrl-C quit. Returns the process exit code.
 */
export async function runListTui(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const rows = listPeers({ env })
  let state: TuiState = { cursor: 0, filter: '', filterMode: false }
  const stdin = process.stdin
  const stdout = process.stdout
  if (!stdin.isTTY) {
    stdout.write('list TUI requires a terminal (use `iapeer list --json` for scripts)\n')
    return 2
  }
  const draw = () => stdout.write(renderListPanel(rows, state))
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  draw()
  try {
    for (;;) {
      const key = await nextKey(stdin)
      const { state: next, action } = handleListKey(key, state, filterRows(rows, state.filter))
      state = next
      if (action.type === 'quit') return 0
      if (action.type === 'redraw') draw()
      if (action.type === 'attach') {
        // leave raw mode and the panel before handing the terminal to tmux attach
        stdin.setRawMode(false)
        stdin.pause()
        stdout.write('\x1b[2J\x1b[H')
        const r = await attachPeer({ personality: action.personality, env })
        if (!r.ok) {
          stdout.write(`attach: ${r.reason}\n`)
          return 1
        }
        stdout.write(`${r.woke ? 'woke + ' : ''}attaching ${r.identity}…\n`)
        // pty-only: attach via the supervisor client (no tmux).
        await runSupervisorClient(hostRunDir(), r.identity)
        return 0 // unreachable — runSupervisorClient exits on detach / session end
      }
    }
  } finally {
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
  }
}

/** Resolve the next raw-mode keypress (one chunk = one key / escape sequence). */
function nextKey(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise(resolve => {
    const onData = (chunk: string) => {
      stdin.off('data', onData)
      resolve(chunk)
    }
    stdin.on('data', onData)
  })
}
