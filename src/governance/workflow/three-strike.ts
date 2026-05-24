/**
 * three-strike.ts — code-enforced iteration cap with auto-escalation.
 *
 * Ported from ~/pms/scripts/run-phase-opencode.py judge loop (Tier 1).
 *
 * Each slice gets up to MAX_ITERATIONS builder-judge cycles. After the
 * cap, the orchestrator must NOT dispatch a 4th builder iteration — it
 * MUST escalate. This module is the deterministic counter the
 * orchestrator code calls to track iteration state.
 *
 * Per-slice state is held in-memory for the lifetime of the run process.
 * Persisting to budget.json or a sidecar is the orchestrator's job
 * (the in-memory state is the source of truth during the run; the
 * sidecar is for resume/debug).
 */

import type { Verdict } from './types.js';
import type { Escalation } from './types.js';
import { escalate } from '../escalation/escalation.js';

export const MAX_ITERATIONS_PER_SLICE = 3;

export interface SliceLoopState {
  sliceId: string;
  iteration: number;
  history: Verdict[];
  escalated: boolean;
  passed: boolean;
}

export class LoopTracker {
  private readonly slices = new Map<string, SliceLoopState>();
  private readonly maxIter: number;

  constructor(maxIter = MAX_ITERATIONS_PER_SLICE) {
    this.maxIter = maxIter;
  }

  /** Get or create state for a slice. */
  get(sliceId: string): SliceLoopState {
    let s = this.slices.get(sliceId);
    if (!s) {
      s = { sliceId, iteration: 0, history: [], escalated: false, passed: false };
      this.slices.set(sliceId, s);
    }
    return s;
  }

  /** Mark a new builder iteration starting. Returns the iteration number to dispatch with. */
  nextIteration(sliceId: string): number {
    const s = this.get(sliceId);
    if (s.passed) {
      throw new Error(`slice ${sliceId} already passed; cannot dispatch another iteration`);
    }
    if (s.escalated) {
      throw new Error(`slice ${sliceId} already escalated; cannot dispatch another iteration`);
    }
    if (s.iteration >= this.maxIter) {
      throw new Error(
        `slice ${sliceId} at max iterations (${this.maxIter}); orchestrator must escalate, not dispatch`,
      );
    }
    s.iteration += 1;
    return s.iteration;
  }

  /** Record a judge verdict. Returns next action: "continue" | "next-slice" | "escalate-now". */
  recordVerdict(sliceId: string, verdict: Verdict): 'continue' | 'next-slice' | 'escalate-now' {
    const s = this.get(sliceId);
    s.history.push(verdict);

    if (verdict.verdict === 'pass') {
      s.passed = true;
      return 'next-slice';
    }
    if (verdict.verdict === 'escalate') {
      s.escalated = true;
      return 'escalate-now';
    }
    // verdict === 'revise'
    if (s.iteration >= this.maxIter) {
      // Judge issued revise but we're at the cap — mandatory escalation.
      s.escalated = true;
      return 'escalate-now';
    }
    return 'continue';
  }

  /** Build the escalation record + persist via escalate(). */
  async escalateSlice(
    sliceId: string,
    runId: string,
    perRunEscalationsDir: string,
    globalEscalationsDir?: string,
  ): Promise<Escalation> {
    const s = this.get(sliceId);
    const lastVerdict = s.history[s.history.length - 1];
    const reason =
      lastVerdict?.verdict === 'escalate'
        ? `judge escalated: ${lastVerdict.recommendations.join('; ') || 'no detail'}`
        : `3-strike cap reached on slice ${sliceId} — orchestrator forced escalation`;
    return escalate({
      runId,
      sliceId,
      source: 'three-strike-tracker',
      topic: 'judge-3-strike',
      severity: 'high',
      reason,
      detail: {
        iteration_count: s.iteration,
        verdict_history: s.history.map((v) => ({
          iteration: v.iteration,
          verdict: v.verdict,
          confidence: v.confidence,
        })),
      },
      perRunDir: perRunEscalationsDir,
      globalDir: globalEscalationsDir,
    });
  }

  snapshot(): SliceLoopState[] {
    return [...this.slices.values()];
  }
}
