// Provision-command executor — the v1.2 inversion joint (contract «Слот памяти»
// §Provision провайдера; ADR-009). The slot declares provision/unprovision
// COMMANDS; the core shells into them at the lifecycle joints and knows NOTHING
// about surface forms. The four contract requirements live here:
//   1. argv-form {command, args[]} with PER-ARG placeholder substitution —
//      spawned WITHOUT a shell (injection/quoting class — a backtick in an arg
//      must never reach a shell).
//   2. `command` is ABSOLUTE (parser refuses relative — launchd minimal PATH).
//   3. Timeout 120 s; best-effort semantics live at the CALL SITES (LOUD warn,
//      the birth/remove flow continues) — this module only reports structurally.
//   4. {occasion} vocabulary (финален, contract §Provision): birth | sweep-on |
//      off-peer | off-all | remove — ref-counting of host-global surfaces is the
//      PROVIDER's business. Since the provider-verb removal (ADR-017) the CORE
//      emits only `birth` and `remove`; the sweep occasions remain part of the
//      provider-command interface (their CLI may use them internally).
// Idempotency is the provider's obligation by construction; the provider holds
// its own lock against concurrent provisions.

import { spawnSync } from 'child_process'
import { accessSync, constants as FS } from 'fs'
import type { MemoryProviderProvision } from '../status/index.ts'

/** The agreed occasion vocabulary (финален). */
export type ProvisionOccasion = 'birth' | 'sweep-on' | 'off-peer' | 'off-all' | 'remove'

export const PROVISION_TIMEOUT_MS = 120_000

export interface ProvisionCommandSpec {
  /** The declared command block (provision or unprovision). */
  block: MemoryProviderProvision
  /** Placeholder values — substituted PER-ARG, substring-level (so both
   *  `--cwd {cwd}` and `--cwd={cwd}` argv shapes work). */
  cwd: string
  runtime: string
  personality: string
  occasion: ProvisionOccasion
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export interface ProvisionCommandOutcome {
  state: 'ok' | 'failed' | 'timeout' | 'not-executable'
  exitCode: number | null
  /** stderr tail (last ~400 chars) — the structured detail for eventlog/warns. */
  detail?: string
  durationMs: number
  /** The fully substituted argv (command first) — logged for postmortems. */
  argv: string[]
}

function substitute(arg: string, s: ProvisionCommandSpec): string {
  return arg
    .replaceAll('{cwd}', s.cwd)
    .replaceAll('{runtime}', s.runtime)
    .replaceAll('{personality}', s.personality)
    .replaceAll('{occasion}', s.occasion)
}

function tail(text: string, max = 400): string | undefined {
  const t = text.trim()
  if (!t) return undefined
  return t.length <= max ? t : `…${t.slice(-max)}`
}

/**
 * Run ONE provider provision/unprovision command for ONE peer × runtime ×
 * occasion. Synchronous (the call sites are the synchronous provision/remove
 * flows), no shell, bounded by timeout. NEVER throws — every failure is a
 * structured outcome the call site warns about (best-effort: a provider hiccup
 * must not kill a birth or a remove).
 */
export function runProvisionCommand(spec: ProvisionCommandSpec): ProvisionCommandOutcome {
  const env = spec.env ?? process.env
  const argv = [spec.block.command, ...spec.block.args.map(a => substitute(a, spec))]
  const started = Date.now()
  try {
    accessSync(spec.block.command, FS.X_OK)
  } catch {
    return {
      state: 'not-executable',
      exitCode: null,
      detail: `command not found or not executable: ${spec.block.command}`,
      durationMs: Date.now() - started,
      argv,
    }
  }
  try {
    const r = spawnSync(argv[0]!, argv.slice(1), {
      env: env as Record<string, string>,
      encoding: 'utf8',
      timeout: spec.timeoutMs ?? PROVISION_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const durationMs = Date.now() - started
    // node/bun signal a timeout via error.code ETIMEDOUT + signal SIGTERM
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      return { state: 'timeout', exitCode: null, detail: `timed out after ${spec.timeoutMs ?? PROVISION_TIMEOUT_MS} ms`, durationMs, argv }
    }
    if (r.error) {
      return { state: 'failed', exitCode: null, detail: r.error.message, durationMs, argv }
    }
    if (r.status !== 0) {
      return { state: 'failed', exitCode: r.status, detail: tail(r.stderr ?? ''), durationMs, argv }
    }
    return { state: 'ok', exitCode: 0, detail: tail(r.stderr ?? ''), durationMs, argv }
  } catch (e) {
    return {
      state: 'failed',
      exitCode: null,
      detail: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - started,
      argv,
    }
  }
}
