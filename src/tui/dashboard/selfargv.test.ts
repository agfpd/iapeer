// resolveSelfCliArgv — the dashboard's suspend-and-spawn self-invocation routing.
// Regression for the live incident: the COMPILED bundle lives at
// file:///$bunfs/root/<bundle> (depth 2), so a `../../cli/index.ts` navigation
// escapes /$bunfs and drops the discriminator — the compiled dashboard then spawned
// `<binary> /cli/index.ts attach <peer>` → unknown verb → usage + exit 2
// (Enter→attach dead in `iapeer list`). The discriminator MUST be the module's own
// url, and the cli-path navigation must happen only on the src branch.
import { describe, expect, test } from 'bun:test'
import { resolveSelfCliArgv } from './run.tsx'

describe('resolveSelfCliArgv', () => {
  test('compiled bundle (file:///$bunfs/root/<bundle>) → re-invoke the binary by verb, NO src path', () => {
    // exactly the shape a `bun build --compile` standalone reports (proven by probe)
    expect(resolveSelfCliArgv('/Users/x/.local/bin/iapeer', 'file:///$bunfs/root/iapeer')).toEqual([
      '/Users/x/.local/bin/iapeer',
    ])
  })

  test('regression: the navigated-path form would have escaped /$bunfs — module url keeps the marker', () => {
    // the OLD code passed fileURLToPath(new URL('../../cli/index.ts', import.meta.url))
    // = '/cli/index.ts' (marker lost) → src branch → `<binary> /cli/index.ts attach …`.
    // With the module url as the discriminator the compiled branch is taken instead.
    const argv = resolveSelfCliArgv('/usr/local/bin/iapeer', 'file:///$bunfs/root/out.js')
    expect(argv).toHaveLength(1)
    expect(argv[0]).toBe('/usr/local/bin/iapeer')
  })

  test('src run (real on-disk module) → bun + the real cli entrypoint, resolved relative to run.tsx', () => {
    expect(
      resolveSelfCliArgv('/opt/homebrew/bin/bun', 'file:///Users/x/Projects/iapeer/src/tui/dashboard/run.tsx'),
    ).toEqual(['/opt/homebrew/bin/bun', '/Users/x/Projects/iapeer/src/cli/index.ts'])
  })
})
