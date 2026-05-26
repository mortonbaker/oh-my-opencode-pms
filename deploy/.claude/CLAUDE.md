# CLAUDE_DEFAULTS — Universal Wizard Knowledge (May 2026)

> **Canonical source:** `~/Code/oh-my-opencode-pms/deploy/.claude/CLAUDE.md`
> (git-tracked at github.com/mortonbaker/oh-my-opencode-pms). Deployed to
> `~/.claude/CLAUDE.md` and `~/AGENTS.md` by `deploy/install.sh` (Linux/macOS)
> or `deploy/install.ps1` (Windows). Workflow: edit this file *in the repo*,
> `git push`, then `git pull` on other machines. On symlinked machines the
> change reflects instantly; on Windows **copy mode** (Developer Mode off)
> re-run `install.ps1` after the pull to refresh. Do NOT edit a *symlinked*
> `~/.claude/CLAUDE.md` directly — edit the repo file. (DOC01 currently runs
> copy mode, so its `~/.claude/CLAUDE.md` is a copy, not a live symlink.)
>
> **This file is host- and OS-agnostic.** It is read verbatim on Windows
> (DOC01) and Linux (backup, atlas01, learning-machine) alike. Never hardcode
> a path, home dir, or hostname — detect at runtime per the next section.

---

## MACHINE & OS (detect first — before assuming any path or shell)

- **OS** — check the `Platform` line in the harness environment block:
  `win32` = Windows, `linux` = Linux, `darwin` = macOS. To confirm at runtime
  run `uname -s` (POSIX); if it errors you're on Windows / PowerShell (check
  `$PSVersionTable` / `$env:OS`).
- **Which machine** — run `hostname`. Live roster is in the Tailnet table
  below; `tailscale status` is the source of truth.
- **Home & paths** — never hardcode `C:\Users\morton` or `/home/morton`. Use
  `~` / `$HOME` (both PowerShell and bash/zsh expand them); expand `~` to an
  absolute path before handing it to file tools. Windows: PowerShell,
  backslashes, `$env:VAR`, `if (...) { } else { }`. Linux/macOS: bash/zsh,
  forward slashes, `$VAR`. Quote paths containing spaces.
- **Repo root is machine-specific** — Windows (DOC01) keeps repos under
  `~/repos/` (e.g. `C:\Users\morton\repos\`), except `oh-my-opencode-pms`
  which lives at `~/Code/`. Linux has no `~/repos/`; repos sit directly under
  `$HOME` (and `~/Code/`). Detect with `ls ~` or `find ~ -maxdepth 2 -name .git`.

## WIZARD PERSONA & SLASH COMMANDS (vanilla Claude Code sessions)

If the cwd is **not** inside a specific repo, default to the **Tech Wizard**
persona — but only if its files exist on this machine. Locate agent-stack
(`ls -d ~/repos/agent-stack ~/agent-stack 2>/dev/null`); if `<agent-stack>/wizard/`
is present, read, in order: `SYSTEM_PROMPT.md`, `CLAUDE.md`,
`profile/operator-profile.md`. If the cwd **is** inside a repo, that repo's
own `CLAUDE.md`/`AGENTS.md` takes precedence over the Wizard default.

Switch personas mid-session via user-level slash commands (`~/.claude/commands/`):

| Command | Persona / Repo |
|---|---|
| `/main` | Tech Wizard — `agent-stack/wizard` (default) |
| `/Sedation` | SedationRx engineering rulebook |
| `/Coach` | Executive Coach v8.1 — `executive-coach-system` |
| `/TeamPulse` | Team Pulse engineering rulebook |
| `/Steward` | Trading Coach (Steward persona) — `Trading_Coach` |
| `/Atlas` | Atlas — bird's-eye-view agent |
| `/Philosopher` | Philosopher |
| `/LabCase` | LabCase engineering |
| `/LightBox` | Dental Light Box engineering |
| `/Pi` | Pi-Breakroom-Config (kiosk infra, not a persona) |

Each slash command `cd`s into its repo and loads that repo's `CLAUDE.md` boot
sequence — the repo, not this file, is the source of truth for the persona.

---

## ENVIRONMENT (read first — runtime self-discovery)

Read `~/.config/opencode/opencode.jsonc` at session start to determine which
harness you're in.

- If `opencode-claude-bridge` is in `plugin`: you are inside **opencode**,
  routed to Claude CLI via the bridge. NOT a vanilla Claude Code session.
- If `oh-my-opencode-pms` is in `plugin`: you have the **PMS pantheon** below.

### Active pantheon (oh-my-opencode-pms)

11 agents. Roster + model fallback chains live in
`~/.config/opencode/oh-my-opencode-pms.json` (key `presets.pms.<role>.model`).

| Agent | Role | Edits? | Notes |
|---|---|---|---|
| `project-manager` | Primary orchestrator | yes | Dispatches all others. Governance loop owner. |
| `architect` | Planner | no | Produces slice JSON with falsifiable acceptance criteria. MUST survey before proposing new infra. |
| `builder` | Implementer | yes (scoped) | Edits only files in approved slice. scope-gate hook auto-enforces. |
| `judge` | Reviewer | no | Returns pass/revise/escalate. 3-strike cap then mandatory human escalation. |
| `qa-reviewer` | Evidence keeper | no (runs cmds) | Captures verbatim test/lint/build output. Does not approve. |
| `researcher` | Read-only discovery | no | Parallel-by-default. Codebase + library docs + reference grep. |
| `synthesizer` | Research compressor | no | Takes N raw researcher outputs → 1 cited digest. |
| `triage` | Cheap classifier | no | Used by harness plugins (parallel-detector, criteria-validator, etc.) for tier-1 decisions. |
| `observer` | Visual analysis | no | Images, PDFs, screenshots. |
| `council` | Multi-LLM consensus | ask | High-stakes decisions; aggregates votes from N councillors. |
| `councillor` | Council voter | no | Independent analyst, spawned by council. |

### Dispatch syntax

- **Auto:** opencode's `task` tool routes per the orchestrator's delegation rules.
- **Manual:** type `@<agentname> <task>` in reply text. opencode parses it.
- **Subtask (bounded child):** `/subtask <description>`.
- **HARD RULE — falsifiable criteria:** every `task` dispatch MUST include
  `## Success Criteria` (with measurable verbs) AND `## Verification Commands`
  sections, or the `criteria-validator` plugin tier0-blocks the dispatch.
  Load the `falsifiable-criteria` skill on first dispatch in a session.

### Self-verify at startup

When unsure what's wired up, run the `roster-print` skill or:

```bash
cat ~/.config/opencode/opencode.jsonc                                          # plugin list
jq '.preset, .presets[.preset]' ~/.config/opencode/oh-my-opencode-pms.json    # active roster
ls ~/.config/opencode/agent/                                                   # user agent overrides
ls ~/.config/opencode/skills/                                                  # installed skills
```

The PMS plugin source of truth: `~/Code/oh-my-opencode-pms/` (git-backed at
github.com/mortonbaker/oh-my-opencode-pms). Symlinked into the global node
modules so a rebuild (`bun run build`) is immediately live.

---

## CONFIG MAP — every file that matters

All opencode config below is deployed (symlinked) from
`~/Code/oh-my-opencode-pms/deploy/.config/opencode/` — that repo is the
source of truth, not agent-stack.

| Path | Purpose | Source-of-truth |
|---|---|---|
| `~/.config/opencode/opencode.jsonc` | plugin list, agent disables | `oh-my-opencode-pms/deploy` |
| `~/.config/opencode/oh-my-opencode-pms.json` | active preset + roster | `oh-my-opencode-pms/deploy` |
| `~/.config/opencode/oh-my-opencode-pms/project-manager_append.md` | operator orchestrator prefs | `oh-my-opencode-pms/deploy` |
| `~/.config/opencode/agent/*.md` | per-subagent prompt overrides | `oh-my-opencode-pms/deploy` |
| `~/.config/opencode/skills/*/SKILL.md` | bundled skills (auto-installed by pms CLI) | `~/Code/oh-my-opencode-pms/src/skills/` |
| `~/.config/opencode/plugins/paseo-autoregister.mjs` | tailnet dashboard hook | `oh-my-opencode-pms/deploy` |
| `~/.config/opencode/_attic/` | trash; not synced | (local) |
| `~/.local/share/opencode/opencode.db` | session state (~1GB, ephemeral) | NOT backed up |
| `~/.local/share/opencode/log/` | runtime logs | NOT backed up |
| `~/.local/share/opencode/auth.json` | plugin OAuth tokens | NEVER commit |
| `~/.claude/CLAUDE.md` → repo | this file | `oh-my-opencode-pms/deploy/.claude/` |
| `~/AGENTS.md` → CLAUDE.md | cross-tool alias (Cursor/Codex/Claude) | symlink |
| `~/.claude/.credentials.json` | Claude OAuth | NEVER commit |
| `~/Code/oh-my-opencode-pms/` | canonical harness + deploy bootstrap | github.com/mortonbaker/oh-my-opencode-pms |
| `~/Code/<repo>/AGENTS.md` | per-project conventions | per-repo |

### Persistence tiers (May 2026 layout)

1. **Universal context** — this file (`~/.claude/CLAUDE.md` ≡ `~/AGENTS.md`). Read by every CLI agent on the machine.
2. **Per-tool harness** — `~/.config/opencode/oh-my-opencode-pms/project-manager_append.md` for opencode-only orchestrator behaviors.
3. **Per-project** — `<repo>/AGENTS.md` when working inside a specific repo.
4. **Cross-session memory** — MCP memory server (mem0). Persists decisions, deferred items, drift notes across sessions. Queryable, not bloating prompts. Wired in `~/.config/opencode/opencode.jsonc` `mcp.mem0` block; setup requires `MEM0_API_KEY` env var from app.mem0.ai. Available to orchestrator (via `mcps:["*"]`), architect, and judge by default. Tool surface: `mem0_add`, `mem0_search`, `mem0_get_all`, `mem0_delete`.
5. **Live inventory** — `~/agent-stack/_generated/inventory.md`, regenerated daily by cron from `tailscale status`, `git remote -v` per repo, opencode/pms versions.

### Migrating to a new machine

```bash
git clone https://github.com/mortonbaker/oh-my-opencode-pms.git ~/Code/oh-my-opencode-pms
cd ~/Code/oh-my-opencode-pms && bun install && bun run build && bun link
bun link oh-my-opencode-pms                  # now opencode loads it
# Symlink ~/.claude + ~/.config/opencode defaults from the deploy dir:
#   Linux/macOS:  cd deploy && ./install.sh
#   Windows:      powershell -File deploy\install.ps1
opencode                                      # roster-print to verify
```

`install.ps1` auto-detects symlink capability: with **Developer Mode**
(Settings → Privacy & security → For developers) or an elevated shell it
symlinks like Linux; otherwise it falls back to **copy mode** (re-run after
each `git pull` to refresh). Pass `-Copy` to force copy mode.

Secrets (`auth.json`, `.credentials.json`) re-authenticated manually — they
never live in git.

---

## Tooling Defaults

- **GitHub:** `gh` CLI over the web UI for everything — repos, PRs, issues, releases, comments.
- **Git:** never `--no-verify`. Never force-push to `main`. New commit instead of
  `--amend` unless explicitly asked. **Never** modify global git config.
- **Package managers:** one per project. Detect by lockfile.
- **Long-running commands:** if a command will take more than ~30 s (npm install,
  large clones, builds, test suites), state what's running and start it. Don't ask
  permission first.

---

## Tailnet Access

**Tailnet name:** `tail00ae77.ts.net` — always confirm the live roster with
`tailscale status` (machines/IPs change; this table can drift).

| Machine | Tailscale IP | OS | Role |
|---|---|---|---|
| **DOC01** (`doc01-1`) | `100.94.59.41` | Windows | Office dev workstation |
| **backup** | `100.107.135.99` | Linux | Office box — on the office LAN *and* the tailnet; user `morton`, `HOME=/home/morton` |
| **atlas01** | `100.127.143.78` | Linux | Headless Debian box. Paseo daemon, atlas-automation runtime |
| **device** | `100.107.237.71` | Windows | Windows node |
| **learning-machine** | `100.77.213.11` | Linux | Linux node |

SSH between nodes (MagicDNS short names work tailnet-wide; `backup` is also
reachable on the office LAN):
```bash
ssh morton@backup                      # or backup.tail00ae77.ts.net / 100.107.135.99
ssh morton@atlas01.tail00ae77.ts.net   # or 100.127.143.78
```

Tailscale CLI:
```bash
tailscale status        # show all peers
tailscale netcheck      # check connectivity
tailscale ping <host>   # test peer connectivity
tailscale serve http://localhost:3000   # expose a service on tailnet
```

---

## Paseo Daemon (atlas01)

Paseo manages long-running agent sessions via WebSocket API on port **6767**.

**Daemon config:** `~/.paseo/config.json`

**Restart:**
```bash
kill $(cat ~/.paseo/paseo.pid) 2>/dev/null
paseo daemon > ~/.paseo/daemon.log 2>&1 &
echo $! > ~/.paseo/paseo.pid
```

**Health:**
```bash
tail -20 ~/.paseo/daemon.log
# Good: "Server listening" + "relay_control_connected"
# Bad: port already in use, relay unreachable
```

**Web UI:** https://app.paseo.sh
**Providers:** claude (ANTHROPIC_API_KEY), opencode (opencode CLI), gemini (npx wrapper)
**Log:** `~/.paseo/daemon.log`

---

## OpenCode CLI

```bash
opencode                     # interactive
opencode "your prompt here" # one-shot
```

**Per-repo config errors:** If you see `ConfigInvalidError: Unrecognized key:
_plugin_disabled_*`, the repo's `opencode.json` has a stale key. Remove the
`_plugin_disabled_*` entries from that file.

**Rebuilding the pms plugin after editing:**
```bash
cd ~/Code/oh-my-opencode-pms && bun run build    # ignore preexisting tsc warnings
# Changes are live in the next opencode session via the symlinked global node_modules.
```

---

## API Keys — Where They Live

**Canonical convention** (preferred):

```
~/.config/secrets/           mode 0700
~/.config/secrets/load.sh    mode 0600  — sourced from ~/.bashrc, auto-exports every *.key
~/.config/secrets/<n>.key  mode 0600  — exported as <N>_API_KEY (uppercased)
```

Add a new secret:

```bash
printf '%s' "<the-key>" > ~/.config/secrets/foo.key
python3 -c "import os,stat;os.chmod(os.path.expanduser('~/.config/secrets/foo.key'),stat.S_IRUSR|stat.S_IWUSR)"
. ~/.config/secrets/load.sh    # picks up in this shell; new shells auto-load via .bashrc
```

Current keys (filenames only, never paste contents):
- `mem0.key` → `MEM0_API_KEY` — wired into the mem0 MCP server (see Memory below).

**Fallbacks for legacy / per-tool spots:**

1. **Environment variables** — set directly in shell profile or systemd unit. Check:
   ```bash
   printenv | grep -iE 'ANTHROPIC|OPENAI|GITHUB|GEMINI|CLAUDE|MEM0'
   ```
2. **Paseo config** (`~/.paseo/config.json`) — provider structure only, not secrets.
3. **atlas-automation** — GitHub, Gemini, etc. keys in `data/config.json` within the repo.
4. **Claude OAuth** — `~/.claude/.credentials.json` — never edited by hand; refreshed via the Claude CLI sign-in.

**Never** commit anything from `~/.config/secrets/`, `~/.claude/.credentials.json`, or `~/.local/share/opencode/auth.json` to any git repo. `~/agent-stack/.gitignore` defensively blocks `*.key`, `*.token`, `**/.credentials.json`, `**/auth.json`.

## Memory (mem0)

Cross-session memory lives in mem0 (cloud SaaS). The orchestrator, architect, and judge agents can call `add-memory` and `search-memories` via the MCP server.

- **Server:** `~/.bun/bin/mem0-mcp` (npm `@mem0/mcp-server`)
- **Auth:** `MEM0_API_KEY` env var (loaded from `~/.config/secrets/mem0.key`)
- **userId convention:** `morton` (single-operator setup). All memories scoped to this user; do not invent other userIds.
- **What to store:** durable facts about the operator, machine layout, recurring decisions, deferred items, drift notes. **Not:** ephemeral session state, code snippets, or anything reproducible from the filesystem.
- **What to retrieve:** call `search-memories` at session start if the question concerns operator preferences, machine topology, or any decision made in a previous session.

Quick sanity-check from the CLI:

```bash
# add
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search-memories","arguments":{"query":"morton","userId":"morton"}}}' \
  | mem0-mcp 2>/dev/null | grep '"id":2' | jq -r '.result.content[0].text'
```

**GitHub CLI auth:**
```bash
gh auth status
gh auth login --hostname github.com
```

---

## Common Failure Modes

### Relay repeatedly disconnects
```
relay_control_disconnected code=1006 url="wss://relay.paseo.sh/ws?serverId=srv_J0FJyVusFr0i"
```
Check: `curl -s --max-time 5 https://relay.paseo.sh/health`. If unreachable, agents
still work locally via `http://atlas01:6767`.

### OpenCode fails with ConfigInvalidError
Fix: remove stale `_plugin_disabled_*` keys from `<repo>/opencode.json`.

### Port 6767 already in use
```bash
fuser 6767/tcp
kill $(fuser 6767/tcp)
paseo daemon > ~/.paseo/daemon.log 2>&1 &
```

### Paseo agents can't reach GitHub
`gh auth status` — authenticate if needed.

### Subagent dispatch returns `DISPATCH_BLOCKED`
Missing `## Success Criteria` or `## Verification Commands` sections.
Load the `falsifiable-criteria` skill, reformat dispatch.

### `roster-print` says "pms plugin not configured"
The pms plugin isn't loaded in this opencode session. Check `~/.config/opencode/opencode.jsonc`'s `plugin` array; `"oh-my-opencode-pms"` must be present.

---

## Response Defaults

- Lead with the answer. No preamble.
- Assume the operator wants the working solution, not the explanation.
- When asked "how," give the code/command first, theory after only if non-obvious.
- Default to terse. Expand only when the problem genuinely warrants it.
- If something is a bad idea, say so directly and propose the better path.
- Cite real docs and version numbers.

---

## Clarifying Questions Rule

Do not ask questions you could answer with a tool call. Read, grep, glob, ls —
infer intent from context, state the inference, proceed. Only ask the user when
ALL hold: (a) answer materially changes the plan, (b) you cannot determine it
yourself, (c) getting it wrong is costly to undo. When you must ask: lead with
the immediate context, name files + line numbers, propose a default ("I'll do
X unless you stop me"), one question at a time.

Stupid questions to never ask: anything answerable by reading a file you have
access to; anything answerable by grep/ls/glob; anything answerable by the
plugin's own config or README; "do you want me to also..." for obvious next
steps; naming/formatting bikeshedding unless the user raised it.

(The full version lives in `~/.config/opencode/oh-my-opencode-pms/project-manager_append.md` and is auto-appended to the orchestrator's prompt.)

---

## Operator Context

**Morton Baker, DMD.** Treat as a senior peer — skip the 101. Solo operator with ADHD.
Delegates granular execution to AI agents. Mobile-first, often listening via TTS. Walls of
bullets read as panic; walls of prose read as evasion.

**Machines (see the Tailnet table for the live roster — `tailscale status`):**
- **Office** — DOC01 (Windows dev workstation), backup (Linux; on the office
  LAN and the tailnet), the LAN Pis, dental hardware.
- **Other tailnet nodes** — atlas01, device, learning-machine. Don't assume a
  physical location for any node; check `tailscale status`.
- **Mobile** — phone via TTS, SSH from laptop.

**Hard rule:** Never gate work on physical presence at another location. If a plan
requires the operator to drive somewhere, re-route first.

---

## Friction Principle

Every keystroke the operator types is a finite resource. Every keystroke the agent
runs is free. Minimize operator friction above all else. When the operator describes
a manual workflow, proactively suggest where automation or agents apply — but only
where leverage is real.

---

## What the Operator Doesn't Want

- Apologies for "limitations" you don't actually have.
- Multi-option menus when one decision is obviously right.
- Safety lectures on topics where competence is demonstrated.
- "It depends" without naming what it depends on and which way to lean.
- "Consult a professional" unless actually warranted.
- Plans that gate on the operator being somewhere they aren't.
- Questions you could answer with a 10-second tool call.
