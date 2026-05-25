#!/usr/bin/env bash
# refresh-harness-doc.sh — regenerate AUTOGEN blocks inside docs/HARNESS.md.
#
# Mirrors russellmoss/agent-guard pattern (Feb 2026): pre-commit hook
# regenerates inventory docs + stages them. Never blocks commits.
# Falls back to "prompt mode" stderr if any regen step fails.
#
# Updates ONLY content between markers (preserving hand-written prose):
#
#   <!-- AUTOGEN:hooks --> ... <!-- /AUTOGEN:hooks -->
#   <!-- AUTOGEN:agents --> ... <!-- /AUTOGEN:agents -->
#   <!-- AUTOGEN:skills --> ... <!-- /AUTOGEN:skills -->
#
# Idempotent; safe to run repeatedly.

set -u

REPO="${PMS_ROOT:-$HOME/Code/oh-my-opencode-pms}"
DOC="$REPO/docs/HARNESS.md"

if [ ! -f "$DOC" ]; then
  echo "refresh-harness-doc: $DOC missing — abort" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Replace the content between marker pairs in $DOC with stdin content.
# Usage:  generate_block "hooks" < new-content.txt
replace_block() {
  local marker="$1"
  local start="<!-- AUTOGEN:${marker} -->"
  local end="<!-- /AUTOGEN:${marker} -->"
  local body
  body="$(cat)"

  python3 - "$DOC" "$start" "$end" "$body" <<'PY'
import sys, re
path, start, end, body = sys.argv[1:5]
with open(path) as f:
    src = f.read()
pattern = re.compile(
    r'(' + re.escape(start) + r')(.*?)(' + re.escape(end) + r')',
    re.DOTALL,
)
if not pattern.search(src):
    # No marker present yet — append a new section at end of file
    block = f"\n\n{start}\n{body}\n{end}\n"
    new = src.rstrip() + block
else:
    new = pattern.sub(lambda m: f"{m.group(1)}\n{body}\n{m.group(3)}", src)
if new != src:
    with open(path, 'w') as f:
        f.write(new)
    print(f"refresh-harness-doc: updated AUTOGEN:{start[15:-4]}", file=sys.stderr)
PY
}

# ---------------------------------------------------------------------------
# Generators (each reads source, emits markdown, calls replace_block)
# ---------------------------------------------------------------------------

generate_hooks() {
  {
    echo "| Hook | File | Event |"
    echo "|---|---|---|"
    for d in "$REPO"/src/hooks/*/; do
      [ -d "$d" ] || continue
      name="$(basename "$d")"
      idx="$d/index.ts"
      [ -f "$idx" ] || continue
      # Detect primary event by grepping the keys most likely registered
      event=$(grep -oE "'(experimental\.[a-z.]+|chat\.[a-z]+|tool\.[a-z.]+|session\.[a-z]+)'" "$idx" 2>/dev/null \
              | sort -u | head -3 | paste -sd ',' -)
      [ -z "$event" ] && event="(see source)"
      echo "| \`$name\` | \`src/hooks/$name/index.ts\` | \`$event\` |"
    done
    # Also include hooks defined as bare files (not dirs)
    for f in "$REPO"/src/hooks/*.ts; do
      [ -f "$f" ] || continue
      [[ "$f" == *.test.ts ]] && continue
      [[ "$f" == */index.ts ]] && continue
      name="$(basename "$f" .ts)"
      event=$(grep -oE "'(chat\.[a-z]+|tool\.[a-z.]+|session\.[a-z]+)'" "$f" 2>/dev/null \
              | sort -u | head -3 | paste -sd ',' -)
      [ -z "$event" ] && event="(see source)"
      echo "| \`$name\` | \`src/hooks/$name.ts\` | \`$event\` |"
    done
    # Plus harness/ sub-hooks
    for f in "$REPO"/src/harness/{criteria-validator,parallel-detector,dispatch-judge}.ts; do
      [ -f "$f" ] || continue
      name="harness/$(basename "$f" .ts)"
      echo "| \`$name\` | \`src/$name.ts\` | tool.execute.before / tool.execute.after |"
    done
  }
}

generate_agents() {
  {
    echo "| Agent | File |"
    echo "|---|---|"
    for f in "$REPO"/src/agents/*.ts; do
      [ -f "$f" ] || continue
      [[ "$f" == *.test.ts ]] && continue
      [[ "$f" == */index.ts ]] && continue
      name="$(basename "$f" .ts)"
      echo "| \`$name\` | \`src/agents/$name.ts\` |"
    done
  }
}

generate_skills() {
  {
    echo "| Skill | sourcePath in CUSTOM_SKILLS |"
    echo "|---|---|"
    python3 - <<'PY'
import re, pathlib
src = pathlib.Path(
    '/home/morton/Code/oh-my-opencode-pms/src/cli/custom-skills.ts'
).read_text()
# Find all { name: 'X', ..., sourcePath: 'Y' } blocks
pattern = re.compile(
    r"name:\s*'([^']+)'.*?sourcePath:\s*'([^']+)'",
    re.DOTALL,
)
for m in pattern.finditer(src):
    print(f"| `{m.group(1)}` | `{m.group(2)}` |")
PY
  }
}

generate_commands() {
  {
    echo "| Command | File | Description |"
    echo "|---|---|---|"
    for f in "$REPO"/src/commands/*.ts; do
      [ -f "$f" ] || continue
      [[ "$f" == *.test.ts ]] && continue
      name="$(basename "$f" .ts)"
      desc=$(grep -m1 'description:' "$f" 2>/dev/null | sed -E "s/.*description: *['\"]?//; s/['\"],?.*//" | head -c 80)
      [ -z "$desc" ] && desc="(see source)"
      echo "| \`/$name\` | \`src/commands/$name.ts\` | $desc |"
    done
  }
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

generate_hooks    | replace_block hooks
generate_agents   | replace_block agents
generate_skills   | replace_block skills
generate_commands | replace_block commands

# Stamp last-generated time
python3 - "$DOC" <<'PY'
import sys, re, datetime
p = sys.argv[1]
with open(p) as f:
    s = f.read()
stamp = f"<!-- AUTOGEN:last-refresh {datetime.datetime.utcnow().isoformat()}Z -->"
if '<!-- AUTOGEN:last-refresh' in s:
    s = re.sub(r'<!-- AUTOGEN:last-refresh [^>]+-->', stamp, s)
else:
    s = s.rstrip() + '\n\n' + stamp + '\n'
with open(p, 'w') as f:
    f.write(s)
PY

echo "refresh-harness-doc: ok" >&2
exit 0
