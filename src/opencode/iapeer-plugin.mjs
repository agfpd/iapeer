// iapeer core plugin for OpenCode — the core writes this file before every launch
// (src/opencode/iapeer-plugin.mjs in @agfpd/iapeer). Do not edit the installed copy.
//
// Responsibilities (docs/20-opencode.md):
//   • the single PRODUCER of the observability ABI: events.jsonl (append-only,
//     seq monotonic across restarts) + state.json (atomic; lastEventSeq is a fence);
//   • the structural control surface: a unix socket the core uses for readiness,
//     message delivery (acknowledged only once THIS message is persisted natively),
//     interrupt and TUI session selection.
// Plain ESM, no dependencies: it runs inside OpenCode's own server worker.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA = 1
const DELIVER_ACK_MS = 15000
// Native events forwarded into the journal unchanged (type + properties).
const JOURNALED = new Set([
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.removed',
  'message.part.delta',
  'session.status',
  'session.idle',
  'session.error',
  'session.created',
  'session.updated',
  'session.compacted',
  'permission.asked',
  'permission.replied',
])

// Same layout as OpenCode's own ascending identifiers, so a core-chosen messageID
// sorts correctly in the native history.
const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
let idLast = 0
let idCounter = 0
function ascendingId(prefix) {
  const now = Date.now()
  if (now !== idLast) {
    idLast = now
    idCounter = 0
  }
  idCounter++
  const value = BigInt(now) * 0x1000n + BigInt(idCounter)
  let time = ''
  for (let i = 0; i < 6; i++) time += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return prefix + '_' + time + Array.from(bytes, b => ID_CHARS[b % 62]).join('')
}

function sessionOf(type, p) {
  if (!p || typeof p !== 'object') return null
  if (typeof p.sessionID === 'string') return p.sessionID
  if (p.info && typeof p.info.sessionID === 'string') return p.info.sessionID
  if (p.part && typeof p.part.sessionID === 'string') return p.part.sessionID
  if (type.startsWith('session.') && p.info && typeof p.info.id === 'string') return p.info.id
  return null
}

/** Last `seq` in an existing journal: read only the tail (the journal never shrinks). */
function lastSeq(path) {
  if (!existsSync(path)) return 0
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    let span = 4096
    while (true) {
      const start = Math.max(0, size - span)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      const lines = buf.toString('utf8').split('\n').filter(Boolean)
      // the first line may be cut unless we read from 0
      for (let i = lines.length - 1; i >= (start === 0 ? 0 : 1); i--) {
        try {
          const seq = JSON.parse(lines[i]).seq
          if (Number.isInteger(seq)) return seq
        } catch {}
      }
      if (start === 0) return 0
      span *= 4
    }
  } finally {
    closeSync(fd)
  }
}

async function server(input) {
  const env = process.env
  const dir = env.IAPEER_OPENCODE_DIR
  const identity = env.PEER_IDENTITY
  // Not launched by iapeer (or by an incompatible core): stay inert rather than guess.
  if (!dir || !identity) return {}
  const client = input.client
  const launchID = env.IAPEER_OPENCODE_LAUNCH_ID || ascendingId('lch')
  const paths = {
    events: join(dir, 'events.jsonl'),
    state: join(dir, 'state.json'),
    socket: join(dir, 'control.sock'),
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  let seq = lastSeq(paths.events)
  const state = {
    schema: SCHEMA,
    identity,
    cwd: input.directory,
    sessionID: env.IAPEER_OPENCODE_SESSION || null,
    launchID,
    startedAt: Date.now(),
    lastEventSeq: seq,
    lastActivityMs: Date.now(),
    status: 'starting',
  }
  function writeState() {
    const tmp = paths.state + '.' + process.pid + '.tmp'
    writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: 0o600 })
    renameSync(tmp, paths.state)
  }
  function journal(type, properties, nativeID, sessionID) {
    seq++
    const line = { schema: SCHEMA, seq, time: Date.now(), identity, launchID, sessionID: sessionID ?? null, type, properties, nativeID: nativeID ?? null }
    appendFileSync(paths.events, JSON.stringify(line) + '\n', { mode: 0o600 })
    state.lastEventSeq = seq // fence: the line above is on disk before the state write below
    state.lastActivityMs = line.time
  }

  // ── session: exactly one per identity ──────────────────────────────────────
  let ensuring
  async function ensureSession() {
    if (state.sessionID) return state.sessionID
    ensuring ??= (async () => {
      const res = await client.session.create({ body: { title: identity } })
      if (!res.data || typeof res.data.id !== 'string') throw new Error('session.create failed: ' + JSON.stringify(res.error ?? null))
      state.sessionID = res.data.id
      return state.sessionID
    })().finally(() => {
      ensuring = undefined
    })
    return ensuring
  }
  async function selectInTui() {
    if (!state.sessionID) return
    await client.tui.publish({ body: { type: 'tui.session.select', properties: { sessionID: state.sessionID } } }).catch(() => {})
  }

  // Model of the last assistant turn — compaction runs on it. Seeded from history on resume.
  let lastModel = null
  let compactedAfter = 0
  function noteModel(info) {
    if (info && info.role === 'assistant' && typeof info.providerID === 'string' && typeof info.modelID === 'string') {
      lastModel = { providerID: info.providerID, modelID: info.modelID }
      state.model = info.providerID + '/' + info.modelID // the ACTUAL model, for operators (fleet snapshot)
    }
  }

  // ── message acknowledgements: resolved by the native persist event ──────────
  const waiters = new Map()
  function awaitPersisted(messageID) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(messageID)
        reject(new Error('message ' + messageID + ' not persisted within ' + DELIVER_ACK_MS + 'ms'))
      }, DELIVER_ACK_MS)
      waiters.set(messageID, () => {
        clearTimeout(timer)
        waiters.delete(messageID)
        resolve()
      })
    })
  }

  let reloadFence = null
  let inputOperations = 0
  const pendingInputs = new Set()
  let lastNativeUserAt = 0
  async function handle(req) {
    if (reloadFence && reloadFence.until < Date.now()) reloadFence = null
    if (req && (req.op === 'deliver' || req.op === 'compact') && reloadFence) return { ok: false, error: 'session is reloading; retry shortly' }
    if (req && (req.op === 'deliver' || req.op === 'compact')) {
      inputOperations++
      try { return await handleInput(req) } finally { inputOperations-- }
    }
    return handleInput(req)
  }
  async function handleInput(req) {
    switch (req && req.op) {
      case 'prepareReload':
        if (reloadFence || inputOperations || pendingInputs.size || state.status !== 'idle' || !state.sessionID || lastNativeUserAt < req.notBefore) return { ok: false, error: 'native OpenCode is busy or accepting input' }
        reloadFence = { token: req.token, until: Date.now() + 5000 }
        return { ok: true, sessionID: state.sessionID }
      case 'releaseReload':
        if (reloadFence?.token === req.token) reloadFence = null
        return { ok: true }
      case 'ping':
        return { ok: true, identity, launchID, sessionID: state.sessionID, status: state.status, lastEventSeq: state.lastEventSeq }
      case 'deliver': {
        if (typeof req.text !== 'string' || !req.text) return { ok: false, error: 'deliver: empty text' }
        const sessionID = await ensureSession()
        const messageID = ascendingId('msg')
        pendingInputs.add(messageID)
        const persisted = awaitPersisted(messageID)
        const res = await client.session.promptAsync({
          path: { id: sessionID },
          body: { messageID, agent: 'iapeer', parts: [{ type: 'text', text: req.text }] },
        })
        if (res.error) {
          pendingInputs.delete(messageID)
          waiters.delete(messageID)
          persisted.catch(() => {})
          return { ok: false, error: 'prompt_async: ' + JSON.stringify(res.error) }
        }
        await persisted
        return { ok: true, sessionID, messageID }
      }
      case 'interrupt': {
        if (!state.sessionID) return { ok: false, error: 'no session' }
        const res = await client.session.abort({ path: { id: state.sessionID } })
        if (!res.error) pendingInputs.clear()
        return res.error ? { ok: false, error: JSON.stringify(res.error) } : { ok: true }
      }
      case 'compact': {
        // Native compaction (POST /session/:id/summarize) runs the summary turn to completion before
        // it returns; the ack additionally requires the native `session.compacted` record for THIS
        // session after the request (a silent no-op is never reported as success).
        if (!state.sessionID) return { ok: false, error: 'no session' }
        if (!lastModel) return { ok: false, error: 'nothing to compact (no assistant turn in this session yet)' }
        const before = seq
        const res = await client.session.summarize({ path: { id: state.sessionID }, body: { providerID: lastModel.providerID, modelID: lastModel.modelID } })
        if (res.error) return { ok: false, error: 'summarize: ' + JSON.stringify(res.error) }
        for (let i = 0; i < 50 && compactedAfter <= before; i++) await new Promise(r => setTimeout(r, 100))
        if (compactedAfter <= before) return { ok: false, error: 'summarize returned but no session.compacted was recorded' }
        return { ok: true, sessionID: state.sessionID, lastEventSeq: compactedAfter }
      }
      case 'select':
        await selectInTui()
        return { ok: true, sessionID: state.sessionID }
      default:
        return { ok: false, error: 'unknown op ' + JSON.stringify(req && req.op) }
    }
  }

  // ── human approval (gated, docs/17 + docs/20 OC10) ───────────────────────────
  // Native 1.19.3 never calls the `permission.ask` plugin hook, so the bridge rides the
  // `permission.asked` event: a blocking broker request per native permission, answered back
  // through the native reply route. Every failure direction is reject (fail-safe). A human who
  // answers the native TUI prompt first wins: `permission.replied` aborts the broker request,
  // the daemon sees the transport close and clears the card from every face.
  const gated = env.IAPEER_APPROVAL_MODE === 'gated'
  const fleetUrl = env.IAPEER_FLEET_URL
  const approvals = new Map()
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
  function approvalCard(p) {
    const patterns = Array.isArray(p.patterns) ? p.patterns.map(String) : []
    const meta = p.metadata && typeof p.metadata === 'object' ? p.metadata : {}
    const head = patterns.join('\n') || String(p.permission)
    const extra = Object.keys(meta).length ? '\n\n' + clip(JSON.stringify(meta, null, 2), 6000) : ''
    return { tool: String(p.permission), content: clip(head, 2000) + extra, summary: clip(`${p.permission}: ${patterns.join(' ') || '?'}`, 200) }
  }
  async function replyNative(p, response) {
    await client
      .postSessionIdPermissionsPermissionId({ path: { id: p.sessionID, permissionID: p.id }, body: { response } })
      .catch(() => {}) // already answered (human in the TUI) → native NotFound; nothing to do
  }
  async function brokerApproval(p) {
    const controller = new AbortController()
    approvals.set(p.id, controller)
    let response = 'reject'
    try {
      if (!fleetUrl) throw new Error('no IAPEER_FLEET_URL')
      const headers = { 'content-type': 'application/json' }
      if (env.IAPEER_BEARER_TOKEN) headers.authorization = 'Bearer ' + env.IAPEER_BEARER_TOKEN
      const card = approvalCard(p)
      const res = await fetch(fleetUrl + '/fleet/v1/approvals', {
        method: 'POST',
        headers,
        body: JSON.stringify({ personality: env.PEER_PERSONALITY, runtime: 'opencode', kind: 'tool', ...card }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('broker ' + res.status)
      const d = await res.json()
      if (d && d.decision === 'allow') response = 'once'
    } catch (e) {
      if (controller.signal.aborted) return // the human answered natively; never double-reply
    } finally {
      approvals.delete(p.id)
    }
    await replyNative(p, response)
  }

  // ── control socket ──────────────────────────────────────────────────────────
  rmSync(paths.socket, { force: true })
  const control = createServer(conn => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('data', chunk => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      buf = ''
      let req
      try {
        req = JSON.parse(line)
      } catch {
        conn.end(JSON.stringify({ ok: false, error: 'bad request' }) + '\n')
        return
      }
      handle(req).then(
        r => conn.end(JSON.stringify(r) + '\n'),
        e => conn.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + '\n'),
      )
    })
    conn.on('error', () => {})
  })
  await new Promise((resolve, reject) => {
    control.once('error', reject)
    control.listen(paths.socket, () => resolve())
  })

  // ── launch self-check (OC04): problems OpenCode itself tolerates silently ─────
  // A missing / throwing plugin from a fragment and an unreachable MCP server still give a «working»
  // session with surfaces silently absent. They are reported in runtime.ready.properties.warnings and
  // state.warnings — never a refusal (the session is usable), never silent.
  function tailText(path, bytes) {
    try {
      const size = statSync(path).size
      const fd = openSync(path, 'r')
      try {
        const start = Math.max(0, size - bytes)
        const buf = Buffer.alloc(size - start)
        readSync(fd, buf, 0, buf.length, start)
        return buf.toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return ''
    }
  }
  async function selfCheck() {
    const warnings = []
    try {
      const fromCore = JSON.parse(env.IAPEER_OPENCODE_WARNINGS || '[]') // launch-time facts (e.g. implicit provider)
      if (Array.isArray(fromCore)) for (const w of fromCore) if (typeof w === 'string') warnings.push(w)
    } catch {}
    try {
      const st = await client.mcp.status()
      for (const [name, s] of Object.entries((st && st.data) || {})) {
        if (s && s.status !== 'connected' && s.status !== 'disabled') warnings.push('mcp ' + name + ': ' + s.status + (s.error ? ' — ' + String(s.error).slice(0, 200) : ''))
      }
    } catch (e) {
      warnings.push('mcp status unavailable: ' + (e instanceof Error ? e.message : String(e)))
    }
    try {
      const cfg = await client.config.get()
      for (const spec of ((cfg && cfg.data && cfg.data.plugin) || [])) {
        if (typeof spec === 'string' && spec.startsWith('file://') && !existsSync(fileURLToPath(spec))) warnings.push('plugin missing: ' + spec)
      }
    } catch {}
    // Plugin load failures are only in the native log (one shared file, lines tagged run=<id>): find
    // THIS process's run id through a marker line, then its «failed to load plugin» lines.
    try {
      const marker = 'iapeer-selfcheck ' + launchID
      await client.app.log({ body: { service: 'iapeer', level: 'warn', message: marker } })
      const logFile = join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'opencode', 'log', 'opencode.log')
      let text = ''
      for (let i = 0; i < 10 && !text.includes(marker); i++) {
        await new Promise(r => setTimeout(r, 100))
        text = tailText(logFile, 4 * 1024 * 1024)
      }
      const mine = text.split('\n').find(l => l.includes(marker))
      const run = mine && (mine.match(/ run=([^ ]+)/) || [])[1]
      if (run) {
        for (const l of text.split('\n')) {
          if (l.includes(' run=' + run + ' ') && /failed to load plugin|Failed to load plugin|plugin config hook failed/.test(l)) {
            warnings.push('plugin failed: ' + l.replace(/^.*?message=/, '').slice(0, 300))
          }
        }
      }
    } catch {}
    return warnings
  }

  // Readiness runs AFTER init returns: calling the in-process client while OpenCode is
  // still loading this plugin would wait on the very instance state being built.
  // The socket is up and the session is known (fresh: created now) → runtime.ready —
  // the core's readiness signal, never a screen glyph.
  setTimeout(async () => {
    const resumed = Boolean(state.sessionID)
    try {
      const sessionID = await ensureSession()
      const got = await client.session.get({ path: { id: sessionID } })
      if (!got.data) throw new Error('session ' + sessionID + ' not found: ' + JSON.stringify(got.error ?? null))
      if (resumed) {
        const hist = await client.session.messages({ path: { id: sessionID } }).catch(() => null)
        for (const m of (hist && hist.data) || []) noteModel(m && m.info)
      }
      const warnings = await selfCheck()
      if (warnings.length) state.warnings = warnings
      else delete state.warnings
      if (state.status === 'starting') state.status = 'idle'
      journal('runtime.ready', { session: got.data, resumed, ...(warnings.length ? { warnings } : {}) }, null, sessionID)
    } catch (e) {
      state.status = 'error'
      state.error = e instanceof Error ? e.message : String(e)
      journal('runtime.error', { error: state.error }, null, state.sessionID)
    }
    writeState()
    // The TUI may not be subscribed yet; the core re-selects on demand via op:select.
    setTimeout(() => void selectInTui(), 500)
  }, 0)
  writeState()

  return {
    event: async ({ event }) => {
      const type = event && event.type
      if (!JOURNALED.has(type)) return
      const p = event.properties
      const sessionID = sessionOf(type, p)
      if (type === 'message.updated' && p && p.info && waiters.has(p.info.id)) waiters.get(p.info.id)()
      if (type === 'message.updated' && p && sessionID === state.sessionID) noteModel(p.info)
      if (type === 'message.updated' && p && sessionID === state.sessionID) {
        if (p.info?.role === 'user') lastNativeUserAt = Math.max(lastNativeUserAt, p.info.time?.created ?? 0)
        if (p.info?.role === 'assistant' && p.info.time?.completed && ['stop', 'length', 'content-filter'].includes(p.info.finish)) pendingInputs.delete(p.info.parentID)
      }
      if (gated && type === 'permission.asked' && p && typeof p.id === 'string' && !approvals.has(p.id)) void brokerApproval(p)
      if (type === 'permission.replied' && p && approvals.has(p.requestID)) approvals.get(p.requestID).abort()
      if (sessionID && sessionID === state.sessionID) {
        if (type === 'session.status' && p.status) {
          state.status = p.status.type === 'busy' || p.status.type === 'retry' ? 'busy' : p.status.type === 'idle' ? 'idle' : state.status
          delete state.error
        } else if (type === 'session.idle') state.status = 'idle'
        else if (type === 'permission.asked') state.status = 'approval'
        else if (type === 'permission.replied' && state.status === 'approval') state.status = 'busy'
        else if (type === 'session.error') {
          state.status = 'error'
          state.error = JSON.stringify(p.error ?? null)
        }
      }
      journal(type, p, event.id ?? null, sessionID)
      if (type === 'session.compacted' && sessionID === state.sessionID) compactedAfter = seq
      writeState()
    },
    dispose: async () => {
      for (const c of approvals.values()) c.abort()
      state.status = 'stopped'
      journal('runtime.stopped', { reason: 'dispose' }, null, state.sessionID)
      writeState()
      await new Promise(resolve => control.close(() => resolve()))
      rmSync(paths.socket, { force: true })
    },
  }
}

export default { id: 'iapeer', server }
