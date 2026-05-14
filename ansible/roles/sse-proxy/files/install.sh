#!/bin/bash
# install.sh — idempotent installer for openclaw-sse-proxy
#
# Safe to run any number of times. Run after:
#   - First-time setup
#   - OpenClaw upgrade / reinstall
#   - Workspace wipe + restore
#
# What it does:
#   1. Verifies source files exist at ~/.openclaw/sse-proxy/
#   2. Copies the systemd unit to /etc/systemd/system/ (requires sudo)
#   3. daemon-reload + enable --now
#   4. Verifies the service is listening on :8444
#   5. Verifies Tailscale Funnel is on and pointing at :8444
#   6. Reports any drift; exits non-zero if anything is wrong

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LISTEN_PORT=8444

# All systemd units we manage (source filename = dest filename)
UNITS=(
  "openclaw-sse-proxy.service"
  "openclaw-sse-proxy-healthcheck.service"
  "openclaw-sse-proxy-healthcheck.timer"
  "openclaw-sse-proxy-logrotate.service"
  "openclaw-sse-proxy-logrotate.timer"
)
# Units that should be enabled (and started where applicable)
ENABLE_UNITS=(
  "openclaw-sse-proxy.service"
  "openclaw-sse-proxy-healthcheck.timer"
  "openclaw-sse-proxy-logrotate.timer"
)

red()    { printf "\033[31m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
hr()     { printf -- "---\n"; }

fail() {
  red "FAIL: $1"
  exit 1
}

ok() {
  green "OK:   $1"
}

note() {
  yellow "NOTE: $1"
}

echo "=== openclaw-sse-proxy installer ==="
echo "Source dir: $SCRIPT_DIR"
echo

# 1. Verify source files
for f in proxy-core.js server.js healthcheck.sh healthcheck-wrapper.sh openclaw-sse-proxy.service openclaw-sse-proxy-healthcheck.service openclaw-sse-proxy-healthcheck.timer openclaw-sse-proxy-logrotate.service openclaw-sse-proxy-logrotate.timer; do
  if [[ ! -f "$SCRIPT_DIR/$f" ]]; then
    fail "missing source file: $SCRIPT_DIR/$f"
  fi
done
ok "source files present"

# Ensure shell scripts are executable
chmod +x "$SCRIPT_DIR/healthcheck.sh" "$SCRIPT_DIR/healthcheck-wrapper.sh" "$SCRIPT_DIR/install.sh" 2>/dev/null || true
ok "script perms set"

# Ensure healthcheck.log exists and is owned by the running user (so the systemd
# unit running as User=debian can append to it). If the log was previously
# created by root (e.g. early bootstrap with a different unit), fix ownership.
LOG_FILE="$SCRIPT_DIR/healthcheck.log"
if [[ ! -e "$LOG_FILE" ]]; then
  touch "$LOG_FILE" 2>/dev/null || sudo install -o "$(id -un)" -g "$(id -gn)" -m 644 /dev/null "$LOG_FILE"
fi
if [[ -O "$LOG_FILE" ]]; then
  ok "healthcheck.log owned by current user"
else
  sudo chown "$(id -un):$(id -gn)" "$LOG_FILE" && ok "healthcheck.log chown'd to current user"
fi

# 2. Verify gateway is listening on its expected port (parse from openclaw.json)
GATEWAY_PORT="$(python3 -c 'import json,sys; print(json.load(open("/home/debian/.openclaw/openclaw.json")).get("gateway",{}).get("port") or 8443)' 2>/dev/null || echo 8443)"
echo "Gateway port from openclaw.json: $GATEWAY_PORT"
if ss -tlnp 2>/dev/null | grep -q "127.0.0.1:$GATEWAY_PORT "; then
  ok "gateway listening on :$GATEWAY_PORT"
else
  note "gateway NOT listening on :$GATEWAY_PORT — proxy will still start but upstream calls will fail until gateway is up"
fi

# Compare against the unit file's UPSTREAM_PORT
MAIN_UNIT_SRC="$SCRIPT_DIR/openclaw-sse-proxy.service"
UNIT_UPSTREAM="$(grep -E '^Environment=SSE_PROXY_UPSTREAM_PORT=' "$MAIN_UNIT_SRC" 2>/dev/null | cut -d= -f3 || echo '')"
if [[ -n "$UNIT_UPSTREAM" ]] && [[ "$UNIT_UPSTREAM" != "$GATEWAY_PORT" ]]; then
  red "WARN: unit file has SSE_PROXY_UPSTREAM_PORT=$UNIT_UPSTREAM but gateway is on $GATEWAY_PORT"
  red "      Edit $MAIN_UNIT_SRC to fix, then re-run this script."
  echo
fi

hr

# 3. Install all unit files (only those that changed)
ANY_UNIT_CHANGED=0
MAIN_UNIT_CHANGED=0
for unit in "${UNITS[@]}"; do
  src="$SCRIPT_DIR/$unit"
  dst="/etc/systemd/system/$unit"
  if [[ ! -f "$src" ]]; then
    fail "missing source unit: $src"
  fi
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    ok "unit up to date: $unit"
  else
    if sudo install -o root -g root -m 644 "$src" "$dst"; then
      ok "unit installed: $unit"
      ANY_UNIT_CHANGED=1
      [[ "$unit" == "openclaw-sse-proxy.service" ]] && MAIN_UNIT_CHANGED=1
    else
      fail "failed to install unit: $unit"
    fi
  fi
done

# 4. daemon-reload if anything changed
if [[ "$ANY_UNIT_CHANGED" == "1" ]]; then
  sudo systemctl daemon-reload || fail "daemon-reload failed"
  ok "systemd reloaded"
fi

# Enable everything we want enabled
for unit in "${ENABLE_UNITS[@]}"; do
  if ! systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    sudo systemctl enable "$unit" || fail "systemctl enable failed for $unit"
    ok "enabled: $unit"
  fi
done

# Start / restart the main proxy service if changed or not active
if [[ "$MAIN_UNIT_CHANGED" == "1" ]] || ! systemctl is-active --quiet openclaw-sse-proxy 2>/dev/null; then
  echo "Starting openclaw-sse-proxy..."
  # If something else is squatting on :8444, kill it cleanly first.
  SQUATTER=$(ss -tlnp 2>/dev/null | awk -v p=":$LISTEN_PORT " '$0 ~ p {print}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  if [[ -n "$SQUATTER" ]] && ! systemctl status openclaw-sse-proxy 2>/dev/null | grep -q "Main PID: $SQUATTER"; then
    note "killing stale process on :$LISTEN_PORT (pid=$SQUATTER)"
    sudo kill "$SQUATTER" 2>/dev/null || true
    sleep 0.5
  fi
  sudo systemctl reset-failed openclaw-sse-proxy 2>/dev/null || true
  sudo systemctl restart openclaw-sse-proxy || fail "systemctl restart failed"
  sleep 1
fi

# Start the timers (they don't auto-start on `enable` until next boot)
for timer in openclaw-sse-proxy-healthcheck.timer openclaw-sse-proxy-logrotate.timer; do
  if ! systemctl is-active --quiet "$timer" 2>/dev/null; then
    sudo systemctl start "$timer" || fail "failed to start $timer"
    ok "started: $timer"
  fi
done

# 5. Verify listening
if systemctl is-active --quiet openclaw-sse-proxy; then
  ok "service active"
else
  fail "service is not active after start; check 'journalctl -u openclaw-sse-proxy -n 30'"
fi

if ss -tlnp 2>/dev/null | grep -q "127.0.0.1:$LISTEN_PORT "; then
  ok "listening on 127.0.0.1:$LISTEN_PORT"
else
  fail "service active but not listening on :$LISTEN_PORT"
fi

# 6. Verify Tailscale Funnel
hr
FUNNEL_STATUS="$(tailscale funnel status 2>/dev/null || echo '')"
if echo "$FUNNEL_STATUS" | grep -q "Funnel on"; then
  if echo "$FUNNEL_STATUS" | grep -q "127.0.0.1:$LISTEN_PORT"; then
    ok "Tailscale Funnel is on and routes / → 127.0.0.1:$LISTEN_PORT"
  else
    note "Tailscale Funnel is on but routes to a different upstream"
    echo "$FUNNEL_STATUS"
    note "to fix: sudo tailscale funnel --bg $LISTEN_PORT"
  fi
else
  note "Tailscale Funnel is NOT publicly on"
  echo "$FUNNEL_STATUS"
  note "to fix: sudo tailscale funnel --bg $LISTEN_PORT"
fi

hr
green "=== install complete ==="
echo
echo "Quick verification commands:"
echo "  systemctl status openclaw-sse-proxy --no-pager"
echo "  tailscale funnel status"
echo "  curl -is http://127.0.0.1:$LISTEN_PORT/healthz"
echo
echo "Run healthcheck anytime: bash $SCRIPT_DIR/healthcheck.sh"
