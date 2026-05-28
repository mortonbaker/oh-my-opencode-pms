# PMS Pipeline v2 — Two-Stage Research + Parallel Smoke Test

This document describes the agent pipeline used by `oh-my-opencode-pms` as of v0.1.0.

Source of truth for model bindings: [`MODEL_PREFERENCES.md`](../MODEL_PREFERENCES.md).

## Pipeline Overview

```
User request
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ project-manager (Claude Opus 4.7)                            │
│ - Parse request                                              │
│ - Choose path (delegate vs do-it-yourself)                   │
│ - Dispatch specialists                                       │
│ - Run finish-gate smoke test                                 │
└──────┬──────────────────────────────────────────────────────┘
       │
       │ for non-trivial research:
       ▼
┌──────────────────────────┐    ┌─────────────────────────────┐
│ N × researcher           │───▶│ synthesizer                  │
│ (MiniMax M2.7 highspeed) │    │ (Mimo 2.5 Pro / Gemini fallback)│
│ parallel · cheap · broad │    │ compress · cite · gap-flag   │
└──────────────────────────┘    └────────────┬────────────────┘
                                              │
                                              ▼
                                ┌─────────────────────────────┐
                                │ architect                    │
                                │ (Gemini 3.1 Pro / Mimo fallback)│
                                │ baseline + slice spec        │
                                └────────────┬────────────────┘
                                              │
                                              ▼
                                ┌─────────────────────────────┐
                                │ builder                      │
                                │ (GLM 5.1 from zai-coding-plan)│
                                │ approved file_changes only   │
                                └────────────┬────────────────┘
                                              │
                                              ▼
                                ┌─────────────────────────────┐
                                │ judge                        │
                                │ (DeepSeek v4 Pro from crof)  │
                                │ pass / revise / escalate     │
                                └────────────┬────────────────┘
                                              │
                                              ▼
                                ┌─────────────────────────────┐
                                │ N × qa-reviewer (parallel)   │
                                │ (MiniMax M2.7 highspeed)     │
                                │ unit · integration · e2e     │
                                └────────────┬────────────────┘
                                              │
                                              ▼
                                         User result
```

## Stage Details

### 1. Orchestrator (`project-manager`)
- **Model chain**: `anthropic/claude-opus-4-7` → `xiaomi-token-plan-sgp/mimo-v2.5-pro` → `minimax-coding-plan/MiniMax-M2.7-highspeed`
- **Role**: Parses request, owns gates, dispatches specialists, runs the finish-gate smoke test.
- **Never bypasses** the PMS governance contract (baseline → permission → action → event → policy → state → report).

### 2. Two-Stage Research (NEW in v0.1.0)

**Gather phase** — `researcher` (parallel-by-default)
- **Model chain**: `minimax-coding-plan/MiniMax-M2.7-highspeed` → `google/gemini-3.1-pro-preview` → `xiaomi-token-plan-sgp/mimo-v2.5-pro`
- **Pattern**: PM dispatches N parallel researchers, one per facet (codebase X, library Y, doc Z).
- **Output**: Raw `<files>`, `<external>`, `<answer>` blocks per researcher.

**Synthesize phase** — `synthesizer` (NEW)
- **Model chain**: `xiaomi-token-plan-sgp/mimo-v2.5-pro` → `google/gemini-3.1-pro-preview` → `minimax-coding-plan/MiniMax-M2.7-highspeed`
- **Input**: Concatenated raw outputs from parallel researchers.
- **Output**: Single `<digest>` with:
  - `<key_findings>` — cited facts (file:line OR library@version)
  - `<contradictions>` — surfaced, NEVER silently resolved
  - `<coverage_gaps>` — flagged for next stage
  - `<recommended_next_step>` — one sentence
- **Hard rules**: No new research, no inventions, preserves all citations.

### 3. Architect
- **Model chain**: `google/gemini-3.1-pro-preview` → `xiaomi-token-plan-sgp/mimo-v2.5-pro` → `minimax-coding-plan/MiniMax-M2.7-highspeed`
- **Role**: Takes synthesized digest, surveys canonical options, produces baseline + falsifiable acceptance criteria + risk forecast.
- **Constraint**: Read-only. Must survey before proposing new infrastructure.

### 4. Builder
- **Model chain**: `zai-coding-plan/glm-5.1` → `minimax-coding-plan/MiniMax-M2.7-highspeed` → `xiaomi-token-plan-sgp/mimo-v2.5-pro`
- **Role**: Executes approved slice file_changes only. No scope expansion.

### 5. Judge
- **Model chain**: `crof/deepseek-v4-pro` → `anthropic/claude-opus-4-7` → `xiaomi-token-plan-sgp/mimo-v2.5-pro`
- **Role**: Pass / revise / escalate verdict against acceptance criteria.
- **Constraint**: After 3 `revise` iterations on same slice → MUST escalate.

### 6. Finish-Gate Smoke Test (NEW in v0.1.0)
- **Model chain**: `minimax-coding-plan/MiniMax-M2.7-highspeed` → `xiaomi-token-plan-sgp/mimo-v2.5-pro` → `crof/deepseek-v4-pro`
- **Role**: PM dispatches **N parallel `qa-reviewer` instances** sharded by test scope (unit / integration / e2e+build+typecheck).
- **Aggregation**: ALL scopes must pass. ANY failure → route to `judge` for verdict.
- **Required even on trivial changes** — last drift-detection point before user sees result.

## Failover Behavior

Each agent's `model` array in `~/.config/opencode/oh-my-opencode-pms.json` is ordered: **primary**, **fallback 1**, **fallback 2**.

The `foreground-fallback` hook (`src/hooks/foreground-fallback/index.ts`) listens for `session.error`, `message.updated`, and `session.status` events. On rate-limit signals (`429`, `quota exceeded`, `overloaded`, `high concurrency`, etc.) it:

1. Picks next untried model in the chain
2. Aborts the in-flight prompt
3. Re-queues the last user message via `promptAsync()`

Per-session deduplication (5s window) prevents thrash. Chains never bleed across agents.

## Banned Provider Prefixes

The following slugs are **explicitly banned** by user preference (recorded in `MODEL_PREFERENCES.md`):

- `openrouter/*`
- `zai/*` (without `-coding-plan`)
- `opencode/*`
- `opencode-go/*`

Only the slugs listed in `MODEL_PREFERENCES.md` may be used.

## Files Changed in v0.1.0

- `src/agents/synthesizer.ts` — NEW agent
- `src/agents/project-manager.ts` — added @synthesizer block + finish-gate smoke test workflow
- `src/agents/index.ts` — registered `createSynthesizerAgent`
- `src/config/constants.ts` — added `synthesizer` to `SUBAGENT_NAMES`, `ORCHESTRATABLE_AGENTS`, `SUBAGENT_DELEGATION_RULES`, `DEFAULT_MODELS`
- `src/config/agent-mcps.ts` — added `synthesizer: []` to `DEFAULT_AGENT_MCPS`
- `MODEL_PREFERENCES.md` — NEW canonical model slug list
- `docs/PIPELINE.md` — NEW (this file)
