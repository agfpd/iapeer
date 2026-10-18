import { test, expect } from 'bun:test'

test('real cfg-only sweep leaves three foreign supervisors alive', async () => {
  const proc = Bun.spawn([process.execPath, 'scripts/proof-fleet-isolation.ts'], { stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  const output = await new Response(proc.stdout).text()
  const error = await new Response(proc.stderr).text()
  expect({ code, error }).toEqual({ code: 0, error: '' })
  expect(output).toContain('foreign supervisors survived')
}, 15000)
