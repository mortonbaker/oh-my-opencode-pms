# Response Template — SOCRR + BLUF + 6-inch putt

**Enforced deterministically by `src/hooks/research-gate/index.ts`.** Any response
asking the operator a question without a `## What I researched` section is
auto-flagged and the orchestrator is forced to self-correct on the next turn.

## Why this template

Researched May 2026 — canonical option-presentation patterns:

| Source | Core rule |
|---|---|
| Spaeth, "Decision Architecture" (righthandchief.substack.com, 2025) | *"Don't bring a question. Bring a call. Line it up. Let your principal tap it in. The 6-inch putt."* |
| River 2026 briefing-memo guide | BLUF in sentence 1; 2-3 options max; status quo is always one; explicit decision + deadline |
| Manager-Tools SOCRR | Situation → Options → Criteria → **R**ecommendation → **R**equest. The Request is non-optional. |
| Jacobian SOCCR (2021) | *"Don't present an option you can't support."* Build from facts to opinion. |
| Princeton policy-memo (Cameron) | Help the boss decide; do NOT persuade. 10 common mistakes including cheerleading + flunking elevator test. |
| Hazeldine, "4-slide framework" (May 2026) | Three options sweet spot. Two = forced choice. Five = unholdable. |
| Umbrex "Decision-Quality Deliverables" (Feb 2026) | *"If you include a strawman, leaders will sense manipulation and lose trust."* |
| Anthropic / Claude Cookbook | BLUF non-negotiable; one-page max. |

## The template

```
## BLUF
<one sentence: the call I'm making>
<one sentence: why this is the call (cite a researched best practice
OR an irreversibility flag)>

## What I researched
- <source 1>: <relevant finding in ≤15 words>
- <source 2>: <relevant finding in ≤15 words>
(If empty, research-gate WILL fire on the next turn — the operator's
hard rule is "no questions without prior research".)

## What I'm doing
<numbered list of concrete actions about to happen, each ≤1 sentence>

## Reversibility
<reversible — proceeding unless stopped>
OR
<irreversible — pausing for explicit go>

## What I need from you
<exactly zero or one explicit ask, with a default>
"Say 'go' or override <field>. Defaulting to <X> in <timeframe>."
```

## What this template does NOT allow

- Asking "would you prefer A or B?" without first doing the lookup that
  reveals which is canonical
- Listing 3+ options where the right answer is obvious (the "strawman" failure)
- Open-ended questions ("what do you want next?") without a default proposal
- Reversal of BLUF — burying the recommendation in paragraph 3
- Multi-question batches where one is substantive and the rest are trivial
- Asking about file paths, naming, formatting, or anything answerable by
  `read`, `grep`, `glob`, `ls`, `gh`, web search, or a skill load

## Reversibility filter (Spaeth, Right Hand Chief, 2025)

**Reversible decisions:** just do it. Don't escalate. Reversibility is usually
GREATER than the brain assumes in the moment. Escalating a reversible decision
wastes operator attention and signals indecision.

**Irreversible decisions:** present properly with the template above. Reversibility
is usually LESS than the brain assumes in the moment when escalating; when *doing*,
re-check: "can I unwind this in one git command?" If yes, reversible.

## Worked example (mid-execution turn, irreversible step ahead)

```
## BLUF
Going with `opencode-memsearch` as-is (per-turn haiku summary +
cold-start injection) plus a pms pre-compaction-flush hook. Memory dir at
`~/.local/share/agent-memory/`, synced via 15-min git push to private
`mortonbaker/agent-memory`.

## What I researched
- jdormit/opencode-memsearch (Mar 2026): every-turn haiku summary,
  system-prompt injection — exact match for canonical pattern
- Claude Cookbook (Mar 2026, Anthropic): pre-compaction flush is the
  "single pattern that fixes the worst failure mode of memory systems"
- Letta MemFS: git-backed memory dir = proven cross-machine sync

## What I'm doing
1. Install opencode-memsearch + configure for ~/.local/share/agent-memory/
2. Build pms hook: hooks/precompact-flush/ (~50 LOC)
3. Create private GitHub repo agent-memory + cron sync every 15 min
4. Demote mem0 to weekly semantic-search-over-the-log role

## Reversibility
Reversible — every file git-tracked, mem0 deletable, plugin uninstallable.

## What I need from you
"Go" to proceed. Override the GitHub username if not `mortonbaker`.
```

## What happens when the template is violated

`src/hooks/research-gate/index.ts` runs on `experimental.chat.messages.transform`,
scans the most recent assistant message for any `?` (outside code blocks and URLs)
absent a `## What I researched` section. On violation:

1. Logs to `~/.local/share/agent-memory/events.jsonl` as
   `type=research_gate_violation` with a 500-char excerpt — surfaces in weekly
   compaction.
2. Injects a strong `<system-reminder>` into the next outgoing message stream
   forcing the orchestrator to self-correct: either delete the question
   (it was unnecessary) or dispatch @researcher and surface the call properly.

## See also

- `src/hooks/research-gate/index.ts` — the enforcement
- `~/.config/opencode/oh-my-opencode-pms/project-manager_append.md` — the operator
  preference for clarifying questions (subset of this template's rule)
- `docs/HARNESS.md` — the complete system map
