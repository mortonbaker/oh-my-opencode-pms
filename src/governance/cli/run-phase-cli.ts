#!/usr/bin/env node
/**
 * run-phase-cli.ts — CLI runner for the workflow orchestrator.
 *
 * Loads a plan + features from disk, runs pre-run gate, dispatches the
 * builder/judge loop via subprocess opencode calls, writes per-run
 * artifacts, prints a summary.
 *
 * Usage:
 *   pms-run-phase --plan plans/phase-X-<ts>.json [--features plans/phase-X-<ts>-features.json]
 *                 [--start-slice <slice-id>] [--repo-root <path>]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { runPhase } from '../workflow/run-phase.js';
import { PlanSchema, FeaturesSchema } from '../workflow/types.js';
import { subprocessDispatch } from '../workflow/dispatch.js';
import { preRun, formatPreRunReport } from '../workflow/pre-run.js';

interface CliArgs {
  planPath?: string;
  featuresPath?: string;
  startSlice?: string;
  repoRoot?: string;
  skipPreRun?: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') out.planPath = argv[++i];
    else if (a === '--features') out.featuresPath = argv[++i];
    else if (a === '--start-slice') out.startSlice = argv[++i];
    else if (a === '--repo-root') out.repoRoot = argv[++i];
    else if (a === '--skip-pre-run') out.skipPreRun = true;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.planPath) {
    console.error('--plan <path> required');
    process.exit(2);
  }
  const repoRoot = args.repoRoot ?? process.cwd();
  const planPath = path.resolve(args.planPath);
  const featuresPath =
    args.featuresPath !== undefined
      ? path.resolve(args.featuresPath)
      : planPath.replace(/\.json$/, '-features.json');

  // Load + parse plan + features
  const planRaw = JSON.parse(await fs.readFile(planPath, 'utf-8'));
  const featuresRaw = JSON.parse(await fs.readFile(featuresPath, 'utf-8'));
  const plan = PlanSchema.parse(planRaw);
  const features = FeaturesSchema.parse(featuresRaw);

  // Pre-run gate
  if (!args.skipPreRun) {
    const preRunResult = await preRun({
      repoRoot,
      pluginNames: ['oh-my-opencode-pms'],
      expectedAgents: ['architect', 'builder', 'judge', 'qa-reviewer', 'researcher'],
      samplePlanPath: planPath,
      sampleFeaturesPath: featuresPath,
    });
    console.log(formatPreRunReport(preRunResult));
    if (!preRunResult.passed) {
      console.error('\npre-run gate FAILED — phase not started');
      process.exit(1);
    }
    console.log('');
  }

  // Run the phase
  console.log(`>> Running phase ${plan.phase_id} (${plan.slices.length} slice(s))`);
  const result = await runPhase({
    repoRoot,
    plan,
    features,
    featuresPath,
    dispatch: subprocessDispatch,
    ...(args.startSlice ? { startSliceId: args.startSlice } : {}),
  });

  // Summary
  console.log('');
  console.log('== Phase Result ==');
  console.log(`run_id:          ${result.runId}`);
  console.log(`run_dir:         ${result.runDir}`);
  console.log(`outcome:         ${result.outcome}`);
  console.log(`total iter:      ${result.totalIterations}`);
  console.log(`escalations:     ${result.escalationsCreated}`);
  console.log('');
  console.log('Per-slice:');
  for (const o of result.outcomes) {
    const status = o.status.padEnd(10);
    const extra = o.smokeFailures ? ` (smoke regression: ${o.smokeFailures.join(', ')})` : '';
    console.log(`  ${status}  ${o.sliceId.padEnd(40)}  iter=${o.iterations}${extra}`);
  }

  process.exit(result.outcome === 'completed' ? 0 : 1);
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/run-phase-cli.ts') ||
  process.argv[1]?.endsWith('/run-phase-cli.js');
if (isMain) {
  void main().catch((e) => {
    console.error(`run-phase failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
