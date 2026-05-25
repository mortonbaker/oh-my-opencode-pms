/**
 * scope-gate/parser.ts — extract <slice> blocks from dispatch prompts.
 *
 * The architect emits slices in one of two formats:
 *
 * 1. JSON in a fenced <slice> block (canonical, post-PMS migration):
 *
 *      <slice>
 *      {
 *        "id": "feature.user-login",
 *        "file_changes": ["src/auth/login.ts", "src/auth/login.test.ts"],
 *        "verification_commands": ["bun test src/auth", "tsc --noEmit"]
 *      }
 *      </slice>
 *
 * 2. Markdown ## Scope block with backticked paths (slim-compat fallback):
 *
 *      ## Scope
 *      `src/auth/login.ts`
 *      `src/auth/login.test.ts`
 *
 *      ## Verification Commands
 *      - `bun test src/auth`
 *      - `tsc --noEmit`
 *
 * Returns null if neither format is present — caller falls back to per-agent
 * default permissions (no slice = ad-hoc work, default rules apply).
 */

import type { SliceScope } from './types';

interface RawSliceJson {
  id?: string;
  file_changes?: unknown;
  verification_commands?: unknown;
  acceptance_criteria?: unknown;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const arr = value.filter((v): v is string => typeof v === 'string');
  return arr.length === value.length ? arr : null;
}

function tryJsonSlice(prompt: string): SliceScope | null {
  // Match <slice>...</slice> wrapping a JSON object. Tolerant of whitespace
  // and optional attributes on the opening tag.
  const match = prompt.match(/<slice\b[^>]*>\s*(\{[\s\S]*?\})\s*<\/slice>/);
  if (!match) return null;
  let parsed: RawSliceJson;
  try {
    parsed = JSON.parse(match[1]) as RawSliceJson;
  } catch {
    return null;
  }
  const fileChanges = asStringArray(parsed.file_changes);
  if (!fileChanges || fileChanges.length === 0) return null;
  const verification =
    asStringArray(parsed.verification_commands) ??
    asStringArray(parsed.acceptance_criteria) ??
    [];
  return {
    id: typeof parsed.id === 'string' ? parsed.id : undefined,
    fileChanges,
    verificationCommands: verification,
    recordedAt: Date.now(),
  };
}

function tryMarkdownScope(prompt: string): SliceScope | null {
  const scopeMatch = prompt.match(
    /(?:^|\n)##\s+Scope\s*\n([\s\S]*?)(?=\n##|\n```|$)/i,
  );
  if (!scopeMatch) return null;
  const paths = [...scopeMatch[1].matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  if (paths.length === 0) return null;

  const verMatch = prompt.match(
    /(?:^|\n)##\s+Verification(?:\s+Commands)?\s*\n([\s\S]*?)(?=\n##|\n```|$)/i,
  );
  const verCommands = verMatch
    ? [...verMatch[1].matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
    : [];

  return {
    fileChanges: paths,
    verificationCommands: verCommands,
    recordedAt: Date.now(),
  };
}

export function parseSliceFromPrompt(prompt: string): SliceScope | null {
  if (!prompt || typeof prompt !== 'string') return null;
  return tryJsonSlice(prompt) ?? tryMarkdownScope(prompt);
}
