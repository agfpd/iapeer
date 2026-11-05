// Real isolated CLI proof. No daemon/fleet/runtime processes or network calls.
// IAPEER_TEST_SANDBOX=1 bun scripts/proof-runtime-discovery.ts [source-root] [--expect-bug]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { upsertPeer } from '../src/registry/index.ts'
import { writePeerProfileAtomic } from '../src/identity/index.ts'

if (process.env.IAPEER_TEST_SANDBOX !== '1') throw new Error('proof requires IAPEER_TEST_SANDBOX=1')
const args = process.argv.slice(2)
const expectBug = args.includes('--expect-bug')
const source = resolve(args.find(a => !a.startsWith('--')) ?? join(import.meta.dir, '..'))
const { discoverPeerRuntimes } = await import(pathToFileURL(join(source, 'src/identity/index.ts')).href)
const root = mkdtempSync(join(tmpdir(), 'iapeer-discovery-proof-'))
const cwd = join(root, 'peer')
const env = { ...process.env, HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), IAPEER_ROOT: join(root, 'state'), IAPEER_LAUNCHAGENTS_DIR: join(root, 'launchagents'), IAPEER_SOCK_DIR: join(root, 'sockets') }
const check = (ok: boolean, label: string) => { if (!ok) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`) }
try {
  mkdirSync(join(cwd, '.iapeer', 'runtimes', 'opencode'), { recursive: true })
  const discovered = discoverPeerRuntimes(cwd, 'claude')
  console.log(JSON.stringify({ source, discovered, expectBug }))
  check(discovered.includes('opencode') === expectBug, expectBug ? 'baseline falsely discovers empty scope' : 'empty scope does not declare an endpoint')
  writePeerProfileAtomic(cwd, { personality: 'peer', runtime: 'claude', runtimes: ['claude'], intelligence: 'artificial', description: 'Isolated discovery proof' })
  await upsertPeer({ personality: 'peer', runtime: 'claude', cwd, intelligence: 'artificial', description: 'Isolated discovery proof' }, { env })
  const profile = readFileSync(join(cwd, '.iapeer', 'peer-profile.json'), 'utf8')
  const run = () => Bun.spawnSync([process.execPath, join(source, 'src/cli/index.ts'), 'verify', '--json'], { env })
  const before = run()
  console.log(JSON.stringify({ stage: 'unwired', code: before.exitCode, output: before.stdout.toString() }))
  check(before.exitCode === (expectBug ? 0 : 1), expectBug ? 'baseline falsely verifies unwired endpoint' : 'unwired endpoint fails real verify CLI')
  if (!expectBug) check(JSON.parse(before.stdout.toString()).runtimeWiring.length === 1, 'JSON reports actionable wiring issue')
  writeFileSync(join(cwd, '.mcp.json'), '{"mcpServers":{"iapeer":{"type":"http","url":"http://127.0.0.1:8765/mcp"}}}')
  const after = run()
  check(after.exitCode === 0, 'wired endpoint passes real verify CLI without contacting daemon')
  check(readFileSync(join(cwd, '.iapeer', 'peer-profile.json'), 'utf8') === profile, 'verify leaves profile unchanged')
} finally { rmSync(root, { recursive: true, force: true }) }
