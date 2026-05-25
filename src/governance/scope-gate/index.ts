// Scope-aware permission gate for subagent dispatches.
//
// Architect produces a slice with file_changes + verification_commands.
// Project-manager dispatches builder/qa-reviewer with the slice embedded
// in the prompt. Scope gate parses the slice, binds it to the spawned
// subagent session via parent-child session.created linkage, then
// auto-allows / hard-denies tool calls based on whether they fall inside
// the architect-approved scope.
//
// Out-of-scope work is blocked WITHOUT a user prompt — surfaces as a
// SCOPE_VIOLATION tool error directly to the subagent. In-scope work
// bypasses opencode's permission prompts. When no slice is registered
// for a session (e.g. ad-hoc work outside a planned phase), falls
// through to per-agent default permissions.

export { ScopeGate } from './scope-gate';
export type { ScopeCheckResult, ScopeDecision, SliceScope } from './types';
export { parseSliceFromPrompt } from './parser';
export { checkBashCommand, checkFileTarget } from './check';
