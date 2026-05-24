/**
 * run-phase.ts — the orchestrator. Drives architect → builder → judge per
 * slice with 3-strike cap, smoke gate, audit chain, budget enforcement.
 *
 * Ported from ~/pms/scripts/run-phase-opencode.py (Tier 1).
 *
 * This is the deterministic glue. Subagent prompts can no longer cause the
 * orchestrator to skip steps, miscount iterations, or forget smoke — all
 * enforced in code.
 *
 * Returns a structured result the caller (CLI or plugin tool) can summarize.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  type Plan,
  type Features,
  type Verdict,
  VerdictSchema,
  type Slice,
} from './types.js';
import { validatePlan, validateFeatures } from './plan-validator.js';
import { LoopTracker, MAX_ITERATIONS_PER_SLICE } from './three-strike.js';
import {
  runSmoke,
  smokeAllPassed,
  smokeFailures,
  updateFeaturesAfterSmoke,
} from './smoke-gate.js';
import {
  newRunId,
  runDirPaths,
  ensureRunDir,
  seedBudgetFile,
  appendProgress,
  DEFAULT_PHASE_BUDGET,
  type BudgetSeed,
  type RunDirPaths,
} from '../run-dir/run-dir.js';
import { appendAuditRow } from '../audit/audit-chain.js';
import { checkBudget, BudgetDenialError } from '../budget/budget-gate.js';
import { escalate } from '../escalation/escalation.js';
import type { DispatchFn, DispatchResult } from './dispatch.js';

export interface RunPhaseOptions {
  repoRoot: string;
  /** Pre-validated plan (loaded from plans/<phase>-<ts>.json). */
  plan: Plan;
  /** Pre-validated features file (sibling of the plan). */
  features: Features;
  /** Path to the features file on disk — needed for smoke updates. */
  featuresPath: string;
  /** Dispatch implementation: subprocess or plugin-client. */
  dispatch: DispatchFn;
  /** Optional: start from a specific slice (skip earlier ones). */
  startSliceId?: string;
  /** Optional: override the phase budget. */
  budgetSeed?: BudgetSeed;
  /** Optional: caller-supplied run ID (default = `<ts>-<phase_id>`). */
  runId?: string;
  /** Optional: caller-supplied global escalations dir (default = <repo>/runs/escalations). */
  globalEscalationsDir?: string;
}

export interface SliceOutcome {
  sliceId: string;
  status: 'passed' | 'escalated' | 'skipped';
  iterations: number;
  verdicts: Verdict[];
  smokeFailures?: string[]; // feature IDs that flipped after slice passed
  builderLogs: string[]; // paths to builder dispatch log files
  judgeLogs: string[]; // paths to judge dispatch log files
}

export interface RunPhaseResult {
  runId: string;
  runDir: string;
  phaseId: string;
  outcome: 'completed' | 'halted_on_escalation';
  outcomes: SliceOutcome[];
  totalIterations: number;
  escalationsCreated: number;
}

/** Standard slice context payload passed to every subagent dispatch. */
function sliceContext(slice: Slice, iteration: number, runId: string) {
  return {
    runId,
    sliceId: slice.id,
    iteration,
    title: slice.title,
    file_changes: slice.file_changes,
    acceptance_criteria: slice.acceptance_criteria,
    complexity_estimate: slice.complexity_estimate,
  };
}

/** Filter slices to start from --start-slice if provided. */
function filterStartSlice(slices: readonly Slice[], startId?: string): Slice[] {
  if (!startId) return [...slices];
  const idx = slices.findIndex((s) => s.id === startId);
  if (idx < 0) {
    throw new Error(`--start-slice id not found in plan: ${startId}`);
  }
  return slices.slice(idx);
}

/** Parse a judge dispatch's output as strict JSON Verdict. */
function parseVerdictOutput(text: string, sliceId: string, iteration: number): Verdict | string {
  // Extract a JSON code block or the first balanced { ... } region.
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const candidate = fenced ? fenced[1]! : extractFirstObject(text);
  if (!candidate) return 'judge output did not contain a JSON object';
  try {
    const parsed = JSON.parse(candidate);
    return VerdictSchema.parse({
      ...parsed,
      slice_id: parsed.slice_id ?? sliceId,
      iteration: parsed.iteration ?? iteration,
    });
  } catch (e) {
    return `judge output JSON parse/validate failed: ${(e as Error).message}`;
  }
}

function extractFirstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export async function runPhase(opts: RunPhaseOptions): Promise<RunPhaseResult> {
  // Pre-flight validation
  const planErrs = validatePlan(opts.plan);
  if (planErrs.length > 0) {
    throw new Error(`invalid plan: ${planErrs.join('; ')}`);
  }
  const featErrs = validateFeatures(opts.features);
  if (featErrs.length > 0) {
    throw new Error(`invalid features: ${featErrs.join('; ')}`);
  }

  const runId = opts.runId ?? newRunId(opts.plan.phase_id);
  const paths = runDirPaths(opts.repoRoot, runId);
  await ensureRunDir(paths);
  await seedBudgetFile(paths, opts.budgetSeed ?? DEFAULT_PHASE_BUDGET);

  await appendProgress(paths, `phase ${opts.plan.phase_id} started — run ${runId}`);
  await appendAuditRow(paths.root, {
    subagent: 'orchestrator',
    tool: 'run-phase',
    input_summary: `phase=${opts.plan.phase_id} slices=${opts.plan.slices.length}`,
    session_id: runId,
    decision: 'allow',
  });

  const slicesToRun = filterStartSlice(opts.plan.slices, opts.startSliceId);
  const tracker = new LoopTracker(MAX_ITERATIONS_PER_SLICE);
  const outcomes: SliceOutcome[] = [];
  const globalEsc =
    opts.globalEscalationsDir ?? path.join(opts.repoRoot, 'runs', 'escalations');
  let escalationsCreated = 0;
  let totalIterations = 0;
  let halted = false;

  for (const slice of slicesToRun) {
    if (halted) {
      outcomes.push({
        sliceId: slice.id,
        status: 'skipped',
        iterations: 0,
        verdicts: [],
        builderLogs: [],
        judgeLogs: [],
      });
      continue;
    }

    const builderLogs: string[] = [];
    const judgeLogs: string[] = [];
    const verdicts: Verdict[] = [];
    let sliceStatus: SliceOutcome['status'] = 'escalated'; // pessimistic default
    let smokeFails: string[] = [];

    // Per-slice builder/judge loop
    while (true) {
      // Budget gate before each iteration
      try {
        await checkBudget(paths.root);
      } catch (e) {
        if (e instanceof BudgetDenialError) {
          await escalate({
            runId,
            sliceId: slice.id,
            source: 'orchestrator',
            topic: 'budget-exhausted',
            severity: 'high',
            reason: e.message,
            perRunDir: paths.escalations,
            globalDir: globalEsc,
          });
          escalationsCreated++;
          halted = true;
          break;
        }
        throw e;
      }

      const iteration = tracker.nextIteration(slice.id);
      totalIterations++;

      // BUILDER dispatch
      await appendProgress(paths, `slice ${slice.id} iter ${iteration}: dispatch @builder`);
      const builderLog = paths.builderReport(slice.id).replace(/\.md$/, `.iter${iteration}.log`);
      const builderResult = await opts.dispatch({
        agent: 'builder',
        prompt:
          `Implement slice ${slice.id} (iteration ${iteration}/${MAX_ITERATIONS_PER_SLICE}). ` +
          `Read every approved file before editing. Run self-checks. Emit <work-report> per builder.md spec.`,
        context: sliceContext(slice, iteration, runId),
        logFile: builderLog,
      });
      builderLogs.push(builderLog);
      await appendAuditRow(paths.root, {
        subagent: 'builder',
        tool: 'dispatch',
        input_summary: `slice=${slice.id} iter=${iteration} exit=${builderResult.exitCode}`,
        session_id: runId,
        decision: builderResult.exitCode === 0 ? 'allow' : 'error',
      });
      // Persist builder report
      await fs.writeFile(paths.builderReport(slice.id), builderResult.output, 'utf-8');

      // JUDGE dispatch
      await appendProgress(paths, `slice ${slice.id} iter ${iteration}: dispatch @judge`);
      const judgeLog = paths.judgeVerdict(slice.id, iteration).replace(/\.json$/, '.log');
      const judgeResult = await opts.dispatch({
        agent: 'judge',
        prompt:
          `Review builder's work for slice ${slice.id}, iteration ${iteration}. ` +
          `Re-run each acceptance criterion's verification command yourself. ` +
          `Emit strict JSON Verdict per judge.md spec.`,
        context: { ...sliceContext(slice, iteration, runId), builderReport: builderResult.output },
        logFile: judgeLog,
      });
      judgeLogs.push(judgeLog);
      const verdictOrErr = parseVerdictOutput(judgeResult.output, slice.id, iteration);
      if (typeof verdictOrErr === 'string') {
        await escalate({
          runId,
          sliceId: slice.id,
          source: 'orchestrator',
          topic: 'judge-output-malformed',
          severity: 'high',
          reason: verdictOrErr,
          detail: { raw_judge_output: judgeResult.output.slice(0, 4000) },
          perRunDir: paths.escalations,
          globalDir: globalEsc,
        });
        escalationsCreated++;
        sliceStatus = 'escalated';
        halted = true;
        break;
      }
      const verdict = verdictOrErr;
      verdicts.push(verdict);
      await fs.writeFile(
        paths.judgeVerdict(slice.id, iteration),
        JSON.stringify(verdict, null, 2) + '\n',
        'utf-8',
      );
      await appendAuditRow(paths.root, {
        subagent: 'judge',
        tool: 'verdict',
        input_summary: `slice=${slice.id} iter=${iteration} verdict=${verdict.verdict}`,
        session_id: runId,
        decision: 'allow',
      });

      const action = tracker.recordVerdict(slice.id, verdict);
      if (action === 'next-slice') {
        // Smoke gate: re-run every feature verification.
        await appendProgress(paths, `slice ${slice.id}: judge passed — running smoke gate`);
        const smokeResults = await runSmoke(opts.features, { cwd: opts.repoRoot });
        await updateFeaturesAfterSmoke(opts.featuresPath, smokeResults, 'orchestrator');
        await appendAuditRow(paths.root, {
          subagent: 'orchestrator',
          tool: 'smoke-gate',
          input_summary: `slice=${slice.id} smoke_features=${smokeResults.length} failed=${smokeFailures(smokeResults).length}`,
          session_id: runId,
          decision: smokeAllPassed(smokeResults) ? 'allow' : 'deny',
        });
        if (smokeAllPassed(smokeResults)) {
          sliceStatus = 'passed';
          await appendProgress(paths, `slice ${slice.id}: PASS (smoke clean) → next slice`);
          break;
        }
        smokeFails = smokeFailures(smokeResults).map((r) => r.featureId);
        await escalate({
          runId,
          sliceId: slice.id,
          source: 'orchestrator',
          topic: 'smoke-regression',
          severity: 'high',
          reason: `slice ${slice.id} passed judge but smoke regressed: ${smokeFails.join(', ')}`,
          detail: {
            failed_features: smokeFails,
            failures: smokeFailures(smokeResults).map((r) => ({
              id: r.featureId,
              command: r.command,
              exit_code: r.exitCode,
              stderr_tail: r.stderr.slice(-500),
            })),
          },
          perRunDir: paths.escalations,
          globalDir: globalEsc,
        });
        escalationsCreated++;
        sliceStatus = 'escalated';
        halted = true;
        break;
      }
      if (action === 'escalate-now') {
        await tracker.escalateSlice(slice.id, runId, paths.escalations, globalEsc);
        escalationsCreated++;
        sliceStatus = 'escalated';
        halted = true;
        break;
      }
      // action === 'continue' → loop back to next iteration
      await appendProgress(paths, `slice ${slice.id}: revise (iter ${iteration} → ${iteration + 1})`);
    }

    outcomes.push({
      sliceId: slice.id,
      status: sliceStatus,
      iterations: tracker.get(slice.id).iteration,
      verdicts,
      ...(smokeFails.length > 0 ? { smokeFailures: smokeFails } : {}),
      builderLogs,
      judgeLogs,
    });
  }

  const result: RunPhaseResult = {
    runId,
    runDir: paths.root,
    phaseId: opts.plan.phase_id,
    outcome: halted ? 'halted_on_escalation' : 'completed',
    outcomes,
    totalIterations,
    escalationsCreated,
  };
  await appendProgress(
    paths,
    `phase ${opts.plan.phase_id} ${result.outcome} — ${outcomes.filter((o) => o.status === 'passed').length}/${opts.plan.slices.length} slices passed`,
  );
  await appendAuditRow(paths.root, {
    subagent: 'orchestrator',
    tool: 'run-phase-complete',
    input_summary: `outcome=${result.outcome} iterations=${totalIterations} escalations=${escalationsCreated}`,
    session_id: runId,
    decision: 'allow',
  });
  return result;
}
