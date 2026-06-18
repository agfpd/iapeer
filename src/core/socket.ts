// Socket-path convention. Consolidated from inter-agent-protocol/src/lib/socket-parser.ts (wins).
// One builder/parser for /tmp/tmux-iap-<runtime>-<personality>.sock and <runtime>-<personality>.

import { basename, join } from 'path'
import {
  DEFAULT_SOCK_DIR,
  NAME_RE_SOURCE,
  RUNTIME_RE_SOURCE,
  isTmuxRuntime,
  isValidName,
  type TmuxRuntime,
} from './constants.ts'

export interface ProcessAddress {
  runtime: TmuxRuntime
  personality: string
  address: `${TmuxRuntime}-${string}`
}

const socketNameRe = new RegExp(
  `^tmux-iap-(${RUNTIME_RE_SOURCE.slice(1, -1)})-(${NAME_RE_SOURCE.slice(1, -1)})\\.sock$`,
)

export function parseSessionName(value: string): ProcessAddress | null {
  const split = value.indexOf('-')
  if (split <= 0) return null
  const runtime = value.slice(0, split)
  const personality = value.slice(split + 1)
  if (!isTmuxRuntime(runtime) || !isValidName(personality)) return null
  return {
    runtime,
    personality,
    address: value as `${TmuxRuntime}-${string}`,
  }
}

export function parseSocketPath(path: string): ProcessAddress | null {
  const m = basename(path).match(socketNameRe)
  if (!m) return null
  const runtime = m[1]
  const personality = m[2]
  if (!isTmuxRuntime(runtime) || !isValidName(personality)) return null
  return {
    runtime,
    personality,
    address: `${runtime}-${personality}` as const,
  }
}

export function buildProcessAddress(
  runtime: TmuxRuntime,
  personality: string,
): `${TmuxRuntime}-${string}` {
  return `${runtime}-${personality}` as const
}

export function buildSocketPath(
  runtime: TmuxRuntime,
  personality: string,
  sockDir = DEFAULT_SOCK_DIR,
): string {
  return join(sockDir, `tmux-iap-${runtime}-${personality}.sock`)
}
