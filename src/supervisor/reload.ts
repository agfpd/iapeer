// Input-fence client. Holding the connection owns a short lease; a crash/disconnect releases it.
// Old hosts ignore this frame: timeout means pending-until-natural-restart, NEVER permission to kill.
import { connect } from 'node:net'
import { FRAME_RELOAD, frame, makeFramer } from './protocol.ts'
import { sockPath } from './paths.ts'

export interface ReloadReply { ok: boolean; pending?: boolean; error?: string; resumeRef?: string }
export async function fenceHost(runDir: string, identity: string): Promise<{
  ready: ReloadReply
  retire: () => Promise<ReloadReply>
  close: () => void
}> {
  const socket = connect(sockPath(runDir, identity))
  let receive: ((r: ReloadReply) => void) | undefined
  let dead = false
  const consume = makeFramer((type, payload) => {
    if (type !== FRAME_RELOAD) return
    try { receive?.(JSON.parse(payload.toString()) as ReloadReply) }
    catch { receive?.({ ok: false, error: 'malformed fence response' }) }
  })
  socket.on('data', consume)
  const died = () => { dead = true; receive?.({ ok: false, error: 'fence connection closed' }) }
  socket.on('error', died)
  socket.on('close', died)
  const request = (op: string): Promise<ReloadReply> => new Promise(resolve => {
    if (dead) return resolve({ ok: false, error: 'fence connection closed' })
    const timer = setTimeout(() => {
      receive = undefined
      resolve({ ok: false, pending: true, error: 'hosting has no input fence; waiting for its next natural restart' })
    }, 1500)
    receive = r => { clearTimeout(timer); receive = undefined; resolve(r) }
    socket.write(frame(FRAME_RELOAD, op))
  })
  const ready = await request('acquire')
  return { ready, retire: () => request('retire'), close: () => socket.destroy() }
}
