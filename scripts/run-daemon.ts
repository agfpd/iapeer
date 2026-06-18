#!/usr/bin/env bun
// Start the iapeer router daemon on a TCP loopback port and write its URL to the
// file given as argv[2]. Used by scripts/h2-gate.sh. Set IAPEER_DAEMON_LOG=1 for
// a per-tool-call request log on stderr (caller + tool name). Stays alive until
// killed.
import { writeFileSync } from 'fs'
import { startDaemon } from '../src/daemon/index.ts'

const urlFile = process.argv[2]
const port = Number(process.env.IAPEER_PORT ?? 0)
const handle = await startDaemon({ port, host: '127.0.0.1' })
if (urlFile) writeFileSync(urlFile, handle.url ?? '')
process.stderr.write(`[run-daemon] READY ${handle.url}\n`)
await new Promise(() => {}) // keep alive
