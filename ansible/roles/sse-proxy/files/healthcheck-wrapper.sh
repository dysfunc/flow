#!/bin/bash
# healthcheck-wrapper.sh — thin wrapper invoked by openclaw-sse-proxy-healthcheck.service
#
# Purpose: ALWAYS log a one-line timestamped heartbeat to healthcheck.log,
# regardless of whether the underlying healthcheck script produced output.
# That way the log is also a "did the timer actually fire?" audit trail.
#
# stdout/stderr of THIS script are captured to healthcheck.log by the unit file.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/healthcheck.sh" --repair --quiet
rc=$?

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf "[%s] healthcheck exit=%d\n" "$ts" "$rc"
exit "$rc"
