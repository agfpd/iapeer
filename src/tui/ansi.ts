// ANSI palette for plain-text CLI output that runs OUTSIDE Ink — chiefly the
// post-Ink onboard summary (run.tsx), which prints after the wizard unmounts and
// would otherwise read as a flat, colorless tail to a styled flow.
//
// It mirrors the Ink wizard's palette one-for-one (see app.tsx color()/glyph()):
//   ok → green ✓ · warn → yellow ! · fail → red ✗ · pending → gray · ·
//   headers → bold (cyan for emphasis) · secondary detail/paths → dim
// so the seam between the React-rendered part and the printed part is invisible.
//
// Color is GATED (colorEnabled): on by default only on a real TTY, force-on with
// FORCE_COLOR (covers inherited-pipe passthrough by a child process), and hard-off
// with NO_COLOR (https://no-color.org — presence disables, any value) so piped /
// redirected / CI captures stay byte-clean. This is the team-wide convention we
// hand to peer providers (e.g. iapeer-memory) whose stdout we surface verbatim.

const ESC = '\x1b['
const RESET = `${ESC}0m`

const CODE = {
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  cyan: '36',
  gray: '90',
} as const

export type AnsiPaint = (s: string) => string

export interface Ansi {
  bold: AnsiPaint
  dim: AnsiPaint
  red: AnsiPaint
  green: AnsiPaint
  yellow: AnsiPaint
  cyan: AnsiPaint
  gray: AnsiPaint
}

/** Whether to emit ANSI color for `stream`. NO_COLOR (any value) hard-disables;
 *  FORCE_COLOR (truthy, not "0"/"false") forces on; otherwise gated on a real TTY. */
export function colorEnabled(
  env: NodeJS.ProcessEnv = process.env,
  stream: { isTTY?: boolean } = process.stdout,
): boolean {
  if (env.NO_COLOR != null) return false
  const fc = env.FORCE_COLOR
  if (fc != null && fc !== '0' && fc !== 'false' && fc !== '') return true
  return stream.isTTY === true
}

/** Build a palette. When `enabled` is false every paint fn is identity (no codes),
 *  so the same call sites produce clean text for pipes/CI. Codes compose: an inner
 *  paint applies before the outer, both before the run resets — `a.bold(a.cyan(s))`
 *  renders bold+cyan. */
export function makeAnsi(enabled: boolean): Ansi {
  const wrap =
    (code: string): AnsiPaint =>
    (s: string) =>
      enabled ? `${ESC}${code}m${s}${RESET}` : s
  return {
    bold: wrap(CODE.bold),
    dim: wrap(CODE.dim),
    red: wrap(CODE.red),
    green: wrap(CODE.green),
    yellow: wrap(CODE.yellow),
    cyan: wrap(CODE.cyan),
    gray: wrap(CODE.gray),
  }
}
