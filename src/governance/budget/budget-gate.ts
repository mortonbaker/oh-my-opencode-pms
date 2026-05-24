/**
 * budget-gate.ts — proactive token / wall-clock budget enforcement.
 *
 * Ported from ~/pms/.opencode/plugins/pre-tool-use.ts::checkBudget (Tier 2).
 *
 * Reads runs/<run-id>/budget.json. Throws DenialError when input or output
 * budget is exhausted, BEFORE the tool call hits the provider.
 *
 * Returns silently when budget.json is missing or malformed — same
 * conservative behavior as the Python original. Caller is responsible for
 * seeding budget.json at run start (see run-dir/seedBudgetFile).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export class BudgetDenialError extends Error {
  constructor(
    public readonly kind: 'input' | 'output' | 'wall_clock',
    message: string,
  ) {
    super(message);
    this.name = 'BudgetDenialError';
  }
}

interface BudgetState {
  input_token_limit?: number;
  input_tokens_used?: number;
  output_token_limit?: number;
  output_tokens_used?: number;
  wall_clock_limit_s?: number;
  started_at?: string;
}

/** Throw BudgetDenialError when any budget dimension is exhausted. */
export async function checkBudget(runDir: string): Promise<void> {
  const budgetPath = path.join(runDir, 'budget.json');
  let raw: string;
  try {
    raw = await fs.readFile(budgetPath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    return; // other IO errors: don't block (matches Python behavior)
  }
  let state: BudgetState;
  try {
    state = JSON.parse(raw) as BudgetState;
  } catch {
    return; // malformed: don't block
  }

  const inputLimit = Number(state.input_token_limit ?? 0);
  const inputUsed = Number(state.input_tokens_used ?? 0);
  if (Number.isFinite(inputLimit) && inputLimit > 0 && inputUsed >= inputLimit) {
    throw new BudgetDenialError(
      'input',
      `input-token budget exceeded (${inputUsed}/${inputLimit}); escalate to gate`,
    );
  }

  const outputLimit = Number(state.output_token_limit ?? 0);
  const outputUsed = Number(state.output_tokens_used ?? 0);
  if (Number.isFinite(outputLimit) && outputLimit > 0 && outputUsed >= outputLimit) {
    throw new BudgetDenialError(
      'output',
      `output-token budget exceeded (${outputUsed}/${outputLimit}); escalate to gate`,
    );
  }

  const wallLimit = Number(state.wall_clock_limit_s ?? 0);
  if (Number.isFinite(wallLimit) && wallLimit > 0 && state.started_at) {
    const elapsedS = (Date.now() - new Date(state.started_at).getTime()) / 1000;
    if (elapsedS >= wallLimit) {
      throw new BudgetDenialError(
        'wall_clock',
        `wall-clock budget exceeded (${Math.round(elapsedS)}s / ${wallLimit}s); escalate to gate`,
      );
    }
  }
}

/** Returns the remaining budget in each dimension; undefined for unset limits. */
export async function budgetRemaining(runDir: string): Promise<{
  inputTokens?: number;
  outputTokens?: number;
  wallClockS?: number;
}> {
  const budgetPath = path.join(runDir, 'budget.json');
  try {
    const raw = await fs.readFile(budgetPath, 'utf-8');
    const state = JSON.parse(raw) as BudgetState;
    const out: { inputTokens?: number; outputTokens?: number; wallClockS?: number } = {};
    if (state.input_token_limit !== undefined) {
      out.inputTokens = Math.max(
        0,
        Number(state.input_token_limit) - Number(state.input_tokens_used ?? 0),
      );
    }
    if (state.output_token_limit !== undefined) {
      out.outputTokens = Math.max(
        0,
        Number(state.output_token_limit) - Number(state.output_tokens_used ?? 0),
      );
    }
    if (state.wall_clock_limit_s !== undefined && state.started_at) {
      const elapsedS = (Date.now() - new Date(state.started_at).getTime()) / 1000;
      out.wallClockS = Math.max(0, Number(state.wall_clock_limit_s) - elapsedS);
    }
    return out;
  } catch {
    return {};
  }
}
