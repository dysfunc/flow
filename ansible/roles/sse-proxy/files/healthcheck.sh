#!/bin/bash
# healthcheck.sh — verify the openclaw-sse-proxy is wired correctly
#
# Default: reports drift, exits non-zero on any failure.
# With --repair: attempts to fix common drift (re-enables Funnel, restarts service).
#
# Useful in cron / monitoring:
#   */15 * * * * /home/debian/.openclaw/sse-proxy/healthcheck.sh --repair >> /var/log/openclaw-sse-proxy-health.log 2>&1
#
# Exit codes:
#   0 = healthy (or repaired successfully)
#   1 = unhealthy and not repaired
#   2 = bad invocation

set -u

REPAIR=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --repair) REPAIR=1 ;;
    --quiet)  QUIET=1 ;;
    -h|--help)
      cat <<EOF
healthcheck.sh — openclaw-sse-proxy health verification

Usage:
  $0              # report-only
  $0 --repair     # auto-fix common drift
  $0 --quiet      # suppress green/ok output (useful in cron)

Checks:
  1. Service is active
  2. Service listening on :8444
  3. Gateway listening on :8443
  4. Tailscale Funnel publicly on
  5. Funnel routes / → 127.0.0.1:8444
EOF
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

LISTEN_PORT=8444
GATEWAY_PORT="$(python3 -c 'import json,sys; print(json.load(open("/home/debian/.openclaw/openclaw.json")).get("gateway",{}).get("port") or 8443)' 2>/dev/null || echo 8443)"

ERRORS=0
REPAIRS=0

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { [[ "$QUIET" == "1" ]] || printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

ok() { green "  ✓ $*"; }
warn() { yellow "  ⚠ $*"; ERRORS=$((ERRORS+1)); }
err() { red "  ✗ $*"; ERRORS=$((ERRORS+1)); }
fixed() { green "  ↻ repaired: $*"; REPAIRS=$((REPAIRS+1)); }

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ "$QUIET" == "1" ]] || echo "[$ts] openclaw-sse-proxy healthcheck (repair=$REPAIR)"

# 1. Service active
if systemctl is-active --quiet openclaw-sse-proxy; then
  ok "service active"
else
  err "service NOT active"
  if [[ "$REPAIR" == "1" ]]; then
    sudo systemctl reset-failed openclaw-sse-proxy 2>/dev/null || true
    sudo systemctl restart openclaw-sse-proxy && sleep 1
    if systemctl is-active --quiet openclaw-sse-proxy; then
      fixed "service restarted"
      ERRORS=$((ERRORS-1))  # un-count, since we recovered
    fi
  fi
fi

# 2. Service listening on :8444
if ss -tlnp 2>/dev/null | grep -q "127.0.0.1:$LISTEN_PORT "; then
  ok "listening on 127.0.0.1:$LISTEN_PORT"
else
  err "NOT listening on :$LISTEN_PORT"
  if [[ "$REPAIR" == "1" ]]; then
    # If a stale node is squatting (e.g. manual test), kill it.
    SQUATTER=$(ss -tlnp 2>/dev/null | awk -v p=":$LISTEN_PORT " '$0 ~ p {print}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
    SERVICE_PID=$(systemctl show -p MainPID --value openclaw-sse-proxy)
    if [[ -n "${SQUATTER:-}" ]] && [[ "$SQUATTER" != "$SERVICE_PID" ]]; then
      sudo kill "$SQUATTER" 2>/dev/null || true
      sleep 0.5
    fi
    sudo systemctl restart openclaw-sse-proxy && sleep 1
    if ss -tlnp 2>/dev/null | grep -q "127.0.0.1:$LISTEN_PORT "; then
      fixed "now listening on :$LISTEN_PORT"
      ERRORS=$((ERRORS-1))
    fi
  fi
fi

# 3. Gateway listening on its expected port
if ss -tlnp 2>/dev/null | grep -q "127.0.0.1:$GATEWAY_PORT "; then
  ok "gateway listening on :$GATEWAY_PORT"
else
  warn "gateway NOT listening on :$GATEWAY_PORT — proxy will fail upstream calls until gateway is up"
  # We can't safely auto-restart the gateway from here; just report.
fi

# 4 + 5. Tailscale Funnel
FUNNEL_STATUS="$(tailscale funnel status 2>/dev/null || echo '')"
if echo "$FUNNEL_STATUS" | grep -q "Funnel on"; then
  ok "Tailscale Funnel publicly on"
  if echo "$FUNNEL_STATUS" | grep -q "127.0.0.1:$LISTEN_PORT"; then
    ok "Funnel routes / → 127.0.0.1:$LISTEN_PORT"
  else
    err "Funnel routes elsewhere (not :$LISTEN_PORT)"
    if [[ "$REPAIR" == "1" ]]; then
      if sudo tailscale funnel --bg "$LISTEN_PORT" >/dev/null 2>&1; then
        fixed "Funnel re-pointed to :$LISTEN_PORT"
        ERRORS=$((ERRORS-1))
      fi
    fi
  fi
else
  err "Tailscale Funnel NOT publicly on (tailnet-only or off)"
  if [[ "$REPAIR" == "1" ]]; then
    if sudo tailscale funnel --bg "$LISTEN_PORT" >/dev/null 2>&1; then
      fixed "Funnel re-enabled on :$LISTEN_PORT"
      ERRORS=$((ERRORS-1))
    fi
  fi
fi

# Summary
if [[ "$QUIET" != "1" ]] || [[ "$ERRORS" -gt 0 ]]; then
  echo
  if [[ "$ERRORS" -eq 0 ]]; then
    green "healthy (repaired=$REPAIRS)"
  else
    red "unhealthy: $ERRORS issue(s) (repaired=$REPAIRS)"
  fi
fi

# Exit clean if everything ended up healthy after repair attempts.
[[ "$ERRORS" -eq 0 ]] && exit 0 || exit 1
