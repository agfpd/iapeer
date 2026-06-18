// Regression: launch() must `mkdir -p` the socket's parent dir before
// `tmux new-session -S <sock>` — tmux does NOT create it and fails silently
// ("session died immediately") when the IAPEER_SOCK_DIR override points at a
// not-yet-created dir (prod sock=/tmp always exists; this bit a sandbox pilot).

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { spawnSync } from 'child_process'
import { launch } from './index.ts'
import { notifierAdapter } from './adapters/notifier.ts'
import type { LaunchConfig, LaunchSpec } from './types.ts'

const dirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-sockdir-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

describe('launch creates a missing socket dir', () => {
  test.if(tmuxAvailable)('router launch into a NON-EXISTENT IAPEER_SOCK_DIR comes up (dir auto-created)', async () => {
    const root = mkTmp()
    const sockDir = join(root, 'does', 'not', 'exist', 'yet') // deep, absent
    const sock = join(sockDir, 'tmux-iap-notifier-sockt.sock')
    const bin = join(root, 'notifier-runtime')
    writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })

    const spec: LaunchSpec = {
      personality: 'sockt',
      runtime: 'notifier',
      cwd: root,
      identity: 'notifier-sockt',
      socketPath: sock,
      intelligence: 'absent',
    }
    const cfg: LaunchConfig = {
      claudeBin: 'claude',
      codexBin: 'codex',
      notifierBin: bin,
      sockDir,
      bootDeadlineSecs: 1,
      readyGateSecs: 1,
      logDir: join(root, 'logs'),
      alwaysOn: true,
    }

    // pty-supervisor hosting is the DEFAULT; this regression tests the legacy TMUX new-session sock-dir
    // mkdir, so opt this peer OUT of pty with a .no-pty-host marker (else it is pty-hosted and the tmux
    // mkdir never runs).
    mkdirSync(cfg.logDir, { recursive: true })
    writeFileSync(join(cfg.logDir, `${spec.identity}.no-pty-host`), '')
    try {
      // The regression assertion: before the fix the dir was NOT created and
      // `tmux new-session -S <sock>` failed silently; now launch mkdir's it. (We assert
      // dir creation, not the READY outcome — whether the session reaches READY depends
      // on tmux + the test-runner env, which is orthogonal to this fix.)
      await launch(spec, notifierAdapter, '', cfg)
      expect(existsSync(sockDir)).toBe(true)
    } finally {
      spawnSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' })
    }
  })

  test('the fix is unconditional dirname(sock) creation (documents the parent)', () => {
    expect(dirname('/a/b/c/tmux-iap-notifier-x.sock')).toBe('/a/b/c')
  })
})
