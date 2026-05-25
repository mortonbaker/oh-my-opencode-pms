/**
 * scope-gate/check.ts — tool-call vs slice-scope matching.
 */

import { resolve } from 'node:path';
import type { SliceScope } from './types';

/**
 * Read-only bash commands always allowed (regardless of slice scope).
 * Subagents need these to inspect the codebase before / during work.
 */
const ALWAYS_ALLOWED_BASH: RegExp[] = [
  /^ls(\s|$)/,
  /^cat(\s|$)/,
  /^head(\s|$)/,
  /^tail(\s|$)/,
  /^wc(\s|$)/,
  /^file(\s|$)/,
  /^find(\s|$)/,
  /^grep(\s|$)/,
  /^rg(\s|$)/,
  /^tree(\s|$)/,
  /^pwd(\s|$)/,
  /^echo(\s|$)/,
  /^git\s+(status|diff|log|show|blame|branch|remote)/,
];

/**
 * Bash commands NEVER allowed without explicit slice approval, even
 * read-only-looking ones can have side effects (e.g. curl|sh).
 */
const ALWAYS_DENIED_BASH: RegExp[] = [
  /^rm\s+-rf?\s+\//, // rm -rf / or rm -r /…
  /\|\s*(sh|bash|zsh|fish)\b/, // curl | sh, wget -O- | bash
  /\bnpm\s+publish\b/,
  /\bgit\s+push\s+--force/,
  /\bgit\s+reset\s+--hard\s+origin/,
  /\b:>\s*\//, // truncate root-level file
];

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

export function checkBashCommand(command: string, scope: SliceScope): boolean {
  if (!command) return false;
  if (ALWAYS_DENIED_BASH.some((re) => re.test(command))) return false;
  if (ALWAYS_ALLOWED_BASH.some((re) => re.test(command))) return true;

  return scope.verificationCommands.some((pattern) => {
    // Treat each verification_command as either a regex or a substring.
    try {
      const re = new RegExp(pattern, 'i');
      if (re.test(command)) return true;
    } catch {
      // Pattern wasn't a valid regex; fall through.
    }
    return command.includes(pattern);
  });
}
