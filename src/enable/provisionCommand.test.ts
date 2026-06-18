// Provision-command executor — the v1.2 inversion joint. Pins the four contract
// requirements: per-arg placeholder substitution WITHOUT a shell (injection
// class), absolute command, timeout, structured outcomes. The fake provider is
// a tmp shell script that journals its argv — no real provider involved.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runProvisionCommand } from './provisionCommand.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'iapeer-provcmd-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A fake provider command journaling each argv element on its own line. */
function fakeProvider(name: string, body?: string): string {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${body ?? `printf '%s\\n' "$@" > '${dir}/journal.txt'`}\n`)
  chmodSync(p, 0o755)
  return p
}

describe('runProvisionCommand (v1.2 executor)', () => {
  test('per-arg substitution of {cwd}/{runtime}/{personality}/{occasion}, argv passed verbatim (no shell)', () => {
    const cmd = fakeProvider('prov.sh')
    const o = runProvisionCommand({
      block: {
        command: cmd,
        // both shapes: bare placeholder arg and embedded `--k={v}`; plus an arg
        // full of shell metacharacters that MUST stay literal (no shell layer)
        args: ['provision-peer', '--cwd', '{cwd}', '--runtime={runtime}', '--occasion', '{occasion}', '$(reboot) `id` ; rm -rf /'],
      },
      cwd: '/tmp/some peer dir',
      runtime: 'claude',
      personality: 'tw-prov',
      occasion: 'birth',
    })
    expect(o.state).toBe('ok')
    expect(o.exitCode).toBe(0)
    const journal = readFileSync(join(dir, 'journal.txt'), 'utf8').split('\n')
    expect(journal[0]).toBe('provision-peer')
    expect(journal[1]).toBe('--cwd')
    expect(journal[2]).toBe('/tmp/some peer dir') // spaces survive — single argv element
    expect(journal[3]).toBe('--runtime=claude') // embedded substitution
    expect(journal[4]).toBe('--occasion')
    expect(journal[5]).toBe('birth')
    expect(journal[6]).toBe('$(reboot) `id` ; rm -rf /') // LITERAL — never shell-parsed
  })

  test('{personality} placeholder is supported (optional for the provider)', () => {
    const cmd = fakeProvider('prov.sh')
    const o = runProvisionCommand({
      block: { command: cmd, args: ['{personality}'] },
      cwd: '/x',
      runtime: 'codex',
      personality: 'boris',
      occasion: 'sweep-on',
    })
    expect(o.state).toBe('ok')
    expect(readFileSync(join(dir, 'journal.txt'), 'utf8').trim()).toBe('boris')
  })

  test('non-zero exit → failed with exit code and stderr tail', () => {
    const cmd = fakeProvider('prov.sh', `echo 'no such peer' >&2; exit 3`)
    const o = runProvisionCommand({
      block: { command: cmd, args: [] },
      cwd: '/x',
      runtime: 'claude',
      personality: 'p',
      occasion: 'off-peer',
    })
    expect(o.state).toBe('failed')
    expect(o.exitCode).toBe(3)
    expect(o.detail).toContain('no such peer')
  })

  test('timeout → state=timeout, never hangs the joint', () => {
    const cmd = fakeProvider('prov.sh', 'sleep 30')
    const o = runProvisionCommand({
      block: { command: cmd, args: [] },
      cwd: '/x',
      runtime: 'claude',
      personality: 'p',
      occasion: 'remove',
      timeoutMs: 300,
    })
    expect(o.state).toBe('timeout')
    expect(o.durationMs).toBeLessThan(5000)
  })

  test('missing/non-executable command → not-executable (never throws)', () => {
    const o = runProvisionCommand({
      block: { command: join(dir, 'nope.sh'), args: [] },
      cwd: '/x',
      runtime: 'claude',
      personality: 'p',
      occasion: 'birth',
    })
    expect(o.state).toBe('not-executable')
    expect(o.exitCode).toBeNull()
  })
})
