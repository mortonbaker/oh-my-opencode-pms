#!/usr/bin/env just --justfile
# justfile — canonical command runner for repeating oh-my-opencode-pms ops.
#
# Pattern: casey/just (~10k repos use it in 2026 as the modern make
# replacement). Run `just` with no args to see all recipes.
#
# Why a justfile over freeform shell?  Per Decision Memo discipline
# (Princeton policy memo + River 2026 briefing-memo guide): repeating
# operations should have ONE canonical command name so the operator never
# has to remember the underlying invocation. Aligns with the "6-inch
# putt" principle — pre-line-up the shot.

# Show all recipes when invoked with no arg
default:
    @just --list

# ---- build / test -------------------------------------------------------

# Full plugin build + cli build + governance cli build + assets
build:
    bun run build

# Run all hook + harness + agents tests
test:
    bun test src/

# Run only the hook tests we own
test-hooks:
    bun test src/hooks/ src/commands/

# Run a single test by name pattern
test-one PATTERN:
    bun test -t "{{PATTERN}}"

# Biome lint + format check (non-mutating; CI mode)
check:
    bun run check:ci

# Biome auto-fix (mutating)
fix:
    bun run check

# TypeScript typecheck only (no emit)
typecheck:
    bun run typecheck

# ---- memory / agent-mem -------------------------------------------------

# Show memory store stats
mem-stats:
    agent-mem stats

# Tail recent memories
mem-tail N="20":
    agent-mem tail -n {{N}}

# Search memories (regex)
mem-search QUERY:
    agent-mem search "{{QUERY}}"

# Force push memory store to remote (cron does this every 15 min anyway)
mem-sync:
    bash scripts/sync-memory.sh
    @cat /tmp/agent-memory-sync.log | tail -1

# ---- docs ---------------------------------------------------------------

# Regenerate AUTOGEN blocks in docs/HARNESS.md
docs-refresh:
    bash scripts/refresh-harness-doc.sh

# Show what would be regenerated without writing
docs-refresh-dry:
    @echo "(dry-run: would refresh AUTOGEN blocks in docs/HARNESS.md)"
    @cd "$(git rev-parse --show-toplevel)" && \
        ls src/hooks src/agents src/commands

# Re-run machine inventory generator
inventory:
    bash scripts/refresh-inventory.sh

# Weekly review: surface stale memories, drift, doc rot
review-weekly:
    @echo "Running weekly review (see ./scripts/weekly-review.sh)"
    @bash scripts/weekly-review.sh

# ---- installation / deployment ------------------------------------------

# Run the deploy installer (symlinks ~/.claude + ~/.config/opencode)
install:
    bash deploy/install.sh

# Smoke-test the deployment (symlinks resolve, dist current, mcps reachable)
smoke:
    @echo "=== symlinks ==="
    @for f in opencode.jsonc oh-my-opencode-pms.json agent skills plugins; do \
       tgt=$(readlink ~/.config/opencode/$f); \
       printf "  %-30s → %s\n" "$f" "$tgt"; \
     done
    @echo ""
    @echo "=== built dist contains current hooks ==="
    @grep -c 'RESEARCH-GATE\|Durable memories\|Lightweight ADR' dist/index.js | \
       awk '{print "  hook strings in dist:", $1, "/ expected: 3+"}'
    @echo ""
    @echo "=== MCP servers ==="
    @opencode mcp list 2>/dev/null | sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g' | grep '●' | awk '{print "  " $2 " " $3 " " $4}'
    @echo ""
    @echo "=== hook tests ==="
    @bun test src/hooks/ src/commands/ 2>&1 | tail -3

# ---- harness deploy (canary then fanout to tailnet peers) ---------------

# Canary deploy (atlas01) — see src/skills/harness-deploy/SKILL.md
canary:
    @echo "harness-deploy canary stage — see SKILL.md for the full protocol"
    @echo "(this is a placeholder; real canary uses the harness_deploy tool)"

# ---- adr / remember -----------------------------------------------------

# Show recent decisions (ADR records)
adr-list:
    @ls -1t ~/.local/share/agent-memory/decisions/ 2>/dev/null | head -10 || \
        echo "(no decisions yet — use /remember in opencode or  just remember <text>)"

# Append a quick decision from the CLI
remember TEXT:
    agent-mem append --type=decision --tags=cli "{{TEXT}}"
    @echo "(for a structured ADR doc, use /remember inside opencode)"

# ---- agent-stack maintenance --------------------------------------------

# Pull latest pms + agent-stack on this machine
update:
    @echo "→ pms"
    @git -C ~/Code/oh-my-opencode-pms pull --rebase --autostash
    @echo ""
    @echo "→ agent-stack"
    @git -C ~/agent-stack pull --rebase --autostash
    @echo ""
    @echo "→ agent-memory"
    @git -C ~/.local/share/agent-memory pull --rebase --autostash

# Show what's drifted across the three tracked dirs
status-all:
    @echo "=== pms ==="
    @git -C ~/Code/oh-my-opencode-pms status -sb | head -10
    @echo ""
    @echo "=== agent-stack ==="
    @git -C ~/agent-stack status -sb | head -10
    @echo ""
    @echo "=== agent-memory ==="
    @git -C ~/.local/share/agent-memory status -sb | head -10
