// Spawn-flip Ф1 serving-wiring — resolveDaemonSelfArgv picks the right re-invocation for the detached
// supervisor daemon: a real on-disk module (bun/source) runs directly; an EMBEDDED module (a compiled
// `bun build --compile` standalone, whose self path is NOT on disk) re-invokes the installed binary
// through its `supervisor` verb. The bug this guards: a bare bunfs-path invocation mis-routes through
// the CLI (unknown verb → usage), the daemon never comes up, and a hosted launch falls back to tmux.
import { describe, expect, test } from 'bun:test'
import { resolveDaemonSelfArgv } from './index.ts'

describe('resolveDaemonSelfArgv', () => {
  // Paths are the EMPIRICALLY-verified shapes: bun → real /private/... file; compiled → /$bunfs/root/...
  test('source (real on-disk module) → re-run the module directly via the runtime (bun)', () => {
    expect(resolveDaemonSelfArgv('/Users/x/.bun/bin/bun', '/Users/x/iapeer/src/supervisor/index.ts'))
      .toEqual(['/Users/x/.bun/bin/bun', '/Users/x/iapeer/src/supervisor/index.ts'])
  })

  test('compiled standalone (embedded /$bunfs path) → installed binary + `supervisor` verb', () => {
    expect(resolveDaemonSelfArgv('/Users/x/.local/bin/iapeer', '/$bunfs/root/src/supervisor/index.ts'))
      .toEqual(['/Users/x/.local/bin/iapeer', 'supervisor'])
    // The caller appends `daemon <session> <runtime> --run-dir <dir>` → `iapeer supervisor daemon …`,
    // which the CLI routes to runSupervisorCli('daemon', …). NOT a bare bunfs-path (→ usage dump).
  })
})
