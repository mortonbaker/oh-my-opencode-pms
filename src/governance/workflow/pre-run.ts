/**
 * pre-run.ts — boot-time infra gate.
 *
 * Ported from ~/pms/.opencode/plugins/pre-run.ts (Tier 1).
 *
 * Runs 4 gates BEFORE the architect spawns:
 *   1. Plugin paths exist (no stale references in opencode.json plugin list)
 *   2. Write paths exist (the agent MDs we're about to dispatch to)
 *   3. Skills exist (any skills referenced by the agents)
 *   4. Plan schema importable (zod schema parses)
 *
 * Any gate failure prevents the phase from starting. Cheap fail-fast catches
 * a class of "everything looks fine until iteration 2 when something blows
 * up" bugs.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { PlanSchema, FeaturesSchema } from './types.js';

export interface PreRunInput {
  repoRoot: string;
  /** Plugin name strings as they appear in opencode.json plugin array. */
  pluginNames: readonly string[];
  /** Agent MD names (without .md) we expect to dispatch to. */
  expectedAgents: readonly string[];
  /** Optional: skills the agents reference. */
  expectedSkills?: readonly string[];
  /** Optional: path to a sample plan + features to schema-check. */
  samplePlanPath?: string;
  sampleFeaturesPath?: string;
}

export interface PreRunGateResult {
  gate: 'plugin-paths' | 'agent-mds' | 'skills' | 'plan-schema';
  passed: boolean;
  detail: string;
}

export interface PreRunResult {
  passed: boolean;
  gates: PreRunGateResult[];
}

export async function preRun(input: PreRunInput): Promise<PreRunResult> {
  const gates: PreRunGateResult[] = [];

  // Gate 1: plugin names resolve via Node module resolution OR are file paths that exist.
  for (const name of input.pluginNames) {
    if (name.startsWith('/') || name.startsWith('~') || name.startsWith('.')) {
      const resolved = name.replace(/^~/, process.env.HOME ?? '');
      try {
        await fs.access(resolved);
        gates.push({
          gate: 'plugin-paths',
          passed: true,
          detail: `${name} exists at ${resolved}`,
        });
      } catch {
        gates.push({ gate: 'plugin-paths', passed: false, detail: `${name} not found` });
      }
    } else {
      // npm package name — just check that node_modules has it OR it's a known global
      const candidate = path.join(input.repoRoot, 'node_modules', name);
      const globalCandidate = path.join(
        process.env.HOME ?? '',
        '.config',
        'opencode',
        'node_modules',
        name,
      );
      try {
        await fs.access(candidate);
        gates.push({ gate: 'plugin-paths', passed: true, detail: `${name} → ${candidate}` });
      } catch {
        try {
          await fs.access(globalCandidate);
          gates.push({
            gate: 'plugin-paths',
            passed: true,
            detail: `${name} → ${globalCandidate}`,
          });
        } catch {
          gates.push({
            gate: 'plugin-paths',
            passed: false,
            detail: `${name} not found in node_modules`,
          });
        }
      }
    }
  }

  // Gate 2: expected agent MD files exist.
  const agentDir = path.join(process.env.HOME ?? '', '.config', 'opencode', 'agent');
  for (const agent of input.expectedAgents) {
    const mdPath = path.join(agentDir, `${agent}.md`);
    try {
      await fs.access(mdPath);
      gates.push({ gate: 'agent-mds', passed: true, detail: `${agent}.md → ${mdPath}` });
    } catch {
      gates.push({ gate: 'agent-mds', passed: false, detail: `${agent}.md missing at ${mdPath}` });
    }
  }

  // Gate 3: skills exist (optional).
  if (input.expectedSkills && input.expectedSkills.length > 0) {
    const skillsDir = path.join(process.env.HOME ?? '', '.config', 'opencode', 'skills');
    for (const skill of input.expectedSkills) {
      const skillPath = path.join(skillsDir, skill);
      try {
        await fs.access(skillPath);
        gates.push({ gate: 'skills', passed: true, detail: `skill ${skill} present` });
      } catch {
        gates.push({ gate: 'skills', passed: false, detail: `skill ${skill} missing` });
      }
    }
  }

  // Gate 4: sample plan + features parse against schemas.
  if (input.samplePlanPath) {
    try {
      const raw = await fs.readFile(input.samplePlanPath, 'utf-8');
      PlanSchema.parse(JSON.parse(raw));
      gates.push({ gate: 'plan-schema', passed: true, detail: `${input.samplePlanPath} valid` });
    } catch (e) {
      gates.push({
        gate: 'plan-schema',
        passed: false,
        detail: `${input.samplePlanPath}: ${(e as Error).message.slice(0, 200)}`,
      });
    }
  }
  if (input.sampleFeaturesPath) {
    try {
      const raw = await fs.readFile(input.sampleFeaturesPath, 'utf-8');
      FeaturesSchema.parse(JSON.parse(raw));
      gates.push({
        gate: 'plan-schema',
        passed: true,
        detail: `${input.sampleFeaturesPath} valid`,
      });
    } catch (e) {
      gates.push({
        gate: 'plan-schema',
        passed: false,
        detail: `${input.sampleFeaturesPath}: ${(e as Error).message.slice(0, 200)}`,
      });
    }
  }

  return {
    passed: gates.every((g) => g.passed),
    gates,
  };
}

/** Format pre-run report for human consumption. */
export function formatPreRunReport(result: PreRunResult): string {
  const lines = [`Pre-run gate: ${result.passed ? 'PASS' : 'FAIL'}`];
  const byGate = new Map<string, PreRunGateResult[]>();
  for (const g of result.gates) {
    const arr = byGate.get(g.gate) ?? [];
    arr.push(g);
    byGate.set(g.gate, arr);
  }
  for (const [gate, items] of byGate) {
    const passed = items.filter((i) => i.passed).length;
    lines.push(`  ${gate}: ${passed}/${items.length} passed`);
    for (const i of items) {
      lines.push(`    ${i.passed ? '✓' : '✗'} ${i.detail}`);
    }
  }
  return lines.join('\n');
}
