/**
 * /remember — promote a piece of information from in-conversation context
 * to a DURABLE structured record. Two writes happen atomically:
 *
 *   1. A Lightweight ADR-style markdown file at
 *      ~/.local/share/agent-memory/decisions/NNNN-<slug>.md
 *      (ThoughtWorks 2016 / Nygard 2011 / new-adr-style numbering)
 *
 *   2. An entry in ~/.local/share/agent-memory/events.jsonl with
 *      type=decision and a `doc:` field pointing at the ADR
 *
 * Both writes flow back to mortonbaker/agent-memory via the existing
 * /15-min sync-memory.sh cron — so the record propagates to every
 * tailnet machine without manual sync.
 *
 * Why a structured doc instead of just an events.jsonl append?
 * Per DEV community 2026-05-18 ("What an AI agent's memory layer
 * actually has to store"): durable memory =
 *   - decisions (what + why + what was superseded)
 *   - boundaries (X owns Y, do not touch Z)
 *   - authoritative sources (file F is source of truth for X)
 *   - failure modes (what broke + cause)
 *   - mandatory conventions
 * Each of these benefits from a STRUCTURED record with searchable
 * frontmatter, not just a one-line log entry. The log entry is the
 * INDEX; the .md file is the body.
 *
 * Per Hidekazu Konishi (May 2026), "Storage matters more than format.
 * ThoughtWorks 2016 keep ADRs in source control. Wiki = invisible."
 * → our store is git-tracked (agent-memory private repo).
 *
 * Usage in opencode:
 *   /remember <free-form text>          → type=decision, default title
 *   /remember Operator prefers tabs     → numbered doc + events.jsonl entry
 *
 * The command is INTERCEPTED before the LLM sees it (no LLM call needed
 * for the simple case). For complex multi-paragraph remembrances the
 * operator can edit the generated .md file directly afterwards.
 */

import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

const STORE_DIR = join(homedir(), '.local', 'share', 'agent-memory');
const DECISIONS_DIR = join(STORE_DIR, 'decisions');
const EVENTS_LOG = join(STORE_DIR, 'events.jsonl');
const COMMAND_NAME = 'remember';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || 'untitled';
}

async function nextOrdinal(): Promise<number> {
  try {
    const entries = await readdir(DECISIONS_DIR);
    let max = 0;
    for (const e of entries) {
      const m = e.match(/^(\d+)-/);
      if (m) {
        const n = Number(m[1]);
        if (n > max) max = n;
      }
    }
    return max + 1;
  } catch {
    return 1;
  }
}

interface RememberResult {
  ordinal: number;
  slug: string;
  docPath: string;
  eventLine: string;
}

/**
 * Pure logic: format ADR markdown body.
 * Exported for testing.
 */
export function buildAdrBody(opts: {
  ordinal: number;
  title: string;
  text: string;
  machine: string;
  sessionID?: string;
  agent?: string;
}): string {
  const padded = String(opts.ordinal).padStart(4, '0');
  const date = new Date().toISOString().slice(0, 10);
  return [
    '---',
    `id: ADR-${padded}`,
    `title: ${opts.title}`,
    `date: ${date}`,
    `status: accepted`,
    `machine: ${opts.machine}`,
    `agent: ${opts.agent ?? 'orchestrator'}`,
    opts.sessionID ? `session: ${opts.sessionID}` : '',
    `type: decision`,
    '---',
    '',
    `# ADR-${padded}: ${opts.title}`,
    '',
    '## Context',
    '',
    'Captured via `/remember` slash command.',
    '',
    '## Decision',
    '',
    opts.text,
    '',
    '## Consequences',
    '',
    '_To be filled in if/when this decision drives observable downstream',
    'changes. Re-edit this file directly to amend._',
    '',
    '## Source',
    '',
    opts.sessionID
      ? `opencode session: \`${opts.sessionID}\``
      : 'manual entry (no session id)',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * Atomic-ish write of an ADR + an indexing log entry.
 * Returns the resulting paths for caller-side messaging.
 */
export async function remember(opts: {
  text: string;
  sessionID?: string;
  agent?: string;
}): Promise<RememberResult> {
  if (!opts.text || opts.text.trim().length === 0) {
    throw new Error('/remember: text is required');
  }

  await mkdir(DECISIONS_DIR, { recursive: true });

  const ordinal = await nextOrdinal();
  // Title = first line, or first 80 chars
  const firstLine = opts.text.split('\n')[0].trim();
  const title = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
  const slug = slugify(title);
  const padded = String(ordinal).padStart(4, '0');
  const docPath = join(DECISIONS_DIR, `${padded}-${slug}.md`);

  const body = buildAdrBody({
    ordinal,
    title,
    text: opts.text,
    machine: hostname().split('.')[0],
    sessionID: opts.sessionID,
    agent: opts.agent,
  });
  await writeFile(docPath, body, { mode: 0o644 });

  const event = {
    ts: new Date().toISOString(),
    machine: hostname().split('.')[0],
    agent: opts.agent ?? 'orchestrator',
    session: opts.sessionID ?? 'manual',
    type: 'decision',
    tags: ['remember', `adr-${padded}`],
    text: title,
    doc: docPath.replace(homedir(), '~'),
  };
  const eventLine = JSON.stringify(event);
  await appendFile(EVENTS_LOG, eventLine + '\n', { flag: 'a' });

  return { ordinal, slug, docPath, eventLine };
}

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

/**
 * Public: createRememberCommand() — exposes the opencode-compatible
 * registerCommand + handleCommandExecuteBefore pair, mirroring
 * the convention used by session-goal / interview / preset commands.
 */
export function createRememberCommand(
  options?: {
    getAgentName?: (sessionID: string) => string | undefined;
  },
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
          'Promote the given text to a durable ADR-style decision record at ~/.local/share/agent-memory/decisions/. Also appends to events.jsonl with type=decision for cross-session retrieval.',
        description:
          'Capture a durable decision/preference/topology fact as a structured ADR + events.jsonl index entry',
      };
    },

    handleCommandExecuteBefore: async (input, output) => {
      if (input.command !== COMMAND_NAME) return;

      // Short-circuit: don't let the LLM see this. Do the filesystem
      // work synchronously and replace the output with a confirmation.
      output.parts.length = 0;

      const text = input.arguments.trim();
      if (!text) {
        output.parts.push({
          type: 'text',
          text:
            '/remember: provide text to capture.\nUsage: /remember <durable fact>\nExample: /remember Operator prefers tabs over spaces in JSON',
        });
        return;
      }

      try {
        const agent = options?.getAgentName?.(input.sessionID);
        const result = await remember({
          text,
          sessionID: input.sessionID,
          agent,
        });
        output.parts.push({
          type: 'text',
          text: [
            `✓ Remembered as ADR-${String(result.ordinal).padStart(4, '0')}`,
            `  doc: ${result.docPath.replace(homedir(), '~')}`,
            `  index: events.jsonl (type=decision)`,
            ``,
            `Next sync: /15-min cron will push to mortonbaker/agent-memory.`,
            `Force sync now: bash ~/Code/oh-my-opencode-pms/scripts/sync-memory.sh`,
          ].join('\n'),
        });
      } catch (err) {
        output.parts.push({
          type: 'text',
          text: `/remember: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}

export const __testing = {
  slugify,
  STORE_DIR,
  DECISIONS_DIR,
  EVENTS_LOG,
  COMMAND_NAME,
};
