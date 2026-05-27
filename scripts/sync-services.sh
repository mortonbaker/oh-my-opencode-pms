#!/usr/bin/env bash
# sync-services.sh — full service-registry refresh cycle for this machine.
#
# Pipeline:
#   1. collect-services-local.sh → writes machines/<host>.json
#   2. aggregate-services.sh     → rebuilds REGISTRY.md
#   3. sync-memory.sh            → git pull + commit + push to GitHub
#
# Designed to run from cron every 15 min. Idempotent. Always exits 0.

set -u

PMS="${PMS_ROOT:-$HOME/Code/oh-my-opencode-pms}"
LOG="/tmp/services-sync.log"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

log "=== sync-services start ==="

bash "$PMS/scripts/collect-services-local.sh" >> "$LOG" 2>&1 \
  || log "WARN: collect failed"

bash "$PMS/scripts/aggregate-services.sh" >> "$LOG" 2>&1 \
  || log "WARN: aggregate failed"

bash "$PMS/scripts/sync-memory.sh" \
  || log "WARN: sync-memory exited non-zero"

log "=== sync-services done ==="
exit 0
