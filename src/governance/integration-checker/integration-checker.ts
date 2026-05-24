/**
 * integration-checker.ts — between-phase compatibility check.
 *
 * Ported from ~/pms (Tier 1).
 *
 * After phase N completes, dispatch the integration-checker agent to verify
 * the deliverables of phase N are compatible with the assumptions of phase
 * N+1. The integration-checker returns one of three verdicts:
 *
 *   - compatible:           proceed to phase N+1
 *   - needs-clarification:  open a clarification escalation; phase N+1 blocked
 *   - incompatible:         open a hard escalation; phase N+1 abandoned
 *
 * The agent reads the most recent run dirs for both phases and looks for
 * interface_contracts mismatches, breaking changes, or new dependencies
 * not declared in the next phase's spec.
 */

import { z } from 'zod';

import type { DispatchFn } from '../workflow/dispatch.js';
import { escalate } from '../escalation/escalation.js';

export const IntegrationVerdictSchema = z.object({
  verdict: z.enum(['compatible', 'needs-clarification', 'incompatible']),
  prev_phase_id: z.string(),
  next_phase_id: z.string(),
  findings: z.array(
    z.object({
      kind: z.string(),
      description: z.string(),
      blocking: z.boolean(),
    }),
  ),
  recommendations: z.array(z.string()).default([]),
  confidence: z.enum(['high', 'medium', 'low']),
  confidence_reason: z.string(),
});

export type IntegrationVerdict = z.infer<typeof IntegrationVerdictSchema>;

export interface IntegrationCheckInput {
  prevPhaseId: string;
  prevRunDir: string;
  nextPhaseId: string;
  nextPhaseSpecPath: string;
  dispatch: DispatchFn;
  /** For escalation routing. */
  runId: string;
  perRunEscalationsDir: string;
  globalEscalationsDir?: string;
}

export interface IntegrationCheckResult {
  verdict: IntegrationVerdict;
  proceedToNextPhase: boolean;
}

/** Parse the integration-checker's output as strict JSON. */
function parseIntegrationOutput(text: string): IntegrationVerdict | string {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const start = text.indexOf('{');
  const candidate = fenced ? fenced[1]! : extractBalanced(text, start);
  if (!candidate) return 'integration-checker output did not contain a JSON object';
  try {
    return IntegrationVerdictSchema.parse(JSON.parse(candidate));
  } catch (e) {
    return `integration-checker JSON parse/validate failed: ${(e as Error).message}`;
  }
}

function extractBalanced(text: string, start: number): string | null {
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

export async function checkIntegration(
  input: IntegrationCheckInput,
): Promise<IntegrationCheckResult> {
  const result = await input.dispatch({
    agent: 'integration-checker',
    prompt:
      `Verify that deliverables from phase ${input.prevPhaseId} are compatible ` +
      `with the assumptions of phase ${input.nextPhaseId}. ` +
      `Read prev run artifacts at ${input.prevRunDir} and the next phase spec at ${input.nextPhaseSpecPath}. ` +
      `Look for interface_contracts mismatches, breaking changes, undeclared dependencies. ` +
      `Emit strict JSON IntegrationVerdict.`,
    context: {
      runId: input.runId,
      prevPhaseId: input.prevPhaseId,
      prevRunDir: input.prevRunDir,
      nextPhaseId: input.nextPhaseId,
      nextPhaseSpecPath: input.nextPhaseSpecPath,
    },
  });

  const parsed = parseIntegrationOutput(result.output);
  if (typeof parsed === 'string') {
    // Output malformed → escalate
    await escalate({
      runId: input.runId,
      source: 'integration-checker',
      topic: 'integration-output-malformed',
      severity: 'high',
      reason: parsed,
      detail: { raw_output: result.output.slice(0, 4000) },
      perRunDir: input.perRunEscalationsDir,
      globalDir: input.globalEscalationsDir,
    });
    return {
      verdict: {
        verdict: 'incompatible',
        prev_phase_id: input.prevPhaseId,
        next_phase_id: input.nextPhaseId,
        findings: [{ kind: 'malformed-output', description: parsed, blocking: true }],
        recommendations: ['rerun integration-checker with clearer prompt'],
        confidence: 'low',
        confidence_reason: 'agent output could not be parsed',
      },
      proceedToNextPhase: false,
    };
  }

  if (parsed.verdict === 'incompatible') {
    await escalate({
      runId: input.runId,
      source: 'integration-checker',
      topic: 'integration-incompatible',
      severity: 'critical',
      reason: `phase ${input.nextPhaseId} blocked: incompatible with phase ${input.prevPhaseId}`,
      detail: { verdict: parsed },
      perRunDir: input.perRunEscalationsDir,
      globalDir: input.globalEscalationsDir,
    });
    return { verdict: parsed, proceedToNextPhase: false };
  }
  if (parsed.verdict === 'needs-clarification') {
    await escalate({
      runId: input.runId,
      source: 'integration-checker',
      topic: 'integration-needs-clarification',
      severity: 'medium',
      reason: `phase ${input.nextPhaseId} needs clarification before proceeding`,
      detail: { verdict: parsed },
      perRunDir: input.perRunEscalationsDir,
      globalDir: input.globalEscalationsDir,
    });
    return { verdict: parsed, proceedToNextPhase: false };
  }
  return { verdict: parsed, proceedToNextPhase: true };
}
