#!/bin/sh
# iapeer installer — https://github.com/agfpd/iapeer
#
#   curl -fsSL https://agfpd.github.io/iapeer/install.sh | sh
#
# What it does, in order:
#   1. checks the OS (macOS only for now; other OSes exit cleanly with a pointer)
#   2. ensures `bun` is on PATH (installs it from bun.sh if missing — the
#      foundation is a Bun project and ships no precompiled JS)
#   3. installs @agfpd/iapeer (compiles the stable ~/.local/bin/iapeer binary +
#      the ~/.iapeer scaffold + the always-on daemon plist)
#   4. makes sure ~/.local/bin is on your PATH
#   5. prints a NEXT-STEP — run `iapeer onboard` yourself in a normal terminal.
#      The interactive wizard needs a real TTY; this installer never runs it under
#      curl|sh (a raw-mode prompt fed by the script pipe would wedge). Onboard then
#      surfaces the security checks + asks before installing the memory provider.
#
# Prefer not to pipe to a shell? The README documents the same steps run by hand:
#   https://github.com/agfpd/iapeer#install
#
# Preview without changing anything:  IAPEER_INSTALL_DRYRUN=1 sh install.sh
set -eu

DRYRUN="${IAPEER_INSTALL_DRYRUN:-0}"
ROADMAP_URL="https://github.com/agfpd/iapeer#roadmap"

say()  { printf 'iapeer: %s\n' "$1"; }
warn() { printf 'iapeer: %s\n' "$1" >&2; }
run()  { # run a mutating step, or just describe it under dry-run
  if [ "$DRYRUN" = "1" ]; then printf '  [dry-run] would: %s\n' "$*"; else eval "$*"; fi
}

# ── 1. OS gate — macOS only for now ─────────────────────────────────────────
OS="$(uname -s 2>/dev/null || echo unknown)"
if [ "$OS" != "Darwin" ]; then
  say "only macOS is supported right now (detected: $OS)."
  say "Linux is on the roadmap — $ROADMAP_URL"
  exit 0   # a clean, expected outcome — not an error
fi
say "macOS detected."

# ── 2. bun — the required runtime ───────────────────────────────────────────
if command -v bun >/dev/null 2>&1; then
  say "bun found ($(bun --version 2>/dev/null || echo '?'))."
else
  say "bun not found — installing it from https://bun.sh …"
  run 'curl -fsSL https://bun.sh/install | bash'
  # bun installs to $BUN_INSTALL (default ~/.bun); put it on PATH for this run
  BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  PATH="$BUN_INSTALL/bin:$PATH"
  export PATH
  if [ "$DRYRUN" != "1" ] && ! command -v bun >/dev/null 2>&1; then
    warn "bun installation did not put 'bun' on PATH. Install it manually (https://bun.sh) and re-run."
    exit 1
  fi
fi

# ── 3. install @agfpd/iapeer (builds the binary + scaffold + daemon plist) ───
# Pin the EXACT latest version. A bare `bunx @agfpd/iapeer` can reuse a STALE
# locally-cached package (bun: "checks for a locally installed package first"), so
# a re-install on a non-pristine machine may rebuild an OLD binary. Resolving the
# exact version from the npm registry (curl — no npm needed) forces a fresh fetch.
IAPEER_PKG='@agfpd/iapeer'
IAPEER_VER="$(curl -fsSL https://registry.npmjs.org/@agfpd/iapeer/latest 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1)"
if [ -n "$IAPEER_VER" ]; then
  IAPEER_PKG="@agfpd/iapeer@$IAPEER_VER"
else
  IAPEER_PKG='@agfpd/iapeer@latest'
  warn "could not resolve exact version from the registry — falling back to @latest"
fi
# Heads-up BEFORE the build code-signs the binary (no surprise: a mid-install Mac
# password prompt otherwise reads as a bug to a new user).
say "installing $IAPEER_PKG — this compiles and code-signs ~/.local/bin/iapeer."
say "macOS may ask for your LOGIN KEYCHAIN PASSWORD — that is the local signing"
say "identity that keeps Full Disk Access across updates. It's expected; allow it."
run "bunx $IAPEER_PKG"

# ── 4. ensure ~/.local/bin is on PATH (now, and for future shells) ──────────
LOCAL_BIN="$HOME/.local/bin"
IAPEER_BIN="$LOCAL_BIN/iapeer"
case ":${PATH}:" in
  *":${LOCAL_BIN}:"*) : ;;  # already there
  *)
    PATH="${LOCAL_BIN}:${PATH}"; export PATH
    # persist for future shells in the right profile (idempotent)
    case "${SHELL:-}" in
      *zsh)  PROFILE="$HOME/.zshrc" ;;
      *bash) PROFILE="$HOME/.bash_profile" ;;
      *)     PROFILE="$HOME/.profile" ;;
    esac
    # literal text written to the profile — $HOME/$PATH must expand at shell start, not now
    # shellcheck disable=SC2016
    LINE='export PATH="$HOME/.local/bin:$PATH"'
    if [ "$DRYRUN" = "1" ]; then
      printf '  [dry-run] would add ~/.local/bin to PATH in %s\n' "$PROFILE"
    elif [ -f "$PROFILE" ] && grep -qF "$LINE" "$PROFILE" 2>/dev/null; then
      : # already persisted
    else
      printf '\n# Added by the iapeer installer\n%s\n' "$LINE" >> "$PROFILE"
      say "added ~/.local/bin to PATH in $PROFILE (open a new terminal to pick it up)."
    fi
    ;;
esac

# ── 5. installed — onboard runs SEPARATELY in a real terminal (NOT from here) ──
# We deliberately do NOT run `iapeer onboard` from this script. Under `curl … | sh`
# this process's stdin is the script (a pipe), not the keyboard; Bun's interactive
# raw-mode reader does not receive keys from a redirect-opened /dev/tty, so an
# onboard prompt would wedge (no echo, Ctrl-C swallowed). Onboard is an interactive
# TUI and must run in a REAL inherited terminal. So: install here, hand the next
# step to a normal terminal.
say "installed."
if [ "$DRYRUN" = "1" ]; then
  printf '  [dry-run] would print the next-step (open a normal terminal → run: iapeer onboard)\n'
  exit 0
fi
printf '\n'
printf 'Next: finish setup with the onboarding wizard — in a NORMAL terminal (not a pipe).\n'
printf 'Open a new terminal window (so your PATH picks up ~/.local/bin), then run:\n'
printf '\n'
printf '    iapeer onboard\n'
printf '\n'
printf 'It reviews security, detects your agent runtimes, and sets up shared memory.\n'
printf '(Or run it right now by full path: %s onboard)\n' "$IAPEER_BIN"
