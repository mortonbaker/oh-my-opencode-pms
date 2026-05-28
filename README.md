# oh-my-opencode-pms

A PMS-governed agent pantheon + harness for [OpenCode](https://opencode.ai), as a single plugin.

> **Fork of [`oh-my-opencode-slim`](https://github.com/alvinunreal/oh-my-opencode-slim)** by Boring Dystopia. This fork replaces the slim canonical roster with a Project-Management-System (PMS) pantheon, folds the [opencode-harness](https://github.com/morton/opencode-harness) governance plugins inline, and locks model selection to a verified subscription-only slug list. Upstream credit goes to `alvinunreal` — see the slim README for the original architecture, V2 background-orchestration story, and full skills/MCP feature surface.

## What this plugin is

One opencode plugin that wires up three things in a single load:

1. **An agent pantheon** — a project-manager primary orchestrator plus eight specialist subagents, each bound to a specific model via a preset file.
2. **A governance harness** — three hooks (parallel-detector, criteria-validator, dispatch-judge) and one tool (`harness_deploy`) that fire automatically around every dispatch. Previously these lived as separate plugins in `~/.opencode/plugins/`; they're now folded inline to remove plugin-loader drift.
3. **Skills + MCPs** — `simplify`, `codemap`, `clonedeps`, `falsifiable-criteria`, `harness-deploy`, `parallelization-template`, `roster-print`, plus the upstream council/webfetch/ast-grep/subtask tools.

The principle is unchanged from upstream: route each part of the job to the agent best suited for it. The fork tightens which agents exist, which models they use, and which gates they pass through.

---

## The pantheon

| Agent | Role | Default model | Notes |
|---|---|---|---|
| **`project-manager`** | Primary orchestrator. Owns gates, baselines, evidence, drift detection. | `anthropic/claude-opus-4-7` | Renamed from `orchestrator`; aliased so legacy configs keep working. |
| **`architect`** | Planning specialist. Surveys canonical options, writes baselines + acceptance criteria + risk forecasts. Read-only. | `google/gemini-3.1-pro-preview` | Must survey before proposing new infrastructure. |
| **`researcher`** | Read-only discovery. Parallel-by-default. Cheap+broad gather. | `minimax-coding-plan/MiniMax-M2.7-highspeed` | Two-stage research pattern — see below. |
| **`synthesizer`** | Compression specialist. Takes N raw researcher outputs and produces one cited digest. | `xiaomi-token-plan-sgp/mimo-v2.5-pro` | Preserves citations, surfaces contradictions, flags coverage gaps. **NEW in this fork.** |
| **`builder`** | Implementation specialist. Executes approved file changes only. | `zai-coding-plan/glm-5.1` | No scope expansion, no deps, no migrations without approval. |
| **`judge`** | Independent reviewer. Returns pass / revise / escalate against acceptance criteria. | `crof/deepseek-v4-pro` | Cannot self-approve. Must escalate after 3 revise iterations on same slice. |
| **`qa-reviewer`** | Quality-evidence keeper. Runs tests/lint/typecheck/build, records verbatim output. | `minimax-coding-plan/MiniMax-M2.7-highspeed` | Failures reported in full — never summarized. |
| **`triage`** | Tier-1 classifier. JSON-only, no tools. Used internally by harness hooks. | `anthropic/claude-haiku-4-5` | NEVER does work — only classifies. |
| **`observer`** | Visual analysis (images, PDFs, screenshots). | `xiaomi-token-plan-sgp/mimo-v2.5-pro` | Disabled by default; enable explicitly. |
| **`council`** | Multi-LLM consensus engine. Spawns councillors on different model families. | `anthropic/claude-opus-4-7` | Use for critical decisions where disagreement is signal. |
| **`councillor`** | Internal per-model executor for council. | `xiaomi-token-plan-sgp/mimo-v2.5-pro` | Never spawned directly. |

See [`MODEL_PREFERENCES.md`](./MODEL_PREFERENCES.md) for the canonical slug list and banned provider prefixes.

---

## The harness (folded inline)

These run automatically once the plugin loads. No separate plugin entries needed.

| Component | Hook | What it does |
|---|---|---|
| `parallel-detector` | `experimental.chat.messages.transform` | Regex + cheap haiku triage. When user prompt looks like N similar units of work, appends a `<system-reminder>` nudging the orchestrator to dispatch in parallel. |
| `criteria-validator` | `tool.execute.before` (task tool) | Hard-blocks any `task` dispatch lacking falsifiable success criteria + verification commands. Throws `DISPATCH_BLOCKED`. |
| `dispatch-judge` | `tool.execute.after` (task tool) | Re-runs the verification commands the subagent claimed it ran. Appends a `<system-reminder>` on failure. Fail-open via `runPostToolHook`. |
| `harness_deploy` | Tool registration | Canary → bake → fanout deploy of the harness across the tailnet. |

Source lives under `src/harness/`. Each module exports a `createXHook(ctx)` factory that `src/index.ts` chains into PMS's main hook handlers — no separate `Plugin` modules, no `~/.opencode/plugins/` wrapper files.

---

## Pipeline

```
User request
    │
    ▼
project-manager (Claude Opus 4.7)
    │
    │ for non-trivial research:
    ▼
N × researcher  ─▶  synthesizer  ─▶  architect  ─▶  builder  ─▶  judge  ─▶  N × qa-reviewer
(MiniMax 2.7)      (Mimo 2.5 Pro)    (Gemini 3.1 Pro)  (GLM 5.1)    (DeepSeek v4 Pro)  (MiniMax 2.7, parallel by scope)
```

Full diagram + stage rules in [`docs/PIPELINE.md`](./docs/PIPELINE.md).

**Failover** is independent of role specialization. Each agent's `model` field is an ordered array (primary, fallback 1, fallback 2). The runtime `foreground-fallback` hook (`src/hooks/foreground-fallback/index.ts`) watches for rate-limit signals (429, quota exceeded, overloaded, high-concurrency) and re-prompts the session with the next untried model. Per-session dedup (5s window); chains never bleed across agents.

---

## Install

This is a private fork — not published to npm. Install locally:

```bash
git clone https://github.com/morton/oh-my-opencode-pms ~/Code/oh-my-opencode-pms
cd ~/Code/oh-my-opencode-pms
bun install
bun run build
```

Wire it into your opencode config (`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "oh-my-opencode-pms"
  ],
  "agent": {
    "explore": { "disable": true },
    "general": { "disable": true }
  },
  "lsp": true
}
```

Tell opencode where the plugin lives (set up the cache wrapper once):

```bash
mkdir -p ~/.cache/opencode/packages/oh-my-opencode-pms@latest
cat > ~/.cache/opencode/packages/oh-my-opencode-pms@latest/package.json <<EOF
{
  "name": "oh-my-opencode-pms-cache",
  "private": true,
  "dependencies": {
    "oh-my-opencode-pms": "file:$HOME/Code/oh-my-opencode-pms"
  }
}
EOF
cd ~/.cache/opencode/packages/oh-my-opencode-pms@latest && bun install
# If the file: install creates a symlink opencode rejects, copy the dist directly:
mkdir -p ~/.cache/opencode/packages/oh-my-opencode-pms@latest/node_modules/oh-my-opencode-pms
cp -r ~/Code/oh-my-opencode-pms/dist \
      ~/Code/oh-my-opencode-pms/package.json \
      ~/Code/oh-my-opencode-pms/src/skills \
      ~/.cache/opencode/packages/oh-my-opencode-pms@latest/node_modules/oh-my-opencode-pms/
```

Then verify:

```bash
opencode run "PONG"
# Expect: "> project-manager · claude-opus-4-7"
```

If the plugin loads cleanly, the next line in `~/.local/share/opencode/log/*.log` should be `service=plugin path=oh-my-opencode-pms loading plugin` with no subsequent error.

---

## Config

Drop your preset at `~/.config/opencode/oh-my-opencode-pms.json`:

```jsonc
{
  "$schema": "https://opencode.ai/schemas/oh-my-opencode-slim.json",
  "preset": "pms",
  "presets": {
    "pms": {
      "orchestrator": {
        "model": [
          "anthropic/claude-opus-4-7",
          "xiaomi-token-plan-sgp/mimo-v2.5-pro",
          "minimax-coding-plan/MiniMax-M2.7-highspeed"
        ],
        "skills": ["*"],
        "mcps": ["*"]
      },
      "architect": {
        "model": [
          "google/gemini-3.1-pro-preview",
          "xiaomi-token-plan-sgp/mimo-v2.5-pro",
          "minimax-coding-plan/MiniMax-M2.7-highspeed"
        ],
        "skills": ["simplify", "codemap", "falsifiable-criteria"],
        "mcps": []
      },
      "researcher": {
        "model": [
          "minimax-coding-plan/MiniMax-M2.7-highspeed",
          "google/gemini-3.1-pro-preview",
          "xiaomi-token-plan-sgp/mimo-v2.5-pro"
        ],
        "skills": ["codemap", "clonedeps"],
        "mcps": []
      },
      "synthesizer": {
        "model": [
          "xiaomi-token-plan-sgp/mimo-v2.5-pro",
          "google/gemini-3.1-pro-preview",
          "minimax-coding-plan/MiniMax-M2.7-highspeed"
        ],
        "skills": ["simplify"],
        "mcps": []
      },
      "builder": {
        "model": [
          "zai-coding-plan/glm-5.1",
          "minimax-coding-plan/MiniMax-M2.7-highspeed",
          "xiaomi-token-plan-sgp/mimo-v2.5-pro"
        ],
        "skills": [],
        "mcps": []
      },
      "judge": {
        "model": [
          "crof/deepseek-v4-pro",
          "anthropic/claude-opus-4-7",
          "xiaomi-token-plan-sgp/mimo-v2.5-pro"
        ],
        "skills": ["simplify", "falsifiable-criteria"],
        "mcps": []
      },
      "qa-reviewer": {
        "model": [
          "minimax-coding-plan/MiniMax-M2.7-highspeed",
          "xiaomi-token-plan-sgp/mimo-v2.5-pro",
          "crof/deepseek-v4-pro"
        ],
        "skills": ["falsifiable-criteria"],
        "mcps": []
      }
    }
  }
}
```

The `$schema` URL is still labeled `slim` upstream — that's intentional for editor bridge compatibility. The file content is PMS-flavored.

> **Legacy slim names accepted.** `explorer`, `librarian`, `oracle`, `designer`, `fixer`, `orchestrator` aliases are mapped to PMS equivalents (`researcher`, `judge`, `qa-reviewer`, `builder`, `project-manager`) so existing user configs keep working without rewrites.

---

## Governance contract

Every meaningful action flows through:

```
baseline → permission decision → action → event capture → policy check → state update → human-readable report → next allowed action
```

Drift (editing unapproved files, adding deps without approval, deploying without approval, skipping evidence) is detected and stopped at the relevant gate. Specifics:

- **Scope control** — `@builder` edits only files listed in slice `file_changes`; no deps/migrations/deployments without approval.
- **Evidence** — every task must produce verbatim test/lint/typecheck/build output. `@qa-reviewer` never summarizes failures.
- **Judgment** — `@judge` returns pass / revise / escalate against acceptance criteria. Must escalate after 3 revise iterations on the same slice. Cannot self-approve.
- **Finish-gate smoke test** — before declaring a task done, `@project-manager` dispatches **parallel `@qa-reviewer` instances** sharded by test scope (unit / integration / e2e). All scopes must pass; any failure routes to `@judge`. Not optional even on trivial changes.

---

## Repo layout

```
src/
├── agents/           # PMS pantheon (architect, builder, judge, qa-reviewer,
│                     # researcher, synthesizer, triage, observer, council,
│                     # councillor, project-manager)
├── harness/          # Folded-in opencode-harness (parallel-detector,
│                     # criteria-validator, dispatch-judge, deploy-fanout, _lib)
├── hooks/            # PMS hooks (apply-patch, chat-headers, delegate-task-retry,
│                     # filter-available-skills, foreground-fallback,
│                     # image-hook, json-error-recovery, phase-reminder,
│                     # post-file-tool-nudge, session-goal, task-session-manager,
│                     # todo-continuation, plus harness hooks chained from index.ts)
├── skills/           # simplify, codemap, clonedeps, falsifiable-criteria,
│                     # harness-deploy, parallelization-template, roster-print
├── config/           # constants (SUBAGENT_NAMES, DEFAULT_MODELS, etc.),
│                     # schema, loader, MCP defaults
├── council/          # Multi-LLM consensus engine
├── multiplexer/      # Tmux/Zellij session management
├── governance/       # Audit chain, budget gates, escalation, run-phase CLI
├── divoom/           # Optional GIF status display
├── interview/        # Council deliberation
├── mcp/              # Built-in MCP server definitions
├── tools/            # webfetch, ast-grep, subtask, council, preset-manager
├── tui.ts            # TUI sidebar rendering
└── index.ts          # Plugin entry — instantiates agents, hooks, harness;
                      # returns the Plugin object opencode loads
docs/
└── PIPELINE.md       # Two-stage research + finish-gate smoke test diagram
MODEL_PREFERENCES.md  # Canonical model slug list (the ONLY ones to use)
```

---

## Development

| Command | Description |
|---|---|
| `bun run build` | Build TypeScript bundles to `dist/` (index.ts, tui.ts, cli, governance/cli) |
| `bun run typecheck` | TypeScript type check without emitting |
| `bun test` | Run all tests with Bun |
| `bun run lint` | Biome lint |
| `bun run check:ci` | Biome check (lint + format + organize imports), CI mode |
| `bun run dev` | Build and run with OpenCode |

**Testing note.** Some tests reference legacy slim agent names (`orchestrator`, `oracle`, `explorer`, etc.) and have not been updated for the PMS rename. They fail loudly without affecting runtime correctness. Snapshot updates are a known follow-up.

**Plugin loader gotcha.** opencode's plugin loader **rejects any module with named exports** — it expects only `export default`. The harness `*.ts` files have named exports for tests, so they're imported into `src/index.ts` and surfaced through PMS's own default export rather than registered as separate plugins. If you add a new file directly to opencode's plugin list, make sure it has only `export default <plugin>` and nothing else exported.

---

## Credit

- Upstream: [`oh-my-opencode-slim`](https://github.com/alvinunreal/oh-my-opencode-slim) by Alvin Mehmet (`alvinunreal`) / Boring Dystopia Development. All the heavy lifting — agent factory system, multiplexer, council engine, hook framework, TUI integration — is upstream work.
- Harness: [`opencode-harness`](https://github.com/morton/opencode-harness) (now folded into this repo).
- OpenCode: [`opencode-ai/opencode`](https://github.com/opencode-ai/opencode) + [`anomalyco/opencode`](https://github.com/anomalyco/opencode).

---

## License

Inherits from upstream `oh-my-opencode-slim`. See [`LICENSE`](./LICENSE).
