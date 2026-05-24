#!/usr/bin/env node
/**
 * gate.ts — human gate CLI for resolving escalations.
 *
 * Ported from ~/pms/scripts/gate.py (Tier 1).
 *
 * Usage:
 *   pms-gate list [--all]                              List escalations (default: open only)
 *   pms-gate show <escalation-id>                      Print one escalation's full record
 *   pms-gate resolve <escalation-id> --action <a> --note "<rationale>" [--by <name>]
 *                                                      Resolve an escalation
 *
 * Actions: approve | revise-spec | revise-adr | new-research | abandon-phase
 *
 * Resolutions are append-only — the original escalation file's "status" flips
 * from "open" to "resolved" and a "resolution" block gets added.
 *
 * This CLI does NOT call back into run-phase automatically. It records the
 * human decision; the operator decides what to do next.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  listEscalations,
  resolveEscalation,
} from '../escalation/escalation.js';
import { GATE_ACTIONS, type GateAction } from '../workflow/types.js';

const REPO_ROOT = process.cwd();
const DEFAULT_ESC_DIR = path.join(REPO_ROOT, 'runs', 'escalations');

interface Args {
  cmd: 'list' | 'show' | 'resolve' | 'help';
  escalationId?: string;
  action?: string;
  note?: string;
  by?: string;
  all?: boolean;
  dir?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { cmd: 'help' };
  if (argv.length === 0) return out;
  const cmd = argv[0];
  if (cmd === 'list' || cmd === 'show' || cmd === 'resolve') {
    out.cmd = cmd;
  } else {
    return out;
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--action') out.action = argv[++i];
    else if (a === '--note') out.note = argv[++i];
    else if (a === '--by') out.by = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (!a?.startsWith('--')) out.escalationId = a;
  }
  return out;
}

function printHelp(): void {
  console.log(`pms-gate — human gate CLI for resolving escalations

Usage:
  pms-gate list [--all] [--dir <path>]
  pms-gate show <escalation-id> [--dir <path>]
  pms-gate resolve <escalation-id> --action <a> --note "<rationale>" [--by <name>] [--dir <path>]

Actions: ${GATE_ACTIONS.join(' | ')}

Default escalations dir: <cwd>/runs/escalations
`);
}

async function cmdList(args: Args): Promise<number> {
  const dir = args.dir ?? DEFAULT_ESC_DIR;
  const items = await listEscalations(dir, !args.all);
  if (items.length === 0) {
    console.log(`(no ${args.all ? '' : 'open '}escalations in ${dir})`);
    return 0;
  }
  for (const { record } of items) {
    console.log(
      `[${record.status.padEnd(8)}] ${record.severity.padEnd(8)} ${record.ts}  ${record.escalation_id}`,
    );
    console.log(`    source=${record.source} topic=${record.topic}`);
    if (record.slice_id) console.log(`    slice=${record.slice_id}`);
    console.log(`    reason: ${record.reason}`);
  }
  return 0;
}

async function cmdShow(args: Args): Promise<number> {
  if (!args.escalationId) {
    console.error('escalation-id required');
    return 2;
  }
  const dir = args.dir ?? DEFAULT_ESC_DIR;
  const items = await listEscalations(dir, false);
  const match = items.find(
    (i) =>
      i.record.escalation_id === args.escalationId ||
      path.basename(i.path, '.json') === args.escalationId,
  );
  if (!match) {
    console.error(`escalation not found: ${args.escalationId}`);
    return 1;
  }
  console.log(JSON.stringify(match.record, null, 2));
  return 0;
}

async function cmdResolve(args: Args): Promise<number> {
  if (!args.escalationId) {
    console.error('escalation-id required');
    return 2;
  }
  if (!args.action) {
    console.error(`--action required (one of: ${GATE_ACTIONS.join(', ')})`);
    return 2;
  }
  if (!GATE_ACTIONS.includes(args.action as GateAction)) {
    console.error(`unknown --action ${args.action}; valid: ${GATE_ACTIONS.join(', ')}`);
    return 2;
  }
  if (!args.note) {
    console.error('--note "rationale" required');
    return 2;
  }
  const dir = args.dir ?? DEFAULT_ESC_DIR;
  const items = await listEscalations(dir, false);
  const match = items.find(
    (i) =>
      i.record.escalation_id === args.escalationId ||
      path.basename(i.path, '.json') === args.escalationId,
  );
  if (!match) {
    console.error(`escalation not found: ${args.escalationId}`);
    return 1;
  }
  const resolvedBy = args.by ?? (process.env.USER ?? 'human');
  const updated = await resolveEscalation(
    match.path,
    args.action as GateAction,
    args.note,
    resolvedBy,
  );
  console.log(
    `resolved ${updated.escalation_id} → action=${args.action} by=${resolvedBy}`,
  );
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let exit = 0;
  if (args.cmd === 'list') exit = await cmdList(args);
  else if (args.cmd === 'show') exit = await cmdShow(args);
  else if (args.cmd === 'resolve') exit = await cmdResolve(args);
  else printHelp();
  process.exit(exit);
}

// Run iff invoked as a script (Bun and Node both set this on direct exec).
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/gate.ts') ||
  process.argv[1]?.endsWith('/gate.js');
if (isMain) {
  void main();
}
