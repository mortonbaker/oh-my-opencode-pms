/**
 * plan-validator.ts — light schema-shape check on architect plan + features file.
 *
 * Ported from ~/pms/scripts/_run_phase_lib.py::_validate + _validate_features.
 *
 * Intentionally light: full semantic checks (e.g. depends_on referencing
 * existing slice IDs) live in the judge, not here. The orchestrator just
 * gates on "the JSON has the keys we need to drive the builder/judge loop".
 */

import { PlanSchema, FeaturesSchema, type Plan, type Features } from './types.js';
import { ZodError } from 'zod';

/** Returns list of human-readable error strings; empty list = valid. */
export function validatePlan(raw: unknown): string[] {
  try {
    PlanSchema.parse(raw);
    // Additional cross-slice checks
    const plan = raw as Plan;
    const sliceIds = new Set(plan.slices.map((s) => s.id));
    const errs: string[] = [];
    for (const slice of plan.slices) {
      for (const dep of slice.depends_on ?? []) {
        if (!sliceIds.has(dep)) {
          errs.push(`slice ${slice.id}: depends_on references unknown slice "${dep}"`);
        }
      }
    }
    return errs;
  } catch (e) {
    if (e instanceof ZodError) {
      return e.issues.map((iss) => {
        const path = iss.path.join('.');
        return `${path || '<root>'}: ${iss.message}`;
      });
    }
    return [`unexpected error: ${(e as Error).message}`];
  }
}

/** Returns list of human-readable error strings; empty list = valid. */
export function validateFeatures(raw: unknown): string[] {
  try {
    FeaturesSchema.parse(raw);
    return [];
  } catch (e) {
    if (e instanceof ZodError) {
      return e.issues.map((iss) => {
        const path = iss.path.join('.');
        // Strict-mode rejection of unknown keys is reported as "unrecognized_keys"
        if (iss.code === 'unrecognized_keys') {
          return `${path || '<root>'}: extra keys ${JSON.stringify(
            (iss as unknown as { keys?: string[] }).keys ?? [],
          )} — features schema is exactly 5 keys per entry`;
        }
        return `${path || '<root>'}: ${iss.message}`;
      });
    }
    return [`unexpected error: ${(e as Error).message}`];
  }
}

/** Compute counts: total features vs. how many have passes:true. */
export function featuresCoverage(features: Features): { total: number; passing: number; failing: number } {
  let passing = 0;
  let failing = 0;
  for (const entry of Object.values(features)) {
    if (entry.passes) passing++;
    else failing++;
  }
  return { total: passing + failing, passing, failing };
}

/** True if all features pass. */
export function featuresAllPassing(features: Features): boolean {
  return Object.values(features).every((e) => e.passes);
}
