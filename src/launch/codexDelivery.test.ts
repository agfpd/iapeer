import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexDeliveryBlocker, codexQueueCarries, codexReceiptBaseline, codexUserRecordCarries, confirmCodexDelivery, type CodexDeliveryIO } from './codexDelivery.ts'

const message = '<iap from="sender" runtime="notifier" ts="12:34:56">\nReply via send_to_peer.\n<msg>long task ' + 'x'.repeat(1482) + '</msg>\n</iap>'
const locked = '🔒 This conversation is open in another app  r to retry\nClose it there and press R to continue here.'
const queued = { text: `• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\n  ↳ ${message.split('\n')[0]}\n    Reply via send_to_peer.\n    …\n› Ask Codex to do anything\n⚠ 1 warning · f2 to view`, composerOccupied: false }
function io(): CodexDeliveryIO & { sends: number; retries: number } {
  let time = 0
  const x = {
    sends: 0, retries: 0,
    state: async () => ({ text: `› [Pasted Content ${[...message].length} chars]`, composerOccupied: true }),
    send: async () => { x.sends++; return { ok: true } },
    resubmit: async () => { x.retries++; return { ok: true } },
    landed: () => false, submitted: () => false, sameHost: () => true, attached: () => false,
    now: () => time, sleep: async (ms: number) => { time += ms }, graceMs: 4000,
  }
  return x
}

describe('Codex acceptance, not socket ACK', () => {
  test('long paste stuck in composer transfers durable custody, not a retryable failure', async () => {
    const x = io(), r = await confirmCodexDelivery(message, x)
    expect(r.ok).toBe(true); expect(r.acceptance).toBe('pending')
    expect(x.sends).toBe(1); expect(x.retries).toBe(2)
  })
  test('retry submits our own paste, then a message-specific native receipt confirms', async () => {
    const x = io(); x.landed = () => x.retries > 0
    expect((await confirmCodexDelivery(message, x)).ok).toBe(true)
    expect(x.sends).toBe(1); expect(x.retries).toBe(1)
  })
  test('busy native queue needs BOTH new full-payload history AND matching queue with cleared composer', async () => {
    const x = io(); x.state = async () => queued; x.submitted = () => true
    expect((await confirmCodexDelivery(message, x)).ok).toBe(true)
    expect(x.retries).toBe(0)
    x.submitted = () => false
    expect((await confirmCodexDelivery(message, x)).acceptance).toBe('pending')
  })
  test('history alone, an old queue for another header, or draft + queue cannot confirm', async () => {
    for (const state of [
      { text: '› Ask Codex to do anything', composerOccupied: false },
      { ...queued, text: queued.text.replace('sender', 'somebody-else') },
      { ...queued, composerOccupied: true },
    ]) {
      const x = io(); x.state = async () => state; x.submitted = () => true
      expect((await confirmCodexDelivery(message, x)).acceptance).toBe('pending')
    }
  })
  test('external writer is diagnosed before paste; never press r or Enter to take ownership', async () => {
    const x = io(); x.state = async () => ({ text: locked, composerOccupied: false })
    expect((await confirmCodexDelivery(message, x)).error).toContain('open in another app')
    expect(x.sends).toBe(0); expect(x.retries).toBe(0)
    expect(codexDeliveryBlocker('⚠ 1 warning · f2 to view')).toBeNull()
  })
  test('native receipt appearing during awaited capture wins over the expired deadline', async () => {
    const x = io()
    let captured = 0, received = false
    x.state = async () => {
      if (captured++ > 0) { await x.sleep!(5000); received = true }
      return { text: '› Ask Codex to do anything', composerOccupied: false }
    }
    x.landed = () => received
    expect(await confirmCodexDelivery(message, x)).toEqual({ ok: true })
    expect(x.sends).toBe(1); expect(x.retries).toBe(0)
  })
  test('unknown modal / absent snapshot / attached human never receives blind submit retries', async () => {
    for (const state of [null, { text: 'Select a dangerous action', composerOccupied: false }]) {
      const x = io(); x.state = async () => state
      expect((await confirmCodexDelivery(message, x)).acceptance).toBe('pending'); expect(x.retries).toBe(0)
    }
    const x = io(); x.attached = () => true
    expect((await confirmCodexDelivery(message, x)).acceptance).toBe('pending'); expect(x.retries).toBe(0)
  })
  test('replacement host cannot supply a receipt', async () => {
    const x = io(); x.sameHost = () => x.sends === 0; x.landed = () => true
    expect((await confirmCodexDelivery(message, x)).acceptance).toBe('pending')
  })
  test('native receipt counts only user input, not quoted tool/assistant output', () => {
    for (const role of ['assistant', 'tool', 'developer']) expect(codexUserRecordCarries({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text: message }] } }, message)).toBe(false)
    expect(codexQueueCarries({ ...queued, text: queued.text.replace('• Messages to be submitted after next tool call', 'Transcript quote:') }, message)).toBe(false)
  })
  test('baseline excludes previous copies; includes fresh rollout; CODEX_HOME is explicitly injected', () => {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-codex-receipt-'))
    try {
      const sessions = join(root, 'sessions/2026/10/30'), cwd = join(root, 'peer')
      mkdirSync(sessions, { recursive: true }); mkdirSync(cwd)
      const history = join(root, 'history.jsonl'), p = join(sessions, 'rollout-id.jsonl')
      const meta = JSON.stringify({ type: 'session_meta', payload: { cwd, id: 'id' } }) + '\n'
      const user = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] } }) + '\n'
      const h = JSON.stringify({ session_id: 'id', text: message }) + '\n'
      writeFileSync(p, meta + user); writeFileSync(history, h)
      const b = codexReceiptBaseline(root, cwd, message)
      expect(b.landed()).toBe(false); expect(b.submitted()).toBe(false)
      appendFileSync(history, h); expect(b.submitted()).toBe(true); expect(b.landed()).toBe(false)
      writeFileSync(join(sessions, 'rollout-new.jsonl'), meta + user)
      expect(b.landed()).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
