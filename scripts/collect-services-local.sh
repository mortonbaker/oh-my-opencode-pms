#!/usr/bin/env bash
# collect-services-local.sh — scan THIS machine's listening ports + ~/Code repos
# and write to ~/.local/share/agent-memory/services/machines/<host>.json
#
# Companion: aggregate-services.sh merges all machines/*.json + services.json → REGISTRY.md
# Sync: sync-memory.sh (separate cron) git-pushes the result to all peers.
#
# Exit code: 0 always (advisory).

set -u

MEM_DIR="${AGENT_MEMORY_DIR:-$HOME/.local/share/agent-memory}"
OUT_DIR="$MEM_DIR/services/machines"
HOST="$(hostname -s 2>/dev/null || hostname)"
OUT="$OUT_DIR/$HOST.json"
TMP="$(mktemp)"

mkdir -p "$OUT_DIR"

TS_IP="$(tailscale ip -4 2>/dev/null | head -1)"
TS_FQDN="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // ""' | sed 's/\.$//')"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
COLLECTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---------------------------------------------------------------------------
# Ports: ss -tlnp, filtered.
#   - Drop pure loopback (127.0.0.1, [::1])
#   - Drop tailscale's own ephemeral high port on the TS interface
#   - Drop SSH/CUPS (22, 631) and system services we don't care about
# ---------------------------------------------------------------------------
SYSTEM_PORTS_REGEX='^(22|631|25|53|111)$'

PORTS_JSON="$(
  ss -tlnpH 2>/dev/null \
  | while read -r line; do
      # Columns: State Recv-Q Send-Q LocalAddr:Port PeerAddr:Port [users:(...)]
      addr=$(echo "$line" | awk '{print $4}')
      proc=$(echo "$line" | awk '{print $6}')
      port="${addr##*:}"

      # Skip loopback
      case "$addr" in
        127.0.0.1:*|"[::1]:"*) continue;;
      esac

      # Skip well-known system ports
      [[ "$port" =~ $SYSTEM_PORTS_REGEX ]] && continue

      # Parse pid/name from users:(("name",pid=N,fd=M))
      pid="$(echo "$proc" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)"
      name="$(echo "$proc" | grep -oE '\("[^"]+"' | head -1 | tr -d '(' | tr -d '"')"

      cwd=""
      cmd=""
      if [ -n "${pid:-}" ] && [ -r "/proc/$pid/cwd" ]; then
        cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
        cmd="$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | head -c 200)"
      fi

      jq -nc \
        --argjson port "${port:-0}" \
        --arg proto "tcp" \
        --arg process "${name:-}" \
        --argjson pid "${pid:-null}" \
        --arg cwd "${cwd:-}" \
        --arg cmd "${cmd:-}" \
        '{port:$port, proto:$proto, process:$process, pid:$pid, cwd:$cwd, cmdline:$cmd}'
    done \
  | jq -cs '. // []'
)"

# ---------------------------------------------------------------------------
# Repos: ~/Code/*/.git
# ---------------------------------------------------------------------------
REPOS_JSON="$(
  for d in "$HOME"/Code/*/; do
    [ -d "$d/.git" ] || continue
    name="$(basename "$d")"
    [[ "$name" == _* ]] && continue

    remote="$(git -C "$d" remote get-url origin 2>/dev/null | sed -E 's|https://github\.com/||; s|git@github\.com:||; s|\.git$||' || echo '')"
    branch="$(git -C "$d" branch --show-current 2>/dev/null || echo '')"
    dirty="false"
    [ -n "$(git -C "$d" status --porcelain 2>/dev/null)" ] && dirty="true"

    jq -nc \
      --arg name "$name" \
      --arg path "$d" \
      --arg remote "$remote" \
      --arg branch "$branch" \
      --argjson dirty "$dirty" \
      '{name:$name, path:$path, remote:$remote, branch:$branch, dirty:$dirty}'
  done \
  | jq -cs '. // []'
)"

jq -n \
  --arg host "$HOST" \
  --arg fqdn "$TS_FQDN" \
  --arg ip "${TS_IP:-}" \
  --arg platform "$PLATFORM" \
  --arg collected_at "$COLLECTED_AT" \
  --argjson ports "${PORTS_JSON:-[]}" \
  --argjson repos "${REPOS_JSON:-[]}" \
  '{host:$host, tailnet_fqdn:$fqdn, ts_ip:$ip, platform:$platform, collected_at:$collected_at, ports:$ports, repos:$repos}' \
  > "$TMP"

mv "$TMP" "$OUT"
echo "Wrote: $OUT ($(jq '.ports | length' "$OUT") ports, $(jq '.repos | length' "$OUT") repos)"
