---
name: roster-print
description: Print the active opencode harness environment — preset, pantheon roster, model bindings, plugin stack, and dispatch syntax. Use at session start or whenever the orchestrator is unsure what subagents are reachable. Triggers include "what agents do I have", "roster", "ping all agents", "what harness am I in", "/roster-print".
---

# Roster Print

Print a concise environment self-description so the orchestrator (or operator)
has crystal clarity about what's wired up at any given moment. This is the
deterministic answer to "what subagents can I actually spawn here?".

## When to run

- At session start if the orchestrator hasn't yet read the environment
- When `@fixer` (or any pantheon role) doesn't work as expected
- After switching presets via `/preset`
- After editing `~/.config/opencode/oh-my-opencode-pms.json`
- Whenever the operator asks "what agents do I have"

## Procedure

Run these commands in order and print the consolidated output:

```bash
# 1. Harness identification
echo "=== HARNESS ==="
cat ~/.config/opencode/opencode.jsonc | head -40

# 2. Active preset + full roster
echo ""
echo "=== ACTIVE PRESET ==="
jq -r '.preset' ~/.config/opencode/oh-my-opencode-pms.json

echo ""
echo "=== ROSTER (model · variant · skills · mcps) ==="
jq -r '
  .preset as $p |
  .presets[$p] | to_entries[] |
  "\(.key)\t\(.value.model)\t\(.value.variant // "-")\t\((.value.skills // []) | join(","))\t\((.value.mcps // []) | join(","))"
' ~/.config/opencode/oh-my-opencode-pms.json | column -t -s $'\t'

# 3. Custom .md subagents (rare)
echo ""
echo "=== .md SUBAGENTS ==="
ls -1 ~/.config/opencode/agent/ ~/.claude/agents/ 2>/dev/null | sort -u

# 4. Models opencode can actually reach (slow — only if --full)
if [ "$1" = "--full" ]; then
  echo ""
  echo "=== AVAILABLE MODELS ==="
  opencode models 2>/dev/null | head -50
fi

# 5. Dispatch reminder
cat <<'EOF'

=== DISPATCH ===
Auto: opencode's `task` tool routes per orchestrator delegation rules.
Manual: type `@agentname <task>` in your reply text.
Subtask: `/subtask <description>` for a bounded child worker.
EOF
```

## Output format

A single consolidated report. Operator skims it; orchestrator parses the
roster table to know which roles are live.

## Cost target

Pure shell + jq. Zero tokens. Sub-second on any machine.

## Failure modes

- `oh-my-opencode-pms.json` missing → emit a clear "pms plugin not configured" notice and a pointer to `bunx oh-my-opencode-pms@latest install`.
- `opencode.jsonc` missing → emit "not in opencode; you are in vanilla Claude Code or some other runtime".
- `jq` missing → fall back to `cat` and tell the operator to install jq.
