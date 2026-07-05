// tray/render — PURE SwiftBar-format renderer for the fleet snapshot. No IO, fully
// deterministic (a fixed snapshot + `now` → a fixed string), so it is unit-tested
// directly. It consumes a snapshot modelled by its OWN local interfaces (the docs/15
// shape) and ignores every field it does not name — client obligation 2 (additive
// evolution: a new snapshot field must never break an old client). This module is the
// second consumer of docs/15 after fleet.ts wrote it — the contract dogfood.
//
// SwiftBar output grammar (see docs/16-tray.md): lines before the first `---` are the
// menu-bar title; lines after are the dropdown. Item params follow ` | key=value`.
// Submenu depth is a `--` prefix per level. Click actions: `bash=<bin> paramN=…
// terminal=<bool>` runs the binary (terminal=true opens Terminal.app — that is how a
// peer row hands off to `iapeer attach`, the terminal-handoff the API deliberately
// keeps client-side).

const GLYPH: Record<'live' | 'asleep' | 'stopped', string> = { live: '●', asleep: '○', stopped: '✕' }

const COLOR = {
  meta: '#8b949e',
  live: '#3fb950',
  down: '#f85149',
} as const

// ── docs/15 snapshot shape (only the fields the tray reads) ───────────────────

export interface TrayRuntime {
  runtime: string
  status: 'live' | 'asleep' | 'stopped'
  attached?: boolean
}

export interface TrayPeer {
  personality: string
  intelligence?: string
  runtimes: TrayRuntime[]
  last_active_runtime?: string
  last_active_ms?: number
  attached?: boolean
  launchd_managed?: boolean
  wake_policy?: 'warm' | 'ephemeral'
  queue_depth?: number
}

export interface TraySnapshot {
  version?: string
  host?: {
    version?: string
    uptimeSecs?: number
    memory?: { provider: string; version: string; heartbeatAgeSecs: number | null } | null
    voice?: { provider: string; version: string; heartbeatAgeSecs: number | null } | null
    fda?: boolean | null
  }
  peers: TrayPeer[]
}

export interface RenderOptions {
  /** Absolute path to the installed `iapeer` binary (embedded into click actions). */
  binPath: string
  /** Clock for age rendering (injectable for tests). */
  now?: number
}

// ── param serialization ───────────────────────────────────────────────────────

/** Serialize SwiftBar item params. Simple tokens stay bare; anything else is
 *  double-quoted with embedded quotes escaped (SwiftBar accepts quoted values). */
function params(pairs: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(pairs)) {
    if (v === undefined) continue
    const s = String(v)
    const val = /^[\w.#/@-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`
    parts.push(`${k}=${val}`)
  }
  return parts.length ? ` | ${parts.join(' ')}` : ''
}

/** One dropdown line at submenu `depth` (0 = top level). */
function line(depth: number, text: string, p: Record<string, string | number | boolean | undefined> = {}): string {
  return `${'--'.repeat(depth)}${text}${params(p)}`
}

/** A menu separator at submenu `depth`: the `--`×depth prefix + `---` (SwiftBar: a
 *  top-level separator is `---`, a depth-1 one is `-----`, etc.). */
function separator(depth: number): string {
  return `${'--'.repeat(depth)}---`
}

// ── time helpers ────────────────────────────────────────────────────────────────

export function fmtUptime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '?'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${Math.floor(secs)}s`
}

export function fmtAge(ms: number, now: number): string {
  const secs = Math.floor((now - ms) / 1000)
  if (!Number.isFinite(secs)) return ''
  if (secs < 45) return 'now'
  const m = Math.floor(secs / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── peer status aggregation ─────────────────────────────────────────────────────

function aggregate(p: TrayPeer): 'live' | 'asleep' | 'stopped' {
  if (p.runtimes.some(r => r.status === 'live')) return 'live'
  if (p.runtimes.some(r => r.status === 'asleep')) return 'asleep'
  return 'stopped'
}

const RANK: Record<'live' | 'asleep' | 'stopped', number> = { live: 0, asleep: 1, stopped: 2 }

// ── renderers ─────────────────────────────────────────────────────────────────

const MANAGE_COMMANDS: Array<{ cmd: string; label: string }> = [
  { cmd: 'wake', label: 'Wake' },
  { cmd: 'stop', label: 'Stop' },
  { cmd: 'start', label: 'Start' },
  { cmd: 'new', label: 'New session (fresh)' },
  { cmd: 'interrupt', label: 'Interrupt' },
  { cmd: 'refresh', label: 'Refresh (soft-reload)' },
  { cmd: 'compact', label: 'Compact dialogue' },
]

/** The full SwiftBar plugin output for a reachable daemon. */
export function renderSwiftBar(snapshot: TraySnapshot, opts: RenderOptions): string {
  const now = opts.now ?? Date.now()
  const bin = opts.binPath
  const peers = [...snapshot.peers].sort((a, b) => {
    const r = RANK[aggregate(a)] - RANK[aggregate(b)]
    return r !== 0 ? r : a.personality.localeCompare(b.personality)
  })
  const liveCount = snapshot.peers.filter(p => aggregate(p) === 'live').length

  const lines: string[] = []
  // ── menu-bar title: antenna icon + live-peer count ──
  lines.push(line(0, String(liveCount), { sfimage: 'antenna.radiowaves.left.and.right' }))
  lines.push('---')

  // ── host header ──
  const ver = snapshot.host?.version ?? snapshot.version ?? '?'
  const up = snapshot.host?.uptimeSecs !== undefined ? ` · up ${fmtUptime(snapshot.host.uptimeSecs)}` : ''
  lines.push(line(0, `iapeer ${ver}${up}`, { color: COLOR.meta }))
  const providers = renderProviders(snapshot.host)
  if (providers) lines.push(line(0, providers, { color: COLOR.meta }))
  lines.push('---')

  // ── peers ──
  if (peers.length === 0) {
    lines.push(line(0, 'no peers registered', { color: COLOR.meta }))
  }
  for (const p of peers) {
    lines.push(...renderPeerRow(p, bin, now))
  }

  // ── footer ──
  lines.push('---')
  lines.push(line(0, 'Refresh', { refresh: true, sfimage: 'arrow.clockwise' }))
  lines.push(line(0, `iapeer · fleet dashboard`, { color: COLOR.meta, size: 11 }))
  return lines.join('\n') + '\n'
}

function renderProviders(host: TraySnapshot['host']): string {
  if (!host) return ''
  const seg: string[] = []
  const one = (label: string, slot: { version: string; heartbeatAgeSecs: number | null } | null | undefined): void => {
    if (!slot) return
    // fresh heartbeat (< 90s) → ●, declared-but-silent → ○
    const glyph = slot.heartbeatAgeSecs !== null && slot.heartbeatAgeSecs < 90 ? '●' : '○'
    seg.push(`${label} ${glyph} ${slot.version}`)
  }
  one('mem', host.memory)
  one('voice', host.voice)
  if (host.fda === false) seg.push('⚠ no full-disk-access')
  return seg.join(' · ')
}

function renderPeerRow(p: TrayPeer, bin: string, now: number): string[] {
  const agg = aggregate(p)
  const detail = p.runtimes.map(r => `${r.runtime}${GLYPH[r.status]}`).join(' ')
  const badges =
    (p.attached ? ' 👤' : '') +
    (p.launchd_managed ? ' 🔒' : '') +
    (p.wake_policy === 'ephemeral' && (p.queue_depth ?? 0) > 0 ? ` ⏳${p.queue_depth}` : '')
  const ageStr = p.last_active_ms ? `  ${fmtAge(p.last_active_ms, now)}` : ''
  const label = `${p.personality}  ${detail}${badges}${ageStr}`
  const rowColor = agg === 'live' ? COLOR.live : COLOR.meta

  const out: string[] = []
  // The peer row IS the attach action: click → Terminal.app running `iapeer attach
  // <peer>` (attach resolves its own runtime — default-anchored last-active, same as
  // the CLI). terminal=true is the terminal-handoff docs/15 keeps client-side.
  out.push(
    line(0, label, {
      color: rowColor,
      bash: bin,
      param1: 'attach',
      param2: p.personality,
      terminal: true,
    }),
  )
  // Lifecycle controls live in a submenu (they route through the fleet command
  // endpoints via `iapeer tray cmd …` — dogfooding POST /fleet/v1/peers/<p>/<cmd>).
  out.push(line(1, 'Attach…', { bash: bin, param1: 'attach', param2: p.personality, terminal: true, sfimage: 'terminal' }))
  out.push(separator(1))
  for (const c of MANAGE_COMMANDS) {
    out.push(
      line(1, c.label, {
        bash: bin,
        param1: 'tray',
        param2: 'cmd',
        param3: c.cmd,
        param4: p.personality,
        terminal: false,
        refresh: true,
      }),
    )
  }
  return out
}

/** The degraded output when no advertised daemon address answers (docs/15: "A
 *  dashboard that cannot reach any advertised address should render the daemon as
 *  down"). Distinct menu-bar icon + a red header; a Refresh item to retry. */
export function renderDaemonDown(reason: string, opts: RenderOptions): string {
  const lines: string[] = []
  lines.push(line(0, '', { sfimage: 'exclamationmark.triangle.fill', color: COLOR.down }))
  lines.push('---')
  lines.push(line(0, 'iapeer daemon unreachable', { color: COLOR.down }))
  lines.push(line(0, reason, { color: COLOR.meta }))
  lines.push('---')
  lines.push(line(0, 'Refresh', { refresh: true, sfimage: 'arrow.clockwise' }))
  return lines.join('\n') + '\n'
}
