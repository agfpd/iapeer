import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadLifecycleConfig, type LifecycleConfig } from './index.ts'
import { noteHostingGeneration, noteWorkOrigin, workOriginAtLimit, workOriginStillValid } from './workOrigin.ts'
import type { InflightNote } from '../transport/index.ts'

let root: string, env: NodeJS.ProcessEnv, cfg: LifecycleConfig, file: string, note: InflightNote & { ts: number }
const event = Date.now(), identity = 'codex-probe'
const rendered = '<iap from="pm" runtime="claude" intelligence="artificial" ts="01:00:00"><msg>explicit task</msg></iap>'
const user = { type: 'event_msg', timestamp: new Date(event - 1000).toISOString(), payload: { type: 'user_message', message: rendered } }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iap-work-origin-'))
  env = { ...process.env, HOME: root, IAPEER_ROOT: join(root, 'iap'), IAPEER_SOCK_DIR: join(root, 's'), IAPEER_LAUNCHAGENTS_DIR: join(root, 'la') }
  cfg = loadLifecycleConfig(env)
  file = join(root, 'limited.jsonl')
  writeFileSync(file, JSON.stringify(user) + '\n')
  note = { identity, personality: 'probe', runtime: 'codex', cwd: root, sessionToken: 'limited-host', ts: event - 1000, sentAt: '01:00:00', caller: { personality: 'pm', runtime: 'claude' }, message: 'explicit task', rendered, explicitRuntime: true }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('only explicitly addressed, landed, unfinished work earns a bounded hosting authorization', () => {
  noteWorkOrigin(cfg, note)
  const origin = workOriginAtLimit(cfg, identity, event, env, file)
  expect(origin?.caller.personality).toBe('pm')
  expect(workOriginStillValid(cfg, origin, identity, event, env)).toBe(true)
  expect(workOriginAtLimit(cfg, identity, event - 2000, env, file)).toBeUndefined()
  noteWorkOrigin(cfg, { ...note, explicitRuntime: undefined })
  expect(workOriginAtLimit(cfg, identity, event, env, file)).toBeUndefined()
})
test('the confirmation timestamp may follow a fast refusal; acceptance time establishes causal order', () => {
  noteWorkOrigin(cfg, { ...note, ts: event + 1000, acceptedAtMs: event - 1000 })
  expect(workOriginAtLimit(cfg, identity, event, env, file)).toBeDefined()
})
test('an old explicit task completed BEFORE the limit does not authorize another autonomous turn', () => {
  noteWorkOrigin(cfg, note)
  const done = { type: 'event_msg', timestamp: new Date(event - 100).toISOString(), payload: { type: 'task_complete' } }
  writeFileSync(file, [user, done].map(x => JSON.stringify(x)).join('\n'))
  expect(workOriginAtLimit(cfg, identity, event, env, file)).toBeUndefined()
  // A refusal may close a native task at the event itself; it is not an earlier completion.
  done.timestamp = new Date(event).toISOString()
  writeFileSync(file, [user, done].map(x => JSON.stringify(x)).join('\n'))
  expect(workOriginAtLimit(cfg, identity, event, env, file)).toBeDefined()
})
test('a core notice does not grant authorization; a later implicit message revokes old explicit provenance', () => {
  noteWorkOrigin(cfg, { ...note, caller: { personality: 'iapeer-system', runtime: 'core' } })
  expect(workOriginAtLimit(cfg, identity, event, env, file)).toBeUndefined()
  noteWorkOrigin(cfg, note)
  noteWorkOrigin(cfg, { ...note, caller: { personality: 'iapeer-system', runtime: 'core' } })
  expect(workOriginAtLimit(cfg, identity, event, env, file)).toBeDefined()
  noteWorkOrigin(cfg, { ...note, explicitRuntime: undefined })
  expect(workOriginAtLimit(cfg, identity, event, env, file)).toBeUndefined()
})
test('a receipt from another transcript or a replacement hosting is not authorization', () => {
  noteWorkOrigin(cfg, note)
  const other = join(root, 'other.jsonl'); writeFileSync(other, '{}\n')
  expect(workOriginAtLimit(cfg, identity, event, env, other)).toBeUndefined()
  const origin = workOriginAtLimit(cfg, identity, event, env, file)
  const dir = cfg.supervisorRunDir!
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${identity}.pid`), String(process.pid))
  writeFileSync(join(dir, `${identity}.sock`), '')
  expect(workOriginStillValid(cfg, origin, identity, event, env)).toBe(false)
  rmSync(join(dir, `${identity}.pid`)); rmSync(join(dir, `${identity}.sock`))
  noteHostingGeneration(cfg, identity, 'replacement-host-that-already-reaped')
  expect(workOriginStillValid(cfg, origin, identity, event, env)).toBe(false)
})
