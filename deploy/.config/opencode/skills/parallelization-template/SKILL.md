---
name: parallelization-template
description: Decomposition contract for parallel subagent dispatch. Use ONLY when parallel-detector plugin injected a `PARALLELIZATION DETECTED` system-reminder. Provides the deterministic markdown template the orchestrator copies verbatim into each parallel `task` tool call. Not a workflow — a template.
---

# Parallelization template

When `parallel-detector` injects a `PARALLELIZATION DETECTED` reminder, you MUST use this template for the decomposition.

## Step 1 — Build the unit table

For the N units the reminder named, fill this table:

| unit_id | scope | success_criteria | verification_commands | expected_output_shape |
|---|---|---|---|---|
| u1 | <one-line scope> | <falsifiable criterion> | <shell cmd or read_only> | <field list> |
| u2 | ... | ... | ... | ... |
| ... | | | | |

**Constraints**:
- `unit_id` must be stable + unique (e.g. `audit-features-claims`, `audit-features-financial`)
- `scope` must reference an absolute file path or an unambiguous symbol
- `success_criteria` MUST be falsifiable — use measurable verbs (`exits 0`, `returns`, `equals`, `contains`, `count == N`, `file exists`, `matches /regex/`, `passes`)
- `verification_commands` MUST be present OR the unit MUST be annotated `read_only`/`research_only`/`prose_only`
- `expected_output_shape` must list ≥3 named fields when verification is empty

## Step 2 — Per-unit dispatch prompt template

Each parallel `task` tool call uses THIS exact prompt structure:

```
<one-paragraph context — what's being audited/changed/tested and why>

## Scope
<absolute path or symbol — narrow as possible>

## Success Criteria (machine-checkable)
- [ ] <criterion 1 with measurable verb>
- [ ] <criterion 2 with measurable verb>
- [ ] <criterion 3 with measurable verb>

## Verification Commands
```
<shell command 1>
<shell command 2>
```
OR
verificationCommands: []  read_only

## Expected Output Shape
- field_name_1: <type or example>
- field_name_2: <type or example>
- field_name_3: <type or example>

## Constraints
- Read-only OR write-isolated to <single path>
- Do not modify <off-limits paths>

Stop when done. Report against the Expected Output Shape exactly.
```

## Step 3 — Self-review checklist (before fan-out)

Before dispatching the parallel `task` calls, confirm each unit:

- [ ] unit prompts each have `## Success Criteria`, `## Verification Commands`, `## Expected Output Shape`
- [ ] unit work is truly independent (no cross-unit dependencies)
- [ ] write paths are non-overlapping (no merge conflicts)
- [ ] each unit fits in subagent context (<30k input tokens estimated)
- [ ] verification commands actually test the criteria (not just compile/lint)

If any box is unchecked, re-decompose. The `criteria-validator` plugin will hard-block any dispatch that fails this contract — fix it before dispatching, not after the block.

## Step 4 — Fan out

Dispatch all N units in a SINGLE message containing N `task` tool-use blocks. This is the documented Anthropic parallel-dispatch pattern.

## Step 5 — Aggregate

When all N return, merge into a single report:
- Per-unit pass/fail
- Aggregate findings (what's common across units)
- Any unit that escalated → orchestrator review

## What this skill is NOT

- NOT a planner — the orchestrator decomposes, this is just the contract
- NOT an executor — the `task` tool dispatches subagents
- NOT a workflow with branches — strictly a template

## What triggers this skill

Only the `parallel-detector` plugin's `PARALLELIZATION DETECTED` system-reminder. Do not invoke this skill for sequential work or for single-unit tasks. The plugin's regex+haiku cascade decides; this skill provides the contract once the decision is made.
