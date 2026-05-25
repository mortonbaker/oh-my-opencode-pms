#!/usr/bin/env bun
/**
 * agent-mem — CLI for the canonical cross-machine memory store at
 * ~/.local/share/agent-memory/events.jsonl
 *
 * Usable from ANY shell (bare claude-code session, plain terminal,
 * other CLI agents) — does NOT require opencode to be running.
 *
 * Subcommands:
 *   agent-mem append --type=<type> [--tags=t1,t2] <text>
 *   agent-mem search <query>           (regex, case-insensitive)
 *   agent-mem tail [-n N]              (default N=20)
 *   agent-mem stats
 *   agent-mem sync                     (commit + push to remote)
 */

import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const STORE_DIR = join(homedir(), '.local', 'share', 'agent-memory');
const EVENTS_LOG = join(STORE_DIR, 'events.jsonl');
const VALID_TYPES = new Set([
  'preference',
  'decision',
  'topology',
  'deferred',
  'drift',
  'fact',
  'workflow',
  'pattern',                // "we did X, it worked, do X again next time"
  'archive_summary',
  'research_gate_violation',
  'session_debrief',        // emitted by /debrief command
  'manual',
]);

interface MemoryEvent {
  ts: string;
  machine: string;
  agent: string;
  session: string;
  type: string;
  tags?: string[];
  text: string;
  ttl_days?: number | null;
}

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string>; positional: string[] } {
  const cmd = argv[2] ?? '';
  const rest = argv.slice(3);
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        flags[a.slice(2)] = rest[++i] ?? 'true';
      }
    } else if (a.startsWith('-') && a.length === 2) {
      flags[a.slice(1)] = rest[++i] ?? 'true';
    } else {
      positional.push(a);
    }
  }
  return { cmd, flags, positional };
}

async function ensureStore(): Promise<void> {
  await mkdir(STORE_DIR, { recursive: true });
}

async function appendEvent(e: MemoryEvent): Promise<void> {
  await ensureStore();
  // POSIX O_APPEND is atomic for <=4KB writes on Linux. Cap text at 3.5KB.
  if (e.text.length > 3500) e.text = e.text.slice(0, 3500) + '...(truncated)';
  await appendFile(EVENTS_LOG, JSON.stringify(e) + '\n', { flag: 'a' });
}

async function cmdAppend(flags: Record<string, string>, text: string): Promise<void> {
  if (!text || text.trim().length === 0) {
    console.error('agent-mem append: <text> is required');
    process.exit(2);
  }
  const type = flags.type ?? 'manual';
  if (!VALID_TYPES.has(type)) {
    console.error(`agent-mem append: invalid --type '${type}'. Valid: ${[...VALID_TYPES].join(', ')}`);
    process.exit(2);
  }
  const event: MemoryEvent = {
    ts: new Date().toISOString(),
    machine: hostname().split('.')[0],
    agent: flags.agent ?? process.env.OPENCODE_AGENT ?? 'cli',
    session: flags.session ?? process.env.OPENCODE_SESSION_ID ?? 'manual',
    type,
    tags: flags.tags ? flags.tags.split(',').map((t) => t.trim()) : undefined,
    text: text.trim(),
    ttl_days: flags['ttl-days'] ? Number(flags['ttl-days']) : null,
  };
  await appendEvent(event);
  console.log(`appended: type=${event.type} (${event.text.length}B)`);
}

async function readAllEvents(): Promise<MemoryEvent[]> {
  try {
    const raw = await readFile(EVENTS_LOG, 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as MemoryEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is MemoryEvent => e !== null);
  } catch {
    return [];
  }
}

async function cmdSearch(query: string): Promise<void> {
  if (!query) {
    console.error('agent-mem search: <query> is required');
    process.exit(2);
  }
  const events = await readAllEvents();
  const re = new RegExp(query, 'i');
  const hits = events.filter((e) => re.test(e.text) || (e.tags && e.tags.some((t) => re.test(t))));
  if (hits.length === 0) {
    console.log('(no matches)');
    return;
  }
  for (const e of hits.slice(-50)) {
    console.log(`[${e.ts}] [${e.type}] ${e.text}`);
  }
  console.log(`\n(${hits.length} match${hits.length === 1 ? '' : 'es'})`);
}

async function cmdTail(flags: Record<string, string>): Promise<void> {
  const n = Number(flags.n ?? flags.lines ?? 20);
  const events = await readAllEvents();
  for (const e of events.slice(-n)) {
    console.log(`[${e.ts}] [${e.type}] ${e.text.slice(0, 200)}`);
  }
}

async function cmdStats(): Promise<void> {
  const events = await readAllEvents();
  const byType = new Map<string, number>();
  for (const e of events) {
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  }
  let size = 0;
  try {
    const st = await stat(EVENTS_LOG);
    size = st.size;
  } catch {}
  console.log(`store: ${STORE_DIR}`);
  console.log(`events.jsonl: ${events.length} events, ${(size / 1024).toFixed(1)} KB`);
  console.log(`by type:`);
  for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${n}`);
  }
  if (events.length > 0) {
    console.log(`oldest: ${events[0].ts}`);
    console.log(`newest: ${events[events.length - 1].ts}`);
  }
}

async function cmdSync(): Promise<void> {
  await ensureStore();
  // git add + commit + push (best-effort; fail loud but don't block)
  try {
    await execAsync('git add -A', { cwd: STORE_DIR });
    const { stdout: statusOut } = await execAsync('git status --porcelain', {
      cwd: STORE_DIR,
    });
    if (statusOut.trim().length === 0) {
      console.log('sync: clean, nothing to commit');
      return;
    }
    const msg = `sync: ${new Date().toISOString()} from ${hostname().split('.')[0]}`;
    await execAsync(`git -c commit.gpgsign=false commit -m "${msg}"`, {
      cwd: STORE_DIR,
    });
    await execAsync('git push 2>&1', { cwd: STORE_DIR });
    console.log(`sync: pushed (${msg})`);
  } catch (err) {
    console.error(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function usage(): void {
  console.log(`agent-mem — cross-machine memory store CLI

Usage:
  agent-mem append [--type=<t>] [--tags=t1,t2] [--ttl-days=N] "<text>"
  agent-mem search "<regex>"
  agent-mem tail [-n 20]
  agent-mem stats
  agent-mem sync

Types: ${[...VALID_TYPES].join(', ')}

Store: ${STORE_DIR}`);
}

async function main(): Promise<void> {
  const { cmd, flags, positional } = parseArgs(process.argv);
  switch (cmd) {
    case 'append':
      await cmdAppend(flags, positional.join(' '));
      break;
    case 'search':
      await cmdSearch(positional.join(' '));
      break;
    case 'tail':
      await cmdTail(flags);
      break;
    case 'stats':
      await cmdStats();
      break;
    case 'sync':
      await cmdSync();
      break;
    case '':
    case '--help':
    case '-h':
    case 'help':
      usage();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      usage();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`agent-mem: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
