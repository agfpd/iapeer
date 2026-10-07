// Native artifact acceptance, NOT a host deploy. Run from the unpacked npm package:
// bun scripts/proof-install-signature.ts [package-root]
// Real CLI installer/compiler/codesign; launchd update seams are explicitly isolated.
import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'

if (process.platform !== 'darwin') throw new Error('native signature proof requires macOS')
if (process.env.IAPEER_TEST_SANDBOX === '1') throw new Error('native proof must execute real codesign; run outside bun test')
const identity = spawnSync('/usr/bin/security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' })
if (identity.status !== 0 || !identity.stdout.includes('"iapeer Local Codesign"')) {
  throw new Error('proof requires the EXISTING local identity; it does not create one')
}

const pkg = resolve(process.argv[2] ?? join(import.meta.dir, '..'))
const fromPackage = (path: string) => import(pathToFileURL(join(pkg, path)).href)
const { installIapeer, rollbackIapeer, stampBinaryHealthy } = await fromPackage('src/install/index.ts')
const { ensureExecutableSignature } = await fromPackage('src/install/signature.ts')
const { updateIapeer } = await fromPackage('src/update/index.ts')
const { installRuntimePackage } = await fromPackage('src/runtime/deploy.ts')
const { updateRuntime } = await fromPackage('src/runtime/update.ts')
const { writeRuntimeManifest, runtimeManifestPath } = await fromPackage('src/runtime/index.ts')
const expectedVersion = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version
const root = mkdtempSync(join(tmpdir(), 'iapeer-native-signature-'))
const tools = join(root, 'tools')
const faultyTools = join(root, 'faulty-tools')
const tray = join(root, 'tray')
for (const dir of [tools, faultyTools, tray, join(root, 'home')]) mkdirSync(dir, { recursive: true })
const env = {
  ...process.env,
  HOME: join(root, 'home'),
  IAPEER_ROOT: join(root, 'state'),
  IAPEER_BIN_DIR: join(root, 'bin'),
  IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'),
  IAPEER_SOCK_DIR: join(root, 'sockets'),
  IAPEER_PROOF_SWIFTBAR_DIR: tray,
  PATH: `${tools}:${process.env.PATH ?? ''}`,
}
// SwiftBar preferences are host-global even with HOME overridden. The stock install
// discovers a pre-existing plugin dir through this isolated read-only defaults shim.
writeFileSync(join(tools, 'defaults'), '#!/bin/sh\nif [ "$1" = read ]; then printf "%s\\n" "$IAPEER_PROOF_SWIFTBAR_DIR"; else echo "proof refuses defaults write" >&2; exit 71; fi\n', { mode: 0o755 })
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
// A disposable HOME otherwise hides the existing login keychain from security.
// Permit its read/sign operations on our staged files, but refuse identity imports.
const hostHome = process.env.HOME || homedir()
writeFileSync(join(tools, 'security'), `#!/bin/sh
if [ "$1" != find-identity ]; then echo 'proof refuses keychain mutation' >&2; exit 71; fi
export HOME=${quote(hostHome)}
exec /usr/bin/security "$@"
`, { mode: 0o755 })
writeFileSync(join(tools, 'codesign'), `#!/bin/sh
export HOME=${quote(hostHome)}
exec /usr/bin/codesign "$@"
`, { mode: 0o755 })
// Fault only the compiler's OUTPUT, not signing or the installer. CLI execution is
// forwarded to the real Bun; a build exits zero with a malformed staged Mach-O.
writeFileSync(join(faultyTools, 'bun'), `#!/bin/sh
if [ "$1" = build ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --outfile ]; then shift; dd if="$IAPEER_BIN_DIR/iapeer" of="$1" bs=4096 count=1 2>/dev/null; chmod +x "$1"; exit 0; fi
    shift
  done
  exit 72
fi
exec ${quote(process.execPath)} "$@"
`, { mode: 0o755 })
const faultyEnv = { ...env, PATH: `${faultyTools}:${env.PATH}` }
const checks: string[] = []
const check = (ok: boolean, label: string) => {
  if (!ok) throw new Error(`FAIL: ${label}`)
  checks.push(label)
  console.log(`PASS: ${label}`)
}
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const installCli = (passedEnv = env) => {
  const result = spawnSync('/bin/bash', [join(pkg, 'bin/iapeer'), 'install'], {
    encoding: 'utf8', env: passedEnv, cwd: pkg, timeout: 180_000,
  })
  console.log(result.stdout)
  if (result.stderr) console.log(result.stderr)
  return result
}
const bin = join(env.IAPEER_BIN_DIR, 'iapeer')
const execute = () => {
  const result = spawnSync(bin, ['version'], { encoding: 'utf8', env, timeout: 30_000 })
  check(result.status === 0 && result.stdout.trim() === expectedVersion, 'compiled binary executes expected version')
}
try {
  let result = installCli()
  check(result.status === 0 && result.stdout.includes('signing: signed'), 'stock CLI full-payload install succeeds with existing stable identity')
  check(ensureExecutableSignature(bin, { env, repair: false }).state === 'verified', 'installed inode strictly verifies')
  execute()
  check(stampBinaryHealthy(env), 'isolated healthy stamp')
  result = installCli()
  check(result.status === 0, 'stock CLI reinstall succeeds')
  check(stampBinaryHealthy(env), 'isolated healthy stamp after reinstall')
  // Foundation has no runtime manifest; its binary/config pair is binary + daemon
  // plist. Include rollback bytes and healthy stamp in every refusal comparison.
  const paths = [bin, `${bin}.prev`, `${bin}.healthy`, join(env.IAPEER_LAUNCHAGENTS_DIR, 'com.agfpd.iapeer.plist')]
  const snapshot = () => paths.map(hash)
  const unchanged = (before: string[], label: string) => {
    check(snapshot().every((v, i) => v === before[i]), label)
    check(!existsSync(`${bin}.tmp`), 'rejected staged file removed')
    execute()
  }
  const beforeRefusal = snapshot()
  result = installCli(faultyEnv)
  check(result.status !== null && result.status !== 0 && `${result.stdout}${result.stderr}`.includes('executable signature'), 'stock CLI rejects compiler output through REAL codesign')
  unchanged(beforeRefusal, 'CLI refusal preserves binary/.prev/.healthy/daemon-plist byte-for-byte')

  let restarted = 0
  let recycled = 0
  const update = (passedEnv: typeof env) => updateIapeer({
    env: passedEnv, currentVersion: expectedVersion, force: true,
    resolveVersion: () => expectedVersion,
    runInstall: () => installCli(passedEnv).status === 0,
    // No launchctl commands or real daemon health claims in native artifact proof.
    restartDaemon: () => { restarted++; return { state: 'restarted' } },
    waitHealthy: async () => ({ healthy: true }),
    recycleInfraJobs: () => { recycled++; return [] },
    stampHealthy: () => stampBinaryHealthy(env),
  })
  const failedUpdate = await update(faultyEnv)
  check(failedUpdate.status === 'failed' && restarted === 0 && recycled === 0, 'update install refusal prevents ALL lifecycle activation calls')
  unchanged(beforeRefusal, 'update refusal preserves binary/config/rollback pair')
  const successfulUpdate = await update(env)
  check(successfulUpdate.status === 'updated' && restarted === 1 && recycled === 1, 'real successful installer passes update activation gate (lifecycle seams isolated)')
  check(ensureExecutableSignature(bin, { env, repair: false }).state === 'verified', 'updated inode strictly verifies')
  execute()

  const sameVersionEnv = { ...env, IAPEER_BIN_DIR: join(root, 'same-version-bin') }
  mkdirSync(sameVersionEnv.IAPEER_BIN_DIR)
  const sameVersionBin = join(sameVersionEnv.IAPEER_BIN_DIR, 'iapeer')
  copyFileSync(bin, sameVersionBin)
  const sameVersion = () => updateIapeer({
    env: sameVersionEnv, currentVersion: expectedVersion, resolveVersion: () => expectedVersion,
    liveDaemonVersion: () => expectedVersion,
  })
  check((await sameVersion()).status === 'already-latest', 'same-version foundation update passes REAL verify-only gate')
  writeFileSync(sameVersionBin, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
  const invalidBefore = hash(sameVersionBin)
  const invalidSameVersion = await updateIapeer({
    env: sameVersionEnv, currentVersion: expectedVersion, resolveVersion: () => expectedVersion,
    liveDaemonVersion: () => '0.0.0',
    restartDaemon: () => { throw new Error('unexpected stale-daemon activation') },
  })
  check(invalidSameVersion.status === 'failed' && invalidSameVersion.reason.includes('signature'), 'invalid same-version foundation cannot activate stale-daemon recovery')
  check(hash(sameVersionBin) === invalidBefore, 'foundation verify-only gate leaves installed bytes unchanged')

  const tiny = join(root, 'tiny.ts')
  writeFileSync(tiny, 'console.log("tiny-signature-proof")\n')
  const beforeTiny = snapshot()
  let tinyError: unknown
  try { installIapeer(tiny, env) } catch (e) { tinyError = e }
  if (tinyError) {
    console.log(`INFO: real tiny-source build rejected: ${String(tinyError)}`)
    unchanged(beforeTiny, 'real tiny-source refusal preserves binary/config/rollback pair')
  } else {
    console.log('INFO: tiny-source output is signable on this compiler; restoring full CLI')
    check(installCli().status === 0, 'restore full CLI after signable tiny-source build')
    check(stampBinaryHealthy(env), 'restored healthy stamp')
  }

  // Secondary core gate: real installed launcher signature, no provisioning or
  // restart. A custom manifest also exercises package resolution outside the map.
  const launcher = join(env.IAPEER_BIN_DIR, 'proof-runtime')
  copyFileSync(bin, launcher)
  writeRuntimeManifest({ runtime: 'proof', package: '@proof/runtime', version: '1.0.0', peers: [] }, { env })
  const unexpected = () => { throw new Error('unexpected runtime install/restart') }
  const runtimeEnv = { ...env, PATH: `${env.IAPEER_BIN_DIR}:${env.PATH}` }
  check(installRuntimePackage({ runtime: 'proof', env: runtimeEnv, runNpx: unexpected }).state === 'skipped', 'already-installed runtime passes REAL verify-only gate')
  check((await updateRuntime({ runtime: 'proof', env: runtimeEnv, npmVersion: () => '1.0.0', restartPeer: unexpected, runNpx: unexpected })).state === 'already-latest', 'already-latest runtime passes REAL verify-only gate')
  const manifestPath = runtimeManifestPath('proof', { env })
  writeFileSync(launcher, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
  const rejectedPair = [hash(launcher), hash(manifestPath)]
  check(installRuntimePackage({ runtime: 'proof', env: runtimeEnv, runNpx: unexpected }).state === 'failed', 'already-installed runtime rejects invalid launcher')
  check((await updateRuntime({ runtime: 'proof', env: runtimeEnv, npmVersion: () => '1.0.0', restartPeer: unexpected, runNpx: unexpected })).state === 'install-failed', 'already-latest runtime rejects invalid launcher before restart')
  check(hash(launcher) === rejectedPair[0] && hash(manifestPath) === rejectedPair[1], 'verify-only runtime gate preserves supplied binary/manifest without repair')

  check(rollbackIapeer(env).status === 'rolled-back', 'isolated foundation rollback succeeds')
  check(ensureExecutableSignature(bin, { env, repair: false }).state === 'verified', 'rollback inode strictly verifies')
  execute()
  console.log(JSON.stringify({ version: expectedVersion, bun: Bun.version, platform: process.platform, packageRoot: pkg, checks, lifecycle: 'injected: no live restart or daemon-health claim' }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
