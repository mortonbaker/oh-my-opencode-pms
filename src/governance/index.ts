/**
 * Public API for the oh-my-opencode-pms governance harness.
 *
 * Tier 1 — Workflow mechanism (deterministic orchestration):
 *   - workflow/types       Plan, Slice, Features, Verdict, Escalation (zod)
 *   - workflow/run-phase   The orchestrator function
 *   - workflow/dispatch    Subagent dispatch abstraction (subprocess + plugin)
 *   - workflow/pre-run     Boot-time infra gate
 *   - workflow/smoke-gate  Per-slice deterministic feature verification
 *   - workflow/three-strike  Loop tracker with mandatory escalation
 *
 * Tier 2 — Resource governance:
 *   - budget/budget-gate   Proactive token + wall-clock budget enforcement
 *
 * Tier 3 — Audit & state discipline:
 *   - audit/audit-chain    HMAC-SHA256 hash-chained audit log + verifier
 *   - run-dir/run-dir      Per-run directory convention + budget seeding
 *   - escalation/escalation  Structured escalation records (per-run + global)
 *
 * Tier 4 — Quality enforcement:
 *   - post-edit/post-edit-verifier  Scoped typecheck/lint after every edit
 *
 * Integration:
 *   - integration-checker/integration-checker  Between-phase compatibility
 *
 * CLIs (under src/governance/cli/, invokable via npm-script wrappers):
 *   - cli/gate            pms-gate (list/show/resolve escalations)
 *   - cli/run-phase-cli   pms-run-phase (drive a phase end-to-end)
 */

// Workflow
export * from './workflow/types.js';
export * from './workflow/plan-validator.js';
export * from './workflow/three-strike.js';
export * from './workflow/smoke-gate.js';
export * from './workflow/dispatch.js';
export * from './workflow/run-phase.js';
export * from './workflow/pre-run.js';

// Run dir + budget
export * from './run-dir/run-dir.js';
export * from './budget/budget-gate.js';

// Audit
export * from './audit/audit-chain.js';
export { canonicalJsonStringify } from './_lib/canonical-json.js';
export type { AuditRow, Subagent, GovernanceDecision, Severity } from './_lib/types.js';

// Escalation
export * from './escalation/escalation.js';

// Post-edit verifier
export * from './post-edit/post-edit-verifier.js';

// Integration checker
export * from './integration-checker/integration-checker.js';
