import { spawnSync } from 'node:child_process'

export interface ProcessRecord { pid: number; ppid: number; tty: string; token: string }

/** No argv/env in this snapshot: ancestry + controlling PTY, not names or groups, own cleanup. */
export function parseProcessTable(table: string): ProcessRecord[] {
  return table.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (!m || Number(m[1]) <= 0) return []
    return [{ pid: Number(m[1]), ppid: Number(m[2]), tty: m[3], token: m[4] }]
  })
}

function processTable(pid?: number): ProcessRecord[] {
  const args = pid === undefined ? ['-axo', 'pid=,ppid=,tty=,lstart='] : ['-o', 'pid=,ppid=,tty=,lstart=', '-p', String(pid)]
  const r = spawnSync('/bin/ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  if (r.error || r.status !== 0) throw new Error('could not read process ancestry for session teardown')
  return parseProcessTable(r.stdout)
}

/** Capture BEFORE killing the runtime: afterwards stdio launchers may already have PPID 1.
 * The controlling PTY is the ownership boundary: separate process groups (Codex stdio MCP) remain
 * inside it, whereas setsid/detached services (possibly shared with other clients) leave it. Prune
 * those entire branches. Never signal a whole group: only proven PTY descendants whose start token
 * still matches are ours. This preserves the existing HARD session teardown semantics; it is not
 * a replacement for an MCP client's graceful EOF protocol.
 * Already-reparented children and children racing the snapshot are outside this ancestry snapshot. */
export function killPtyDescendants(root: number, rootToken: string | null, deps: {
  table?: () => ProcessRecord[]
  identity?: (pid: number) => Pick<ProcessRecord, 'token' | 'tty'> | null
  signal?: (pid: number) => void
} = {}): { killed: number; skipped: number } {
  if (!Number.isInteger(root) || root <= 1 || root === process.pid) throw new Error('invalid hosted runtime pid')
  const rows = (deps.table ?? processTable)()
  // The root may already have died (terminal.exit), even before this snapshot. Do not
  // adopt an unrelated tree on PID reuse; a missing root needs no ancestry cleanup.
  const currentRoot = rows.find(r => r.pid === root)
  if (!currentRoot) return { killed: 0, skipped: 0 }
  if (!rootToken || currentRoot.token !== rootToken) return { killed: 0, skipped: 1 }
  if (['', '-', '??', '?'].includes(currentRoot.tty)) return { killed: 0, skipped: 1 }
  const children = new Map<number, ProcessRecord[]>()
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, [])
    children.get(row.ppid)!.push(row)
  }
  const seen = new Set([root, process.pid])
  const owned: ProcessRecord[] = []
  const visit = (parent: number) => {
    for (const row of children.get(parent) ?? []) {
      if (seen.has(row.pid)) continue
      if (row.tty !== currentRoot.tty) continue // detached daemon and everything it owns are not this PTY's
      seen.add(row.pid)
      visit(row.pid)
      owned.push(row) // leaves first, while ancestry is still available
    }
  }
  visit(root)
  let killed = 0, skipped = 0
  for (const row of owned) {
    // Unlike killing the root by its Bun subprocess handle, a descendant is a ps-derived PID.
    // An unreadable token is NOT permission to signal it; fail closed on reuse / uncertainty.
    let current: Pick<ProcessRecord, 'token' | 'tty'> | null
    try { current = (deps.identity ?? (pid => processTable(pid)[0] ?? null))(row.pid) } catch { current = null }
    if (current?.token !== row.token || current.tty !== row.tty) { skipped++; continue }
    try {
      (deps.signal ?? (pid => process.kill(pid, 'SIGKILL')))(row.pid)
      killed++
    } catch { /* exited between verification and signal */ }
  }
  return { killed, skipped }
}
