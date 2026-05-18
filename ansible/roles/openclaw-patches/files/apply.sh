#!/usr/bin/env bash
# apply.sh — re-apply all OpenClaw dist patches.
# Idempotent: safe to run after every OpenClaw update.

set -euo pipefail

PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="${OPENCLAW_DIST_DIR:-/usr/lib/node_modules/openclaw/dist}"

if [ ! -d "$DIST_DIR" ]; then
  echo "ERROR: OpenClaw dist directory not found at $DIST_DIR" >&2
  exit 1
fi

failed=0
applied=0
already=0

for patch in "$PATCH_DIR"/*.patch.js; do
  [ -e "$patch" ] || continue
  name="$(basename "$patch")"
  echo "==> $name"
  if ! result="$(node "$patch" "$DIST_DIR" 2>&1)"; then
    echo "FAILED:"
    echo "$result" | sed 's/^/    /'
    failed=$((failed + 1))
    continue
  fi
  status="$(echo "$result" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["status"])' 2>/dev/null || echo unknown)"
  echo "    status: $status"
  case "$status" in
    applied) applied=$((applied + 1)) ;;
    already-applied) already=$((already + 1)) ;;
    *) failed=$((failed + 1)) ;;
  esac
done

echo
echo "Summary: applied=$applied already=$already failed=$failed"
exit $failed
