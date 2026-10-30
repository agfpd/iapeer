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
