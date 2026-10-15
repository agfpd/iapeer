import { expect, test } from 'bun:test'
import { killPtyDescendants, parseProcessTable } from './processTree.ts'

test('ps ancestry parser preserves the locale-pinned start token including a single-digit day', () => {
  expect(parseProcessTable('  101   1 ttys001 Thu Oct  1 20:57:30 2026\n 102 101 ?? Thu Oct 15 20:57:30 2026\ninvalid\n 0 0 ?? bad')).toEqual([
    { pid: 101, ppid: 1, tty: 'ttys001', token: 'Thu Oct  1 20:57:30 2026' },
    { pid: 102, ppid: 101, tty: '??', token: 'Thu Oct 15 20:57:30 2026' },
  ])
})

test('only PTY descendants, deepest first; root, siblings, orphans and detached daemon branches excluded', () => {
  const signals: number[] = []
  const result = killPtyDescendants(100, 'root', {
    table: () => [
      { pid: 100, ppid: 1, tty: 'ttys001', token: 'root' },
      { pid: 101, ppid: 100, tty: 'ttys001', token: 'wrapper' },
      { pid: 102, ppid: 101, tty: 'ttys001', token: 'server' },
      { pid: 103, ppid: 1, tty: 'ttys001', token: 'sentinel' },
      { pid: 104, ppid: 100, tty: '??', token: 'shared-daemon' },
      { pid: 105, ppid: 104, tty: '??', token: 'foreign-mcp' },
    ],
    identity: pid => ({ token: ({ 101: 'wrapper', 102: 'server' })[pid] ?? '', tty: 'ttys001' }),
    signal: pid => { signals.push(pid) },
  })
  expect(signals).toEqual([102, 101])
  expect(result).toEqual({ killed: 2, skipped: 0 })
})

test('reused/unreadable descendant PID is never signalled; reused/unreadable/non-PTY root adopts no tree', () => {
  const table = () => [
    { pid: 100, ppid: 1, tty: 'ttys001', token: 'root' },
    { pid: 101, ppid: 100, tty: 'ttys001', token: 'old' },
    { pid: 102, ppid: 100, tty: 'ttys001', token: 'unreadable' },
  ]
  const signal = () => { throw new Error('must not signal') }
  expect(killPtyDescendants(100, 'root', { table, identity: p => p === 101 ? { token: 'new', tty: 'ttys001' } : null, signal })).toEqual({ killed: 0, skipped: 2 })
  expect(killPtyDescendants(100, 'root', { table, identity: p => ({ token: p === 101 ? 'old' : 'unreadable', tty: '??' }), signal })).toEqual({ killed: 0, skipped: 2 })
  expect(killPtyDescendants(100, 'previous-root', { table, signal })).toEqual({ killed: 0, skipped: 1 })
  expect(killPtyDescendants(100, null, { table, signal })).toEqual({ killed: 0, skipped: 1 })
  expect(killPtyDescendants(100, 'root', { table: () => [], signal })).toEqual({ killed: 0, skipped: 0 })
  expect(killPtyDescendants(100, 'root', { table: () => table().map(r => ({ ...r, tty: '??' })), signal })).toEqual({ killed: 0, skipped: 1 })
})

test('invalid roots and unreadable ancestry fail closed instead of issuing a broad group kill', () => {
  for (const root of [0, -100, 1, process.pid, NaN]) expect(() => killPtyDescendants(root, 'root')).toThrow()
  expect(() => killPtyDescendants(100, 'root', { table: () => { throw new Error('ps unavailable') } })).toThrow('ps unavailable')
})
