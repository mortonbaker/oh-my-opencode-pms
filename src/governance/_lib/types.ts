/**
 * Shared types for the governance harness.
 * Kept minimal — domain types live in their respective modules
 * (workflow/, audit/, budget/, etc.).
 */

/** A subagent role name in the PMS pantheon. */
export type Subagent =
  | 'project-manager'
  | 'architect'
  | 'builder'
  | 'judge'
  | 'qa-reviewer'
  | 'researcher'
  | 'integration-checker'
  | 'observer'
  | 'council'
  | 'councillor';

/** A pre-tool-use / post-edit / audit decision. */
export type GovernanceDecision = 'allow' | 'deny' | 'error';

/** Severity of an audit row / escalation. */
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** An audit row exactly as written to runs/<run-id>/audit.jsonl. */
export interface AuditRow {
  ts: string; // ISO-8601 with microsecond padding to match Python
  subagent: string;
  tool: string;
  input_summary: string; // truncated to <= 1 KiB
  session_id: string;
  decision: GovernanceDecision;
  reason?: string;
  hash_prev: string; // hex sha-256
  hash: string; // hex sha-256
}
