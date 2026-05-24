/**
 * architect-output-validator.ts — enforces the 4-survey + falsifiable-
 * criteria contract on architect output BEFORE dispatch reaches the builder.
 *
 * Closes the gap where the architect.md prompt requires surveys but the
 * model can ignore the requirement and ship a hand-wave plan. Code
 * enforcement runs between architect dispatch return and builder dispatch
 * start in the run-phase orchestrator. Missing/empty survey → orchestrator
 * escalates instead of dispatching builder.
 *
 * Also flags non-falsifiable acceptance criteria (vibe-language patterns).
 *
 * Two entry points:
 *   - validateArchitectOutput(rawText) — checks an architect's raw response
 *     text for survey block + plan structure
 *   - validateSliceCriteria(slice)    — checks an individual slice for
 *     non-falsifiable acceptance criteria
 */

import type { Slice } from './types.js';

const SURVEY_HAND_WAVE_PATTERNS = [
  /\bskipped\b/i,
  /\btrivial\b/i,
  /\btodo\b/i,
  /\bn\/a\b/i,
  /\bnot needed\b/i,
  /\bnot applicable\b/i,
  /\bnone needed\b/i,
];

/** Required survey-block child labels. Each must appear at least once. */
const REQUIRED_SURVEY_KEYWORDS: ReadonlyArray<{ name: string; aliases: readonly string[] }> = [
  { name: 'codebase', aliases: ['codebase', 'code-base', 'repo'] },
  { name: 'plugin', aliases: ['plugin', 'platform', 'ecosystem', 'extension'] },
  {
    name: 'installed-cli-or-design-system',
    aliases: ['installed', 'cli', 'design-system', 'design system', 'tooling'],
  },
  { name: 'canonical', aliases: ['canonical', 'standard', 'best practice', 'best-practice', 'reference'] },
];

/** Vibe-language patterns that fail falsifiability. */
const NON_FALSIFIABLE_PATTERNS = [
  /\blooks (good|nice|polished|right)\b/i,
  /\bfeels (good|right|clean)\b/i,
  /\bis clean\b/i,
  /\bis nice\b/i,
  /\bworks well\b/i,
  /\bseems? to work\b/i,
  /\bappropriate\b/i, // alone is too vague; with a measurable companion it's fine
  /\bgood enough\b/i,
];

export type ValidationIssue = {
  severity: 'hard' | 'soft';
  topic:
    | 'missing-plan-tag'
    | 'missing-survey-block'
    | 'survey-missing-keyword'
    | 'survey-hand-wave'
    | 'non-falsifiable-criterion';
  detail: string;
};

export interface ArchitectValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** Extract the first <survey>...</survey> block content. */
function extractSurveyBlock(text: string): string | null {
  const m = /<survey>([\s\S]*?)<\/survey>/i.exec(text);
  return m ? m[1]!.trim() : null;
}

/** Extract the first <plan>...</plan> block content. */
function extractPlanBlock(text: string): string | null {
  const m = /<plan>([\s\S]*?)<\/plan>/i.exec(text);
  return m ? m[1]!.trim() : null;
}

/** Validate an architect's raw response text. */
export function validateArchitectOutput(rawText: string): ArchitectValidationResult {
  const issues: ValidationIssue[] = [];

  const planBody = extractPlanBlock(rawText);
  if (!planBody) {
    issues.push({
      severity: 'hard',
      topic: 'missing-plan-tag',
      detail:
        'Architect output did not contain a <plan>...</plan> block. Per architect.md output format the entire response must be wrapped in <plan>.',
    });
    // Without a plan tag we can still check for a survey block at top level
  }

  const surveyBody = extractSurveyBlock(planBody ?? rawText);
  if (!surveyBody) {
    issues.push({
      severity: 'hard',
      topic: 'missing-survey-block',
      detail:
        'Architect output missing <survey>...</survey> block. The 4-survey gate is mandatory for every plan.',
    });
    return { ok: false, issues };
  }

  const lowerSurvey = surveyBody.toLowerCase();

  for (const slot of REQUIRED_SURVEY_KEYWORDS) {
    const matched = slot.aliases.some((alias) => lowerSurvey.includes(alias));
    if (!matched) {
      issues.push({
        severity: 'hard',
        topic: 'survey-missing-keyword',
        detail: `Survey block missing required slot "${slot.name}" (looked for any of: ${slot.aliases.join(', ')}).`,
      });
    }
  }

  for (const pattern of SURVEY_HAND_WAVE_PATTERNS) {
    if (pattern.test(surveyBody)) {
      issues.push({
        severity: 'hard',
        topic: 'survey-hand-wave',
        detail: `Survey block contains hand-wave language (pattern: ${pattern.source}). If a survey is genuinely not needed, write WHY in that survey field instead of "skipped"/"trivial"/"TODO".`,
      });
    }
  }

  return { ok: issues.filter((i) => i.severity === 'hard').length === 0, issues };
}

/** Validate falsifiability of one slice's acceptance criteria. */
export function validateSliceCriteria(slice: Slice): ArchitectValidationResult {
  const issues: ValidationIssue[] = [];
  for (const crit of slice.acceptance_criteria) {
    // Skip the falsifiability check when the criterion already contains a
    // command-like fragment (backticks, $, command keywords) — those are
    // almost certainly falsifiable.
    const hasCommandLike =
      /`[^`]+`/.test(crit) ||
      /\bexit (code )?0\b/i.test(crit) ||
      /\bPASS\b|\bFAIL\b/.test(crit) ||
      /\b(curl|npm|cargo|tsc|jest|vitest|pytest|bash)\b/.test(crit);
    if (hasCommandLike) continue;

    for (const pattern of NON_FALSIFIABLE_PATTERNS) {
      if (pattern.test(crit)) {
        issues.push({
          severity: 'hard',
          topic: 'non-falsifiable-criterion',
          detail: `Slice "${slice.id}" criterion is vibe-language (pattern: ${pattern.source}): "${crit}". Rewrite as a measurable command + threshold.`,
        });
        break;
      }
    }
  }
  return { ok: issues.filter((i) => i.severity === 'hard').length === 0, issues };
}

/** Convenience: validate output + every slice in one call. */
export function validateArchitectFully(
  rawText: string,
  slices: readonly Slice[],
): ArchitectValidationResult {
  const out = validateArchitectOutput(rawText);
  const issues = [...out.issues];
  for (const slice of slices) {
    const sliceCheck = validateSliceCriteria(slice);
    issues.push(...sliceCheck.issues);
  }
  return { ok: issues.filter((i) => i.severity === 'hard').length === 0, issues };
}
