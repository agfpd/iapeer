// Secondary, verify-only gate. The package must verify its staged inode BEFORE
// publishing it; the foundation refuses provisioning/restart of invalid code.
import { ensureExecutableSignature, type ExecutableSignatureOptions } from '../install/signature.ts'
import { resolveExecutable } from '../launch/launchd.ts'
import { type Runtime } from '../core/constants.ts'
import { readRuntimeManifest, type RuntimeManifest } from './index.ts'

export type RuntimeSignatureVerifier = (runtime: Runtime, env: NodeJS.ProcessEnv, manifest?: RuntimeManifest) => void

export function verifyRuntimeSignatures(
  runtime: Runtime,
  env: NodeJS.ProcessEnv,
  suppliedManifest?: RuntimeManifest,
  opts: Pick<ExecutableSignatureOptions, 'run' | 'platform'> = {},
): void {
  if ((opts.platform ?? process.platform) !== 'darwin') return
  if (!opts.run && (env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1')) return
  const manifest = suppliedManifest ?? readRuntimeManifest(runtime, { env })
  const names = new Set<string>()
  const declared = manifest?.peers ?? []
  // The same default launcher the core's provisioning/launch scheme uses. A
  // fully explicit declared-set needs only its explicitly declared launchers.
  if (!declared.length || declared.some(p => !p.runtimeBin)) names.add(`${runtime}-runtime`)
  for (const peer of declared) if (peer.runtimeBin) names.add(peer.runtimeBin)
  const hook = manifest?.selfConfig
  if (hook) names.add(typeof hook === 'string' ? hook : hook.command)
  const checked = new Set<string>()
  for (const name of names) {
    const path = resolveExecutable(name, env)
    if (!path) throw new Error(`runtime "${runtime}" launcher not executable or not found: ${name}`)
    if (checked.has(path)) continue
    checked.add(path)
    ensureExecutableSignature(path, { ...opts, env, repair: false })
  }
}
