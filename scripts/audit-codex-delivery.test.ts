import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('read-only Codex audit distinguishes ingestion, busy delay, no receipt and next-day aliases', () => {
  const root = mkdtempSync(join(tmpdir(), 'iapeer-delivery-audit-'))
  try {
    const core = join(root, 'core'), home = join(root, 'codex'), cwd = join(root, 'peer')
    mkdirSync(join(core, 'logs/iapeer'), { recursive: true }); mkdirSync(join(home, 'sessions/2026/10/29'), { recursive: true })
    mkdirSync(cwd)
    writeFileSync(join(core, 'peers-profiles.json'), JSON.stringify({ peers: [{ personality: 'p', cwd }] }))
    const base = '2026-10-29T'
    const delivery = (time: string, topic: string) => `ts=${base}${time}.500Z ev=delivery caller=notifier-timer to=p ok=true via=codex-p ms=500 topic=${topic}\n`
    writeFileSync(join(core, 'logs/iapeer/delivery.log'), delivery('10:00:00', 'ok') + delivery('10:01:00', 'busy') + delivery('10:02:00', 'lost') + delivery('10:03:00', 'tomorrow'))
    writeFileSync(join(core, 'logs/iapeer/turns.log'), `ts=${base}10:00:00Z at_iso=${base}10:00:00Z ev=turn-started personality=p runtime=codex\n`)
    const user = (time: string, stamp: string, topic: string, role = 'user') => JSON.stringify({ timestamp: time, type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text: `<iap from="timer" runtime="notifier" ts="${stamp}" topic="${topic}">\n<msg>task</msg>\n</iap>` }] } }) + '\n'
    writeFileSync(join(home, 'sessions/2026/10/29/rollout-id.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd, id: 'id' } }) + '\n'
      + user(base + '10:00:00.100Z', '13:00:00', 'ok')
      + user(base + '10:04:00Z', '13:01:00', 'busy')
      + user(base + '10:02:01Z', '13:02:00', 'lost', 'assistant')
      + user('2026-10-30T10:03:00Z', '13:03:00', 'tomorrow'))
    const p = Bun.spawnSync(['python3', resolve(import.meta.dir, 'audit-codex-delivery.py'), '--since', base + '09:00:00Z', '--until', base + '11:00:00Z', '--root', core, '--codex-home', home])
    expect(p.exitCode).toBe(0)
    const r = JSON.parse(p.stdout.toString())
    expect(r.summary.p).toEqual({ native_input: 1, late_native_input_candidate: 1, missing_native_input: 2 })
    expect(r.deliveries[1].previous_turn_event.event).toBe('turn-started')
    expect(r.deliveries[1].native_input_delay_s).toBe(180)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('pending acknowledgement is not ingestion; exact delivery IDs expose final outcomes and duplicate USERs', () => {
  const root = mkdtempSync(join(tmpdir(), 'iapeer-delivery-audit-id-'))
  try {
    const core = join(root, 'core'), home = join(root, 'codex'), cwd = join(root, 'peer')
    mkdirSync(join(core, 'logs/iapeer'), { recursive: true }); mkdirSync(join(home, 'sessions'), { recursive: true }); mkdirSync(cwd)
    mkdirSync(join(core, 'state/supervisor/acceptance'), { recursive: true })
    const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']
    writeFileSync(join(core, 'peers-profiles.json'), JSON.stringify({ peers: [{ personality: 'p', cwd }] }))
    writeFileSync(join(core, 'logs/iapeer/delivery.log'), ids.map((id, i) => `ts=2026-10-29T10:00:0${i}Z ev=delivery caller=notifier-timer to=p rt=codex ok=true via=codex-p ms=500 queued=true acceptance=pending deliveryId=${id}\n`).join(''))
    writeFileSync(join(core, 'state/supervisor/acceptance', ids[0] + '.json'), JSON.stringify({ status: 'delivered' }))
    writeFileSync(join(core, 'state/supervisor/acceptance', ids[1] + '.json'), JSON.stringify({ status: 'unresolved' }))
    const user = JSON.stringify({ timestamp: '2026-10-29T10:05:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `task [iapeer deliveryId=${ids[0]}]` }] } }) + '\n'
    writeFileSync(join(home, 'sessions/rollout-id.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n' + user + user)
    const p = Bun.spawnSync(['python3', resolve(import.meta.dir, 'audit-codex-delivery.py'), '--since', '2026-10-29T09:00:00Z', '--until', '2026-10-29T11:00:00Z', '--root', core, '--codex-home', home])
    expect(p.exitCode).toBe(0)
    const r = JSON.parse(p.stdout.toString())
    expect(r.acceptance_summary).toEqual({ delivered: 1, unresolved: 1 })
    expect(r.deliveries[0].status).toBe('native_input')
    expect(r.deliveries[0].native_user_records).toBe(2)
    expect(r.duplicate_native_inputs).toBe(1)
    expect(r.deliveries[1].status).toBe('missing_native_input')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
