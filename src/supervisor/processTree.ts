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

/** Capture BEFORE killing the runtime: afterwards children are reparented to launchd (PPID 1) and
 * ancestry can no longer prove ownership. OWNERSHIP = ANCESTRY: every live descendant of the hosted
 * runtime root is this session's, whatever its terminal or process group. The earlier controlling-PTY
 * boundary (0.4.1xx) pruned non-PTY branches as «detached/shared daemons» — but both runtimes run their
 * TOOL commands exactly there: Claude Code's Bash tool shell is a setsid child with no tty, Codex's exec
 * child likewise (measured live 04.11.2026: `python3 … sleep` under codex and zsh under claude, tty ??).
 * So a stop/new left the running tool tree alive as orphans (PPID 1) that could finish side effects after
 * the restart. A truly detached daemon double-forks away from the root and is outside the ancestry — it
 * is never adopted here. Never signal a whole group: only ancestry-proven descendants whose start token
 * still matches; an unreadable token is no permission to signal (fail closed on PID reuse).
 * Several passes while the root is still alive: a child forked during a pass is caught by the next.
 * Already-reparented processes (orphaned before the first snapshot) are outside this cleanup. */
export function killPtyDescendants(root: number, rootToken: string | null, deps: {
  table?: () => ProcessRecord[]
  identity?: (pid: number) => Pick<ProcessRecord, 'token' | 'tty'> | null
  signal?: (pid: number) => void
  passes?: number
} = {}): { killed: number; skipped: number } {
  if (!Number.isInteger(root) || root <= 1 || root === process.pid) throw new Error('invalid hosted runtime pid')
  let killed = 0, skipped = 0
  const refused = new Set<string>()
  for (let pass = 0; pass < (deps.passes ?? 3); pass++) {
    const rows = (deps.table ?? processTable)()
    // The root may already have died (terminal.exit), even before this snapshot. Do not
    // adopt an unrelated tree on PID reuse; a missing root needs no ancestry cleanup.
    const currentRoot = rows.find(r => r.pid === root)
    if (!currentRoot) return { killed, skipped }
    if (!rootToken || currentRoot.token !== rootToken) return { killed, skipped: skipped + 1 }
    if (['', '-', '??', '?'].includes(currentRoot.tty)) return { killed, skipped: skipped + 1 }
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
        seen.add(row.pid)
        visit(row.pid)
        owned.push(row) // leaves first, while ancestry is still available
      }
    }
    visit(root)
    const todo = owned.filter(r => !refused.has(`${r.pid}:${r.token}`))
    if (todo.length === 0) break
    for (const row of todo) {
      // Unlike killing the root by its Bun subprocess handle, a descendant is a ps-derived PID.
      // An unreadable token is NOT permission to signal it; fail closed on reuse / uncertainty.
      let current: Pick<ProcessRecord, 'token' | 'tty'> | null
      try { current = (deps.identity ?? (pid => processTable(pid)[0] ?? null))(row.pid) } catch { current = null }
      if (current?.token !== row.token) { skipped++; refused.add(`${row.pid}:${row.token}`); continue }
      try {
        (deps.signal ?? (pid => process.kill(pid, 'SIGKILL')))(row.pid)
        killed++
      } catch { /* exited between verification and signal */ }
      refused.add(`${row.pid}:${row.token}`) // signalled once; a zombie still listed is not re-counted
    }
  }
  return { killed, skipped }
}
