#!/usr/bin/env bun
// Install / remove a peer's codex realtime voice prompt (docs/22-voice.md §voice-layer prompt).
//
//   bun scripts/voice-prompt.ts <peer-cwd> <prompt.md>    install or replace
//   bun scripts/voice-prompt.ts <peer-cwd> --remove       back to codex's built-in prompt
//
// Carrier: the peer's PROJECT config <cwd>/.codex/config.toml. The key
// `experimental_realtime_ws_backend_prompt` is not in codex's project-local denylist
// (config/src/loader/mod.rs PROJECT_LOCAL_CONFIG_DENYLIST, rust-v0.164.0), so it stays per peer.
// It is written as ONE physical line (TOML basic string, JSON escapes are valid TOML escapes) and
// placed before the first table header, since top-level keys must precede tables. A single line
// also survives iapeer's own section-scoped line merges of this file (launch/nativeMemory.ts).
// codex reads config at startup: the peer's codex session must be relaunched to pick it up.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const KEY = 'experimental_realtime_ws_backend_prompt'
const MARK = '# iapeer voice prompt'

export function applyVoicePrompt(configText: string, prompt: string | null, source = ''): string {
  const lines = configText.split('\n')
  const kept = lines.filter((l, i) => !(l.startsWith(MARK) || l.startsWith(`${KEY} =`) || (l.trim() === '' && lines[i - 1]?.startsWith(`${KEY} =`))))
  if (prompt === null) return kept.join('\n')
  const entry = [`${MARK}: ${source} — do not edit here, regenerate (scripts/voice-prompt.ts)`, `${KEY} = ${JSON.stringify(prompt.trimEnd())}`, '']
  const firstTable = kept.findIndex(l => /^\s*\[/.test(l))
  const at = firstTable < 0 ? kept.length : firstTable
  return [...kept.slice(0, at), ...entry, ...kept.slice(at)].join('\n')
}

if (import.meta.main) {
  const [cwd, arg] = process.argv.slice(2)
  if (!cwd || !arg) {
    console.error('usage: bun scripts/voice-prompt.ts <peer-cwd> <prompt.md>|--remove')
    process.exit(2)
  }
  const dir = join(cwd, '.codex')
  const path = join(dir, 'config.toml')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const next = arg === '--remove' ? applyVoicePrompt(current, null) : applyVoicePrompt(current, readFileSync(arg, 'utf8'), basename(arg))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, next)
  console.log(`${arg === '--remove' ? 'removed' : 'installed'}: ${path}`)
}
