// buildLaunchInvocation — the argv + child-env composition shared by the tmux launch path and the
// (cutover Block 2) supervisor serving path. Factored out of launch()'s inline build so BOTH produce
// a BYTE-IDENTICAL invocation from ONE source — parity by construction (a supervisor-served session
// must be indistinguishable from a tmux-launched one: same flags, same env, same identity). PURE
// composition: reads the per-peer launch.env + assembles the identity ABI env; no spawn, no tmux.
// The tmux path shell-quotes the argv into a new-session string; the supervisor path hands the argv
// array straight to Bun.spawn — same argv, same env, different transport.
import { homedir } from 'os'
import { CODEX_BEARER_ENV_VAR, CODEX_DUMMY_BEARER } from '../core/constants.ts'
import { readLaunchEnv } from '../storage/index.ts'
import type { LaunchAdapterConfig, LaunchSpec, RuntimeAdapter } from './types.ts'

export interface LaunchInvocation {
  /** Runtime argv: binary + flags, including the per-session system-prompt swap (claude
   *  --system-prompt-file / codex -c model_instructions_file=) and the appended PEER_START_ARGS.
   *  The tmux path shell-quotes+joins it; the supervisor path passes it to Bun.spawn verbatim. */
  argv: string[]
  /** Full child environment: base env + per-peer launch.env extras + (codex) the non-secret bearer
   *  stub + the identity ABI (PEER_PERSONALITY/RUNTIME/IDENTITY, written LAST so a stray PEER_* in
   *  launch.env can never override the resolved identity) + PATH. */
  env: NodeJS.ProcessEnv
}

/**
 * Compose the runtime invocation (argv + child env) for a fully-resolved spec — the single source
 * for both the tmux launch path and the supervisor serving path. PEER_START_ARGS from launch.env
 * append AFTER the adapter's base flags (extraArgs is last in every buildArgv); an explicit
 * spec.extraArgs (caller override) comes first, then launch.env's.
 */
export function buildLaunchInvocation(
  spec: LaunchSpec,
  adapter: RuntimeAdapter,
  cfg: LaunchAdapterConfig & { env?: NodeJS.ProcessEnv },
): LaunchInvocation {
  const env = cfg.env ?? process.env
  const launchEnv = readLaunchEnv(spec.cwd, spec.runtime)
  const specWithArgs: LaunchSpec = {
    ...spec,
    ...(launchEnv.startArgs.length > 0 ? { extraArgs: [...(spec.extraArgs ?? []), ...launchEnv.startArgs] } : {}),
    // launch.env PEER_DISALLOWED_TOOLS opt-in — an explicit spec.disallowedTools (caller override) wins;
    // else the launch.env value (undefined = key absent → adapter default, fleet unchanged).
    ...(spec.disallowedTools === undefined && launchEnv.disallowedTools !== undefined
      ? { disallowedTools: launchEnv.disallowedTools }
      : {}),
  }
  const argv = adapter.buildArgv(specWithArgs, cfg)
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ...launchEnv.env,
    // codex token-free MCP import: the bearer env var is set to the PUBLIC, non-secret stub so codex
    // flips authStatus unsupported→bearer_token and imports send_to_peer (the OPEN daemon ignores it,
    // authenticating by PEER_IDENTITY below via env_http_headers). Only for codex — claude carries its
    // identity in .mcp.json.
    ...(spec.runtime === 'codex' ? { [CODEX_BEARER_ENV_VAR]: CODEX_DUMMY_BEARER } : {}),
    PEER_PERSONALITY: spec.personality,
    PEER_RUNTIME: spec.runtime,
    PEER_IDENTITY: spec.identity,
    // В45 — a per-peer launch.env PATH override WINS: this literal sits after the launchEnv
    // spread, so `env.PATH ?? default` silently clobbered the operator's override (env.PATH
    // is nearly always set). The legacy launcher sourced the file — there PATH took effect.
    PATH:
      launchEnv.env.PATH ??
      env.PATH ??
      `${homedir()}/.bun/bin:${homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`,
  }
  // Strip the claude-code-internal session namespace from the inherited env. When a launch is
  // INITIATED from inside a running claude session (an operator CLI, or a claude peer shelling out),
  // process.env carries that session's CLAUDE_CODE_SESSION_ID + CLAUDE_CODE_CHILD_SESSION. Inherited
  // by a newly-launched claude, they make it believe it is a CHILD sub-session of the initiator → it
  // writes NO independent ~/.claude/projects transcript → newestActivityMtime(cwd) is permanently
  // null → the warm-deliver landed-confirm false-fails WHILE the message actually lands (a silent-
  // loss, the class the contract forbids). Stripping the whole namespace makes a launched claude
  // always start as a FRESH top-level session (it re-establishes its own vars), independent of who
  // initiated the launch — the env-composition analogue of the supervisor's TMUX strip. Caught live
  // by the claude-hosting canary. Harmless for codex (no CLAUDE_* usage). NOTE: a launch driven by
  // the always-on daemon already has a clean env (no claude session) — this hardens the CLI / peer-
  // initiated paths and removes the silent-loss class regardless of initiator.
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete childEnv[k]
  }
  // В59 — pin claude to the CLASSIC (main-screen) renderer. Two load-bearing effects: (1) the whole
  // supervisor model — pane-log serialize-snapshot, composer-occupancy, the ready-gate flip — assumes
  // claude's DEFAULT no-alt-screen relative-cursor rendering (the daemon census). Pinning it makes that
  // assumption UNCONDITIONAL: no future claude feature, and no mis-accepted mid-session upsell, can
  // silently switch to the alt-screen renderer and corrupt the surface the supervisor reads off. This
  // NEUTRALIZES the consequence of the В40 fullscreen-renderer nag even if a stray keystroke accepts it.
  // (2) It disables the very feature that upsell offers, so the modal has nothing to enable — expected to
  // suppress it at the SOURCE (the root-cause complement to the nag-watcher backstop). Set AFTER the
  // CLAUDE_CODE_* strip above (which would otherwise delete it); claude-only — codex/router runtimes
  // ignore CLAUDE_CODE_*. Safe by construction: claude already renders classic by default (peers boot and
  // attach today), so this pins the current behavior, it does not change it.
  if (spec.runtime === 'claude') childEnv.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1'
  return { argv, env: childEnv }
}
