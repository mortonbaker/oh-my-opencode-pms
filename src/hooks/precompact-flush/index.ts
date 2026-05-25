/**
 * precompact-flush — Anthropic Claude Cookbook pre-compaction memory flush.
 *
 * Reference (May 2026):
 *   "Run a pre-compaction flush — give the model one turn to save anything
 *    worth remembering before you summarize. This single pattern fixes the
 *    worst failure mode of every other memory system I have looked at."
 *   — Anthropic Claude Cookbook, Context Engineering, Mar 2026.
 *
 * Implementation:
 *   Hooks `experimental.session.compacting` (fires BEFORE opencode summarizes
 *   a session that's hit the token threshold). Appends a context block to the
 *   default compaction prompt instructing the model to identify and preserve
 *   durable facts (decisions, operator preferences, topology, conventions,
 *   failure modes) at the TOP of its compaction summary inside a
 *   `## Durable memories` section. Those bullets then live inside the
 *   compaction summary that survives into all future turns of the session.
 *
 * Optional v2 (NOT in v1): a second hook (chat.message or text.complete)
 *   scans newly-produced assistant text for `## Durable memories` blocks and
 *   auto-writes each bullet to ~/.local/share/agent-memory/events.jsonl via
 *   agent-mem append. For v1 we trust the compaction summary itself to carry
 *   the memory; subsequent turns get them for free via opencode's normal
 *   compaction-survival mechanism.
 *
 * Sources also referenced:
 *   - Letta sleep-time agents: "memory edits run on N-step cadence OR on
 *     compaction event" (docs.letta.com)
 *   - Springdrift sensorium (arxiv 2604.04660): structured XML block at every
 *     cycle preserving operational state across context resets
 *   - DEV community 2026-05-18: "Durable layer = decisions, boundaries,
 *     authoritative sources, failure modes, mandatory conventions. NOT
 *     exploration paths or stack traces."
 */

const HOOK_NAME = 'precompact-flush';

const FLUSH_INSTRUCTION = [
  '## Pre-compaction flush (HARD rule — execute before summarizing)',
  '',
  'Before producing your compaction summary, identify the small set of',
  'DURABLE facts from this session that need to survive into the next turn.',
  'Emit them as the FIRST section of your summary under the header:',
  '',
  '    ## Durable memories',
  '',
  'Each as a bullet on its own line, ≤200 chars, format:',
  '',
  '    - [<type>] <fact>',
  '',
  'Valid types (mirror agent-mem CLI vocabulary):',
  '  preference  — operator preference, working-style rule, "never do X"',
  '  decision    — choice made with rationale, especially Type-1 (irreversible)',
  '  topology    — machine/network/repo/file layout, "X lives at Y"',
  '  workflow    — repeatable procedure, "to do X, run Y then Z"',
  '  fact        — durable single-statement fact about the operator or system',
  '  deferred    — explicitly punted work + when it should resurface',
  '  drift       — observed deviation between intent and reality',
  '',
  'What to INCLUDE (per DEV community May 2026 + Anthropic Cookbook):',
  '  - Decisions made + WHY + what was superseded',
  '  - Operator preferences expressed (positive AND negative)',
  '  - Boundaries set ("X owns Y", "do not touch Z")',
  '  - Authoritative sources identified ("file F is source of truth for X")',
  '  - Failure modes hit + their cause',
  '  - Mandatory conventions established',
  '',
  'What to EXCLUDE:',
  '  - Exploration paths that did not pan out',
  '  - Verbatim stack traces or tool output',
  '  - Routine tool-shuffling',
  '  - Anything reproducible by re-reading a file',
  '',
  'AFTER `## Durable memories`, continue with the rest of your normal',
  'compaction summary. Both halves survive into the next turn.',
].join('\n');

interface CompactingInput {
  sessionID: string;
}

interface CompactingOutput {
  context: string[];
  prompt?: string;
}

export function createPrecompactFlushHook() {
  return {
    'experimental.session.compacting': async (
      _input: CompactingInput,
      output: CompactingOutput,
    ): Promise<void> => {
      // Append (do NOT replace) — preserve opencode's default compaction prompt
      output.context.push(FLUSH_INSTRUCTION);
    },
  };
}

export const __testing = {
  HOOK_NAME,
  FLUSH_INSTRUCTION,
};
