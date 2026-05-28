# Harness Map — oh-my-opencode-pms

**Canonical system map. Single source of truth.** This file documents every
hook, every agent, every skill, every workflow, every config file location
across the entire pms harness so nothing is ever lost.

If you make a change anywhere in the system, update this doc in the same commit.

---

## 1. What this repo IS

The `oh-my-opencode-pms` plugin + its deploy infrastructure. Forked from
[`alvinunreal/oh-my-opencode-slim`](https://github.com/alvinunreal/oh-my-opencode-slim).

Repo: `github.com/mortonbaker/oh-my-opencode-pms`
Live location: `~/Code/oh-my-opencode-pms`
Loaded into opencode via: symlink at `~/.bun/install/global/node_modules/oh-my-opencode-pms`
Plugin name in opencode.jsonc: `"oh-my-opencode-pms"`

## 2. Repository structure

```
oh-my-opencode-pms/
├── src/                       # plugin source — all TypeScript
│   ├── agents/                # 11-agent pantheon factories + AGENT_DESCRIPTIONS table
│   ├── harness/               # criteria-validator, parallel-detector, dispatch-judge, deploy-fanout
│   ├── governance/            # PMS governance: scope-gate, budget, escalation, audit, integration-checker, workflow
│   ├── hooks/                 # 17 lifecycle hooks (see §4)
│   ├── mcp/                   # built-in MCP clients (context7, grep-app, websearch)
│   ├── multiplexer/           # tmux + zellij integration for subagent panes
│   ├── council/               # multi-LLM voting (council + councillor)
│   ├── interview/             # wizard-style preset/auth bootstrapping
│   ├── tools/                 # ast-grep, smartfetch, subtask
│   ├── skills/                # 7 bundled skills (see §5)
│   ├── cli/                   # bunx oh-my-opencode-pms <subcmd> + agent-mem CLI
│   ├── config/                # loader.ts (reads user overrides), schemas
│   ├── utils/                 # logger.ts, session helpers, tmux utils, canonical-JSON
│   └── index.ts               # plugin entrypoint
├── deploy/                    # everything that goes to ~/ on a target machine
│   ├── install.sh             # symlink bootstrap
│   ├── .claude/CLAUDE.md      # universal wizard context (links to ~/.claude/)
│   └── .config/opencode/      # opencode + pms preset (links to ~/.config/opencode/)
├── scripts/                   # operator-facing scripts
│   ├── refresh-inventory.sh   # daily cron → _generated/inventory.md
│   └── sync-memory.sh         # /15min cron → git push agent-memory
├── docs/                      # canonical docs (this file lives here)
├── _generated/                # autogen artifacts (inventory.md)
└── dist/                      # bundled output (bun run build)
```

## 3. The 11-agent pantheon

| Agent | Source | Role | Edits? | Models (first-available) |
|---|---|---|---|---|
| `project-manager` | `src/agents/project-manager.ts` | Primary orchestrator. Owns governance loop. | yes | anthropic/claude-opus-4-7 → mimo-v2.5-pro → MiniMax-M2.7-highspeed |
| `architect` | `src/agents/architect.ts` | Planner. Slice JSON with falsifiable criteria. MUST survey before new infra. | no | google/gemini-3.1-pro-preview → mimo → MiniMax |
| `builder` | `src/agents/builder.ts` | Implementer. Scope-gate enforces approved file_changes. | yes (scoped) | zai/glm-5.1 → MiniMax → mimo |
| `judge` | `src/agents/judge.ts` | Reviewer. pass/revise/escalate. 3-strike cap. | no | crof/deepseek-v4-pro → opus → mimo |
| `qa-reviewer` | `src/agents/qa-reviewer.ts` | Evidence keeper. Verbatim test/lint/build output. | no (runs cmds) | MiniMax → mimo → deepseek |
| `researcher` | `src/agents/researcher.ts` | Read-only discovery. Parallel-by-default. | no | MiniMax → gemini → mimo |
| `synthesizer` | `src/agents/synthesizer.ts` | Compresses N researcher outputs → 1 cited digest. | no | mimo → gemini → MiniMax |
| `triage` | `src/agents/triage.ts` | Cheap classifier. Used by harness plugins for tier-1 decisions. | no | (per preset) |
| `observer` | `src/agents/observer.ts` | Visual analysis (images, PDFs, screenshots). | no | (per preset) |
| `council` | `src/agents/council.ts` | Multi-LLM consensus for high-stakes decisions. | ask | (per preset) |
| `councillor` | `src/agents/councillor.ts` | Individual voter spawned by council. | no | (per preset) |

User .md overrides live in `~/.config/opencode/agent/*.md` (symlinked into deploy/).
Per-agent append prompts in `~/.config/opencode/oh-my-opencode-pms/*_append.md`.

## 4. Hooks (17 lifecycle hooks)

| Hook | File | Event | Purpose |
|---|---|---|---|
| **research-gate** ⭐NEW | `src/hooks/research-gate/index.ts` | `experimental.chat.messages.transform` | Detects unresearched questions, injects forcing reminder, logs violations to events.jsonl |
| phase-reminder | `src/hooks/phase-reminder/index.ts` | `experimental.chat.messages.transform` | Appends workflow phase reminder after user message |
| filter-available-skills | `src/hooks/filter-available-skills/` | `experimental.chat.messages.transform` | Strips skills not in preset roster |
| task-session-manager | `src/hooks/task-session-manager/` | various | Reuses/spawns specialist sessions per agent |
| auto-update-checker | `src/hooks/auto-update-checker/` | session.created | Notifies when pms has new release |
| post-file-tool-nudge | `src/hooks/post-file-tool-nudge/` | tool.execute.after | Reminds to verify after edit |
| chat-headers | `src/hooks/chat-headers.ts` | chat.headers | Adds harness identity to outgoing requests |
| delegate-task-retry | `src/hooks/delegate-task-retry/` | tool.execute.after | Re-tries task tool on transient failures |
| apply-patch | `src/hooks/apply-patch/` | tool.execute.after | Improves error messages from apply_patch tool |
| json-error-recovery | `src/hooks/json-error-recovery/` | tool.execute.after | Recovers from malformed JSON in tool calls |
| todo-continuation | `src/hooks/todo-continuation/` | session.idle | Auto-continues orchestrator on incomplete todos |
| session-goal | `src/hooks/session-goal/` | various | /session-goal command + idle tracking |
| foreground-fallback | `src/hooks/foreground-fallback/` | various | Model fallback on rate-limit |
| image-hook | `src/hooks/image-hook.ts` | various | Image attachment processing |
| **harness/criteria-validator** | `src/harness/criteria-validator.ts` | tool.execute.before (task) | Blocks dispatches missing ## Success Criteria + ## Verification Commands |
| **harness/parallel-detector** | `src/harness/parallel-detector.ts` | various | Detects N≥3 same-shape units → injects parallel-dispatch reminder |
| **harness/dispatch-judge** | `src/harness/dispatch-judge.ts` | tool.execute.after (task) | Validates subagent dispatch quality |

Registration site: `src/index.ts` (search for `createXxxHook`).

## 5. Skills (7 bundled)

| Skill | Path | Allowed agents | Purpose |
|---|---|---|---|
| `simplify` | `src/skills/simplify/` | oracle, ... | Code simplification |
| `codemap` | `src/skills/codemap/` | orchestrator | Repo structure mapping |
| `clonedeps` | `src/skills/clonedeps/` | orchestrator | Clone dependency source for inspection |
| `roster-print` | `src/skills/roster-print/` | orchestrator, project-manager | Print active harness preset + roster |
| `falsifiable-criteria` | `src/skills/falsifiable-criteria/` | orchestrator, architect, judge, qa-reviewer, project-manager | Vocabulary for criteria-validator contract |
| `harness-deploy` | `src/skills/harness-deploy/` | orchestrator, project-manager | Canary-then-fanout deploy workflow |
| `parallelization-template` | `src/skills/parallelization-template/` | orchestrator, project-manager | Decomposition contract for parallel dispatch |

Registry: `src/cli/custom-skills.ts`. Installed by `bunx oh-my-opencode-pms install`.

## 6. MCP servers

| Server | Type | Source | Tools |
|---|---|---|---|
| `mem0` | local stdio | npm `@mem0/mcp-server`, key in `~/.config/secrets/mem0.key` | add-memory, search-memories |
| `websearch` | remote URL | built-in (`mcp.exa.ai`) | web_search_exa |
| `context7` | remote URL | built-in (`mcp.context7.com`) | query-docs, resolve-library-id |
| `grep_app` | remote URL | built-in (`mcp.grep.app`) | searchGitHub |

Config: `~/.config/opencode/opencode.jsonc` `mcp.<name>` blocks.
Per-agent allowlist: `~/.config/opencode/oh-my-opencode-pms.json` `presets.pms.<agent>.mcps`.

## 7. Memory architecture

**Three layers.**

1. **Canonical event log** (cross-machine via private GitHub):
   - `~/.local/share/agent-memory/events.jsonl` — append-only JSONL, O_APPEND atomic ≤4KB
   - Synced every 15 min via cron: `scripts/sync-memory.sh` → `github.com/mortonbaker/agent-memory` (PRIVATE)
   - Writers: `agent-mem` CLI, `src/hooks/research-gate/` (logs violations), upcoming `precompact-flush` hook
   - Reader: any agent via `agent-mem search`, `agent-mem tail`, or direct `jq` on events.jsonl

2. **opencode-memsearch** (per-project semantic):
   - npm `opencode-memsearch` plugin in `opencode.jsonc`
   - Backed by `memsearch` CLI (Python, installed via pipx with ONNX embeddings)
   - Summarizes each turn via `claude-haiku-4-5` → `.memsearch/memory/YYYY-MM-DD.md`
   - Cold-start: tail of last 2 daily files injected into system prompt
   - Per-project (one .memsearch/ per project root)

3. **mem0 cloud** (semantic search fallback):
   - `@mem0/mcp-server` global, key in `~/.config/secrets/mem0.key`
   - userId scope: `morton` (single operator)
   - Use for: queries grep can't satisfy. Not the primary store.

## 8. Workflow recipes

| Request type | Pipeline |
|---|---|
| New feature | @architect plan → @builder → @qa-reviewer → @judge (loop if revise, escalate at strike 3) |
| Bug fix (defined) | @builder → @qa-reviewer → @judge |
| Bug fix (unclear cause) | @researcher (parallel) → @architect → builder/qa/judge |
| Refactor | @architect with risk forecast → @builder per slice → @judge per slice |
| Investigation only | @researcher (parallel facets) → @synthesizer → present (no edits) |
| Strategic decision | @council → human → record |
| Image/PDF in scope | @observer → re-route |

## 9. Response discipline

Every operator-facing turn that requires action follows the template in
`docs/RESPONSE_TEMPLATE.md`:

- BLUF (recommendation + why in 2 sentences)
- What I researched (citations)
- What I'm doing (numbered)
- Reversibility (reversible → proceed; irreversible → pause)
- What I need from you (zero or one explicit ask, with default)

Enforced by `src/hooks/research-gate/`.

## 10. Config file map (every file that matters on a deployed machine)

| Path | Source | Purpose |
|---|---|---|
| `~/.config/opencode/opencode.jsonc` | symlink → `deploy/.config/opencode/opencode.jsonc` | plugin list, MCP servers, agent disables |
| `~/.config/opencode/oh-my-opencode-pms.json` | symlink → `deploy/.config/opencode/oh-my-opencode-pms.json` | active preset + per-agent roster (model fallback chains) |
| `~/.config/opencode/oh-my-opencode-pms/project-manager_append.md` | symlink → deploy/ | operator orchestrator preferences |
| `~/.config/opencode/agent/*.md` | symlink → deploy/ | per-subagent prompt overrides |
| `~/.config/opencode/skills/*/SKILL.md` | symlink → deploy/ | bundled skills (auto-installed by pms CLI) |
| `~/.config/opencode/plugins/paseo-autoregister.mjs` | symlink → deploy/ | tailnet dashboard hook |
| `~/.config/opencode/memsearch.config.json` | direct file | opencode-memsearch plugin config |
| `~/.claude/CLAUDE.md` | symlink → `deploy/.claude/CLAUDE.md` | universal wizard context for ALL CLI agents |
| `~/AGENTS.md` | symlink → `~/.claude/CLAUDE.md` | cross-tool alias for Cursor/Codex |
| `~/.config/secrets/*.key` | direct files (mode 0600) | API keys; auto-exported by load.sh |
| `~/.config/secrets/load.sh` | direct file (mode 0600) | sourced from ~/.bashrc |
| `~/.local/share/agent-memory/events.jsonl` | git-tracked clone | canonical memory log |
| `~/.local/share/opencode/opencode.db` | runtime | session DB (ephemeral, ~1GB) |
| `~/.local/share/opencode/auth.json` | runtime | OAuth tokens — NEVER commit |
| `~/.claude/.credentials.json` | runtime | Claude OAuth — NEVER commit |

## 11. Cron jobs

| Schedule | Script | Purpose |
|---|---|---|
| `*/15 * * * *` | `scripts/sync-memory.sh` | git push events.jsonl to mortonbaker/agent-memory |
| `0 7 * * *` | `scripts/refresh-inventory.sh` | regenerate `_generated/inventory.md` |

## 12. Migration to a new machine

```bash
# 1. Clone the harness
git clone https://github.com/mortonbaker/oh-my-opencode-pms.git ~/Code/oh-my-opencode-pms
cd ~/Code/oh-my-opencode-pms && bun install && bun run build && bun link
bun link oh-my-opencode-pms

# 2. Symlink configs
~/Code/oh-my-opencode-pms/deploy/install.sh

# 3. Set up secrets (manual — never tracked in git)
mkdir -p ~/.config/secrets
printf '%s' "<your-mem0-key>" > ~/.config/secrets/mem0.key
python3 -c "import os,stat;os.chmod(os.path.expanduser('~/.config/secrets/mem0.key'),stat.S_IRUSR|stat.S_IWUSR)"
. ~/.config/secrets/load.sh

# 4. Auth
gh auth login
claude   # OAuth flow on first session

# 5. Verify
opencode mcp list      # mem0 + websearch + context7 + grep_app should all be connected
opencode               # then run /roster-print
```

Cron jobs auto-register via `deploy/install.sh` (or copy from `scripts/`).

## 13. What this repo is NOT

- Not a personal substrate. The user's coach/wizard/atlas/philosopher dirs
  live in `github.com/mortonbaker/agent-stack`, separate concern.
- Not a code-review tool. See opencode `/review` command.
- Not a model provider. Models come via opencode plugins (claude-bridge,
  anthropic-oauth, gemini-auth) using the operator's existing subscriptions.

## 14. Provenance

- Forked from `alvinunreal/oh-my-opencode-slim` 2026-05-22.
- Consolidated 2026-05-25: deploy/ + scripts/ + docs/ + _generated/ all moved
  IN from `mortonbaker/agent-stack` to make this the single source of truth.
- Research-gate hook added 2026-05-25.
- agent-memory private GitHub repo created 2026-05-25.

## 15. Auto-generated indexes

> The four tables below are regenerated by
> `scripts/refresh-harness-doc.sh`. Do not hand-edit between the
> `AUTOGEN` markers — your edits will be overwritten. To change them,
> edit the source under `src/` and re-run the script (or commit, which
> triggers the pre-commit hook).

### Hooks (autogen)

<!-- AUTOGEN:hooks -->
| Hook | File | Event |
|---|---|---|
| `apply-patch` | `src/hooks/apply-patch/index.ts` | `'tool.execute.before'` |
| `auto-update-checker` | `src/hooks/auto-update-checker/index.ts` | `'session.created'` |
| `debrief-prompt` | `src/hooks/debrief-prompt/index.ts` | `'chat.message','experimental.chat.messages.transform','session.idle'` |
| `delegate-task-retry` | `src/hooks/delegate-task-retry/index.ts` | `(see source)` |
| `filter-available-skills` | `src/hooks/filter-available-skills/index.ts` | `'experimental.chat.messages.transform'` |
| `foreground-fallback` | `src/hooks/foreground-fallback/index.ts` | `'session.deleted','session.error','session.status'` |
| `json-error-recovery` | `src/hooks/json-error-recovery/index.ts` | `(see source)` |
| `phase-reminder` | `src/hooks/phase-reminder/index.ts` | `'experimental.chat.messages.transform'` |
| `post-file-tool-nudge` | `src/hooks/post-file-tool-nudge/index.ts` | `'tool.execute.after'` |
| `precompact-flush` | `src/hooks/precompact-flush/index.ts` | `'experimental.session.compacting'` |
| `research-gate` | `src/hooks/research-gate/index.ts` | `'experimental.chat.messages.transform','session.idle','session.status'` |
| `session-goal` | `src/hooks/session-goal/index.ts` | `'session.created','session.deleted'` |
| `task-session-manager` | `src/hooks/task-session-manager/index.ts` | `'experimental.chat.messages.transform','session.created','session.deleted'` |
| `todo-continuation` | `src/hooks/todo-continuation/index.ts` | `'session.deleted','session.error','session.idle'` |
| `chat-headers` | `src/hooks/chat-headers.ts` | `'chat.headers'` |
| `image-hook` | `src/hooks/image-hook.ts` | `(see source)` |
| `harness/criteria-validator` | `src/harness/criteria-validator.ts` | tool.execute.before / tool.execute.after |
| `harness/parallel-detector` | `src/harness/parallel-detector.ts` | tool.execute.before / tool.execute.after |
| `harness/dispatch-judge` | `src/harness/dispatch-judge.ts` | tool.execute.before / tool.execute.after |
<!-- /AUTOGEN:hooks -->

### Agents (autogen)

<!-- AUTOGEN:agents -->
| Agent | File |
|---|---|
| `architect` | `src/agents/architect.ts` |
| `builder` | `src/agents/builder.ts` |
| `council` | `src/agents/council.ts` |
| `councillor` | `src/agents/councillor.ts` |
| `judge` | `src/agents/judge.ts` |
| `observer` | `src/agents/observer.ts` |
| `project-manager` | `src/agents/project-manager.ts` |
| `qa-reviewer` | `src/agents/qa-reviewer.ts` |
| `researcher` | `src/agents/researcher.ts` |
| `synthesizer` | `src/agents/synthesizer.ts` |
| `triage` | `src/agents/triage.ts` |
<!-- /AUTOGEN:agents -->

### Skills (autogen)

<!-- AUTOGEN:skills -->
| Skill | sourcePath in CUSTOM_SKILLS |
|---|---|
| `simplify` | `src/skills/simplify` |
| `codemap` | `src/skills/codemap` |
| `clonedeps` | `src/skills/clonedeps` |
| `roster-print` | `src/skills/roster-print` |
| `falsifiable-criteria` | `src/skills/falsifiable-criteria` |
| `harness-deploy` | `src/skills/harness-deploy` |
| `parallelization-template` | `src/skills/parallelization-template` |
<!-- /AUTOGEN:skills -->

### Commands (autogen)

<!-- AUTOGEN:commands -->
| Command | File | Description |
|---|---|---|
| `/debrief` | `src/commands/debrief.ts` | (see source) |
| `/remember` | `src/commands/remember.ts` | (see source) |
| `/tts-speak` | `src/commands/tts-speak.ts` | (see source) |
<!-- /AUTOGEN:commands -->

<!-- AUTOGEN:last-refresh 2026-05-28T13:51:17.825477Z -->
