#!/bin/bash
# healthcheck.sh — verify openclaw-gateway-proxy is wired correctly
#
# Default: reports drift, exits non-zero on any failure.
# With --repair: attempts to fix common drift (Funnel target, service restart).
#
# Exit codes:
#   0 = healthy (or repaired)
#   1 = unhealthy
#   2 = bad invocation
#
# Checks:
#   1. Service is active
#   2. Service listening on :8444
#   3. Gateway listening on :8443
#   4. Tailscale Funnel publicly on
#   5. Funnel routes → 127.0.0.1:8444
#   6. (Phase 2+) OpenClaw acting-user patches still applied (self-heals)
#   7. OpenClaw package mtime watcher (re-applies patches after npm updates)

set -u

REPAIR=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --repair) REPAIR=1 ;;
    --quiet)  QUIET=1 ;;
    -h|--help)
      cat <<EOF
healthcheck.sh — openclaw-gateway-proxy health verification

Usage:
  $0              # report-only
  $0 --repair     # auto-fix common drift
  $0 --quiet      # suppress green/ok output (useful in cron)
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

ok()    { green "  ✓ $*"; }
warn()  { yellow "  ⚠ $*"; ERRORS=$((ERRORS+1)); }
err()   { red "  ✗ $*"; ERRORS=$((ERRORS+1)); }
fixed() { green "  ↻ repaired: $*"; REPAIRS=$((REPAIRS+1)); }

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ "$QUIET" == "1" ]] || echo "[$ts] openclaw-gateway-proxy healthcheck (repair=$REPAIR)"

# 1. Service active
if systemctl is-active --quiet openclaw-gateway-proxy; then
  ok "service active"
else
  err "service NOT active"
  if [[ "$REPAIR" == "1" ]]; then
    sudo systemctl reset-failed openclaw-gateway-proxy 2>/dev/null || true
    sudo systemctl restart openclaw-gateway-proxy && sleep 1
    if systemctl is-active --quiet openclaw-gateway-proxy; then
      fixed "service restarted"
      ERRORS=$((ERRORS-1))
    fi
  fi
fi

# 2. Service listening
if ss -tlnp 2>/dev/null | grep -q "127.0.0.1:$LISTEN_PORT "; then
  ok "listening on 127.0.0.1:$LISTEN_PORT"
else
  err "NOT listening on :$LISTEN_PORT"
  if [[ "$REPAIR" == "1" ]]; then
    SQUATTER=$(ss -tlnp 2>/dev/null | awk -v p=":$LISTEN_PORT " '$0 ~ p {print}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
    SERVICE_PID=$(systemctl show -p MainPID --value openclaw-gateway-proxy)
    if [[ -n "${SQUATTER:-}" ]] && [[ "$SQUATTER" != "$SERVICE_PID" ]]; then
      sudo kill "$SQUATTER" 2>/dev/null || true
      sleep 0.5
    fi
    sudo systemctl restart openclaw-gateway-proxy && sleep 1
    if ss -tlnp 2>/dev/null | grep -q "127.0.0.1:$LISTEN_PORT "; then
      fixed "now listening on :$LISTEN_PORT"
      ERRORS=$((ERRORS-1))
    fi
  fi
fi

# 3. Gateway listening
if ss -tlnp 2>/dev/null | grep -q "127.0.0.1:$GATEWAY_PORT "; then
  ok "gateway listening on :$GATEWAY_PORT"
else
  warn "gateway NOT listening on :$GATEWAY_PORT"
fi

# 4 + 5. Funnel
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
  err "Tailscale Funnel NOT publicly on"
  if [[ "$REPAIR" == "1" ]]; then
    if sudo tailscale funnel --bg "$LISTEN_PORT" >/dev/null 2>&1; then
      fixed "Funnel re-enabled on :$LISTEN_PORT"
      ERRORS=$((ERRORS-1))
    fi
  fi
fi

# 5.5. Patch trust-chain integrity (security check).
#      The openclaw-patches/ tree is invoked as root via sudoers + ExecStartPre.
#      It MUST be root-owned; debian-writable files there are a privesc path.
#      This check has no auto-repair (can't safely chown without policy decision);
#      it loudly alerts if drift is detected.
PATCH_DIR_FOR_AUDIT="/home/debian/.openclaw/openclaw-patches"
if [[ -d "$PATCH_DIR_FOR_AUDIT" ]]; then
  nonroot_count=$(find "$PATCH_DIR_FOR_AUDIT" \( -not -user root -o -not -group root \) 2>/dev/null | wc -l)
  if [[ "$nonroot_count" -eq 0 ]]; then
    ok "patch trust-chain root-owned ($PATCH_DIR_FOR_AUDIT)"
  else
    err "PRIVESC RISK: $nonroot_count file(s) in $PATCH_DIR_FOR_AUDIT not owned by root"
    find "$PATCH_DIR_FOR_AUDIT" \( -not -user root -o -not -group root \) 2>/dev/null | sed 's/^/      /' >&2
    err "  Fix: sudo chown -R root:root $PATCH_DIR_FOR_AUDIT"
  fi
fi

# 6. OpenClaw dist/ patches applied (self-healing).
#    Reads ~/.openclaw/openclaw-patches/expected-signatures.txt (one grep-able
#    string per line) and asserts each appears in at least one file under
#    /usr/lib/node_modules/openclaw/dist/. On miss + --repair, runs apply.sh
#    via sudoers-allowlisted invocation, then re-asserts. Alerts only if the
#    signature is still missing after re-apply.
PATCH_DIR="/home/debian/.openclaw/openclaw-patches"
APPLY_SH="$PATCH_DIR/apply.sh"
SIG_FILE="$PATCH_DIR/expected-signatures.txt"
DIST_DIR="/usr/lib/node_modules/openclaw/dist"

check_signatures() {
  local missing=0
  while IFS= read -r sig; do
    [[ -z "$sig" || "$sig" =~ ^# ]] && continue
    if ! grep -rqsF -- "$sig" "$DIST_DIR" 2>/dev/null; then
      missing=$((missing+1))
      MISSING_SIGS+=("$sig")
    fi
  done < "$SIG_FILE"
  return $missing
}

run_apply() {
  # apply.sh writes to root-owned dist/; use the sudoers-allowlisted entry.
  # Captures full output for the log; surfaces only summary line on stdout.
  if sudo -n "$APPLY_SH" 2>&1 | sed 's/^/      /'; then
    return 0
  else
    return 1
  fi
}

if [[ -r "$SIG_FILE" && -x "$APPLY_SH" && -d "$DIST_DIR" ]]; then
  MISSING_SIGS=()
  if check_signatures; then
    while IFS= read -r sig; do
      [[ -z "$sig" || "$sig" =~ ^# ]] && continue
      ok "openclaw-patch signature present: $sig"
    done < "$SIG_FILE"
  else
    if [[ "$REPAIR" == "1" ]]; then
      yellow "  ⚠ ${#MISSING_SIGS[@]} patch signature(s) missing — running apply.sh"
      if run_apply; then
        # Re-verify after apply
        MISSING_SIGS=()
        if check_signatures; then
          fixed "openclaw patches re-applied (signatures restored)"
        else
          for sig in "${MISSING_SIGS[@]}"; do
            err "openclaw-patch signature STILL MISSING after re-apply: $sig"
          done
        fi
      else
        err "apply.sh failed during self-heal"
      fi
    else
      for sig in "${MISSING_SIGS[@]}"; do
        err "openclaw-patch signature MISSING: $sig (run apply.sh)"
      done
    fi
  fi
fi

# 7. OpenClaw npm package mtime watcher.
#    If /usr/lib/node_modules/openclaw/package.json mtime is newer than our
#    state stamp, OpenClaw was updated (or reinstalled). Re-apply patches
#    unconditionally. This catches updates that happen between healthcheck
#    cycles (e.g. seconds after npm install -g openclaw completes).
STATE_DIR="/home/debian/.openclaw/gateway-proxy/state"
STAMP_FILE="$STATE_DIR/openclaw-package.mtime"
PKG_FILE="$DIST_DIR/../package.json"

if [[ -r "$PKG_FILE" && -x "$APPLY_SH" ]]; then
  mkdir -p "$STATE_DIR"
  current_mtime="$(stat -c %Y "$PKG_FILE" 2>/dev/null || echo 0)"
  stamped_mtime="$(cat "$STAMP_FILE" 2>/dev/null || echo 0)"
  if [[ "$current_mtime" -gt "$stamped_mtime" ]]; then
    if [[ "$REPAIR" == "1" ]]; then
      yellow "  ⚠ openclaw package mtime advanced ($stamped_mtime → $current_mtime) — update detected, re-applying patches"
      if run_apply; then
        echo "$current_mtime" > "$STAMP_FILE"
        fixed "patches re-applied after openclaw update"
      else
        err "apply.sh failed after openclaw update; STAMP NOT advanced (will retry next cycle)"
      fi
    else
      warn "openclaw package mtime advanced (update detected) — run with --repair to re-apply patches"
    fi
  else
    ok "openclaw package mtime stable (no update since $stamped_mtime)"
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

[[ "$ERRORS" -eq 0 ]] && exit 0 || exit 1
