/**
 * run-dir.ts — per-run directory discipline.
 *
 * Ported from ~/pms convention (Tier 3):
 *   runs/<UTC-timestamp>-<phase-id>/
 *     audit.jsonl                  hash-chained audit log
 *     budget.json                  per-run token/wall-clock budget
 *     PROGRESS.md                  human-readable status
 *     builder-<slice>.md           builder work-reports per slice
 *     judge-<slice>-iter<N>.json   judge verdicts per iteration
 *     escalations/<slice>-<topic>.json
 *     prior-attempts/<ts>/...      archived earlier work on --start-slice
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const TS_PATTERN = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}Z`;
};

/** Canonical run-directory name. */
export function newRunId(phaseId: string): string {
  return `${TS_PATTERN()}-${phaseId}`;
}

/** Per-run directory paths. */
export interface RunDirPaths {
  root: string;
  audit: string;
  budget: string;
  progress: string;
  escalations: string;
  builderReport: (sliceId: string) => string;
  judgeVerdict: (sliceId: string, iteration: number) => string;
  escalation: (sliceId: string, topic: string) => string;
}

/** Compute per-run paths under repoRoot/runs/<runId>/. */
export function runDirPaths(repoRoot: string, runId: string): RunDirPaths {
  const root = path.join(repoRoot, 'runs', runId);
  return {
    root,
    audit: path.join(root, 'audit.jsonl'),
    budget: path.join(root, 'budget.json'),
    progress: path.join(root, 'PROGRESS.md'),
    escalations: path.join(root, 'escalations'),
    builderReport: (sliceId) => path.join(root, `builder-${sliceId}.md`),
    judgeVerdict: (sliceId, iteration) =>
      path.join(root, `judge-${sliceId}-iter${iteration}.json`),
    escalation: (sliceId, topic) =>
      path.join(root, 'escalations', `${sliceId}-${topic}.json`),
  };
}

/** Create all directories the run will write into. Idempotent. */
export async function ensureRunDir(paths: RunDirPaths): Promise<void> {
  await fs.mkdir(paths.root, { recursive: true });
  await fs.mkdir(paths.escalations, { recursive: true });
}

/** Seed budget.json at run start. Caller can override defaults. */
export interface BudgetSeed {
  input_token_limit: number;
  output_token_limit: number;
  wall_clock_limit_s: number;
}

export const DEFAULT_PHASE_BUDGET: BudgetSeed = {
  input_token_limit: 2_000_000,
  output_token_limit: 500_000,
  wall_clock_limit_s: 4 * 60 * 60, // 4 hours
};

export const DEFAULT_SLICE_BUDGET: BudgetSeed = {
  input_token_limit: 200_000,
  output_token_limit: 50_000,
  wall_clock_limit_s: 30 * 60, // 30 minutes
};

export async function seedBudgetFile(
  paths: RunDirPaths,
  seed: BudgetSeed = DEFAULT_PHASE_BUDGET,
): Promise<void> {
  const body = {
    input_token_limit: seed.input_token_limit,
    output_token_limit: seed.output_token_limit,
    wall_clock_limit_s: seed.wall_clock_limit_s,
    input_tokens_used: 0,
    output_tokens_used: 0,
    started_at: new Date().toISOString(),
  };
  await fs.writeFile(paths.budget, JSON.stringify(body, null, 2) + '\n', 'utf-8');
}

/** Atomically update budget.json with new usage counts. */
export async function bumpBudget(
  paths: RunDirPaths,
  inputDelta: number,
  outputDelta: number,
): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(paths.budget, 'utf-8');
    current = JSON.parse(raw);
  } catch {
    // missing/malformed: start fresh
  }
  current['input_tokens_used'] =
    Number(current['input_tokens_used'] ?? 0) + inputDelta;
  current['output_tokens_used'] =
    Number(current['output_tokens_used'] ?? 0) + outputDelta;
  current['updated_at'] = new Date().toISOString();

  const tmp = `${paths.budget}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(current, null, 2) + '\n', 'utf-8');
  await fs.rename(tmp, paths.budget);
}

/** Append a line to PROGRESS.md with a UTC timestamp prefix. */
export async function appendProgress(
  paths: RunDirPaths,
  line: string,
): Promise<void> {
  await fs.mkdir(paths.root, { recursive: true });
  const stamp = new Date().toISOString();
  await fs.appendFile(paths.progress, `- ${stamp} — ${line}\n`, 'utf-8');
}

/** Archive prior-attempts/<ts>/<old artifacts> when --start-slice rewinds. */
export async function archivePriorAttempt(
  paths: RunDirPaths,
  sliceId: string,
): Promise<string> {
  const ts = TS_PATTERN();
  const dest = path.join(paths.root, 'prior-attempts', `${ts}-${sliceId}`);
  await fs.mkdir(dest, { recursive: true });
  // Move builder + judge artifacts for the slice into the archive.
  const entries = await fs.readdir(paths.root);
  for (const name of entries) {
    if (
      name.startsWith(`builder-${sliceId}`) ||
      (name.startsWith(`judge-${sliceId}`) && name.endsWith('.json'))
    ) {
      await fs.rename(
        path.join(paths.root, name),
        path.join(dest, name),
      );
    }
  }
  return dest;
}
