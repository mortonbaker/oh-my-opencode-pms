/**
 * workflow/types.ts — schemas for phase / plan / slice / features.
 *
 * Ported from ~/pms/scripts/_run_phase_lib.py (Tier 1).
 *
 * Atomic unit: a SLICE (not a "task"). Architect emits a plan containing
 * an ordered list of slices; orchestrator drives builder→judge per slice
 * with 3-strike cap. Features file (sibling JSON) defines machine-
 * verifiable smoke gates re-checked after every slice completes.
 */

import { z } from 'zod';

// -----------------------------------------------------------------------
// Slice — the atomic unit of work.
// -----------------------------------------------------------------------

export const SliceSchema = z.object({
  /** Stable ID like "infra.h3-judge-feature-gate". */
  id: z.string().min(1),
  /** Human-readable title. */
  title: z.string().min(1),
  /** Which subagent skills this slice exercises (e.g. ["ts", "schema"]). */
  skills_required: z.array(z.string()),
  /** Paths the builder may edit. Outside this list = scope violation. */
  file_changes: z.array(z.string()),
  /** Interface contracts produced/consumed (free-form). */
  interface_contracts: z.array(z.string()).default([]),
  /** Falsifiable acceptance criteria — judge enforces these. */
  acceptance_criteria: z.array(z.string().min(1)),
  /** Risks the architect identified. */
  risks: z.array(z.string()).default([]),
  /** Complexity estimate — drives budget caps. */
  complexity_estimate: z.enum(['S', 'M', 'L', 'XL']),
  /** Optional dependency on earlier slice IDs (must precede this one). */
  depends_on: z.array(z.string()).optional(),
});

export type Slice = z.infer<typeof SliceSchema>;

// -----------------------------------------------------------------------
// Plan — architect's output. One per phase run.
// -----------------------------------------------------------------------

export const PlanSchema = z.object({
  phase_id: z.string().min(1),
  spec_source: z.string().min(1), // path to the phase spec markdown
  spec_sha: z.string().regex(/^[0-9a-f]{64}$/, 'spec_sha must be hex sha-256'),
  slices: z.array(SliceSchema).min(1),
  /** When the plan was authored — used by the features-gate grandfather rule. */
  created_at: z.string().datetime().optional(),
});

export type Plan = z.infer<typeof PlanSchema>;

// -----------------------------------------------------------------------
// Features — machine-verifiable smoke gates re-checked per slice.
// -----------------------------------------------------------------------

export const FeatureEntrySchema = z.object({
  /** Human-readable description of what this feature does. */
  description: z.string().min(1),
  /** Concrete verification command/recipe. Builder must make this pass. */
  verification: z.string().min(1),
  /** Live state. Starts false; flipped to true when verification passes. */
  passes: z.boolean(),
  /** ISO-8601 timestamp of last verification (null if never verified). */
  verified_at: z.string().nullable(),
  /** Which subagent verified (null if never verified). */
  verified_by: z.string().nullable(),
}).strict(); // Exact 5-key shape — invented fields are schema errors.

export type FeatureEntry = z.infer<typeof FeatureEntrySchema>;

/** Features file is a record of feature-id → entry. */
export const FeaturesSchema = z.record(z.string(), FeatureEntrySchema);

export type Features = z.infer<typeof FeaturesSchema>;

// -----------------------------------------------------------------------
// Phase spec — markdown + YAML frontmatter (loaded separately).
// -----------------------------------------------------------------------

export const PhaseFrontmatterSchema = z.object({
  phase_id: z.string().min(1),
  authoring_pattern: z.string().optional(),
  budget: z
    .object({
      input_tokens: z.number().int().positive().optional(),
      output_tokens: z.number().int().positive().optional(),
      wall_clock_hours: z.number().positive().optional(),
    })
    .optional(),
});

export type PhaseFrontmatter = z.infer<typeof PhaseFrontmatterSchema>;

// -----------------------------------------------------------------------
// Verdict — judge output per iteration.
// -----------------------------------------------------------------------

export const VerdictSchema = z.object({
  verdict: z.enum(['pass', 'revise', 'escalate']),
  slice_id: z.string(),
  iteration: z.number().int().positive(),
  criteria_check: z.array(
    z.object({
      criterion: z.string(),
      result: z.enum(['PASS', 'FAIL']),
      evidence: z.string(),
    }),
  ),
  scope_check: z.object({
    approved_files_only: z.boolean(),
    no_unapproved_deps: z.boolean(),
    no_blocked_commands: z.boolean(),
    violations: z.array(z.string()).default([]),
  }),
  recommendations: z.array(z.string()).default([]),
  confidence: z.enum(['high', 'medium', 'low']),
  confidence_reason: z.string(),
});

export type Verdict = z.infer<typeof VerdictSchema>;

// -----------------------------------------------------------------------
// Escalation — recorded when judge issues escalate OR loop hits 3 strikes
// OR budget/provider exhaustion fires.
// -----------------------------------------------------------------------

export const EscalationSchema = z.object({
  escalation_id: z.string(),
  run_id: z.string(),
  slice_id: z.string().optional(),
  ts: z.string(),
  source: z.string(), // "judge" | "orchestrator" | "pre-tool-use" | ...
  topic: z.string(),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  reason: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['open', 'resolved']).default('open'),
  resolution: z
    .object({
      action: z.enum([
        'approve',
        'revise-spec',
        'revise-adr',
        'new-research',
        'abandon-phase',
      ]),
      note: z.string(),
      resolved_at: z.string(),
      resolved_by: z.string(),
    })
    .optional(),
});

export type Escalation = z.infer<typeof EscalationSchema>;

/** Verdict types the human gate CLI accepts. */
export const GATE_ACTIONS = [
  'approve',
  'revise-spec',
  'revise-adr',
  'new-research',
  'abandon-phase',
] as const;

export type GateAction = (typeof GATE_ACTIONS)[number];
