// The installed binary's own version — BAKED at build time. `bun build --compile`
// inlines this JSON import, so the standalone ~/.local/bin/iapeer reports its
// version with NO package.json present at runtime. `iapeer update` compares this
// against `npm view @agfpd/iapeer version` to decide whether a pull is needed.
//
// Single source of truth: package.json (bumped by `npm version` in the release
// flow), so the binary's version and the published npm version never drift.
import pkg from '../../package.json'

export const IAPEER_VERSION: string = (pkg as { version: string }).version
