# Model Preferences — oh-my-opencode-pms

**This is the canonical source of truth for model provider slugs.** All agent model bindings in `src/config/constants.ts` and `~/.config/opencode/oh-my-opencode-pms.json` must reference these exact slugs.

---

## Allowed Slugs (the ONLY ones to use)

| Role | Slug | Notes |
|---|---|---|
| **Orchestrator** | `anthropic/claude-opus-4-7` | Primary for project-manager |
| **GLM Coding** | `zai-coding-plan/glm-5.1` | Builder agent primary |
| **MiniMax** | `minimax-coding-plan/MiniMax-M2.7-highspeed` | Researcher/parallel tasks |
| **Mimo** | `xiaomi-token-plan-sgp/mimo-v2.5-pro` | Synthesizer agent primary |
| **Gemini** | `google/gemini-3.1-pro-preview` | Architect failover |
| **Judge** | `crof/deepseek-v4-pro` | ~6000 requests/day quota |

---

## Banned Prefixes (will not use)

- `openrouter/*`
- `zai/*` (without `-coding-plan`)
- `opencode/*`
- `opencode-go/*`

---

## Fallback Chain Convention

For each agent, the `model` array in the preset config is ordered:

1. **Primary** — best model for the role (e.g., `zai-coding-plan/glm-5.1` for builder)
2. **Fallback 1** — secondary option (e.g., `minimax-coding-plan/MiniMax-M2.7-highspeed`)
3. **Fallback 2** — tertiary option (e.g., `google/gemini-3.1-pro-preview` or `anthropic/claude-opus-4-7`)

The `foreground-fallback` hook will automatically fail over to the next model in the chain on rate-limit errors.

---

## Two-Stage Research Pattern

1. **Gather phase** — `researcher` agent uses `minimax-coding-plan/MiniMax-M2.7-highspeed` for parallel websearch + summary
2. **Synthesize phase** — `synthesizer` agent uses `xiaomi-token-plan-sgp/mimo-v2.5-pro` primary → `google/gemini-3.1-pro-preview` fallback to compress outputs
3. **Architect phase** — `architect` agent uses `google/gemini-3.1-pro-preview` primary → `anthropic/claude-opus-4-7` fallback for planning

---

## Last Updated

2026-05-24
