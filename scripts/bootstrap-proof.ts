// Real Codex TUI → WebSocket/stdio bridge → real native app-server.
// Only account/read is held/faulted; startup frames and all other RPCs are native.
// Protocol: openai/codex rust-v0.164.0 codex-rs/tui/src/lib.rs; Bun WebSockets docs.
export function bootstrapProxy(native: string, env: NodeJS.ProcessEnv) {
  let held: (() => void) | undefined, reject = false, rejected = 0
  const events: unknown[] = [], children = new Set<Bun.Subprocess>()
  const server = Bun.serve<{ child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>; heldOnce?: boolean }>({
    hostname: '127.0.0.1', port: 0,
    fetch(req, server) {
      const child = Bun.spawn([native, 'app-server', '--listen', 'stdio://'], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
      children.add(child)
      if (server.upgrade(req, { data: { child } })) return
      child.kill(); return new Response('upgrade failed', { status: 400 })
    },
    websocket: {
      async open(ws) {
        const child = ws.data.child
        // Drain native stderr independently; retained for diagnosing bridge failures.
        void new Response(child.stderr).text().then(stderr => events.push({ stderr }))
        let buf = ''; const decoder = new TextDecoder()
        for await (const chunk of child.stdout) {
          buf += decoder.decode(chunk, { stream: true })
          let n: number
          while ((n = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 1); if (line.trim()) ws.send(line) }
        }
      },
      message(ws, message) {
        const text = message.toString(), request = JSON.parse(text)
        events.push({ at: Date.now(), method: request.method, id: request.id })
        if (request.method === 'account/read' && !ws.data.heldOnce) {
          ws.data.heldOnce = true
          const fail = () => { rejected++; ws.send(JSON.stringify({ id: request.id, error: { code: -32603, message: 'workspace routing discovery timed out (isolated proof)' } })) }
          if (reject && rejected) { fail(); return }
          held = () => {
            events.push({ at: Date.now(), accountReadReleased: true, reject })
            if (reject) fail()
            else ws.data.child.stdin.write(text + '\n')
          }
        } else ws.data.child.stdin.write(text + '\n')
      },
      close(ws) { ws.data.child.kill(); children.delete(ws.data.child) },
    },
  })
  return { url: `ws://127.0.0.1:${server.port}`, events, blocked: () => !!held,
    release() { const f = held; held = undefined; f?.() }, reject() { reject = true },
    close() { server.stop(true); for (const child of children) child.kill() } }
}
