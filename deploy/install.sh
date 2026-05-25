#!/usr/bin/env bash
# install.sh — Bootstrap ~/.claude/ AND ~/.config/opencode/ defaults from
# the oh-my-opencode-pms harness repo.
#
# Run this once on a new machine to symlink the deploy directory into
# ~/.claude/ AND ~/.config/opencode/. After this, `git pull` inside the
# pms repo updates the defaults on this machine. Idempotent — re-runs are safe.
#
# Also creates a canonical ~/AGENTS.md symlink pointing at the CLAUDE.md so
# Cursor / Codex / other AGENTS.md-aware tools share the same context.
#
# Sources (relative to this script):
#   .claude/         → ~/.claude/        (every file symlinked)
#   .config/opencode/→ ~/.config/opencode/ (every file symlinked)
#
# Usage:
#   cd ~/Code/oh-my-opencode-pms/deploy && ./install.sh
#   # or from anywhere:
#   ~/Code/oh-my-opencode-pms/deploy/install.sh

set -e

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${HOME:-}"

if [ -z "$HOME_DIR" ]; then
  echo "ERROR: \$HOME is not set. Cannot proceed." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Helper: symlink contents of $SRC into $DEST, backing up real files/dirs.
# ---------------------------------------------------------------------------
symlink_contents() {
  local src="$1"
  local dest="$2"
  local label="$3"

  if [ ! -d "$src" ]; then
    echo "ERROR: $src does not exist" >&2
    return 1
  fi

  mkdir -p "$dest"
  echo ""
  echo "── $label ──"
  echo "  src:  $src"
  echo "  dest: $dest"

  for f in "$src"/*; do
    # Skip if no matches (glob with no files in dir)
    [ -e "$f" ] || continue

    local filename
    filename="$(basename "$f")"
    local dest_file="$dest/$filename"

    # If a real file/dir already exists at dest (not a symlink), back it up
    if [ -e "$dest_file" ] && [ ! -L "$dest_file" ]; then
      local backup="${dest_file}.bak-$(date +%Y%m%d-%H%M%S)"
      echo "  backup: $dest_file → $backup"
      mv "$dest_file" "$backup"
    fi

    # Remove stale symlink (idempotent re-link)
    if [ -L "$dest_file" ]; then
      rm "$dest_file"
    fi

    echo "  link:   $filename"
    ln -s "$f" "$dest_file"
  done
}

# ---------------------------------------------------------------------------
# 1. ~/.claude/  (universal wizard context, AGENTS.md cross-tool alias)
# ---------------------------------------------------------------------------
symlink_contents "$DEPLOY_DIR/.claude" "$HOME_DIR/.claude" "~/.claude/"

# Cross-tool AGENTS.md alias — same file, different name for Cursor/Codex/etc.
if [ -e "$HOME_DIR/.claude/CLAUDE.md" ]; then
  if [ -e "$HOME_DIR/AGENTS.md" ] && [ ! -L "$HOME_DIR/AGENTS.md" ]; then
    mv "$HOME_DIR/AGENTS.md" "$HOME_DIR/AGENTS.md.bak-$(date +%Y%m%d-%H%M%S)"
  fi
  [ -L "$HOME_DIR/AGENTS.md" ] && rm "$HOME_DIR/AGENTS.md"
  ln -s "$HOME_DIR/.claude/CLAUDE.md" "$HOME_DIR/AGENTS.md"
  echo ""
  echo "── ~/AGENTS.md ──"
  echo "  link: → ~/.claude/CLAUDE.md  (cross-tool alias)"
fi

# ---------------------------------------------------------------------------
# 2. ~/.config/opencode/  (opencode harness + pms plugin config)
# ---------------------------------------------------------------------------
symlink_contents \
  "$DEPLOY_DIR/.config/opencode" \
  "$HOME_DIR/.config/opencode" \
  "~/.config/opencode/"

# ---------------------------------------------------------------------------
# 3. ~/.local/share/agent-memory/  (cross-machine memory store)
# ---------------------------------------------------------------------------
MEM_DIR="$HOME_DIR/.local/share/agent-memory"
if [ ! -d "$MEM_DIR/.git" ]; then
  mkdir -p "$(dirname "$MEM_DIR")"
  if gh repo view mortonbaker/agent-memory >/dev/null 2>&1; then
    echo ""
    echo "── memory store ──"
    git clone "git@github.com:mortonbaker/agent-memory.git" "$MEM_DIR" 2>&1 \
      || git clone "https://github.com/mortonbaker/agent-memory.git" "$MEM_DIR" 2>&1 \
      || { echo "  could not clone — create empty store"; mkdir -p "$MEM_DIR" && git -C "$MEM_DIR" init -q; }
    echo "  → $MEM_DIR (cloned)"
  else
    echo ""
    echo "── memory store (offline / no gh auth) ──"
    mkdir -p "$MEM_DIR"
    git -C "$MEM_DIR" init -q 2>/dev/null || true
    echo "  → $MEM_DIR (initialized empty)"
  fi
fi

# ---------------------------------------------------------------------------
# Done.
# ---------------------------------------------------------------------------
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo " Done. ~/.claude/, ~/.config/opencode/, ~/.local/share/agent-memory/"
echo " are all tracked under the oh-my-opencode-pms harness."
echo ""
echo " Update from upstream:  cd ~/Code/oh-my-opencode-pms && git pull"
echo " Capture local edits:   cd ~/Code/oh-my-opencode-pms && git add -A && git commit -m '...' && git push"
echo ""
echo " Auth secrets are NEVER tracked — re-authenticate manually:"
echo "   gh auth login"
echo "   claude (Pro/Max sign-in on first session)"
echo "═══════════════════════════════════════════════════════════════════"
