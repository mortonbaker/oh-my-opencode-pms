---
name: harness-deploy
description: Deploy opencode-harness changes to all tailnet machines using canary-then-fanout strategy. Use when user asks to deploy harness updates, push harness to tailnet, or roll out plugin/skill changes machine-wide. NEVER use for individual repo changes — only opencode-harness itself. Variant A — explicit deploy on command, no auto-deploy.
---

# Harness deploy contract

When the user invokes you ("deploy the harness", "push harness updates to tailnet", "roll out the new plugin"), you MUST follow this exact sequence. No skipping. No proceeding to fanout if canary smoke fails.

## Pre-flight (you do these BEFORE invoking the deploy plugin)

### Step 1 — Verify clean working tree

Run: `git -C ~/Code/opencode-harness status --porcelain`

Required: empty output. If non-empty, STOP and report the dirty files. Operator must commit or stash.

### Step 2 — Verify tests pass locally

Run: `cd ~/Code/opencode-harness && npx vitest run`

Required: exit 0, all suites green. If any test fails, STOP and report. No deploy on red.

### Step 3 — Show the canary plan

Read `~/Code/opencode-harness/manifests/tailnet.json` and print:
- The canary host + bake_seconds
- All non-deferred fanout peers grouped by platform (linux/windows)
- Any deferred peers + reason

Format as a table.

### Step 4 — Get explicit user approval for canary

Ask: "Proceed with canary deploy to <canary host> (bake = <bake_seconds>s)?"

Wait for user "yes" or equivalent. STOP if user declines.

## Canary stage (invoke `harness_deploy` tool with `stage: "canary"`)

### Step 5 — Invoke canary stage

The plugin runs stages 1-7 (PRECOMMIT → LOCAL_TESTS → LOCAL_INSTALL → LOCAL_SMOKE → CANARY_DEPLOY → CANARY_SMOKE → BAKE).

You MUST surface the smoke-test JSON report verbatim to the user. The report contains:
- Per-stage pass/fail with timing
- Smoke test names + results (8 falsifiable tests)
- Bake observations (any ERROR-level lines from canary's opencode log)

### Step 6 — Report canary outcome

If canary stage failed:
- Report which stage + why
- Plugin auto-reverts canary to previous git SHA
- STOP. Do not proceed to fanout.

If canary stage passed:
- Report bake observations (clean / N errors)
- Ask: "Canary green and bake clean. Proceed with fanout to <N> non-deferred peers?"
- Wait for explicit user approval. STOP if user declines.

## Fanout stage (invoke `harness_deploy` tool with `stage: "fanout"`)

### Step 7 — Invoke fanout stage

The plugin runs stages 8-10 (FANOUT_PARALLEL → FANOUT_SMOKE → AUDIT) over ALL non-deferred peers in parallel.

### Step 8 — Report fanout outcome

Print a table:
| host | platform | git_pull | install | smoke | result |
|---|---|---|---|---|---|

Failed peers: report cause, plugin already auto-reverted them. Surface the audit log path.

Deferred peers: list with reason.

## Hard rules (you cannot skip)

- NEVER invoke `harness_deploy` with `stage: "fanout"` if canary smoke failed
- NEVER invoke `harness_deploy` without explicit user approval at step 4 AND step 6
- NEVER skip the smoke-test JSON surfacing — operator MUST see what passed/failed
- NEVER edit `manifests/tailnet.json` as part of the deploy — that's a separate operator action

## What this skill is NOT

- NOT for deploying repo-specific changes (use the repo's own deploy)
- NOT for deploying changes to atlas-automation, pms, or pms-design
- NOT a workflow with branching — strictly the canary→bake→fanout protocol per May 2026 best practices (Google SRE workbook, AWS ECS gradual deployments, GenAIPatterns Cascading)

## Loud failure plan

Every stage failure writes a structured escalation via `escalation.ts::escalate()`. Bake-window log errors trigger same-day TTS escalation. The audit record at `runs/deploys/<timestamp>.jsonl` captures full stage timings and per-peer outcomes for offline review.
