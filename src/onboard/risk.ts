// Onboard security gate (pre-release): the operator must consciously accept the
// risk of running beta infra with live agents BEFORE onboard mutates the host
// (daemon start + peer registration). The warning text is the owner's verbatim
// disclaimer — do NOT reword it.
//
// BOUNDARY: this must never break a NON-INTERACTIVE onboard (a one-liner installer /
// automation calls onboard without a TTY). Acceptance paths:
//   • --accept-risk (CLI flag) or IAPEER_ACCEPT_RISK=1 (env) → accept, no prompt
//     (the explicit non-interactive channel);
//   • a real TTY → show the warning and require a y/yes answer;
//   • a NON-TTY without the flag → REFUSE with how-to (never a silent proceed, never
//     a hang waiting on stdin that no one will type into).

/** The owner's verbatim security disclaimer. Shown at the top of an interactive
 *  onboard and in the non-interactive refusal. Word-for-word — do not edit. */
export const ONBOARD_SECURITY_WARNING = `Security warning — please read.

iapeer is beta infrastructure for live AI agents on your machine. Expect sharp edges.

It starts a local daemon, registers peers, and routes messages between Claude Code,
Codex CLI, Telegram humans, and services. If tools, memory, or project files are
enabled, a bad prompt can make an agent do unsafe things.

iapeer is not a hostile multi-user security boundary.
Do not expose it to untrusted users, untrusted Telegram chats, or the public internet.

State, profiles, logs, memory, and runtime configuration live under ~/.iapeer and
peer-local .iapeer folders. Treat that data as sensitive.

If you are not comfortable with local daemons, filesystem access, Telegram bot tokens,
and agent tool permissions, do not continue.

Recommended baseline:
- localhost only;
- private Telegram bots/chats only;
- least-privilege project folders and tools;
- no secrets in reachable files;
- review peers, memory, logs, and configs after onboarding.

I understand this is powerful and inherently risky. Continue?`

/** How the onboard verb should react after the gate. */
export type RiskGateResult =
  | 'accepted-flag' // --accept-risk / IAPEER_ACCEPT_RISK → non-interactive accept (no prompt)
  | 'accepted-prompt' // interactive TTY answered y/yes
  | 'declined' // interactive TTY answered no → abort
  | 'refused-non-tty' // no TTY and no accept flag → refuse with how-to (never proceed)

export interface RiskGateOptions {
  /** The --accept-risk CLI flag. */
  accept?: boolean
  env?: NodeJS.ProcessEnv
  /** Override TTY detection (tests). Default: stdin AND stdout are TTYs. */
  isTty?: boolean
  /** Injectable prompt (tests). Default: a readline question on the live TTY. */
  ask?: () => Promise<string>
  /** stdout sink (default process.stdout). */
  out?: (s: string) => void
  /** stderr sink (default process.stderr). */
  errOut?: (s: string) => void
}

const RISK_ENV = 'IAPEER_ACCEPT_RISK'

function envAccepts(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes)$/i.test((env[RISK_ENV] ?? '').trim())
}

async function defaultAsk(): Promise<string> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question('')).trim()
  } finally {
    rl.close()
  }
}

/**
 * Confirm the operator accepts the onboard risk. Returns the gate outcome; the
 * caller maps a non-accept outcome to a non-zero exit. Never throws, never hangs a
 * non-interactive run: the flag/env path is silent-accept, a TTY is prompted, a
 * non-TTY without the flag is refused with the exact how-to.
 */
export async function confirmOnboardRisk(opts: RiskGateOptions = {}): Promise<RiskGateResult> {
  const env = opts.env ?? process.env
  const out = opts.out ?? ((s: string) => void process.stdout.write(s))
  const errOut = opts.errOut ?? ((s: string) => void process.stderr.write(s))

  // Non-interactive accept channel (one-liner installers / automation).
  if (opts.accept === true || envAccepts(env)) return 'accepted-flag'

  const tty = opts.isTty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true)
  if (!tty) {
    // No one to answer the prompt — refuse LOUD with how-to, never a silent proceed.
    errOut(
      `${ONBOARD_SECURITY_WARNING}\n\n` +
        `Non-interactive onboard: no TTY to confirm. Re-run with --accept-risk ` +
        `(or set ${RISK_ENV}=1) to accept this risk explicitly.\n`,
    )
    return 'refused-non-tty'
  }

  out(`${ONBOARD_SECURITY_WARNING} `)
  const ask = opts.ask ?? defaultAsk
  const answer = (await ask()).trim().toLowerCase()
  if (answer === 'y' || answer === 'yes') return 'accepted-prompt'
  out('onboard aborted — risk not accepted.\n')
  return 'declined'
}
