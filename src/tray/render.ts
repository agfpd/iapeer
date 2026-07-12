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
  warn: '#d29922',
} as const

// Approval content shown INLINE in the menu is capped (a big diff must not blow up the
// dropdown); the FULL verbatim content stays available via `iapeer approvals` + GET
// /fleet/v1/approvals/<id> (criterion #7 holds on the payload, the menu is its truncated view).
const APPROVAL_CONTENT_MAX_LINES = 20
const APPROVAL_CONTENT_MAX_CHARS = 8000

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
  /** Human-approval mode (docs/17). ABSENT ⇒ `yolo` (client obligation — a pre-approval daemon omits it). */
  approval_mode?: 'yolo' | 'gated'
  wake_policy?: 'warm' | 'ephemeral'
  queue_depth?: number
}

export interface TrayApproval {
  id: string
  personality: string
  runtime?: string
  kind?: string
  tool: string
  summary?: string
  content?: string
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
  /** Pending human-approval requests (docs/15/17). ABSENT ⇒ empty queue (client obligation). */
  approvals?: TrayApproval[]
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

/** Local wall-clock `HH:MM:SS` for the footer freshness stamp. */
export function fmtClock(now: number): string {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ── peer status aggregation ─────────────────────────────────────────────────────

function aggregate(p: TrayPeer): 'live' | 'asleep' | 'stopped' {
  if (p.runtimes.some(r => r.status === 'live')) return 'live'
  if (p.runtimes.some(r => r.status === 'asleep')) return 'asleep'
  return 'stopped'
}

const RANK: Record<'live' | 'asleep' | 'stopped', number> = { live: 0, asleep: 1, stopped: 2 }

// 🔒 launchd-managed peers (the human channel + service infra — arthur/timer/watcher) are
// NON-clickable status rows. They form ONE contiguous block at the very TOP, before the first
// working agent, regardless of live/asleep — so the bar separates "service, don't touch" from the
// working agents at a glance (owner UX). `attachable` (= !launchd_managed) is the same predicate.
const lockRank = (p: TrayPeer): number => (p.launchd_managed ? 0 : 1)

// ── renderers ─────────────────────────────────────────────────────────────────

const MANAGE_COMMANDS: Array<{ cmd: string; label: string }> = [
  // NB: no 'Wake' — a peer-row click (attach) already wakes a sleeping peer before it
  // connects, so a separate Wake item was redundant (owner decision). `tray cmd wake`
  // stays available on the CLI / fleet API; only the menu item is dropped.
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
    // primary: the 🔒 lock block first (service/human infra), working agents below
    const l = lockRank(a) - lockRank(b)
    if (l !== 0) return l
    // secondary (within EACH block): the existing live→asleep→stopped, then alpha
    const r = RANK[aggregate(a)] - RANK[aggregate(b)]
    return r !== 0 ? r : a.personality.localeCompare(b.personality)
  })
  const liveCount = snapshot.peers.filter(p => aggregate(p) === 'live').length
  const pending = snapshot.approvals ?? []
  const pendingByPeer = new Map<string, number>()
  for (const a of pending) pendingByPeer.set(a.personality, (pendingByPeer.get(a.personality) ?? 0) + 1)

  const lines: string[] = []
  // ── menu-bar title ──
  // Pending approvals TAKE OVER the menu-bar as a red iOS-style badge so the owner sees an awaiting
  // request at a glance; an empty queue is the normal antenna + live-peer count.
  if (pending.length > 0) {
    lines.push(renderBadge(pending.length))
  } else {
    lines.push(line(0, String(liveCount), { sfimage: 'antenna.radiowaves.left.and.right' }))
  }
  lines.push('---')

  // ── pending approvals (ALWAYS-ON: whenever the queue is non-empty, at the TOP of the dropdown;
  //    each request expanded with verbatim content + Allow/Deny at depth 0 — no extra clicks) ──
  if (pending.length > 0) {
    lines.push(...renderApprovals(pending, bin))
    lines.push('---')
  }

  // ── host header ──
  const ver = snapshot.host?.version ?? snapshot.version ?? '?'
  const up = snapshot.host?.uptimeSecs !== undefined ? ` · up ${fmtUptime(snapshot.host.uptimeSecs)}` : ''
  lines.push(line(0, `iapeer ${ver}${up}`, { color: COLOR.meta }))
  const providers = renderProviders(snapshot.host)
  if (providers) lines.push(line(0, providers, { color: COLOR.meta }))
  lines.push('---')

  // ── peers — each peer is a SUBMENU: expand → Attach (first) + its actions. ONE list
  //    (no separate Manage section): the peer rows and their lifecycle used to be two
  //    parallel lists of every peer (a click-attach list + a Manage list) — a visible
  //    dupe. Folded here (owner decision — 2 clicks to attach: expand peer → Attach). ──
  if (peers.length === 0) {
    lines.push(line(0, 'no peers registered', { color: COLOR.meta }))
  }
  for (const p of peers) {
    lines.push(...renderPeerSubmenu(p, bin, now, pendingByPeer.get(p.personality) ?? 0))
  }

  // ── footer ──
  // No explicit "Refresh" item: the plugin is streamable + SSE-driven, so the menu is
  // always current on open — a manual refresh gives the user nothing and (being a
  // SwiftBar refresh) just closes the dropdown. The emergency "restart the plugin" lever
  // lives in SwiftBar's own service menu (right-click → Refresh).
  //
  // The trailing clock is LOAD-BEARING, not cosmetic: it makes every rendered block
  // unique, so each streamable heartbeat emit DIFFERS from the previous one and
  // SwiftBar's content-change publisher fires every time. SwiftBar's _updateMenu()
  // starts with show() (NSStatusItem.isVisible = true) — that is the tray's self-heal:
  // a menu-bar icon hidden for ANY reason (SwiftBar's per-chunk UTF-8 decode nil
  // hiding the item, an accidental ⌘-drag removal, a stale persisted
  // `NSStatusItem VisibleCC` flag) comes back within one heartbeat (≤15 s) instead of
  // staying invisible until the fleet next changes. See docs/16-tray.md §icon-visibility.
  lines.push('---')
  lines.push(line(0, `iapeer · fleet dashboard · ${fmtClock(now)}`, { color: COLOR.meta, size: 11 }))
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

/** A peer is attachable when it is NOT launchd-managed: launchd-owned infra peers
 *  (telegram / notifier) have no attachable pty session, so their rows carry no attach
 *  action (a plain status line). Agent peers (claude / codex) are attachable. */
function attachable(p: TrayPeer): boolean {
  return !p.launchd_managed
}

/** The status label for a peer's submenu-parent row: `<peer>  <rt><glyph> … <badges> <age>`.
 *  Badges: 👤 attached · 🔒 launchd · 🛡 gated approval (docs/17; yolo=fleet default=no badge) ·
 *  ⏳N ephemeral queue. A pending approval prepends ⚠ + a 🔴N count so the owner sees WHICH peer
 *  waits (the Allow/Deny itself lives in the top approvals section, not here). */
function peerLabel(p: TrayPeer, now: number, pendingCount: number): string {
  const detail = p.runtimes.map(r => `${r.runtime}${GLYPH[r.status]}`).join(' ')
  const badges =
    (p.attached ? ' 👤' : '') +
    (p.launchd_managed ? ' 🔒' : '') +
    (p.approval_mode === 'gated' ? ' 🛡' : '') +
    (p.wake_policy === 'ephemeral' && (p.queue_depth ?? 0) > 0 ? ` ⏳${p.queue_depth}` : '')
  const ageStr = p.last_active_ms ? `  ${fmtAge(p.last_active_ms, now)}` : ''
  const prefix = pendingCount > 0 ? '⚠ ' : ''
  const pendingBadge = pendingCount > 0 ? ` 🔴${pendingCount}` : ''
  return `${prefix}${p.personality}  ${detail}${badges}${pendingBadge}${ageStr}`
}

/**
 * One peer as a SUBMENU (single unified list — no separate Manage). The parent row is the
 * status label (no direct action — clicking EXPANDS); the children are, in order:
 *   1. **Attach** (agentic peers only) — the terminal handoff, unchanged (0.4.67): `iapeer tray
 *      attach-term <peer>` in the BACKGROUND (terminal=false) opens a `.command` via `open`, needing
 *      NO Accessibility/Automation TCC (avoids SwiftBar's `terminal=true` Cmd-T keystroke). This is
 *      the ONE trade Arthur accepted: attach is now expand-then-Attach (2 clicks) for a dupe-free list.
 *   2. lifecycle commands (Stop/Start/New/Interrupt/Refresh/Compact) — `iapeer tray cmd <c> <peer>`.
 *   3. approval-mode toggle (agentic peers only — docs/17).
 *
 * Launchd-managed peers (arthur/timer/watcher, 🔒): NO Attach (no pty session) and NO approval toggle
 * (always yolo); they keep the lifecycle submenu (service Stop/Start etc — the SAME set the old Manage
 * already offered them, just relocated under the peer). Per-infra-type trimming (e.g. dropping
 * Interrupt/Compact for the human peer) is a separate call, out of scope for a de-dupe render change.
 */
function renderPeerSubmenu(p: TrayPeer, bin: string, now: number, pendingCount = 0): string[] {
  const rowColor = pendingCount > 0 ? COLOR.down : aggregate(p) === 'live' ? COLOR.live : COLOR.meta
  const out: string[] = [line(0, peerLabel(p, now, pendingCount), { color: rowColor })]
  // 1) Attach FIRST (agentic only — launchd infra/human peers have no pty session to attach)
  if (attachable(p)) {
    out.push(line(1, 'Attach', { bash: bin, param1: 'tray', param2: 'attach-term', param3: p.personality, terminal: false }))
  }
  // 2) lifecycle commands — each `iapeer tray cmd <c> <peer>` → POST /fleet/v1/peers/<peer>/<c>.
  //    No refresh=true: the SSE stream reflects the outcome (streamable is always fresh).
  for (const c of MANAGE_COMMANDS) {
    out.push(line(1, c.label, { bash: bin, param1: 'tray', param2: 'cmd', param3: c.cmd, param4: p.personality, terminal: false }))
  }
  // 3) approval-mode toggle (agentic only)
  if (attachable(p)) out.push(...renderApprovalToggle(p, bin, 1))
  return out
}

/**
 * The per-peer approval-mode control in the Manage submenu (docs/17): READS the current
 * mode and FLIPS it via the local `approval-mode` verb.
 *
 * APPLY = next session, NOT now. The flip persists the mode + brings the runtime
 * surfaces to it; it does NOT pass --now, so it takes effect on the peer's NEXT fresh
 * session. A menu tap must never kill a live session mid-work (a respawn is a heavy,
 * surprising side effect of a click). The item says "(next session)" so the wait is
 * explicit.
 *
 * refresh=true is the ONE deliberate exception to the "no refresh in the streamable
 * menu" rule: the flip runs the local verb (no daemon round-trip → NO SSE event), so
 * the plugin must re-render to reflect the new mode.
 *
 * SECURITY-ASYMMETRIC friction (a mode-flip changes the security PERIMETER — unlike a
 * one-off Deny): yolo→gated STRENGTHENS (adds human approval) → a single safe tap;
 * gated→yolo WEAKENS (REMOVES human approval) → the current mode sits on a submenu and
 * the flip is an explicit red ⚠ confirm CHILD, so the perimeter is never dropped by one
 * stray click. SwiftBar has no native confirm dialog — the nested explicit item IS the
 * confirm.
 */
function renderApprovalToggle(p: TrayPeer, bin: string, depth: number): string[] {
  const flip = (target: 'gated' | 'yolo'): Record<string, string | boolean> => ({
    bash: bin,
    param1: 'approval-mode',
    param2: p.personality,
    param3: target,
    terminal: false,
    refresh: true, // local verb → no SSE event → re-render to show the new mode
  })
  if (p.approval_mode === 'gated') {
    // WEAKEN — current on the parent (no action); the flip is an explicit red confirm child.
    return [
      line(depth, 'Approval: gated 🛡', { color: COLOR.warn }),
      line(depth + 1, '⚠ Switch to yolo — removes human approval (next session)', { color: COLOR.down, ...flip('yolo') }),
    ]
  }
  // STRENGTHEN (yolo → gated) — safe, one tap.
  return [line(depth, 'Approval: yolo → gated 🛡 (next session)', flip('gated'))]
}

// ── approval renderers (docs/17 — the always-on approval channel in the bar) ─────

/** Menu-bar pending badge: a red `N.circle.fill` SF Symbol (the iOS-notification look — a red circle
 *  with the number inside). SF Symbols carries numbered circles 0…50; past that, a red
 *  exclamation-circle + the count as text. `sfcolor` tints the symbol red; `color` is set too as a
 *  fallback for SwiftBar builds that read `color` for the tint. The numbered symbol carries the count,
 *  so no text is needed for ≤50. */
function renderBadge(count: number): string {
  if (count <= 50) return line(0, '', { sfimage: `${count}.circle.fill`, sfcolor: COLOR.down, color: COLOR.down })
  return line(0, String(count), { sfimage: 'exclamationmark.circle.fill', sfcolor: COLOR.down, color: COLOR.down })
}

/** Defuse SwiftBar STRUCTURAL injection from verbatim content: ` | ` is the param separator (replace
 *  with a broken bar) and a leading `--` nests a submenu (defused by the `│ ` prefix in capContent).
 *  Display-only — the FULL verbatim content stays in `iapeer approvals` (criterion #7 on the payload;
 *  the menu is its truncated, structurally-safe view). */
function sanitizeMenuText(s: string): string {
  return s.replace(/ \| /g, ' ¦ ')
}

/** Cap the inline content (a big diff must not blow up the dropdown) and prefix each row with `│ ` so
 *  it reads as quoted content AND never begins with `--`. Full verbatim content stays in `iapeer
 *  approvals`. */
function capContent(content: string): string[] {
  const clipped = content.length > APPROVAL_CONTENT_MAX_CHARS ? content.slice(0, APPROVAL_CONTENT_MAX_CHARS) : content
  let rows = clipped.split('\n')
  let truncated = content.length > APPROVAL_CONTENT_MAX_CHARS
  if (rows.length > APPROVAL_CONTENT_MAX_LINES) {
    rows = rows.slice(0, APPROVAL_CONTENT_MAX_LINES)
    truncated = true
  }
  const out = rows.map(r => `│ ${sanitizeMenuText(r)}`)
  if (truncated) out.push('│ …[truncated — full content: iapeer approvals]')
  return out
}

/** The pending-approval section (top of the dropdown). Each request is FLAT (depth 0, no submenu): a
 *  header (peer · tool), the verbatim content (monospace, capped), then Allow / Deny click actions —
 *  both visible + clickable with NO extra clicks. A click runs `iapeer tray approve|deny <id>` in the
 *  background (unix-first fleet POST) → the broker resolves → the streaming plugin re-renders off the
 *  approval-resolved SSE event (no refresh=true — the stream is always fresh). */
function renderApprovals(approvals: TrayApproval[], bin: string): string[] {
  const out: string[] = [
    line(0, `${approvals.length} pending approval${approvals.length === 1 ? '' : 's'}`, {
      sfimage: 'bell.badge.fill',
      sfcolor: COLOR.down,
      color: COLOR.down,
    }),
  ]
  for (let i = 0; i < approvals.length; i++) {
    if (i > 0) out.push('---') // separate multiple requests
    const a = approvals[i]!
    out.push(line(0, `${a.personality} · ${a.tool}`, { sfimage: 'hand.raised.fill', sfcolor: COLOR.warn, color: COLOR.warn }))
    const content = a.content ?? a.summary ?? ''
    if (content) for (const cl of capContent(content)) out.push(line(0, cl, { font: 'Menlo', size: 12, color: COLOR.meta }))
    out.push(line(0, 'Allow', { sfimage: 'checkmark.circle.fill', sfcolor: COLOR.live, color: COLOR.live, bash: bin, param1: 'tray', param2: 'approve', param3: a.id, terminal: false }))
    out.push(line(0, 'Deny', { sfimage: 'xmark.circle.fill', sfcolor: COLOR.down, color: COLOR.down, bash: bin, param1: 'tray', param2: 'deny', param3: a.id, terminal: false }))
  }
  return out
}

/** The degraded output when no advertised daemon address answers (docs/15: "A
 *  dashboard that cannot reach any advertised address should render the daemon as
 *  down"). Distinct menu-bar icon + a red header; a Refresh item to retry. */
export function renderDaemonDown(reason: string, opts: RenderOptions): string {
  const now = opts.now ?? Date.now()
  const lines: string[] = []
  lines.push(line(0, '', { sfimage: 'exclamationmark.triangle.fill', color: COLOR.down }))
  lines.push('---')
  lines.push(line(0, 'iapeer daemon unreachable', { color: COLOR.down }))
  lines.push(line(0, reason, { color: COLOR.meta }))
  lines.push('---')
  lines.push(line(0, 'Refresh', { refresh: true, sfimage: 'arrow.clockwise' }))
  // Same load-bearing uniqueness stamp as renderSwiftBar's footer: the down-block is
  // re-emitted every few seconds while the daemon is away — the changing clock keeps
  // the ⚠ icon visible (show() fires per update) instead of a stale hidden item.
  lines.push('---')
  lines.push(line(0, `iapeer · ${fmtClock(now)}`, { color: COLOR.meta, size: 11 }))
  return lines.join('\n') + '\n'
}
