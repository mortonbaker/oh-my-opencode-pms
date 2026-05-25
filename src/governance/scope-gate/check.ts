/**
 * scope-gate/check.ts — tool-call gating.
 *
 * Design principle: default ALLOW. Block only actively-destructive operations
 * via a hard-deny list. Do NOT pre-filter Bash by role or by a narrow
 * verification_commands whitelist — agents legitimately need a vast range of
 * commands depending on the task (sqlite3, psql, cargo sqlx migrate run,
 * docker, kubectl, curl, python, node, jq, awk, …). Pre-listing them all is
 * impossible; pre-listing only "safe" commands is too narrow and breaks real
 * work.
 *
 * Safety net layering:
 *   1. File-scope gate (this module + scope-gate.ts) blocks Edit/Write
 *      outside architect-approved file_changes.
 *   2. Hard-deny bash list (here) blocks anything that could damage the
 *      repo, host, or remote infrastructure.
 *   3. Agent's job description (its system prompt) constrains intent.
 *   4. Builder's slice acceptance_criteria + judge review catch behavioral
 *      drift after the fact.
 *
 * The verification_commands array in a slice is a HINT for the agent and an
 * AUDIT ANCHOR for the judge — it is NOT a permission whitelist. We do not
 * deny commands just because they're absent from verification_commands.
 */

import { resolve } from 'node:path';
import type { SliceScope } from './types';

/**
 * Hard-deny Bash patterns. These are NEVER allowed regardless of slice
 * scope, agent role, or user config. Block actively destructive operations
 * only — everything else falls through to allow.
 *
 * Tests for these patterns run on the raw command string in order; first
 * match denies.
 */
const HARD_DENY_BASH: ReadonlyArray<{ re: RegExp; label: string }> = [
  // ── Recursive deletes against system / home / repo-root ──────────────
  {
    re: /\brm\s+(-[rRf]+\s+|--recursive\s+|--force\s+)+(\/|~|\$HOME|\*|\.\.?)(\s|$)/,
    label: 'rm -rf against /, ~, $HOME, *, . or ..',
  },
  {
    re: /\brm\s+(-[rRf]+\s+)+\/?(home|root|etc|usr|var|bin|sbin|boot|lib|proc|sys)\b/,
    label: 'rm -rf against a system directory',
  },

  // ── Pipe-to-shell (curl|sh, wget|bash) ────────────────────────────────
  {
    re: /\|\s*(sh|bash|zsh|fish|dash|ash)(\s|$)/,
    label: 'pipe to shell (curl|sh, wget|bash, etc.)',
  },

  // ── Privilege escalation ─────────────────────────────────────────────
  {
    re: /(^|;|&&|\|\||\s)(sudo|doas)(\s|$)/,
    label: 'privilege escalation (sudo/doas)',
  },
  { re: /(^|;|&&|\|\|)\s*su\s+-?(\s|$)/, label: 'su to another user' },

  // ── Git destruction ──────────────────────────────────────────────────
  {
    re: /\bgit\s+push\b[^;]*(-f\b|--force\b|--force-with-lease\b)[^;]*\b(origin\/)?(main|master|prod|production|release)\b/,
    label: 'force-push to a protected branch',
  },
  {
    re: /\bgit\s+push\s+\S+\s+\+/,
    label: 'force-push via + ref syntax',
  },
  {
    re: /\bgit\s+reset\s+--hard\s+(origin\/)?(main|master|prod|production|release)\b/,
    label: 'reset --hard against a protected branch',
  },
  {
    re: /\bgit\s+filter-(branch|repo)\b/,
    label: 'git filter-branch / filter-repo (rewrites history)',
  },
  {
    re: /\bgit\s+config\s+--(global|system)\s+(?!--get|-l|--list|--show)/,
    label: 'modify global/system git config',
  },

  // ── Publish / release / production deploy ────────────────────────────
  {
    re: /\b(npm|yarn|pnpm|bun)\s+publish\b/,
    label: 'package publish to npm registry',
  },
  { re: /\bcargo\s+publish\b/, label: 'cargo publish to crates.io' },
  { re: /\b(twine\s+upload|pip\s+upload)\b/, label: 'Python package upload' },
  {
    re: /\bgh\s+release\s+create\b/,
    label: 'GitHub release creation',
  },
  {
    re: /\bdocker\s+push\s+\S+:(latest|prod|production)\b/,
    label: 'docker push :latest/:prod tag',
  },

  // ── Filesystem-level destruction ─────────────────────────────────────
  {
    re: /\b(mkfs|fdisk|parted|cryptsetup|wipefs|sfdisk|gdisk)\b/,
    label: 'low-level filesystem/partition tool',
  },
  { re: /\bdd\s+[^;]*\bof=\/dev\//, label: 'dd writing to a device' },
  { re: /\bshred\s+-/, label: 'shred (secure overwrite)' },

  // ── Permission grants opening exposure ───────────────────────────────
  { re: /\bchmod\s+\d*[267]\d{2}\b/, label: 'chmod world/group writable' },
  {
    re: /\bchmod\s+(\+|=)?[ugoa]*[+=][rwx]*w[rwx]*\b.*\bo[+=]w\b/,
    label: 'chmod adding o+w (world-writable)',
  },
  {
    re: /\b(chmod|chown)\s+[^;]*\s\/(usr|etc|bin|sbin|boot|root|lib|proc|sys)\b/,
    label: 'chmod/chown on system path',
  },

  // ── SSH / cloud credential writes ────────────────────────────────────
  {
    re: />\s*~?\/?\.ssh\/(authorized_keys|id_\w+|config)\b/,
    label: 'write to ~/.ssh/* credentials',
  },
  {
    re: />\s*~?\/?\.aws\/(credentials|config)\b/,
    label: 'write to ~/.aws/* credentials',
  },
  {
    re: />\s*~?\/?\.docker\/config\.json\b/,
    label: 'write to ~/.docker/config.json',
  },

  // ── Env file overwrites (truncate `>`, not append `>>`) ──────────────
  {
    re: /(?:^|[^>])>\s*\.env(\.[\w]+)?(\s|$)/,
    label: 'truncate-write to .env file',
  },

  // ── System power / process kill ──────────────────────────────────────
  {
    re: /(^|;|&&|\|\|)\s*(shutdown|reboot|halt|poweroff|init\s+[06])\b/,
    label: 'system power command',
  },
  { re: /\bkill\s+-9\s+1\b/, label: 'kill PID 1' },

  // ── Raw SQL destruction (production-ish only — dev DBs OK) ───────────
  {
    re: /\bDROP\s+(DATABASE|SCHEMA)\s+(?!.*\b(test|dev|local|tmp|scratch)\b)/i,
    label: 'DROP DATABASE/SCHEMA against non-dev database',
  },
  {
    re: /\bTRUNCATE\s+(TABLE\s+)?(?!.*\b(test|dev|local|tmp|scratch|fixture)\b)/i,
    label: 'TRUNCATE TABLE against non-dev database',
  },

  // ── Docker host escape ───────────────────────────────────────────────
  { re: /\bdocker\s+run\b[^;]*--privileged\b/, label: 'docker run --privileged' },
  {
    re: /\bdocker\s+run\b[^;]*-v\s+\/:/,
    label: 'docker run mounting host /',
  },
  {
    re: /\bdocker\s+run\b[^;]*-v\s+~?\/\.ssh\b/,
    label: 'docker run mounting ~/.ssh',
  },
];

export function findHardDeny(command: string): string | null {
  for (const { re, label } of HARD_DENY_BASH) {
    if (re.test(command)) return label;
  }
  return null;
}

/**
 * File-scope check for Edit / Write tools. When a slice IS registered for
 * the session, Edit/Write targets must fall inside slice.fileChanges.
 * When no slice is registered, the per-agent permission defaults apply
 * (handled in src/agents/index.ts).
 */
export function checkFileTarget(
  targetPath: string,
  scope: SliceScope,
  cwd: string,
): boolean {
  if (!targetPath) return false;
  const target = resolve(cwd, targetPath);
  return scope.fileChanges.some((approved) => {
    const approvedAbs = resolve(cwd, approved);
    if (target === approvedAbs) return true;
    // Directory match: approved entry is a parent of target.
    return target.startsWith(`${approvedAbs}/`);
  });
}

/**
 * Bash check. Default ALLOW; deny only on hard-deny match.
 *
 * The `scope` parameter is intentionally unused for the allow/deny decision
 * (verification_commands is not a whitelist). It's retained in the signature
 * for future use (audit logging, soft-deny middle tier).
 */
export function checkBashCommand(
  command: string,
  _scope: SliceScope | undefined,
): { decision: 'allow' | 'deny'; reason?: string } {
  if (!command || typeof command !== 'string') {
    return { decision: 'deny', reason: 'empty bash command' };
  }
  const denyLabel = findHardDeny(command);
  if (denyLabel) {
    return {
      decision: 'deny',
      reason: `destructive operation blocked (${denyLabel})`,
    };
  }
  return { decision: 'allow' };
}
