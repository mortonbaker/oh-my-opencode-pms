# MIMO Multi-Account Load Distribution Plan

## Problem

Claude Max subscription tokens burn out quickly during normal orchestration use. MIMO and MiniMax have huge limits but a single account still has quotas. Distributing load across multiple mimo accounts effectively multiplies total available quota.

## Strategy

Interleave multiple mimo API keys in the model cascade so requests round-robin across accounts before falling through to MiniMax.

## Provider Info

- **Provider:** Xiaomi Token Plan (Singapore)
- **API Base URL:** `https://token-plan-sgp.xiaomimimo.com/v1`
- **Anthropic-compat URL:** `https://token-plan-sgp.xiaomimimo.com/anthropic`
- **Models:** `mimo-v2.5-pro`, `mimo-v2.5`, `mimo-v2-flash`, `mimo-v2-omni`, `mimo-v2-pro`
- **npm package:** `@ai-sdk/openai-compatible`

## Setup Steps (per additional account)

### 1. Create a new xiaomi account and get an API key

### 2. Register the credential

Run `/connect` in opencode TUI, scroll to **Other**, enter provider ID:

```
xiaomi-2
```

Paste the API key when prompted.

### 3. Configure the custom provider

Add to `~/.config/opencode/opencode.jsonc` under `"provider"`:

```jsonc
"provider": {
  "xiaomi-2": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Xiaomi #2",
    "options": {
      "baseURL": "https://token-plan-sgp.xiaomimimo.com/v1"
    },
    "models": {
      "mimo-v2.5-pro": {},
      "mimo-v2.5": {}
    }
  }
}
```

For `xiaomi-3`, `xiaomi-4`, etc. repeat with the same pattern.

### 4. Update the model cascade

In `~/.config/opencode/oh-my-opencode-slim.json`, update each role's model array:

```json
"model": [
  "xiaomi-token-plan-sgp/mimo-v2.5-pro",
  "xiaomi-2/mimo-v2.5-pro",
  "xiaomi-3/mimo-v2.5-pro",
  "minimax-coding-plan/MiniMax-M2.7-highspeed",
  "xiaomi-token-plan-sgp/mimo-v2.5"
]
```

The cascade tries account 1, then account 2, then account 3, then MiniMax as safety net, then mimo-v2.5 (smaller/cheaper) as last resort.

## Cascade Logic

| Priority | Model | Purpose |
|----------|-------|---------|
| 1 | `xiaomi-token-plan-sgp/mimo-v2.5-pro` | Primary mimo account |
| 2 | `xiaomi-2/mimo-v2.5-pro` | Second account, catches overflow |
| 3 | `xiaomi-3/mimo-v2.5-pro` | Third account (if needed) |
| N | `minimax-coding-plan/MiniMax-M2.7-highspeed` | Different provider safety net |
| last | `xiaomi-token-plan-sgp/mimo-v2.5` | Smaller model, last resort |

## Current Config (2026-05-24)

All PMS roles (architect, builder, judge, qa-reviewer, researcher) use:

```json
"model": [
  "xiaomi-token-plan-sgp/mimo-v2.5-pro",
  "minimax-coding-plan/MiniMax-M2.7-highspeed",
  "xiaomi-token-plan-sgp/mimo-v2.5"
]
```

Orchestrator uses Claude Opus 4.7 as primary (Max subscription), same cascade as fallback.

## Notes

- Each mimo account is an independent quota — doubling accounts roughly doubles throughput
- MiniMax is kept as cross-provider fallback (different infrastructure, different limits)
- z.ai (GLM models) exists as a provider but is unreliable — not included in primary cascade
- Free tiers (opencode-go, opencode bridge) have tiny weekly limits and are not worth the complexity
- OpenRouter is available as pay-per-token fallback if needed
