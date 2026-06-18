// Stable code-signing for the installed binary — TCC grants must SURVIVE updates
// (grant once at install; subsequent updates must not re-trigger the TCC prompts).
//
// ROOT CAUSE (proven on the host): `bun build --compile` output is ad-hoc
// linker-signed (Identifier=a.out, no cert chain) — its only stable identity is
// the CDHash, which CHANGES with every build. macOS TCC keys grants on the code
// requirement; for an ad-hoc binary that collapses to the cdhash → every update
// is a NEW TCC subject → re-prompts.
//
// FIX (proven live): a LOCAL self-signed code-signing
// identity ("iapeer Local Codesign", created once at install) re-signs the binary
// after every build. Two different binaries signed by it carry the IDENTICAL
// designated requirement:
//   identifier "com.agfpd.iapeer" and certificate leaf = H"<leaf-hash>"
// — stable across updates, so the TCC grant follows the requirement, not the
// bytes. Trust of the cert chain is NOT needed: codesign signs with an untrusted
// (CSSMERR_TP_NOT_TRUSTED) identity fine, and TCC matches the requirement.
//
// Failure policy: SOFT. The binary works ad-hoc-signed exactly as before; a
// signing hiccup must never break install/update. It is reported loud (the
// operator learns TCC prompts will re-appear) but the install succeeds.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

/** CROSS-PRODUCT CONTRACT: this CN is the
 *  SHARED signing identity of the whole agfpd stack. Each product signs with its
 *  OWN --identifier (foundation: com.agfpd.iapeer; memory: com.agfpd.iapeer-memory),
 *  so TCC subjects stay separate while the host carries ONE key (one keychain
 *  prompt ever). Creation is first-needs-creates with the IDENTICAL profile (EKU
 *  codeSigning, system LibreSSL p12, import -T /usr/bin/codesign) on both sides.
 *  Changing the CN or the creation profile is a COORDINATED change across repos.
 *  Known shared costs: re-creating the identity (deleted/expired — cert is 10 y)
 *  migrates the TCC grants of EVERY stack product at once; a concurrent
 *  first-creation by two installers could duplicate the CN (codesign would then
 *  report an ambiguous identity) — installs are operator-sequential, residual
 *  risk accepted. */
export const SIGNING_IDENTITY_CN = 'iapeer Local Codesign'
export const SIGNING_IDENTIFIER = 'com.agfpd.iapeer'

/** System LibreSSL — ALWAYS present on macOS and its pkcs12 output imports into
 *  the keychain directly. (Homebrew OpenSSL 3.x defaults to PBES2/AES p12, which
 *  `security import` rejects with "MAC verification failed" unless -legacy —
 *  live-caught during the experiment; pinning the system binary removes the
 *  PATH-dependent branch entirely.) */
const SYSTEM_OPENSSL = '/usr/bin/openssl'

export interface SigningRunner {
  (cmd: string, args: string[], input?: string): { status: number | null; stdout: string; stderr: string }
}

const defaultRunner: SigningRunner = (cmd, args) => {
  // 90 s ceiling: a keychain GUI prompt left unanswered must not wedge an
  // unattended update forever — it degrades to failed-soft instead.
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 90_000 })
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export interface SigningOutcome {
  state:
    | 'signed' // re-signed with the existing identity
    | 'signed-new-identity' // identity created this run (the ONE install-time event), then signed
    | 'skipped-sandbox' // tests never touch the real keychain
    | 'failed-soft' // signing failed — binary stays ad-hoc (works; TCC prompts return)
  detail?: string
}

/** True iff the local signing identity already exists in the keychain. Deliberately
 *  NOT `-v` (valid-only): the self-signed cert reads CSSMERR_TP_NOT_TRUSTED, which
 *  is fine for signing — `-v` would hide it and re-create endlessly. */
function identityPresent(run: SigningRunner): boolean {
  const r = run('security', ['find-identity', '-p', 'codesigning'])
  return r.status === 0 && r.stdout.includes(`"${SIGNING_IDENTITY_CN}"`)
}

/** Create the local self-signed code-signing identity (key + cert with EKU
 *  codeSigning → p12 → keychain import with codesign pre-authorized via -T).
 *  The one-time install event. */
function createIdentity(run: SigningRunner): { ok: boolean; detail?: string } {
  const dir = mkdtempSync(join(tmpdir(), 'iapeer-signing-'))
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  const p12 = join(dir, 'id.p12')
  // Throwaway p12 transport password — the file lives seconds inside a 0700 tmp dir.
  const pass = `iapeer-${process.pid}-${Math.floor(Math.random() * 1e9)}`
  try {
    const req = run(SYSTEM_OPENSSL, [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
      '-days', '3650', '-nodes', '-subj', `/CN=${SIGNING_IDENTITY_CN}`,
      '-addext', 'keyUsage=digitalSignature', '-addext', 'extendedKeyUsage=codeSigning',
    ])
    if (req.status !== 0) return { ok: false, detail: `openssl req failed: ${req.stderr.trim().split('\n')[0] ?? ''}` }
    const exp = run(SYSTEM_OPENSSL, [
      'pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12,
      '-passout', `pass:${pass}`, '-name', SIGNING_IDENTITY_CN,
    ])
    if (exp.status !== 0) return { ok: false, detail: `openssl pkcs12 failed: ${exp.stderr.trim().split('\n')[0] ?? ''}` }
    // -T /usr/bin/codesign pre-authorizes codesign in the key's ACL — at most ONE
    // keychain confirmation at the very first signing (the install-time event).
    const imp = run('security', ['import', p12, '-P', pass, '-T', '/usr/bin/codesign'])
    if (imp.status !== 0) return { ok: false, detail: `security import failed: ${imp.stderr.trim().split('\n')[0] ?? ''}` }
    return { ok: true }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup of the throwaway key material */
    }
  }
}

/**
 * Re-sign the installed binary with the stable local identity (creating the
 * identity on first use). Called by installIapeer after the atomic rename —
 * i.e. on EVERY install/update path, so the designated requirement (and with it
 * every TCC grant) stays constant while the bytes change.
 */
export function signInstalledBinary(
  binPath: string,
  env: NodeJS.ProcessEnv = process.env,
  run: SigningRunner = defaultRunner,
): SigningOutcome {
  // Keychain + codesign are HOST-GLOBAL — same fail-closed double-check as the
  // launchctl guards: consult both the passed env and the process env.
  if (env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1') {
    return { state: 'skipped-sandbox', detail: 'IAPEER_TEST_SANDBOX=1 — not touching the real keychain' }
  }
  let created = false
  if (!identityPresent(run)) {
    const c = createIdentity(run)
    if (!c.ok) {
      return { state: 'failed-soft', detail: `${c.detail} — binary stays ad-hoc-signed (works, but TCC prompts will re-appear after updates)` }
    }
    created = true
  }
  const sign = run('codesign', ['-f', '-s', SIGNING_IDENTITY_CN, '--identifier', SIGNING_IDENTIFIER, binPath])
  if (sign.status !== 0) {
    return {
      state: 'failed-soft',
      detail: `codesign failed: ${sign.stderr.trim().split('\n')[0] ?? `exit ${sign.status}`} — binary stays ad-hoc-signed (works, but TCC prompts will re-appear after updates)`,
    }
  }
  return created ? { state: 'signed-new-identity' } : { state: 'signed' }
}
