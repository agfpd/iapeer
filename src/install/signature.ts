// Lightweight package-facing activation gate. No keychain/TCC identity creation:
// preserve a valid signature; repair only a trusted, installer-owned staged file.
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { spawnSync } from 'child_process'

export interface SignatureRunner {
  (command: string, args: string[], env: NodeJS.ProcessEnv): {
    status: number | null
    stdout?: string
    stderr?: string
  }
}

export interface ExecutableSignatureOptions {
  env?: NodeJS.ProcessEnv
  /** Default true for staged build artifacts. Use false for installed binaries. */
  repair?: boolean
  /** Test seams: injected runners may run under the sandbox; real codesign cannot. */
  run?: SignatureRunner
  platform?: NodeJS.Platform
}

export interface ExecutableSignatureOutcome {
  state: 'verified' | 'repaired' | 'skipped-platform' | 'skipped-non-macho' | 'skipped-sandbox'
}

const MACH_O_MAGIC = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, // thin, 32/64-bit, either endianness
  0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca, // universal, 32/64-bit
])

function executableKind(path: string): 'macho' | 'script' | 'unknown' {
  const fd = openSync(path, 'r') // missing/unreadable artifact is a hard failure
  try {
    const magic = Buffer.alloc(4)
    const length = readSync(fd, magic, 0, 4, 0)
    if (length === 4 && MACH_O_MAGIC.has(magic.readUInt32BE(0))) {
      const value = magic.readUInt32BE(0)
      const headerSize = value === 0xfeedface || value === 0xcefaedfe ? 28
        : value === 0xfeedfacf || value === 0xcffaedfe ? 32 : 8
      // codesign can sign a magic-only stub as generic data using xattrs. That
      // success is not evidence of a Mach-O executable: require its full header.
      return fstatSync(fd).size >= headerSize ? 'macho' : 'unknown'
    }
    if (length >= 2 && magic[0] === 0x23 && magic[1] === 0x21) return 'script'
    return 'unknown'
  } finally {
    closeSync(fd)
  }
}

const defaultRunner: SignatureRunner = (command, args, env) => {
  const r = spawnSync(command, args, { encoding: 'utf8', env, timeout: 30_000 })
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error?.message ?? r.stderr ?? '' }
}

/**
 * macOS: strict verify → (if invalid and repair allowed) ad-hoc sign → strict verify.
 * Throws on failure. Call AFTER compile/copy/chmod and BEFORE rename/manifest.
 * Valid certificate-backed signatures stay byte-identical. Repair establishes
 * signature validity, not provenance: never use it to trust arbitrary modified code.
 */
export function ensureExecutableSignature(
  path: string,
  opts: ExecutableSignatureOptions = {},
): ExecutableSignatureOutcome {
  if ((opts.platform ?? process.platform) !== 'darwin') return { state: 'skipped-platform' }
  const env = opts.env ?? process.env
  // Both flags count, so a caller cannot accidentally re-enable real commands by
  // passing a sparse env. DI tests use their own runner, never the production one.
  if (!opts.run && (env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1')) {
    return { state: 'skipped-sandbox' }
  }
  const kind = executableKind(path)
  if (kind === 'script') return { state: 'skipped-non-macho' }
  if (kind === 'unknown') throw new Error(`executable signature verification failed for ${path}: not a Mach-O executable or shebang launcher`)
  const run = opts.run ?? defaultRunner
  const verify = (): ReturnType<SignatureRunner> => run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path], env)
  const fail = (step: string, result: ReturnType<SignatureRunner>): never => {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`
    throw new Error(`executable signature ${step} failed for ${path}: ${detail}`)
  }
  const initial = verify()
  if (initial.status === 0) return { state: 'verified' }
  // A timeout/spawn error/signal is not evidence of an invalid signature. Do not
  // rewrite code when the verification tool itself could not run to completion.
  if (initial.status === null) fail('verification', initial)
  if (opts.repair === false) fail('verification', initial)
  const signed = run('/usr/bin/codesign', ['--force', '--sign', '-', path], env)
  if (signed.status !== 0) fail('repair', signed)
  const final = verify()
  if (final.status !== 0) fail('verification after repair', final)
  return { state: 'repaired' }
}
