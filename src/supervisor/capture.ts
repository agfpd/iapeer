import { frame, FRAME_DATA, FRAME_RESIZE, makeFramer, sizePayload } from './protocol.ts'
import { readGeometry, sockPath } from './paths.ts'

/** Read the running host's OWN emulator, never the shared cross-session pane-log.
 * Legacy hosts already implement same-size attach: no resize or input is sent to the child. */
export async function captureHostViewport(runDir: string, session: string): Promise<string | null> {
  const geometry = readGeometry(runDir, session)
  if (!geometry) return null
  const { cols, rows } = geometry
  const bytes = await new Promise<Buffer | null>(resolve => {
    let conn: Awaited<ReturnType<typeof Bun.connect>> | undefined
    const chunks: Buffer[] = []
    let settled = false
    let quiet: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(quiet)
      conn?.end()
      resolve(chunks.length ? Buffer.concat(chunks) : null)
    }
    const deadline = setTimeout(finish, 1500)
    const consume = makeFramer((type, payload) => {
      if (type !== FRAME_DATA) return
      chunks.push(Buffer.from(payload))
      clearTimeout(quiet)
      quiet = setTimeout(finish, 80)
    })
    Bun.connect({ unix: sockPath(runDir, session), socket: {
      open(s) { s.write(frame(FRAME_RESIZE, sizePayload(cols, rows))) },
      data(_s, data) { consume(data) }, close() { finish() }, error() { finish() }, connectError() { finish() },
    } }).then(s => { conn = s; if (settled) s.end() }).catch(finish)
  })
  if (!bytes) return null
  const { Terminal } = await import('@xterm/headless')
  const { modelToPlainText } = await import('./render.ts')
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  try {
    await new Promise<void>(r => term.write(bytes, r))
    return modelToPlainText(term, cols, rows)
  } finally { term.dispose() }
}
