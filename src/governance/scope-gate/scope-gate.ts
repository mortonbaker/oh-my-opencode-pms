/**
 * scope-gate/scope-gate.ts — registry + decision engine.
 *
 * Lifecycle:
 *   1. On `tool.execute.before` for the `task` tool, recordDispatch() parses
 *      <slice> from the prompt and queues it under parentSessionId.
 *   2. On the `session.created` event with a parentID, claimChild() binds
 *      the most recent queued slice for that parent to the new child session.
 *   3. On `tool.execute.before` for Edit / Write / Bash, check() returns
 *      'allow' (in scope) / 'deny' (out of scope) / 'pass-through' (no
 *      slice registered for this session — fall back to per-agent defaults).
 *   4. On `session.deleted`, release() clears entries to bound memory.
 */

import { checkBashCommand, checkFileTarget } from './check';
import { parseSliceFromPrompt } from './parser';
import type { ScopeCheckResult, SliceScope } from './types';

const READ_ONLY_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'list',
  'webfetch',
  'websearch',
  'ast_grep_search',
  'context7',
  'grep_app',
]);

export class ScopeGate {
  /** Pending slices keyed by parent (dispatcher) sessionID — claimed by the child. */
  private pending = new Map<string, SliceScope[]>();
  /** Active slices keyed by the subagent (child) sessionID. */
  private active = new Map<string, SliceScope>();

  /** Returns true if the slice was parsed and queued, false otherwise. */
  recordDispatch(
    parentSessionId: string,
    callId: string,
    prompt: string,
  ): boolean {
    const scope = parseSliceFromPrompt(prompt);
    if (!scope) return false;
    scope.parentSessionId = parentSessionId;
    scope.callId = callId;
    const list = this.pending.get(parentSessionId) ?? [];
    list.push(scope);
    this.pending.set(parentSessionId, list);
    return true;
  }

  claimChild(parentSessionId: string, childSessionId: string): void {
    const list = this.pending.get(parentSessionId);
    if (!list || list.length === 0) return;
    const scope = list.shift();
    if (!scope) return;
    this.active.set(childSessionId, scope);
    if (list.length === 0) this.pending.delete(parentSessionId);
  }

  release(sessionId: string): void {
    this.active.delete(sessionId);
    this.pending.delete(sessionId);
  }

  /** Inspect — useful for audit / debugging. */
  getActiveScope(sessionId: string): SliceScope | undefined {
    return this.active.get(sessionId);
  }

  check(
    sessionId: string | undefined,
    tool: string,
    args: Record<string, unknown> | undefined,
    cwd: string,
  ): ScopeCheckResult {
    if (!sessionId) return { decision: 'pass-through' };
    const scope = this.active.get(sessionId);
    if (!scope) return { decision: 'pass-through' };

    const toolLower = tool.toLowerCase();

    // Read-only inspection always allowed inside a scoped session.
    if (READ_ONLY_TOOLS.has(toolLower)) return { decision: 'allow', scope };

    if (toolLower === 'edit' || toolLower === 'write') {
      const targetPath =
        ((args?.filePath ?? args?.path ?? args?.file) as string | undefined) ??
        '';
      if (!targetPath) return { decision: 'pass-through', scope };
      if (checkFileTarget(targetPath, scope, cwd)) {
        return { decision: 'allow', scope };
      }
      return {
        decision: 'deny',
        scope,
        reason: `SCOPE_VIOLATION: ${tool} target "${targetPath}" not in slice ${scope.id ?? '(unnamed)'} approved file_changes: [${scope.fileChanges.join(', ')}]`,
      };
    }

    if (toolLower === 'bash') {
      const command = (args?.command as string | undefined) ?? '';
      if (checkBashCommand(command, scope)) return { decision: 'allow', scope };
      return {
        decision: 'deny',
        scope,
        reason: `SCOPE_VIOLATION: bash command "${command.slice(0, 80)}" not in slice ${scope.id ?? '(unnamed)'} verification_commands: [${scope.verificationCommands.join(', ')}]`,
      };
    }

    // Tools we don't gate explicitly: pass through (apply-patch, todowrite,
    // task, etc. — these have their own governance paths).
    return { decision: 'pass-through', scope };
  }
}
