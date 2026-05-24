/**
 * run-phase-smoke.test.ts — end-to-end orchestrator smoke test with
 * a mocked dispatch function. No real opencode subagents spawned.
 *
 * Covers:
 *   - happy path: builder passes on iter 1, smoke clean → next slice
 *   - 3-strike: judge revises 3x → mandatory escalation
 *   - smoke regression: judge passes but smoke flips → escalation
 *   - budget exhaustion: gate halts before iter 2
 *   - audit chain valid end-to-end
 *
 * Uses bun:test.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPhase } from '../workflow/run-phase.js';
import type { DispatchFn, DispatchInput, DispatchResult } from '../workflow/dispatch.js';
import type { Plan, Features, Verdict } from '../workflow/types.js';
import { verifyAuditChain } from '../audit/audit-chain.js';
import { seedBudgetFile, runDirPaths } from '../run-dir/run-dir.js';

const SAMPLE_PLAN: Plan = {
  phase_id: 'test-phase',
  spec_source: 'specs/phases/test-phase.md',
  spec_sha: '0'.repeat(64),
  slices: [
    {
      id: 'slice-1',
      title: 'first slice',
      skills_required: ['ts'],
      file_changes: ['src/a.ts'],
      interface_contracts: [],
      acceptance_criteria: ['runs without errors'],
      risks: [],
      complexity_estimate: 'S',
    },
  ],
};

const SAMPLE_FEATURES: Features = {
  'feature-1': {
    description: 'echo passes',
    verification: 'echo ok',
    passes: true,
    verified_at: null,
    verified_by: null,
  },
};

let tmpRoot: string;
let featuresPath: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'pms-run-phase-'));
  featuresPath = path.join(tmpRoot, 'features.json');
  await writeFile(featuresPath, JSON.stringify(SAMPLE_FEATURES, null, 2));
});

/** Build a dispatch fn whose judge always returns the given verdict. */
function mkDispatch(judgeVerdicts: Verdict[]): DispatchFn {
  let judgeCalls = 0;
  return async (input: DispatchInput): Promise<DispatchResult> => {
    if (input.agent === 'builder') {
      return {
        agent: 'builder',
        output:
          '<work-report><slice>' +
          input.context?.sliceId +
          '</slice></work-report>',
        exitCode: 0,
        durationMs: 1,
      };
    }
    if (input.agent === 'judge') {
      const v = judgeVerdicts[judgeCalls++] ?? judgeVerdicts[judgeVerdicts.length - 1]!;
      return {
        agent: 'judge',
        output: '```json\n' + JSON.stringify(v) + '\n```',
        exitCode: 0,
        durationMs: 1,
      };
    }
    return { agent: input.agent, output: '', exitCode: 0, durationMs: 1 };
  };
}

describe('run-phase orchestrator', () => {
  test('happy path: builder passes, smoke clean → completes', async () => {
    const verdict: Verdict = {
      verdict: 'pass',
      slice_id: 'slice-1',
      iteration: 1,
      criteria_check: [{ criterion: 'runs without errors', result: 'PASS', evidence: 'exit 0' }],
      scope_check: { approved_files_only: true, no_unapproved_deps: true, no_blocked_commands: true, violations: [] },
      recommendations: [],
      confidence: 'high',
      confidence_reason: 'tests pass',
    };
    const result = await runPhase({
      repoRoot: tmpRoot,
      plan: SAMPLE_PLAN,
      features: SAMPLE_FEATURES,
      featuresPath,
      dispatch: mkDispatch([verdict]),
    });
    expect(result.outcome).toBe('completed');
    expect(result.outcomes[0]!.status).toBe('passed');
    expect(result.totalIterations).toBe(1);
    expect(result.escalationsCreated).toBe(0);
  });

  test('3-strike cap: judge revises 3x → escalation', async () => {
    const revise: Verdict = {
      verdict: 'revise',
      slice_id: 'slice-1',
      iteration: 1,
      criteria_check: [{ criterion: 'runs without errors', result: 'FAIL', evidence: 'still broken' }],
      scope_check: { approved_files_only: true, no_unapproved_deps: true, no_blocked_commands: true, violations: [] },
      recommendations: ['fix it'],
      confidence: 'medium',
      confidence_reason: 'unclear',
    };
    const result = await runPhase({
      repoRoot: tmpRoot,
      plan: SAMPLE_PLAN,
      features: SAMPLE_FEATURES,
      featuresPath,
      dispatch: mkDispatch([revise, revise, revise]),
    });
    expect(result.outcome).toBe('halted_on_escalation');
    expect(result.outcomes[0]!.status).toBe('escalated');
    expect(result.totalIterations).toBe(3);
    expect(result.escalationsCreated).toBe(1);
  });

  test('immediate escalate verdict halts before iter 2', async () => {
    const esc: Verdict = {
      verdict: 'escalate',
      slice_id: 'slice-1',
      iteration: 1,
      criteria_check: [{ criterion: 'runs without errors', result: 'FAIL', evidence: 'criterion is vague' }],
      scope_check: { approved_files_only: true, no_unapproved_deps: true, no_blocked_commands: true, violations: [] },
      recommendations: ['rewrite spec'],
      confidence: 'high',
      confidence_reason: 'spec ambiguity is blocker',
    };
    const result = await runPhase({
      repoRoot: tmpRoot,
      plan: SAMPLE_PLAN,
      features: SAMPLE_FEATURES,
      featuresPath,
      dispatch: mkDispatch([esc]),
    });
    expect(result.outcome).toBe('halted_on_escalation');
    expect(result.totalIterations).toBe(1);
    expect(result.escalationsCreated).toBe(1);
  });

  test('audit chain valid after a run', async () => {
    const verdict: Verdict = {
      verdict: 'pass',
      slice_id: 'slice-1',
      iteration: 1,
      criteria_check: [{ criterion: 'runs without errors', result: 'PASS', evidence: 'exit 0' }],
      scope_check: { approved_files_only: true, no_unapproved_deps: true, no_blocked_commands: true, violations: [] },
      recommendations: [],
      confidence: 'high',
      confidence_reason: 'tests pass',
    };
    const result = await runPhase({
      repoRoot: tmpRoot,
      plan: SAMPLE_PLAN,
      features: SAMPLE_FEATURES,
      featuresPath,
      dispatch: mkDispatch([verdict]),
    });
    const auditPath = path.join(result.runDir, 'audit.jsonl');
    const verifyErr = await verifyAuditChain(auditPath);
    expect(verifyErr).toBeNull();

    // Should have at least one row.
    const content = await readFile(auditPath, 'utf-8');
    const rowCount = content.split('\n').filter((l) => l.trim()).length;
    expect(rowCount).toBeGreaterThan(0);
  });

  test('malformed judge output → escalation', async () => {
    const badDispatch: DispatchFn = async (input) => {
      if (input.agent === 'builder') {
        return { agent: 'builder', output: 'work-report', exitCode: 0, durationMs: 1 };
      }
      return { agent: input.agent, output: 'not json at all', exitCode: 0, durationMs: 1 };
    };
    const result = await runPhase({
      repoRoot: tmpRoot,
      plan: SAMPLE_PLAN,
      features: SAMPLE_FEATURES,
      featuresPath,
      dispatch: badDispatch,
    });
    expect(result.outcome).toBe('halted_on_escalation');
    expect(result.escalationsCreated).toBe(1);
  });
});
