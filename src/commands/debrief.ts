/**
 * /debrief — session-end forcing function. Captures durable artifacts
 * before context resets or session ends.
 *
 * Operator's mental model: "before we wrap, what should outlive this
 * session?" Without this command those learnings live only in conversation
 * context which evaporates on the next /clear or compaction.
 *
 * Two-phase design:
 *
 *   Phase 1 (this command, deterministic):
 *     - Read events.jsonl entries from the last N hours
 *     - Read decisions/*.md created in the last N hours
 *     - Build a structured digest at
 *       ~/.local/share/agent-memory/debriefs/<session-id>.md
 *     - Emit a `type=session_debrief` event indexing the digest
 *     - Return a short confirmation + path
 *
 *   Phase 2 (orchestrator's NEXT TURN, LLM-driven):
 *     - Operator-preference-approved: auto-write ADRs for classified
 *       items + auto-append patterns/preferences to events.jsonl
 *     - Surface the resulting checklist so operator can retroactive-delete
 *
 * The split lets us ship the deterministic plumbing in this command
 * without locking in any specific LLM-classification flow — the
 * orchestrator already has the model loaded and the harness already has
 * the /remember + agent-mem CLI for writes.
 *
 * Pattern: mirrors src/commands/remember.ts (short-circuit
 * handleCommandExecuteBefore, no LLM hop inside the command itself).
 *
 * Reference: Letta sleep-time compute pattern (every-N-steps memory
 * consolidation) + Anthropic Cookbook pre-compaction flush (save before
 * context drop).
 */

import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

const STORE_DIR = join(homedir(), '.local', 'share', 'agent-memory');
const DEBRIEFS_DIR = join(STORE_DIR, 'debriefs');
const DECISIONS_DIR = join(STORE_DIR, 'decisions');
const EVENTS_LOG = join(STORE_DIR, 'events.jsonl');
const COMMAND_NAME = 'debrief';
const DEFAULT_HOURS_BACK = 6;

interface MemoryEvent {
  ts: string;
  machine: string;
  agent?: string;
  session?: string;
  type: string;
  tags?: string[];
  text: string;
  doc?: string;
}

export async function readRecentEvents(hoursBack: number): Promise<MemoryEvent[]> {
  try {
    const raw = await readFile(EVENTS_LOG, 'utf-8');
    const cutoff = Date.now() - hoursBack * 3600_000;
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try { return JSON.parse(l) as MemoryEvent; } catch { return null; }
      })
      .filter((e): e is MemoryEvent => {
        if (!e) return false;
        const ts = Date.parse(e.ts);
        return Number.isFinite(ts) && ts >= cutoff;
      });
  } catch {
    return [];
  }
}

export async function readRecentDecisions(hoursBack: number): Promise<string[]> {
  try {
    const entries = await readdir(DECISIONS_DIR);
    const cutoff = Date.now() - hoursBack * 3600_000;
    const recent: string[] = [];
    for (const name of entries) {
      const fullPath = join(DECISIONS_DIR, name);
      try {
        const content = await readFile(fullPath, 'utf-8');
        const dateMatch = content.match(/^date: (\d{4}-\d{2}-\d{2})/m);
        if (dateMatch) {
          const decisionTs = Date.parse(dateMatch[1]);
          if (Number.isFinite(decisionTs) && decisionTs >= cutoff - 86400_000) {
            recent.push(name);
          }
        }
      } catch {}
    }
    return recent.sort();
  } catch {
    return [];
  }
}

/**
 * Pure logic: build the debrief markdown body.
 * Exported for testing.
 */
export function buildDebriefBody(opts: {
  sessionID: string;
  agent?: string;
  hoursBack: number;
  operatorNotes: string;
  events: MemoryEvent[];
  decisions: string[];
  machine: string;
}): string {
  const padded = new Date().toISOString().slice(0, 10);
  const eventsByType: Record<string, MemoryEvent[]> = {};
  for (const e of opts.events) {
    if (!eventsByType[e.type]) eventsByType[e.type] = [];
    eventsByType[e.type].push(e);
  }
  const lines: string[] = [];
  lines.push('---');
  lines.push(`session: ${opts.sessionID}`);
  lines.push(`agent: ${opts.agent ?? 'orchestrator'}`);
  lines.push(`machine: ${opts.machine}`);
  lines.push(`date: ${padded}`);
  lines.push(`type: session_debrief`);
  lines.push(`hours_back: ${opts.hoursBack}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Session debrief — ${opts.sessionID.slice(-12)} (${padded})`);
  lines.push('');

  if (opts.operatorNotes.trim().length > 0) {
    lines.push('## Operator notes');
    lines.push('');
    lines.push(opts.operatorNotes);
    lines.push('');
  }

  lines.push('## Recent events by type');
  lines.push('');
  if (Object.keys(eventsByType).length === 0) {
    lines.push('_(no events in window)_');
  } else {
    for (const t of Object.keys(eventsByType).sort()) {
      lines.push(`### ${t} (${eventsByType[t].length})`);
      lines.push('');
      for (const e of eventsByType[t].slice(-10)) {
        const snippet = e.text.length > 140 ? e.text.slice(0, 137) + '...' : e.text;
        lines.push(`- [${e.ts}] ${snippet}`);
      }
      lines.push('');
    }
  }

  if (opts.decisions.length > 0) {
    lines.push('## ADR decisions in window');
    lines.push('');
    for (const d of opts.decisions) lines.push(`- \`${d}\``);
    lines.push('');
  }

  lines.push('## Classification checklist (orchestrator next-turn auto-writes)');
  lines.push('');
  lines.push('The orchestrator should review the events above and write durable');
  lines.push('artifacts to their proper destinations. Per operator preference');
  lines.push('(approved 2026-05-25): auto-write ADRs, then surface the result');
  lines.push('for retroactive-delete.');
  lines.push('');
  lines.push('Routing table:');
  lines.push('');
  lines.push('| Type | Destination | How |');
  lines.push('|---|---|---|');
  lines.push('| `pattern` | events.jsonl | `agent-mem append --type=pattern "..."` |');
  lines.push('| `preference` | events.jsonl | `agent-mem append --type=preference "..."` |');
  lines.push('| `decision` (ADR-worthy) | decisions/ + events.jsonl | `/remember <text>` |');
  lines.push('| `hook-idea` | events.jsonl as deferred | `agent-mem append --type=deferred --tags=hook-idea "..."` |');
  lines.push('| `command-idea` | events.jsonl as deferred | `agent-mem append --type=deferred --tags=command-idea "..."` |');
  lines.push('| `skill-idea` | events.jsonl as deferred | `agent-mem append --type=deferred --tags=skill-idea "..."` |');
  lines.push('| `script-idea` | events.jsonl as deferred | `agent-mem append --type=deferred --tags=script-idea "..."` |');
  lines.push('| `doc-update` | suggestion-only, no auto-write | inline note to operator |');
  lines.push('');
  lines.push('## What worked exceptionally well this session');
  lines.push('');
  lines.push('_(orchestrator fills this in on next turn — these become `type=pattern` events)_');
  lines.push('');

  return lines.join('\n');
}

interface DebriefResult {
  sessionID: string;
  digestPath: string;
  eventsCount: number;
  decisionsCount: number;
  eventLine: string;
}

export async function runDebrief(opts: {
  sessionID: string;
  agent?: string;
  hoursBack?: number;
  operatorNotes?: string;
}): Promise<DebriefResult> {
  const hoursBack = opts.hoursBack ?? DEFAULT_HOURS_BACK;
  await mkdir(DEBRIEFS_DIR, { recursive: true });
  const events = await readRecentEvents(hoursBack);
  const decisions = await readRecentDecisions(hoursBack);

  const body = buildDebriefBody({
    sessionID: opts.sessionID,
    agent: opts.agent,
    hoursBack,
    operatorNotes: opts.operatorNotes ?? '',
    events,
    decisions,
    machine: hostname().split('.')[0],
  });

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const digestPath = join(
    DEBRIEFS_DIR,
    `${date}-${opts.sessionID.replace(/[^a-zA-Z0-9_-]/g, '').slice(-16)}.md`,
  );
  await writeFile(digestPath, body, { mode: 0o644 });

  const event = {
    ts: new Date().toISOString(),
    machine: hostname().split('.')[0],
    agent: opts.agent ?? 'orchestrator',
    session: opts.sessionID,
    type: 'session_debrief',
    tags: ['debrief', `events-${events.length}`, `decisions-${decisions.length}`],
    text: `Debrief covering ${hoursBack}h: ${events.length} events, ${decisions.length} decisions. See ${digestPath.replace(homedir(), '~')}`,
    doc: digestPath.replace(homedir(), '~'),
  };
  const eventLine = JSON.stringify(event);
  await appendFile(EVENTS_LOG, eventLine + '\n', { flag: 'a' });

  return {
    sessionID: opts.sessionID,
    digestPath,
    eventsCount: events.length,
    decisionsCount: decisions.length,
    eventLine,
  };
}

const REMINDER_FOR_ORCHESTRATOR = [
  '<system-reminder>',
  'A /debrief digest was just generated at the path above.',
  '',
  'Per operator-approved policy (2026-05-25): on this NEXT TURN you must:',
  '',
  '1. Read the digest file via the Read tool.',
  '2. For each notable item from "Recent events by type", classify it into',
  '   one of the routing-table categories.',
  '3. Auto-write each classified item to its destination:',
  '     - `pattern` / `preference` → `agent-mem append --type=<t> "..."`',
  '     - ADR-worthy `decision` → `agent-mem append --type=decision`',
  '       AND create a structured doc in `decisions/` via /remember pattern',
  '     - `*-idea` → `agent-mem append --type=deferred --tags=<idea-type> "..."`',
  '     - `doc-update` → inline note in your response (no auto-write)',
  '4. Reply with a checklist of EVERYTHING you wrote so the operator can',
  '   retroactively delete any bad classifications.',
  '5. End with one-line summary: "✓ Wrote N patterns, M deferred ideas, K ADRs."',
  '',
  'Do NOT ask which items to classify — auto-classify and write all of them.',
  'The operator approved bulk-write + retroactive-delete over per-item approval.',
  '</system-reminder>',
].join('\n');

interface OpencodeConfig {
  command?: Record<string, unknown>;
}

interface CommandExecuteBeforeInput {
  command: string;
  sessionID: string;
  arguments: string;
}

interface CommandExecuteBeforeOutput {
  parts: Array<{ type: string; text?: string }>;
}

export function createDebriefCommand(
  options?: { getAgentName?: (sessionID: string) => string | undefined },
): {
  registerCommand: (config: OpencodeConfig) => void;
  handleCommandExecuteBefore: (
    input: CommandExecuteBeforeInput,
    output: CommandExecuteBeforeOutput,
  ) => Promise<void>;
} {
  return {
    registerCommand: (opencodeConfig) => {
      if (!opencodeConfig.command) opencodeConfig.command = {};
      const cmd = opencodeConfig.command as Record<string, unknown>;
      if (cmd[COMMAND_NAME]) return;
      cmd[COMMAND_NAME] = {
        template:
          'Generate a session debrief digest. Auto-classifies and writes durable artifacts to the agent-memory store per operator-approved policy.',
        description:
          'Session-end debrief — captures patterns, preferences, decisions, deferred ideas before context resets',
      };
    },

    handleCommandExecuteBefore: async (input, output) => {
      if (input.command !== COMMAND_NAME) return;
      output.parts.length = 0;

      try {
        const agent = options?.getAgentName?.(input.sessionID);
        const operatorNotes = input.arguments.trim();
        const result = await runDebrief({
          sessionID: input.sessionID,
          agent,
          operatorNotes,
        });

        output.parts.push({
          type: 'text',
          text: [
            `✓ /debrief digest written`,
            `  doc: ${result.digestPath.replace(homedir(), '~')}`,
            `  scope: ${result.eventsCount} recent events, ${result.decisionsCount} ADRs in window`,
            ``,
            REMINDER_FOR_ORCHESTRATOR,
          ].join('\n'),
        });
      } catch (err) {
        output.parts.push({
          type: 'text',
          text: `/debrief: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}

export const __testing = {
  COMMAND_NAME,
  DEBRIEFS_DIR,
  EVENTS_LOG,
  REMINDER_FOR_ORCHESTRATOR,
  DEFAULT_HOURS_BACK,
};
