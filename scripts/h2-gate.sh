#!/usr/bin/env bash
# =============================================================================
# H2 gate harness — reproducible proof that REAL claude/codex http MCP clients
# bind to the iapeer router daemon (canonical SDK StreamableHTTP transport) and
# call its tools, carrying their identity in the per-request X-IAPeer-Identity
# header. Re-runnable: `scripts/h2-gate.sh [target-personality]`.
#
# This script doubles as the connect-skill H2 reference — the binding configs
# below are exactly how a peer reaches the daemon. Note TWO binding forms:
#
#   • TEST binding (used here): an ephemeral `--mcp-config <file>` passed to
#     `claude -p`, and `-c mcp_servers.iap.*` overrides passed to `codex exec`.
#     No persisted approval needed.
#
#   • PRODUCTION binding (what connect-skill writes into a peer's cwd):
#       claude → project `.mcp.json`:
#         { "mcpServers": { "iap": { "type": "http",
#             "url": "http://127.0.0.1:<port>/mcp",
#             "headers": { "X-IAPeer-Identity": "<runtime>-<personality>" } } } }
#         + `.claude/settings.local.json`: { "enableAllProjectMcpServers": true }
#         (a project type:http server sits in "pending approval" without it).
#       codex → `<cwd>/.codex/config.toml`:
#         [mcp_servers.iap]
#         url = "http://127.0.0.1:<port>/mcp"
#         http_headers = { "X-IAPeer-Identity" = "<runtime>-<personality>" }
#         (YOLO/bypass auto-accepts; no extra flag).
#
# H8: the daemon listens on TCP loopback because real http MCP clients connect
# to a URL (a unix socket cannot serve them). Loopback is reachable by any local
# process → production should add a bearer token (OPEN — see the H8 bearer seam).
#
# Default target is a non-registered sentinel: the send_to_peer call is made
# (proving real-client → daemon) but nothing is delivered, so re-runs do not spam
# any peer's pane. Pass a real personality as $1 to also prove end-to-end delivery.
# =============================================================================
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-h2gate-sentinel}"
CALLER_CLAUDE="claude-iapeer"
CALLER_CODEX="codex-iapeer"
TMP="$(mktemp -d)"
URL_FILE="$TMP/url"
DAEMON_LOG="$TMP/daemon.log"
DPID=""
cleanup() { [ -n "$DPID" ] && kill "$DPID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

# ── start the daemon (TCP loopback, ephemeral port) ──────────────────────────
IAPEER_DAEMON_LOG=1 bun "$ROOT/scripts/run-daemon.ts" "$URL_FILE" >"$DAEMON_LOG" 2>&1 &
DPID=$!
for _ in $(seq 1 60); do [ -s "$URL_FILE" ] && break; sleep 0.1; done
URL="$(cat "$URL_FILE" 2>/dev/null || true)"
if [ -z "$URL" ]; then echo "FAIL: daemon did not report a URL"; cat "$DAEMON_LOG"; exit 1; fi
echo "daemon: $URL   target: $TARGET"
PROMPT="Call the MCP tool send_to_peer from the 'iap' server exactly once with personality=\"$TARGET\" and message=\"H2 gate harness probe\". It may return an error for the sentinel target — do not retry; report the tool result verbatim."

# ── claude: .mcp.json type:http + X-IAPeer-Identity header ───────────────────
cat >"$TMP/claude-mcp.json" <<JSON
{ "mcpServers": { "iap": { "type": "http", "url": "$URL", "headers": { "X-IAPeer-Identity": "$CALLER_CLAUDE" } } } }
JSON
echo; echo "── claude -p  (binding: .mcp.json type:http, header X-IAPeer-Identity=$CALLER_CLAUDE) ──"
claude -p "$PROMPT" \
  --mcp-config "$TMP/claude-mcp.json" --strict-mcp-config \
  --allowedTools "mcp__iap__send_to_peer" "mcp__iap__list_online_peers" \
  --dangerously-skip-permissions </dev/null 2>&1 \
  | grep -vE "hook: SessionStart|Warning: no stdin" | tail -6

# ── codex: config.toml [mcp_servers.iap] url + http_headers (via -c TOML) ─────
echo; echo "── codex exec  (binding: config.toml http_headers, X-IAPeer-Identity=$CALLER_CODEX) ──"
codex exec "$PROMPT" \
  -c "mcp_servers.iap.url=\"$URL\"" \
  -c "mcp_servers.iap.http_headers={ \"X-IAPeer-Identity\" = \"$CALLER_CODEX\" }" \
  --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check 2>&1 \
  | grep -vE "hook: SessionStart" | tail -6

# ── daemon-side corroboration (real clients hit the daemon) ──────────────────
echo; echo "── daemon request log ──"
grep "tools/call" "$DAEMON_LOG" || echo "(no tools/call logged)"

CLAUDE_OK="$(grep -c "tools/call .*caller=$CALLER_CLAUDE" "$DAEMON_LOG" || true)"
CODEX_OK="$(grep -c "tools/call .*caller=$CALLER_CODEX" "$DAEMON_LOG" || true)"
echo
echo "H2 GATE: claude=$([ "${CLAUDE_OK:-0}" -ge 1 ] && echo PASS || echo FAIL)  codex=$([ "${CODEX_OK:-0}" -ge 1 ] && echo PASS || echo FAIL)"
[ "${CLAUDE_OK:-0}" -ge 1 ] && [ "${CODEX_OK:-0}" -ge 1 ]
