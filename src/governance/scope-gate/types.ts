/**
 * scope-gate/types.ts — types for the slice-scope-aware permission gate.
 *
 * When @architect produces a slice with file_changes + verification_commands
 * and @project-manager dispatches @builder / @qa-reviewer with that slice
 * embedded in the prompt, this module captures the scope, binds it to the
 * spawned subagent session, and auto-allows / hard-denies tool calls based
 * on whether they fall inside the architect-approved scope.
 *
 * Out-of-scope tool calls throw SCOPE_VIOLATION before opencode prompts the
 * user — no "Allow / Deny / Always Allow" friction for in-scope work.
 * Out-of-scope work is hard-blocked without a prompt.
 */

export interface SliceScope {
  /** Slice identifier (matches SliceSchema.id from workflow/types.ts). */
  id?: string;
  /** Architect-approved file paths for Edit / Write targets. */
  fileChanges: string[];
  /** Architect-approved verification command patterns (regex strings) for Bash. */
  verificationCommands: string[];
  /** Parent (dispatching) session id — for audit. */
  parentSessionId?: string;
  /** Parent tool callID — for audit. */
  callId?: string;
  /** Captured timestamp. */
  recordedAt: number;
}

export type ScopeDecision = 'allow' | 'deny' | 'pass-through';

export interface ScopeCheckResult {
  decision: ScopeDecision;
  /** When 'deny': human-readable reason; when 'allow' or 'pass-through': undefined. */
  reason?: string;
  /** When 'allow' or 'deny': the slice that gated the decision (for audit). */
  scope?: SliceScope;
}
