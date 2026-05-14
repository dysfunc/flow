#!/usr/bin/env bash
# Quick manual backup. Same operation as `make backup` but without ansible.
# Useful if ansible itself is broken or before running ansible upgrades.

set -euo pipefail

BACKUPS_DIR="${BACKUPS_DIR:-$HOME/backups}"
mkdir -p "$BACKUPS_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUPS_DIR/flow-state-$TIMESTAMP.tar.gz"

cd "$HOME"

tar \
  --exclude='.openclaw/logs' \
  --exclude='.openclaw/media' \
  --exclude='.openclaw/delivery-queue' \
  --exclude='.openclaw/session-delivery-queue' \
  --exclude='.openclaw/workspace/reports/data' \
  -czf "$OUT" \
  .openclaw/openclaw.json \
  .openclaw/workspace/MEMORY.md \
  .openclaw/workspace/AGENTS.md \
  .openclaw/workspace/SOUL.md \
  .openclaw/workspace/USER.md \
  .openclaw/workspace/IDENTITY.md \
  .openclaw/workspace/TOOLS.md \
  .openclaw/workspace/HEARTBEAT.md \
  .openclaw/workspace/patches \
  .openclaw/workspace/skills \
  .openclaw/sse-proxy \
  searxng-data/settings.yml \
  2>&1 | grep -v 'Removing leading' || true

SIZE_KB=$(($(stat -c%s "$OUT") / 1024))
echo "✓ Backup: $OUT (${SIZE_KB} KB)"
