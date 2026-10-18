// Core side of the OpenCode control socket served by the core-owned plugin
// (src/opencode/iapeer-plugin.mjs). One newline-terminated JSON request per
// connection, one JSON response line back. Used for readiness, delivery, interrupt.
import { connect } from 'node:net'

export type OpencodeControlRequest =
  | { op: 'ping' }
  | { op: 'deliver'; text: string }
  | { op: 'interrupt' }
  | { op: 'select' }
  | { op: 'compact' }
  | { op: 'prepareReload'; token: string; notBefore: number }
  | { op: 'releaseReload'; token: string }

export interface OpencodeControlResponse {
  ok: boolean
  error?: string
  identity?: string
  launchID?: string
  sessionID?: string | null
  messageID?: string
  status?: string
  lastEventSeq?: number
}

export function opencodeControl(
  socketPath: string,
  request: OpencodeControlRequest,
  timeoutMs = 20000,
): Promise<OpencodeControlResponse> {
  return new Promise(resolve => {
    let buf = ''
    let settled = false
    const done = (r: OpencodeControlResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(r)
    }
    const sock = connect(socketPath)
    const timer = setTimeout(() => done({ ok: false, error: `control ${request.op}: no response within ${timeoutMs}ms` }), timeoutMs)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'))
    sock.on('data', chunk => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      try {
        done(JSON.parse(buf.slice(0, nl)) as OpencodeControlResponse)
      } catch {
        done({ ok: false, error: `control ${request.op}: malformed response` })
      }
    })
    sock.on('error', e => done({ ok: false, error: `control ${request.op}: ${e.message}` }))
    sock.on('close', () => done({ ok: false, error: `control ${request.op}: connection closed without a response` }))
  })
}
