/**
 * plugin-hooks.test.ts — covers the integration layer that bridges the
 * governance harness into opencode's tool.execute.{before,after} hooks.
 *
 * Validates:
 *   - no-op when PMS_RUN_ID is unset (ad-hoc opencode session)
 *   - audit row written when PMS_RUN_ID is set
 *   - budget gate throws BudgetDenialError when budget exhausted
 *   - post-edit verifier no-ops for non-edit tools
 *   - post-edit verifier no-ops for deferred targets (.ps1, .wxs)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  preToolUseGovernance,
  postToolUseGovernance,
} from '../integration/plugin-hooks.js';
import { BudgetDenialError } from '../budget/budget-gate.js';

let tmpRepo: string;
let runDir: string;
const RUN_ID = 'test-run-001';

beforeEach(async () => {
  tmpRepo = await mkdtemp(path.join(tmpdir(), 'pms-plugin-hooks-'));
  runDir = path.join(tmpRepo, 'runs', RUN_ID);
  await mkdir(runDir, { recursive: true });
  process.env.PMS_REPO_ROOT = tmpRepo;
  process.env.PMS_AGENT = 'test-agent';
});

afterEach(async () => {
  delete process.env.PMS_RUN_ID;
  delete process.env.PMS_REPO_ROOT;
  delete process.env.PMS_AGENT;
});

describe('preToolUseGovernance', () => {
  test('no-ops when PMS_RUN_ID unset', async () => {
    // PMS_RUN_ID intentionally not set
    await preToolUseGovernance(
      { tool: 'Read', sessionID: 'ses-1' },
      { args: { path: '/some/file' } },
    );
    // No audit file should exist
    const auditPath = path.join(runDir, 'audit.jsonl');
    let exists = false;
    try {
      await readFile(auditPath);
      exists = true;
    } catch {}
    expect(exists).toBe(false);
  });

  test('audits allow when budget unset (no budget.json)', async () => {
    process.env.PMS_RUN_ID = RUN_ID;
    await preToolUseGovernance(
      { tool: 'Read', sessionID: 'ses-1' },
      { args: { path: '/some/file' } },
    );
    const audit = await readFile(path.join(runDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('"decision":"allow"');
    expect(audit).toContain('"tool":"Read"');
  });

  test('throws BudgetDenialError + audits deny when budget exhausted', async () => {
    process.env.PMS_RUN_ID = RUN_ID;
    await writeFile(
      path.join(runDir, 'budget.json'),
      JSON.stringify({
        input_token_limit: 100,
        input_tokens_used: 100,
        output_token_limit: 100,
        output_tokens_used: 0,
      }),
    );
    await expect(
      preToolUseGovernance(
        { tool: 'Read', sessionID: 'ses-1' },
        { args: {} },
      ),
    ).rejects.toBeInstanceOf(BudgetDenialError);

    const audit = await readFile(path.join(runDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('"decision":"deny"');
    expect(audit).toContain('budget exceeded');
  });
});

describe('postToolUseGovernance', () => {
  test('no-ops when PMS_RUN_ID unset', async () => {
    await postToolUseGovernance(
      { tool: 'Edit', sessionID: 'ses-1' },
      { args: { filePath: '/some/file.ts' } },
    );
    const auditPath = path.join(runDir, 'audit.jsonl');
    let exists = false;
    try {
      await readFile(auditPath);
      exists = true;
    } catch {}
    expect(exists).toBe(false);
  });

  test('audits non-edit tool completion best-effort', async () => {
    process.env.PMS_RUN_ID = RUN_ID;
    await postToolUseGovernance(
      { tool: 'Read', sessionID: 'ses-1' },
      { args: { path: '/some/file' } },
    );
    const audit = await readFile(path.join(runDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('"tool":"Read"');
    expect(audit).toContain('Read:complete');
  });

  test('defers + audits cross-platform target (.ps1) without running verifier', async () => {
    process.env.PMS_RUN_ID = RUN_ID;
    await postToolUseGovernance(
      { tool: 'Edit', sessionID: 'ses-1' },
      { args: { filePath: 'deploy/install.ps1' } },
    );
    const audit = await readFile(path.join(runDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('TOOLCHAIN_TARGET_DEFERRED');
  });

  test('audits allow on edit when no verifier applies to the file type', async () => {
    process.env.PMS_RUN_ID = RUN_ID;
    await postToolUseGovernance(
      { tool: 'Write', sessionID: 'ses-1' },
      { args: { filePath: 'docs/notes.md' } }, // .md has no verifier
    );
    const audit = await readFile(path.join(runDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('no verifier applies');
  });

  test('skips when no file path can be extracted from args', async () => {
    process.env.PMS_RUN_ID = RUN_ID;
    await postToolUseGovernance(
      { tool: 'Edit', sessionID: 'ses-1' },
      { args: { weird: 'shape' } },
    );
    // No audit row should be written for this case (returns silently)
    let content = '';
    try {
      content = await readFile(path.join(runDir, 'audit.jsonl'), 'utf-8');
    } catch {}
    expect(content).toBe('');
  });
});
