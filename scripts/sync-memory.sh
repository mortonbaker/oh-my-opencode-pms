#!/usr/bin/env bash
# sync-memory.sh — cron-driven git push of the agent-memory store.
#
# Pushes any new entries in ~/.local/share/agent-memory/ to the
# private GitHub mirror so other tailnet machines see them on next pull.
#
# Run every 15 min via cron. Idempotent — no-op when clean.
# Exit code: 0 always (advisory; never break cron).

set -u

MEM_DIR="${AGENT_MEMORY_DIR:-$HOME/.local/share/agent-memory}"
LOG="/tmp/agent-memory-sync.log"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

if [ ! -d "$MEM_DIR/.git" ]; then
  log "ERROR: $MEM_DIR is not a git repo — run deploy/install.sh"
  exit 0
fi

cd "$MEM_DIR" || { log "ERROR: cannot cd $MEM_DIR"; exit 0; }

# Pull first so we don't push over remote changes.
git pull --rebase --autostash 2>>"$LOG" || log "WARN: pull failed (likely offline)"

# Stage everything except .git internals
git add -A 2>>"$LOG"

# Nothing to commit?
if [ -z "$(git status --porcelain)" ]; then
  log "clean — no push"
  exit 0
fi

count=$(git status --porcelain | wc -l | tr -d ' ')
host=$(hostname -s 2>/dev/null || hostname)
msg="sync: $count changes from $host at $(ts)"

git -c commit.gpgsign=false commit -m "$msg" 2>>"$LOG" || { log "ERROR: commit failed"; exit 0; }
git push 2>>"$LOG" && log "OK: $msg" || log "WARN: push failed (will retry next cron)"
