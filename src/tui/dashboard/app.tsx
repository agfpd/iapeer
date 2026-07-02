// DashboardApp — the live management dashboard (Ink), the tty form of `iapeer list`
// (Фаза 3 «TUI-редизайн management», эталон вкуса — Claude Code, владелец 02.07).
//
// Presents: a host header (daemon / memory / voice health), a live peer table
// (per-runtime liveness ● ○ ✕, nature, last-activity age), an optional per-peer
// event-log panel (delivery + lifecycle), and a hint footer. State is polled
// in-process (решение B1) — peers every POLL_MS, host header every HOST_POLL_MS.
//
// The app itself never touches the terminal beyond Ink: attach is an ACTION handed
// to run.tsx (suspend-and-spawn — Ink unmounts, `iapeer attach` child inherits the
// real TTY, dashboard remounts on its exit). Quit likewise. That keeps ownership of
// raw-mode/alt-screen in exactly one place (run.tsx).

import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import type { PeerListing, RuntimeLiveness } from '../../cli/index.ts'
import { clampCursor, ellipsize, filterRows, formatAge, scrollWindow } from './model.ts'
import { takeHostHeader, takePeerLog, takePeersSnapshot, type HostHeader } from './data.ts'

export type DashAction = { type: 'attach'; personality: string } | { type: 'quit' }

const POLL_MS = 2000
const HOST_POLL_MS = 10_000
const LOG_LIMIT = 12

const STATUS_GLYPH: Record<RuntimeLiveness, string> = { live: '●', asleep: '○', stopped: '✕' }
const STATUS_COLOR: Record<RuntimeLiveness, string | undefined> = { live: 'green', asleep: undefined, stopped: 'red' }

function RuntimeCells({ row }: { row: PeerListing }): React.ReactElement {
  return (
    <>
      {row.runtimes.map((s, i) => (
        <React.Fragment key={s.runtime}>
          {i > 0 ? <Text> </Text> : null}
          <Text color={STATUS_COLOR[s.status]} dimColor={s.status === 'asleep'}>
            {STATUS_GLYPH[s.status]} {s.runtime}
          </Text>
        </React.Fragment>
      ))}
    </>
  )
}

export function DashboardApp({
  env,
  onAction,
}: {
  env: NodeJS.ProcessEnv
  onAction: (a: DashAction) => void
}): React.ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [rows, setRows] = useState<PeerListing[]>(() => takePeersSnapshot(env))
  const [host, setHost] = useState<HostHeader | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())
  const [cursor, setCursor] = useState(0)
  const [filter, setFilter] = useState('')
  const [filterMode, setFilterMode] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [logLines, setLogLines] = useState<Array<{ text: string; tone: 'ok' | 'fail' | 'info' }>>([])
  // NB: a pty can report 0×0 (ws unset) — `??` alone would keep the zero, so clamp
  // through a positive-or-default helper everywhere a dimension is read.
  const dim = (v: number | undefined, d: number): number => (v && v > 0 ? v : d)
  const [size, setSize] = useState({ cols: dim(stdout?.columns, 80), rows: dim(stdout?.rows, 24) })
  const doneRef = useRef(false)

  const finish = (a: DashAction): void => {
    if (doneRef.current) return
    doneRef.current = true
    onAction(a)
    exit()
  }

  // peers + clock poll (fast), host header poll (slow), resize.
  useEffect(() => {
    const t = setInterval(() => {
      setRows(takePeersSnapshot(env))
      setNow(Date.now())
    }, POLL_MS)
    return () => clearInterval(t)
  }, [env])
  useEffect(() => {
    let gone = false
    const probe = (): void => {
      void takeHostHeader(env).then(h => {
        if (!gone) setHost(h)
      })
    }
    probe()
    const t = setInterval(probe, HOST_POLL_MS)
    return () => {
      gone = true
      clearInterval(t)
    }
  }, [env])
  useEffect(() => {
    if (!stdout) return
    const onResize = (): void => setSize({ cols: dim(stdout.columns, 80), rows: dim(stdout.rows, 24) })
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  const visible = filterRows(rows, filter)
  const cur = clampCursor(cursor, visible.length)
  const selected = visible[cur]

  // per-peer log panel poll — only while open, keyed to the selected peer.
  useEffect(() => {
    if (!logsOpen || !selected) return
    const load = (): void => setLogLines(takePeerLog(env, selected.personality, LOG_LIMIT))
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [logsOpen, selected?.personality, env])

  useInput((input, key) => {
    if (filterMode) {
      if (key.return || key.escape) setFilterMode(false)
      else if (key.backspace || key.delete) setFilter(f => f.slice(0, -1))
      else if (input && !key.ctrl && !key.meta) setFilter(f => f + input)
      setCursor(0)
      return
    }
    if (input === 'q' || (key.ctrl && input === 'c')) return finish({ type: 'quit' })
    if (key.escape) {
      if (logsOpen) setLogsOpen(false)
      else if (filter) setFilter('')
      return
    }
    if (input === '/') return setFilterMode(true)
    if (input === 'l') return setLogsOpen(o => !o)
    if (input === 'r') {
      setRows(takePeersSnapshot(env))
      setNow(Date.now())
      return
    }
    if (key.upArrow || input === 'k') return setCursor(c => clampCursor(c - 1, visible.length))
    if (key.downArrow || input === 'j') return setCursor(c => clampCursor(c + 1, visible.length))
    if (key.return && selected) return finish({ type: 'attach', personality: selected.personality })
  })

  // ── layout ──────────────────────────────────────────────────────────────────
  const liveCount = rows.filter(r => r.runtimes.some(s => s.status === 'live')).length
  // fixed rows around the table: header(1) + header-margin(1) + column line(1) +
  // "↓ N more"(1) + footer margin+line(2) + one spare against terminal rounding.
  const overhead = 7 + (logsOpen ? LOG_LIMIT + 3 : 0) + (filterMode || filter ? 1 : 0)
  const tableHeight = Math.max(3, size.rows - overhead)
  const win = scrollWindow(cur, visible.length, tableHeight)
  const nameW = Math.min(18, Math.max(6, ...visible.map(r => r.personality.length)))
  const rtW = Math.max(10, ...visible.map(r => r.runtimes.map(s => `x ${s.runtime}`).join(' ').length))
  const descW = Math.max(0, size.cols - (2 + nameW + 2 + rtW + 2 + 10 + 2 + 6 + 2) - 2)

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* host header */}
      <Box justifyContent="space-between">
        <Box>
          <Text color="cyan" bold>
            ⏺ iapeer
          </Text>
          <Text bold> peers</Text>
          <Text dimColor>
            {'  '}
            {rows.length} peers · {liveCount} live
          </Text>
        </Box>
        <Box>
          {host ? (
            <>
              <Text dimColor>v{host.version} · daemon </Text>
              <Text color={host.daemonHealthy ? 'green' : 'red'}>{host.daemonHealthy ? '●' : '✕'}</Text>
              <Text dimColor> · memory </Text>
              <Text color={host.memory.present ? 'green' : undefined} dimColor={!host.memory.present}>
                {host.memory.present ? '●' : '○'}
              </Text>
              <Text dimColor> · voice </Text>
              <Text color={host.voice.present ? 'green' : undefined} dimColor={!host.voice.present}>
                {host.voice.present ? '●' : '○'}
              </Text>
            </>
          ) : (
            <Text dimColor>probing host…</Text>
          )}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {'  '}
          {'NAME'.padEnd(nameW)} {'RUNTIMES'.padEnd(rtW)} {'NATURE'.padEnd(10)} {'ACTIVE'.padEnd(6)} DESCRIPTION
        </Text>
      </Box>

      {/* peer table (scroll window) */}
      <Box flexDirection="column">
        {visible.length === 0 ? (
          <Text dimColor> (no peers{filter ? ' match' : ' registered'})</Text>
        ) : (
          visible.slice(win.start, win.end).map((r, i) => {
            const idx = win.start + i
            const sel = idx === cur
            return (
              <Box key={r.personality}>
                <Text color={sel ? 'cyan' : undefined} bold={sel}>
                  {sel ? '❯ ' : '  '}
                  {ellipsize(r.personality, nameW).padEnd(nameW)}{' '}
                </Text>
                <Box width={rtW + 1}>
                  <RuntimeCells row={r} />
                </Box>
                <Text dimColor> {r.intelligence.padEnd(10)}</Text>
                <Text color={sel ? 'cyan' : undefined} dimColor={!sel}>
                  {' '}
                  {formatAge(r.last_active_ms, now).padEnd(6)}
                </Text>
                <Text dimColor> {ellipsize(r.description, descW)}</Text>
              </Box>
            )
          })
        )}
        {visible.length > win.end ? <Text dimColor> ↓ {visible.length - win.end} more</Text> : null}
      </Box>

      {/* per-peer log panel */}
      {logsOpen && selected ? (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Text dimColor>logs · {selected.personality} (delivery + lifecycle)</Text>
          {logLines.length === 0 ? (
            <Text dimColor>(no recent events)</Text>
          ) : (
            logLines.map((l, i) => (
              <Text key={i} color={l.tone === 'fail' ? 'red' : l.tone === 'ok' ? undefined : undefined} dimColor={l.tone !== 'fail'}>
                {ellipsize(l.text, Math.max(10, size.cols - 6))}
              </Text>
            ))
          )}
        </Box>
      ) : null}

      {/* filter + footer */}
      {filterMode ? (
        <Text>
          <Text color="cyan">/</Text>
          {filter}
          <Text color="cyan">▌</Text>
        </Text>
      ) : filter ? (
        <Text dimColor>filter: {filter} (esc to clear)</Text>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>↑↓ move · ⏎ attach · l logs · / filter · r refresh · q quit</Text>
      </Box>
    </Box>
  )
}
