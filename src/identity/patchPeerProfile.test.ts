import { afterEach, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { patchPeerProfile } from './patchPeerProfile.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'profile-patch-')); dirs.push(cwd)
  patchPeerProfile(cwd, raw => { raw.foreign = { value: 42 }; raw.description = 'hello' })
  return { cwd, path: join(cwd, '.iapeer', 'peer-profile.json') }
}
test('preserve foreign fields, delete owned field, no-op preserves bytes and mtime', () => {
  const { cwd, path } = fixture()
  patchPeerProfile(cwd, raw => { delete raw.description })
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ foreign: { value: 42 } })
  const bytes = readFileSync(path, 'utf8'), mtime = statSync(path).mtimeMs
  patchPeerProfile(cwd, () => {})
  expect(readFileSync(path, 'utf8')).toBe(bytes)
  expect(statSync(path).mtimeMs).toBe(mtime)
})
test('malformed JSON, callback error and async callback never publish', () => {
  const { cwd, path } = fixture()
  const bytes = readFileSync(path, 'utf8')
  expect(() => patchPeerProfile(cwd, raw => { raw.x = 1; throw new Error('abort') })).toThrow('abort')
  expect(() => patchPeerProfile(cwd, async raw => { raw.x = 2 })).toThrow('synchronous')
  expect(readFileSync(path, 'utf8')).toBe(bytes)
  writeFileSync(path, '{broken')
  expect(() => patchPeerProfile(cwd, raw => { raw.x = 3 })).toThrow()
  expect(readFileSync(path, 'utf8')).toBe('{broken')
})
test('incompatible protocol refuses callback and leaves profile bytes intact', () => {
  const { cwd, path } = fixture()
  const bytes = readFileSync(path, 'utf8')
  writeFileSync(join(cwd, '.iapeer', '.peer-profile.protocol'), '2\n')
  let called = false
  expect(() => patchPeerProfile(cwd, () => { called = true })).toThrow('protocol mismatch')
  expect(called).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe(bytes)
})
test('separate processes read under the same lock without losing updates', async () => {
  const { cwd, path } = fixture()
  const module = new URL('./patchPeerProfile.ts', import.meta.url).pathname
  const children = Array.from({ length: 4 }, (_, n) => Bun.spawn([process.execPath, '-e',
    `import {patchPeerProfile} from ${JSON.stringify(module)}; for(let i=0;i<20;i++) patchPeerProfile(${JSON.stringify(cwd)}, raw=>{raw.count=Number(raw.count??0)+1;raw['writer${n}']=i})`], { stdout: 'pipe', stderr: 'pipe' }))
  expect(await Promise.all(children.map(p => p.exited))).toEqual([0, 0, 0, 0])
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  expect(raw.count).toBe(80)
  expect(raw.foreign).toEqual({ value: 42 })
  for (let n = 0; n < 4; n++) expect(raw[`writer${n}`]).toBe(19)
})
