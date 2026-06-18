// signInstalledBinary — stable-identity re-sign so TCC grants survive updates
// (Нова's DX requirement 10.06). DI-runner units; the real keychain flow was
// proven live (/tmp experiment: two binaries, different CDHash, IDENTICAL
// designated requirement `identifier "com.agfpd.iapeer" and certificate leaf`).
// The sandbox guard double-checks process.env, so these tests inject a runner
// AND call with the flag stripped via a direct env — guard tested separately.

import { describe, expect, test } from 'bun:test'
import { SIGNING_IDENTIFIER, SIGNING_IDENTITY_CN, signInstalledBinary, type SigningRunner } from './signing.ts'

function harness(opts: { identityExists: boolean; failAt?: 'req' | 'pkcs12' | 'import' | 'codesign' }) {
  const calls: { cmd: string; args: string[] }[] = []
  const run: SigningRunner = (cmd, args) => {
    calls.push({ cmd, args })
    if (cmd === 'security' && args[0] === 'find-identity') {
      return { status: 0, stdout: opts.identityExists ? `1) ABC "${SIGNING_IDENTITY_CN}" (CSSMERR_TP_NOT_TRUSTED)\n` : 'no identities\n', stderr: '' }
    }
    if (cmd.endsWith('openssl') && args[0] === 'req') return { status: opts.failAt === 'req' ? 1 : 0, stdout: '', stderr: 'req boom' }
    if (cmd.endsWith('openssl') && args[0] === 'pkcs12') return { status: opts.failAt === 'pkcs12' ? 1 : 0, stdout: '', stderr: 'p12 boom' }
    if (cmd === 'security' && args[0] === 'import') return { status: opts.failAt === 'import' ? 1 : 0, stdout: '', stderr: 'import boom' }
    if (cmd === 'codesign') return { status: opts.failAt === 'codesign' ? 1 : 0, stdout: '', stderr: 'sign boom' }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { calls, run }
}

// NOTE: process.env.IAPEER_TEST_SANDBOX === '1' under `bun run test`, so the
// guard SHORT-CIRCUITS every real call — these units therefore stub process.env
// off for the duration of each call.
function withSandboxOff<T>(fn: () => T): T {
  const prev = process.env.IAPEER_TEST_SANDBOX
  delete process.env.IAPEER_TEST_SANDBOX
  try {
    return fn()
  } finally {
    if (prev !== undefined) process.env.IAPEER_TEST_SANDBOX = prev
  }
}

describe('signInstalledBinary (stable identity → TCC grants survive updates)', () => {
  test('sandbox guard: never touches the keychain under IAPEER_TEST_SANDBOX', () => {
    const h = harness({ identityExists: true })
    const r = signInstalledBinary('/x/iapeer', { IAPEER_TEST_SANDBOX: '1' } as NodeJS.ProcessEnv, h.run)
    expect(r.state).toBe('skipped-sandbox')
    expect(h.calls.length).toBe(0)
  })

  test('existing identity → single codesign with the stable identifier', () => {
    const h = harness({ identityExists: true })
    const r = withSandboxOff(() => signInstalledBinary('/x/iapeer', {} as NodeJS.ProcessEnv, h.run))
    expect(r.state).toBe('signed')
    const sign = h.calls.find(c => c.cmd === 'codesign')!
    expect(sign.args).toEqual(['-f', '-s', SIGNING_IDENTITY_CN, '--identifier', SIGNING_IDENTIFIER, '/x/iapeer'])
    // identity lookup is NOT -v (an untrusted self-signed identity must be found)
    const find = h.calls.find(c => c.args[0] === 'find-identity')!
    expect(find.args).not.toContain('-v')
  })

  test('no identity → created once (openssl req → pkcs12 → import -T codesign), then signed', () => {
    const h = harness({ identityExists: false })
    const r = withSandboxOff(() => signInstalledBinary('/x/iapeer', {} as NodeJS.ProcessEnv, h.run))
    expect(r.state).toBe('signed-new-identity')
    const seq = h.calls.map(c => `${c.cmd.split('/').pop()}:${c.args[0]}`)
    expect(seq).toEqual(['security:find-identity', 'openssl:req', 'openssl:pkcs12', 'security:import', 'codesign:-f'])
    const imp = h.calls.find(c => c.args[0] === 'import')!
    expect(imp.args).toContain('-T') // codesign pre-authorized in the key ACL
    expect(imp.args).toContain('/usr/bin/codesign')
  })

  test('identity-creation failure → failed-soft with the loud TCC consequence, codesign never attempted', () => {
    const h = harness({ identityExists: false, failAt: 'import' })
    const r = withSandboxOff(() => signInstalledBinary('/x/iapeer', {} as NodeJS.ProcessEnv, h.run))
    expect(r.state).toBe('failed-soft')
    expect(r.detail).toContain('TCC prompts will re-appear')
    expect(h.calls.some(c => c.cmd === 'codesign')).toBe(false)
  })

  test('codesign failure → failed-soft (install never breaks on a signing hiccup)', () => {
    const h = harness({ identityExists: true, failAt: 'codesign' })
    const r = withSandboxOff(() => signInstalledBinary('/x/iapeer', {} as NodeJS.ProcessEnv, h.run))
    expect(r.state).toBe('failed-soft')
    expect(r.detail).toContain('sign boom')
  })
})
