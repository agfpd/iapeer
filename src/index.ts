// @agfpd/iapeer — foundation core.
// Ф0 data layer:
export * from './core/index.ts'
export * from './storage/index.ts'
export * from './codec/index.ts'
export * from './registry/index.ts'
export * from './identity/index.ts'
// Ф1 transport + HTTP-MCP router daemon:
export * from './transport/index.ts'
export * from './daemon/index.ts'
// Ф2 lifecycle (wake-on-miss / supervise / reap):
export * from './lifecycle/index.ts'
// Ф3 launch primitive + runtime adapters + composeSystemPrompt:
export * from './launch/index.ts'
// Daemon production main — composition point (wake + supervise) + daemon plist.
// Last: it wires daemon/index ⇆ lifecycle ⇆ launch (the top of the dependency graph).
export * from './daemon/main.ts'
// Provision — one-call peer creation (identity + registry + infra plist).
export * from './provision/index.ts'
// Init — per-peer onboarding (provision + HTTP-MCP .mcp.json wiring + doctrine template).
export * from './init/index.ts'
// Install — the foundation install-phase (stable ~/.local/bin/iapeer, decoupled from src).
export * from './install/index.ts'
// Update — the cloud-only deploy path (`iapeer update`: npm latest → rebuild → restart).
export * from './update/index.ts'
// Uninstall — symmetric foundation removal (namespace-safe; refuses on a foreign fleet).
export * from './uninstall/index.ts'
// Onboard — the host-phase (idempotent marketplace registration in claude + codex).
export * from './onboard/index.ts'
// Memory slot — the declarative provider slot (контракт «Слот памяти»): status read + onboard step.
export * from './status/index.ts'
export * from './onboard/memory.ts'
// Native runtime-memory levers (slot contract §Native-память): canonized forms + verb mechanics.
export * from './launch/nativeMemory.ts'
export { composeSystemPrompt, gatherPromptInput } from './launch/composeSystemPrompt.ts'
export type { GatherPromptOptions } from './launch/composeSystemPrompt.ts'
