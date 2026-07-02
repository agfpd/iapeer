// Shared TOML-key safety for the codex GLOBAL config.toml writers. codex's host-wide
// config addresses per-project state by a QUOTED-string key — `[projects."<path>"]`,
// `[hooks_trust."<source>"]`, `[mcp_servers.<name>]`. A TOML basic string treats `"`
// and `\` specially, so a key carrying either would need codex-side escaping we cannot
// guarantee round-trips; writing it raw corrupts the whole SHARED config and breaks
// codex for EVERY peer on the host. Refuse instead of guessing.
//
// Extracted from codexHooksTrust.ts (which introduced it for hooks sources) so the
// native-memory pre-trust writer reuses the exact same guard — one definition, one
// behavior, no drift.

/** Throw if `key` cannot be a raw TOML basic-string key (contains `"` or `\`). */
export function assertTomlSafeKey(key: string): void {
  if (key.includes('"') || key.includes('\\')) {
    throw new Error(`path is not TOML-key-safe (contains " or \\): ${key}`)
  }
}
