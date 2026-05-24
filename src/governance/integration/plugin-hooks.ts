/**
 * plugin-hooks.ts — bridge between the opencode plugin lifecycle and
 * the governance harness.
 *
 * preToolUseGovernance(input, output):
 *   - appended to tool.execute.before in src/index.ts
 *   - checks token + wall-clock budget (throws BudgetDenialError to block)
 *   - audits the decision
 *
 * postToolUseGovernance(input, output, error):
 *   - appended to tool.execute.after in src/index.ts
 *   - for Edit/Write tools, runs scoped typecheck/lint verifier (throws on
 *     failure to surface the regression to the calling subagent)
 *   - audits the outcome
 *
 * Both hooks are GRACEFUL: if no run directory is configured (no
 * PMS_RUN_ID env var), they no-op silently. The plugin remains usable
 * for ad-hoc sessions outside the run-phase orchestrator.
 *
 * The run dir is resolved from env at every call so the orchestrator
 * can set PMS_RUN_ID before dispatch without restarting opencode.
 */

import path from 'node:path';

import { appendAuditRow } from '../audit/audit-chain.js';
import { checkBudget, BudgetDenialError } from '../budget/budget-gate.js';
import {
  verifyEditedFile,
  allStepsPassed,
  isDeferredTarget,
} from '../post-edit/post-edit-verifier.js';

interface PreInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}

interface PostInput extends PreInput {}

interface PreOutput {
  args?: unknown;
}

interface PostOutput {
  args?: unknown;
  output?: string;
  error?: unknown;
}

/** Resolve the per-run directory from env. Returns null when unset. */
function resolveRunDir(): string | null {
  const runId = process.env.PMS_RUN_ID;
  if (!runId || runId.length === 0) return null;
  const repoRoot = process.env.PMS_REPO_ROOT ?? process.cwd();
  return path.join(repoRoot, 'runs', runId);
}

function summarizeArgs(args: unknown): string {
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args);
    return s.length > 800 ? s.slice(0, 800) + '...(trunc)' : s;
  } catch {
    return '<unstringifiable>';
  }
}

function extractFilePath(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const o = args as Record<string, unknown>;
  for (const key of ['filePath', 'file_path', 'path', 'target']) {
    const v = o[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Called from tool.execute.before. Throws to block the tool call when the
 * budget is exhausted; otherwise audits the allow and returns silently.
 *
 * No-ops when PMS_RUN_ID is unset.
 */
export async function preToolUseGovernance(
  input: PreInput,
  output: PreOutput,
): Promise<void> {
  const runDir = resolveRunDir();
  if (!runDir) return; // not inside a governed run

  const subagent = process.env.PMS_AGENT ?? 'unknown';
  const sessionId = input.sessionID ?? 'no-session';
  const inputSummary = `${input.tool}:${summarizeArgs(output.args)}`;

  try {
    await checkBudget(runDir);
  } catch (e) {
    if (e instanceof BudgetDenialError) {
      // Audit the denial, then re-throw to block the tool call.
      try {
        await appendAuditRow(runDir, {
          subagent,
          tool: input.tool,
          input_summary: inputSummary,
          session_id: sessionId,
          decision: 'deny',
          reason: e.message,
        });
      } catch {
        // best-effort; don't shadow the budget error
      }
      throw e;
    }
    throw e;
  }

  // Budget OK — audit the allow.
  try {
    await appendAuditRow(runDir, {
      subagent,
      tool: input.tool,
      input_summary: inputSummary,
      session_id: sessionId,
      decision: 'allow',
    });
  } catch {
    // best-effort
  }
}

/**
 * Called from tool.execute.after. For Edit/Write tools, runs the scoped
 * post-edit verifier and throws on failure (which surfaces as a tool-call
 * block to the subagent). Always audits the outcome.
 *
 * No-ops when PMS_RUN_ID is unset.
 */
export async function postToolUseGovernance(
  input: PostInput,
  output: PostOutput,
): Promise<void> {
  const runDir = resolveRunDir();
  if (!runDir) return;

  const subagent = process.env.PMS_AGENT ?? 'unknown';
  const sessionId = input.sessionID ?? 'no-session';
  const toolLower = input.tool.toLowerCase();
  const isEditTool =
    toolLower === 'edit' ||
    toolLower === 'write' ||
    toolLower === 'multiedit' ||
    toolLower === 'notebookedit';

  if (!isEditTool) {
    // Non-edit tool — just audit completion best-effort.
    try {
      await appendAuditRow(runDir, {
        subagent,
        tool: input.tool,
        input_summary: `${input.tool}:complete`,
        session_id: sessionId,
        decision: 'allow',
      });
    } catch {
      // best-effort
    }
    return;
  }

  const filePath = extractFilePath(output.args);
  if (!filePath) return; // nothing to verify

  // Toolchain-target deferral: log + skip when file targets a different host.
  if (isDeferredTarget(filePath)) {
    try {
      await appendAuditRow(runDir, {
        subagent,
        tool: input.tool,
        input_summary: `post-edit:${filePath}`,
        session_id: sessionId,
        decision: 'allow',
        reason: `TOOLCHAIN_TARGET_DEFERRED: ${filePath} skipped (cross-platform target)`,
      });
    } catch {
      // best-effort
    }
    return;
  }

  const repoRoot = process.env.PMS_REPO_ROOT ?? process.cwd();
  const logDir = path.join(runDir, 'post-edit-logs');
  const result = await verifyEditedFile(repoRoot, filePath, logDir);

  if (result.results.length === 0) {
    // No verifier applies to this file extension — audit + return.
    try {
      await appendAuditRow(runDir, {
        subagent,
        tool: input.tool,
        input_summary: `post-edit:${filePath}`,
        session_id: sessionId,
        decision: 'allow',
        reason: 'no verifier applies to this file type',
      });
    } catch {
      // best-effort
    }
    return;
  }

  if (allStepsPassed(result.results)) {
    try {
      await appendAuditRow(runDir, {
        subagent,
        tool: input.tool,
        input_summary: `post-edit:${filePath}`,
        session_id: sessionId,
        decision: 'allow',
        reason: `verifier passed — log: ${result.logPath}`,
      });
    } catch {
      // best-effort
    }
    return;
  }

  // Failure — audit + throw to block.
  const failedSteps = result.results.filter((r) => r.exitCode !== 0);
  const failureNames = failedSteps.map((s) => s.step.name).join(', ');
  const reason = `post-edit verifier failed: ${failureNames} — see ${result.logPath}`;
  try {
    await appendAuditRow(runDir, {
      subagent,
      tool: input.tool,
      input_summary: `post-edit:${filePath}`,
      session_id: sessionId,
      decision: 'deny',
      reason,
    });
  } catch {
    // best-effort
  }
  throw new Error(reason);
}
