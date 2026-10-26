import { describe, expect, test } from 'bun:test'
const parse = (s: string) => Bun.TOML.parse(s)
import { applyVoicePrompt } from './voice-prompt.ts'

const base = '[features]\nmemories = false\n\n[mcp_servers.x]\nurl = "http://h"\n'
const prompt = '## Identity\n\nYou are Darwin (Дарвин). "quoted" \\ back\n* [not a table] line\n'

describe('voice-prompt carrier', () => {
  test('one physical line before the first table; TOML round-trips the exact prompt', () => {
    const out = applyVoicePrompt(base, prompt, 'darwin.md')
    const keyLines = out.split('\n').filter(l => l.startsWith('experimental_realtime_ws_backend_prompt'))
    expect(keyLines).toHaveLength(1)
    expect(out.indexOf('experimental_realtime_ws_backend_prompt')).toBeLessThan(out.indexOf('[features]'))
    const t = parse(out) as Record<string, unknown>
    expect(t.experimental_realtime_ws_backend_prompt).toBe(prompt.trimEnd())
    expect((t.features as Record<string, unknown>).memories).toBe(false)
  })
  test('idempotent replace and clean removal', () => {
    const once = applyVoicePrompt(base, prompt, 'a.md')
    const twice = applyVoicePrompt(once, 'v2', 'b.md')
    expect(twice.match(/experimental_realtime_ws_backend_prompt/g)).toHaveLength(1)
    expect((parse(twice) as Record<string, unknown>).experimental_realtime_ws_backend_prompt).toBe('v2')
    expect(applyVoicePrompt(twice, null)).toBe(base)
  })
})
