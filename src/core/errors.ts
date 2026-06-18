// Result type + IapError. Consolidated from inter-agent-protocol/src/lib/errors.ts (as-is).

export class IapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IapError'
  }
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: IapError }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err<T = never>(message: string): Result<T> {
  return { ok: false, error: new IapError(message) }
}
