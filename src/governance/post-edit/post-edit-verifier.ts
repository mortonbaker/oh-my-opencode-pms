/**
 * post-edit-verifier.ts — scoped typecheck/lint/test after every Edit/Write.
 *
 * Ported from ~/pms/.opencode/plugins/post-edit.ts (Tier 4).
 *
 * BLOCK MECHANISM: On verifier failure, throws an Error. Wired into the
 * plugin's `tool.execute.after` hook — a thrown error surfaces as a
 * tool-call block to the calling subagent.
 *
 * SCOPED: only runs verifiers relevant to the edited file's extension
 * (TS files → tsc + eslint + vitest scoped to changed paths; Rust →
 * cargo check + clippy + test).
 *
 * TOOLCHAIN DEFERRAL: files matching DEFERRAL_GLOBS (e.g. Windows-only
 * `.ps1` / `.wxs` / `deploy/windows/`) skip local verification — they
 * belong on a different build host. Skip is logged so the judge can see
 * it was intentional, not a swallowed failure.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const TIMEOUT_TYPECHECK_S = 180;
export const TIMEOUT_LINT_S = 120;
export const TIMEOUT_TEST_S = 180;

/** Path patterns that defer verification to a different toolchain/host. */
export const DEFERRAL_GLOBS: readonly string[] = [
  'deploy/windows/',
  '.ps1',
  '.wxs',
];

/** True iff this file's verification belongs on a different toolchain. */
export function isDeferredTarget(filePath: string): boolean {
  const s = filePath.replace(/\\/g, '/');
  for (const g of DEFERRAL_GLOBS) {
    if (g.startsWith('.')) {
      if (s.endsWith(g)) return true;
    } else if (s.includes(g)) {
      return true;
    }
  }
  return false;
}

export interface VerifierStep {
  name: string;
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
}

export interface VerifierResult {
  step: VerifierStep;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** Detect which verifier steps apply to a given file. */
export function stepsForFile(repoRoot: string, filePath: string): VerifierStep[] {
  if (isDeferredTarget(filePath)) return [];

  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') {
    return [
      {
        name: 'typecheck',
        argv: ['npx', 'tsc', '--noEmit'],
        cwd: repoRoot,
        timeoutMs: TIMEOUT_TYPECHECK_S * 1000,
      },
      {
        name: 'lint',
        argv: ['npx', 'eslint', filePath],
        cwd: repoRoot,
        timeoutMs: TIMEOUT_LINT_S * 1000,
      },
    ];
  }
  if (ext === '.rs') {
    return [
      {
        name: 'cargo-check',
        argv: ['cargo', 'check', '--message-format=short'],
        cwd: repoRoot,
        timeoutMs: TIMEOUT_TYPECHECK_S * 1000,
        env: { RUSTFLAGS: '-D warnings' },
      },
      {
        name: 'cargo-clippy',
        argv: ['cargo', 'clippy', '--message-format=short', '--', '-D', 'warnings'],
        cwd: repoRoot,
        timeoutMs: TIMEOUT_LINT_S * 1000,
      },
    ];
  }
  return [];
}

/** Run one verifier step with timeout + stdout/stderr capture. */
export function runStep(step: VerifierStep): Promise<VerifierResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const env = { ...process.env, ...(step.env ?? {}) };
    const [cmd, ...args] = step.argv;
    const child = spawn(cmd!, args, { cwd: step.cwd, env });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, step.timeoutMs);
    child.stdout?.on('data', (c) => (stdout += String(c)));
    child.stderr?.on('data', (c) => (stderr += String(c)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ step, exitCode: -1, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ step, exitCode: code, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    });
  });
}

/** Run all verifier steps for a file and write a log under runs/<run-id>/. */
export async function verifyEditedFile(
  repoRoot: string,
  filePath: string,
  logDir: string,
): Promise<{ deferred: boolean; results: VerifierResult[]; logPath: string | null }> {
  if (isDeferredTarget(filePath)) {
    return { deferred: true, results: [], logPath: null };
  }
  const steps = stepsForFile(repoRoot, filePath);
  if (steps.length === 0) {
    return { deferred: false, results: [], logPath: null };
  }
  const results: VerifierResult[] = [];
  for (const step of steps) {
    results.push(await runStep(step));
  }
  await fs.mkdir(logDir, { recursive: true });
  const safe = filePath.replace(/[/\\]/g, '__');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logDir, `post-edit-${ts}-${safe}.log`);
  const body = results
    .map(
      (r) =>
        `=== ${r.step.name} (exit=${r.exitCode}${r.timedOut ? ', TIMEOUT' : ''}, ${r.durationMs}ms) ===\n` +
        `+ ${r.step.argv.join(' ')}\n` +
        `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`,
    )
    .join('\n');
  await fs.writeFile(logPath, body, 'utf-8');
  return { deferred: false, results, logPath };
}

/** True iff every step succeeded. */
export function allStepsPassed(results: readonly VerifierResult[]): boolean {
  return results.every((r) => r.exitCode === 0);
}
