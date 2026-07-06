// resolveSockDir — the ONE socket-dir resolver every socket-touching site shares
// (transport scan/resolve, lifecycle, launchdRun). Regression guard against a site
// re-hardcoding DEFAULT_SOCK_DIR, which made an IAPEER_SOCK_DIR sandbox lie (the
// session created on the override dir, the resolver scanning /tmp → false offline).

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_SOCK_DIR,
  allowedIntelligencesForRuntime,
  defaultIntelligenceForRuntime,
  isIntelligenceAllowedForRuntime,
  resolveSockDir,
} from './constants.ts'

describe('allowedIntelligencesForRuntime (A1 — identity ⊥ channel)', () => {
  test('channel runtimes carry natural OR absent (human OR faceless service bot)', () => {
    expect(allowedIntelligencesForRuntime('telegram')).toEqual(['natural', 'absent'])
    expect(allowedIntelligencesForRuntime('voicetalk')).toEqual(['natural', 'absent'])
  })
  test('service runtimes carry absent only; agentic carry artificial only', () => {
    expect(allowedIntelligencesForRuntime('notifier')).toEqual(['absent'])
    expect(allowedIntelligencesForRuntime('claude')).toEqual(['artificial'])
    expect(allowedIntelligencesForRuntime('codex')).toEqual(['artificial'])
  })
  test('the DEFAULT stays the first allowed — existing peers unchanged, absent is OPT-IN', () => {
    expect(defaultIntelligenceForRuntime('telegram')).toBe('natural') // arthur & co keep natural
    expect(allowedIntelligencesForRuntime('telegram')[0]).toBe(defaultIntelligenceForRuntime('telegram'))
  })
  test('membership: absent allowed on a channel, artificial (LLM agent) never', () => {
    expect(isIntelligenceAllowedForRuntime('telegram', 'absent')).toBe(true)
    expect(isIntelligenceAllowedForRuntime('telegram', 'natural')).toBe(true)
    expect(isIntelligenceAllowedForRuntime('telegram', 'artificial')).toBe(false)
    expect(isIntelligenceAllowedForRuntime('claude', 'absent')).toBe(false)
  })
})

describe('resolveSockDir', () => {
  test('no override → DEFAULT_SOCK_DIR (/tmp, contract sock convention)', () => {
    expect(resolveSockDir({})).toBe(DEFAULT_SOCK_DIR)
    expect(resolveSockDir({})).toBe('/tmp')
  })
  test('IAPEER_SOCK_DIR override is respected (host-wide, like IAPEER_ROOT)', () => {
    expect(resolveSockDir({ IAPEER_SOCK_DIR: '/tmp/sbx/socks' })).toBe('/tmp/sbx/socks')
  })
  test('blank/whitespace override falls back to the default (not an empty dir)', () => {
    expect(resolveSockDir({ IAPEER_SOCK_DIR: '   ' })).toBe(DEFAULT_SOCK_DIR)
    expect(resolveSockDir({ IAPEER_SOCK_DIR: '' })).toBe(DEFAULT_SOCK_DIR)
  })
  test('IAPEER_ROOT implies socket isolation: <root>/socks (boris e2e find 10.06)', () => {
    // An alt-root used to inherit GLOBAL /tmp — a sandboxed list saw PROD sessions
    // live by name collision, and sandboxed stop/start would have hit prod.
    expect(resolveSockDir({ IAPEER_ROOT: '/tmp/sbx/iapeer' })).toBe('/tmp/sbx/iapeer/socks')
  })
  test('explicit IAPEER_SOCK_DIR wins over the root-derived dir', () => {
    expect(resolveSockDir({ IAPEER_ROOT: '/tmp/sbx/iapeer', IAPEER_SOCK_DIR: '/tmp/elsewhere' })).toBe('/tmp/elsewhere')
  })
  test('prod shape (no IAPEER_ROOT, no IAPEER_SOCK_DIR) stays on /tmp — untouched', () => {
    expect(resolveSockDir({ HOME: '/Users/x' })).toBe('/tmp')
  })
})
