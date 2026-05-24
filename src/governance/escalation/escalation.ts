/**
 * escalation.ts — write a structured escalation record.
 *
 * Ported from ~/pms/.opencode/plugins/escalation.ts (Tier 1).
 *
 * Two paths:
 *   - per-run: runs/<run-id>/escalations/<slice>-<topic>.json
 *   - global:  runs/escalations/<run-id>--<topic>.json (cross-run rollup)
 *
 * Status starts "open"; gate CLI flips to "resolved" with action+note.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  EscalationSchema,
  type Escalation,
  type GateAction,
  GATE_ACTIONS,
} from '../workflow/types.js';

export interface EscalateInput {
  runId: string;
  sliceId?: string;
  source: string;
  topic: string;
  severity: Escalation['severity'];
  reason: string;
  detail?: Record<string, unknown>;
  /** Per-run paths.escalations dir (preferred) OR fallback to repoRoot/runs/escalations. */
  perRunDir?: string;
  globalDir?: string;
}

function newEscalationId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `esc-${ts}-${rand}`;
}

export async function escalate(input: EscalateInput): Promise<Escalation> {
  const record: Escalation = EscalationSchema.parse({
    escalation_id: newEscalationId(),
    run_id: input.runId,
    slice_id: input.sliceId,
    ts: new Date().toISOString(),
    source: input.source,
    topic: input.topic,
    severity: input.severity,
    reason: input.reason,
    detail: input.detail,
    status: 'open',
  });

  const filename =
    input.sliceId !== undefined
      ? `${input.sliceId}-${input.topic}.json`
      : `${input.topic}.json`;
  const globalName = `${input.runId}--${input.topic}.json`;

  if (input.perRunDir !== undefined) {
    await fs.mkdir(input.perRunDir, { recursive: true });
    await fs.writeFile(
      path.join(input.perRunDir, filename),
      JSON.stringify(record, null, 2) + '\n',
      'utf-8',
    );
  }
  if (input.globalDir !== undefined) {
    await fs.mkdir(input.globalDir, { recursive: true });
    await fs.writeFile(
      path.join(input.globalDir, globalName),
      JSON.stringify(record, null, 2) + '\n',
      'utf-8',
    );
  }
  return record;
}

/** Resolve an open escalation with a gate action + note. */
export async function resolveEscalation(
  escalationFilePath: string,
  action: GateAction,
  note: string,
  resolvedBy: string,
): Promise<Escalation> {
  if (!GATE_ACTIONS.includes(action)) {
    throw new Error(`unknown gate action: ${action}; allowed: ${GATE_ACTIONS.join(', ')}`);
  }
  const raw = await fs.readFile(escalationFilePath, 'utf-8');
  const existing = JSON.parse(raw) as Escalation;
  const updated: Escalation = {
    ...existing,
    status: 'resolved',
    resolution: {
      action,
      note,
      resolved_at: new Date().toISOString(),
      resolved_by: resolvedBy,
    },
  };
  EscalationSchema.parse(updated);
  await fs.writeFile(escalationFilePath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  return updated;
}

/** List all escalations under a directory, optionally filtering to open. */
export async function listEscalations(
  dir: string,
  filterOpenOnly = false,
): Promise<Array<{ path: string; record: Escalation }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: Array<{ path: string; record: Escalation }> = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const filepath = path.join(dir, name);
    try {
      const raw = await fs.readFile(filepath, 'utf-8');
      const record = EscalationSchema.parse(JSON.parse(raw));
      if (filterOpenOnly && record.status !== 'open') continue;
      out.push({ path: filepath, record });
    } catch {
      // skip malformed files
    }
  }
  return out;
}
