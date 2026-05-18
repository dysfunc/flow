#!/bin/bash
# healthcheck-wrapper.sh — thin wrapper for openclaw-gateway-proxy-healthcheck.service
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/healthcheck.sh" --repair --quiet
rc=$?
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf "[%s] healthcheck exit=%d\n" "$ts" "$rc"
exit "$rc"
