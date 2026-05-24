/**
 * smoke-gate.ts — deterministic shell-based feature verification.
 *
 * Ported from ~/pms/scripts/run-phase-opencode.py::_run_smoke (Tier 1).
 *
 * After a slice's judge issues `pass`, the orchestrator re-runs every
 * feature.verification command from the features file. If any flips from
 * `passes:true` to `passes:false`, the smoke gate FAILS and the
 * orchestrator escalates instead of moving to the next slice.
 *
 * This is "smoke before new work" — features that previously passed must
 * still pass after every slice. Catches regressions immediately.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

import type { Features } from './types.js';
import { FeaturesSchema } from './types.js';

export interface SmokeResult {
  featureId: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface RunSmokeOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Pass to test only a specific subset; default = all features. */
  onlyFeatureIds?: readonly string[];
}

/** Run all feature verifications and return one result per feature. */
export async function runSmoke(
  features: Features,
  opts: RunSmokeOptions = {},
): Promise<SmokeResult[]> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const out: SmokeResult[] = [];
  const ids = opts.onlyFeatureIds ?? Object.keys(features);

  for (const id of ids) {
    const entry = features[id];
    if (!entry) continue;
    const startedAt = Date.now();
    const result = await runOne(entry.verification, opts.cwd, timeoutMs);
    out.push({
      featureId: id,
      command: entry.verification,
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return out;
}

interface OneResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runOne(command: string, cwd?: string, timeoutMs = 300_000): Promise<OneResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/** Update features file with the latest run results (mutates entry.passes/verified_at/verified_by). */
export async function updateFeaturesAfterSmoke(
  featuresPath: string,
  results: SmokeResult[],
  verifiedBy: string,
): Promise<Features> {
  const raw = await fs.readFile(featuresPath, 'utf-8');
  const features = FeaturesSchema.parse(JSON.parse(raw));
  const ts = new Date().toISOString();
  for (const r of results) {
    const entry = features[r.featureId];
    if (!entry) continue;
    entry.passes = r.passed;
    entry.verified_at = ts;
    entry.verified_by = verifiedBy;
  }
  await fs.writeFile(featuresPath, JSON.stringify(features, null, 2) + '\n', 'utf-8');
  return features;
}

/** True iff every feature passed in the smoke run. */
export function smokeAllPassed(results: readonly SmokeResult[]): boolean {
  return results.every((r) => r.passed);
}

/** Subset of results that failed. */
export function smokeFailures(results: readonly SmokeResult[]): SmokeResult[] {
  return results.filter((r) => !r.passed);
}
