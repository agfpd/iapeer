// Shared by the installed acceptance stands: every result.json names the exact binary it exercised.
// A path alone proves nothing after an update replaces the file; the SHA256 is what the reviewer
// compares against the installed binary (src/proof-stands.test.ts enforces it for every stand).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const fileSHA256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Bun exits on SIGTERM/SIGINT without unwinding a pending top-level try/finally.
 * Manual stands must await the SAME teardown on signals and ordinary completion. */
export function installProofCleanup(cleanup: () => Promise<void>) {
  let closing = false, pending: Promise<void> | undefined
  const run = (): Promise<void> => {
    closing = true
    return pending ??= Promise.resolve().then(cleanup).finally(() => {
      process.off('SIGTERM', term)
      process.off('SIGINT', interrupt)
    })
  }
  const signal = (code: number) => { void run().then(() => process.exit(code), e => {
    console.error('proof cleanup failed:', e)
    process.exit(1)
  }) }
  const term = () => signal(143), interrupt = () => signal(130)
  process.on('SIGTERM', term)
  process.on('SIGINT', interrupt)
  return { run, assertRunning() { if (closing) throw new Error('proof is shutting down') } }
}

/** Do not let an unresponsive child pin signal cleanup forever. */
export async function stopProofProcess(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) { await child.exited; return }
  child.kill('SIGTERM')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([child.exited, new Promise<void>(resolve => {
      timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000)
    })])
    await child.exited
  } finally { clearTimeout(timer) }
}
