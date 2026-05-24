/**
 * dispatch.ts — abstract subagent-dispatch interface.
 *
 * Two implementations:
 *   - subprocess: spawns `opencode run --agent <name> -- <prompt>` (matches
 *     ~/pms/scripts/run-phase-opencode.py); used by the standalone CLI.
 *   - plugin: calls PluginInput.client.session.create() from inside an
 *     opencode plugin; used when the orchestrator runs as a plugin tool.
 *
 * Both adhere to the same DispatchFn signature so the run-phase orchestrator
 * is callable from either path.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type SubagentName =
  | 'architect'
  | 'builder'
  | 'judge'
  | 'qa-reviewer'
  | 'researcher'
  | 'integration-checker';

export interface DispatchInput {
  agent: SubagentName;
  prompt: string;
  /** Per-run context — payload the agent should consider. */
  context?: {
    runId?: string;
    sliceId?: string;
    iteration?: number;
    [key: string]: unknown;
  };
  /** Where to capture stdout/stderr (optional log file). */
  logFile?: string;
  /** Hard timeout for the dispatch. */
  timeoutMs?: number;
}

export interface DispatchResult {
  agent: SubagentName;
  output: string;
  exitCode: number | null;
  durationMs: number;
  logFile?: string;
}

export type DispatchFn = (input: DispatchInput) => Promise<DispatchResult>;

// -----------------------------------------------------------------------
// Subprocess implementation: spawn the opencode CLI per agent dispatch.
// Matches ~/pms behavior exactly.
// -----------------------------------------------------------------------

const DEFAULT_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;

export const subprocessDispatch: DispatchFn = async (input) => {
  const startedAt = Date.now();
  const promptWithContext = input.context
    ? `${JSON.stringify(input.context)}\n\n${input.prompt}`
    : input.prompt;

  return new Promise<DispatchResult>((resolve) => {
    const args = ['run', '--agent', input.agent, '--', promptWithContext];
    const child = spawn('opencode', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, input.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS);

    child.stdout?.on('data', (c) => (stdout += String(c)));
    child.stderr?.on('data', (c) => (stderr += String(c)));
    child.on('error', () => {
      clearTimeout(timer);
      void writeLogIfNeeded(input.logFile, stdout, stderr);
      resolve({
        agent: input.agent,
        output: stdout || stderr,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        ...(input.logFile ? { logFile: input.logFile } : {}),
      });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      void writeLogIfNeeded(input.logFile, stdout, stderr);
      resolve({
        agent: input.agent,
        output: stdout,
        exitCode: code,
        durationMs: Date.now() - startedAt,
        ...(input.logFile ? { logFile: input.logFile } : {}),
      });
    });
  });
};

async function writeLogIfNeeded(
  logFile: string | undefined,
  stdout: string,
  stderr: string,
): Promise<void> {
  if (!logFile) return;
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.writeFile(logFile, `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`, 'utf-8');
}
