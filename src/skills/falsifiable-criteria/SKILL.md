---
name: falsifiable-criteria
description: Vocabulary and worked examples for authoring falsifiable success criteria. Use when composing any subagent dispatch (the criteria-validator plugin will hard-block dispatches with vague criteria). Provides the deterministic vocabulary the orchestrator must use.
---

# Falsifiable criteria authoring

The `criteria-validator` plugin hard-blocks any subagent dispatch whose `## Success Criteria` section uses vague terms or lacks measurable verbs. Use this vocabulary when composing dispatches.

## Measurable verbs (USE THESE)

Each criterion bullet MUST contain at least one:

| Verb | Example |
|---|---|
| `exits 0` | `[ ] \`npx tsc --noEmit\` exits 0` |
| `returns` | `[ ] handler returns HTTP 200 with body matching /\^\\\{"ok":true/` |
| `equals` | `[ ] response.tenant_id equals "01a51f01-..."` |
| `contains` | `[ ] stdout contains "X tests passed"` |
| `matches` | `[ ] log line matches /^\\d{4}-\\d{2}-\\d{2}T/` |
| `count ==` / `count >=` | `[ ] count of \`<button>\` elements == 3` |
| `file exists` | `[ ] file `src/foo.ts\` exists` |
| `passes` | `[ ] all tests in \`patient.test.ts\` pass` |
| `not present` / `does not contain` | `[ ] stderr does not contain "WARNING"` |
| `under N ms` / `< N ms` | `[ ] p95 latency < 100 ms` |
| `reduces by N%` | `[ ] bundle size reduces by 30%` |

## Vague terms (DO NOT USE without quantifier)

The plugin's blacklist (case-insensitive, blocks dispatch unless paired with a digit + unit):

```
nice, nicer, better, clean, cleaner, improve, improves,
smooth, smoother, polish, polished, modernize,
optimize, optimized, simplify
```

### Vague → falsifiable rewrites

| Vague (BLOCKED) | Falsifiable (ALLOWED) |
|---|---|
| Make the login flow nicer | `[ ] login form renders with no console errors` `[ ] form submission returns HTTP 200` `[ ] focus moves to password field on Tab` |
| Improve test coverage | `[ ] coverage of \`src/api/\` increases to ≥ 80%` (verified by `npx vitest --coverage`) |
| Clean up the schedule code | `[ ] cyclomatic complexity of \`schedule-workspace.jsx\` ≤ 10 (verified by \`eslint --rule complexity\`)` |
| Make it faster | `[ ] /api/v1/patients responds in < 200 ms p95 (verified by \`hey -n 100 -c 10\`)` |
| Better error messages | `[ ] each error response body contains \`{"code":"PMS-...","message":"..."}\`` |
| Polish the UI | `[ ] no contrast ratio < 4.5:1 (verified by \`npx pa11y http://localhost:5174\`)` |

## Per-subagent-type rules (criteria-validator enforces)

**fixer**: verification MUST contain at least one of `tsc | cargo build | cargo test | eslint | clippy | vitest | jest | pnpm test | npm test | bun test | pytest | go test`

**designer**: verification MUST contain `tsc` OR `eslint` AND a visual property check (regex match for `screenshot | count.*element | color | width | height | grep.*data-testid | playwright | cypress`)

**explorer**: verification MAY be `[]` IF prompt declares `read_only` AND `## Expected Output Shape` lists ≥3 fields

**librarian**: verification MAY be `[]` IF prompt declares `research_only` AND prompt requires citations/URLs/sources

**oracle**: verification MAY be `[]` IF prompt declares `prose_only` AND prompt requires structured review with severity/priority/recommendation/finding

## Worked example: full dispatch

```
Audit the login flow's tenant_hint resolution.

## Scope
prototype-web/src/features/login/login.tsx

## Success Criteria (machine-checkable)
- [ ] grep for \`pms_tenant_hint\` in \`login.tsx\` returns ≥ 1 match
- [ ] grep for \`VITE_DEFAULT_TENANT_HINT\` in \`login.tsx\` returns ≥ 1 match
- [ ] file \`prototype-web/.env.local\` exists OR \`pms_tenant_hint\` sessionStorage write site count == 0
- [ ] returned report contains fields: resolution_chain, env_var_value, fallback_value

## Verification Commands
verificationCommands: []  read_only

## Expected Output Shape
- resolution_chain: array of {source: string, line: number, value: string|null}
- env_var_value: string | null
- fallback_value: string | null

## Constraints
- Read-only — do not modify any file.

Stop when done.
```

## What this skill is NOT

- NOT a workflow — pure vocabulary reference
- NOT enforced by this skill — enforced by the `criteria-validator` plugin (Tier 0 regex + Tier 1 haiku)
- NOT specific to any subagent type — applies to ALL dispatches

When the `criteria-validator` plugin hard-blocks your dispatch, the structured-error JSON names the failed term. Open this skill, find the rewrite, dispatch again.
