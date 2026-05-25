/**
 * parallel-detector.ts — Cascade Component 1
 *
 * Detects when an orchestrator task would benefit from parallel subagent dispatch
 * (N≥3 same-shape units of work) and injects a <system-reminder> urging parallel dispatch.
 *
 * Tier 0 — regex (microseconds, $0): fast signal detection
 * Tier 1 — haiku triage (~$0.0001/call): only fires when Tier 0 matches
 * Decision: inject reminder only when both tiers concur with high confidence
 */

import { classify, type ProviderClient } from "./_lib/cheap-classifier";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Tier0Result {
  matched: boolean;
  signals: string[];
  unitCountHint?: number;
}

export interface Tier1Result {
  parallelizable: boolean;
  unit_count: number;
  unit_axis: string;
  independence: string;
  confidence: number;
}

export interface AnalyzePromptOpts {
  prompt: string;
  providerClient?: ProviderClient;
}

export interface AnalyzePromptResult {
  shouldNudge: boolean;
  reminder?: string;
  tier0: Tier0Result;
  tier1?: Tier1Result;
  error?: string;
}

// ── Locked reminder template ─────────────────────────────────────────────────

export const REMINDER_TEMPLATE =
  "PARALLELIZATION DETECTED (unit_count={N}, axis={AXIS}, confidence={C}).\n" +
  "HARD POLICY: dispatch as N parallel `task` tool calls in ONE message.\n" +
  "Use the parallelization-template skill for the decomposition contract.\n" +
  "Justification required if you choose sequential: explicit reason in your reply.";

function formatReminder(n: number, axis: string, c: number): string {
  return REMINDER_TEMPLATE.replace("{N}", String(n))
    .replace("{AXIS}", axis)
    .replace("{C}", String(c));
}

// ── Tier 0 — Regex patterns (exported as named constants) ──────────────────

export const RX_AUDIT_ACROSS = /\b(audit|review|update|test|migrate|refactor|wire|implement|document|add|fix)\s+\w+\s+(across|in|for|on)\s+(all|every|each|the)\s+\w+/i;

export const RX_DIGIT_PLURAL = /\b(\d+)\s+(features?|pages?|files?|modules?|services?|endpoints?|components?|repos?|projects?)/i;

export const RX_FOR_EACH = /\bfor\s+each\s+\w+/i;

export const RX_GLOB_BRACE = /\{[\w,]+\}/;

export const RX_GLOB_DOUBLESTAR = /\*\*\/\*\.\w+/;

/** Parallelizable plural nouns for digit+plural detection */
const PLURALATABLE_NOUNS = new Set([
  "feature", "features",
  "page", "pages",
  "file", "files",
  "module", "modules",
  "service", "services",
  "endpoint", "endpoints",
  "component", "components",
  "repo", "repos",
  "project", "projects",
]);

// ── Tier 0 — Helpers ─────────────────────────────────────────────────────────

/**
 * Extract the digit found before a parallelizable plural noun.
 * Returns 0 if no match, noun is not parallelizable, or N < 3.
 */
export function extractDigitUnitCount(prompt: string): number {
  const match = prompt.match(RX_DIGIT_PLURAL);
  if (!match) return 0;
  const noun = match[2]!.toLowerCase();
  if (!PLURALATABLE_NOUNS.has(noun)) return 0;
  const n = parseInt(match[1]!, 10);
  return n >= 3 ? n : 0;
}

/**
 * Count parallel-structured bullets (≥3 lines starting with `- ` or `* ` or `\d+\.`
 * AND each starts with the same first word/verb).
 * Returns 0 if < 3 bullets or verbs are mixed.
 */
export function countParallelBullets(prompt: string): number {
  const lines = prompt.split("\n");
  const bulletLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      bulletLines.push(trimmed);
    }
  }

  if (bulletLines.length < 3) return 0;

  // Extract first word (verb) of each bullet
  const verbs = bulletLines.map((l) => {
    const rest = l.replace(/^[-*]\s/, "").replace(/^\d+\.\s/, "");
    return rest.split(/\s+/)[0] ?? "";
  });

  const firstVerb = verbs[0];
  if (!firstVerb) return 0;
  // All verbs must match the first one (case-insensitive)
  if (verbs.every((v) => v.toLowerCase() === firstVerb.toLowerCase())) {
    return bulletLines.length;
  }
  return 0;
}

/**
 * Tier-0 detection: pure sync function exposing all regex signals.
 */
export function tier0Detect(prompt: string): Tier0Result {
  const signals: string[] = [];
  let unitCountHint: number | undefined;

  if (RX_AUDIT_ACROSS.test(prompt)) {
    signals.push("audit_across");
  }

  if (RX_FOR_EACH.test(prompt)) {
    signals.push("for_each");
  }

  if (RX_GLOB_BRACE.test(prompt)) {
    signals.push("glob_brace");
  }

  if (RX_GLOB_DOUBLESTAR.test(prompt)) {
    signals.push("glob_doublestar");
  }

  const digitCount = extractDigitUnitCount(prompt);
  if (digitCount >= 3) {
    signals.push("digit_plural");
    unitCountHint = digitCount;
  }

  const bulletCount = countParallelBullets(prompt);
  if (bulletCount >= 3) {
    signals.push("parallel_bullets");
    if (unitCountHint === undefined || bulletCount > unitCountHint) {
      unitCountHint = bulletCount;
    }
  }

  const result: Tier0Result = {
    matched: signals.length > 0,
    signals,
  };
  if (unitCountHint !== undefined) {
    result.unitCountHint = unitCountHint;
  }
  return result;
}

// ── Tier 1 — Schema & system prompt ──────────────────────────────────────────

const TIER1_SCHEMA = `{
  "parallelizable": boolean,
  "unit_count": number,
  "unit_axis": string,
  "independence": string,
  "confidence": number
}`;

const TIER1_SYSTEM = `You are a classifier. You return JSON only. No prose. No reasoning. No code fences. No explanation.
You never use tools. You never write files. You never plan work.
You read the orchestrator task description and classify it using this schema:
${TIER1_SCHEMA}
Rules:
- "unit_axis" must be one of: files, features, pages, modules, services, repos, other
- "independence" must be one of: independent, shared_state, sequential_required
- "parallelizable" is true only when the task has N>=3 units of the same shape that can be worked on simultaneously
- "confidence" is 0.0-1.0 how confident you are in the parallelizable=true assessment
Schema violations are a hard failure — return {"error": "<one-sentence reason>"} and nothing else.
Do not include the word "json" or markdown formatting. Just the JSON object.`;

// ── Tier 1 — Validation ─────────────────────────────────────────────────────

function isValidTier1(data: unknown): data is Tier1Result {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj["parallelizable"] === "boolean" &&
    typeof obj["unit_count"] === "number" &&
    typeof obj["unit_axis"] === "string" &&
    typeof obj["independence"] === "string" &&
    typeof obj["confidence"] === "number"
  );
}

// ── Core analyzePrompt ───────────────────────────────────────────────────────

export async function analyzePrompt(
  opts: AnalyzePromptOpts,
): Promise<AnalyzePromptResult> {
  const { prompt, providerClient } = opts;

  // Tier 0
  const tier0 = tier0Detect(prompt);

  if (!tier0.matched) {
    return { shouldNudge: false, tier0 };
  }

  // Tier 1 only fires when Tier 0 matches
  if (!providerClient) {
    return {
      shouldNudge: false,
      tier0,
      error: "no provider client — cannot run Tier-1 triage",
    };
  }

  const result = await classify<Tier1Result>({
    input: prompt,
    schema: TIER1_SCHEMA,
    systemPromptOverride: TIER1_SYSTEM,
    providerClient,
  });

  if (!result.ok) {
    console.error("[parallel-detector] Tier-1 error:", result.error);
    return { shouldNudge: false, tier0, error: `Tier-1-error: ${result.error}` };
  }

  if (!isValidTier1(result.data)) {
    console.error("[parallel-detector] Tier-1 shape validation failed:", result.rawText);
    return { shouldNudge: false, tier0, error: "Tier-1 shape validation failed" };
  }

  const tier1 = result.data;

  // Tier-0 false positive: matched regex but haiku says NOT parallelizable
  if (!tier1.parallelizable) {
    console.info("[parallel-detector] Tier-0 false-positive signal caught", {
      signals: tier0.signals,
    });
    return { shouldNudge: false, tier0, tier1 };
  }

  // Decision gate
  const pass =
    tier1.parallelizable === true &&
    tier1.confidence >= 0.8 &&
    tier1.independence === "independent" &&
    tier1.unit_count >= 3;

  if (!pass) {
    return { shouldNudge: false, tier0, tier1 };
  }

  const reminder = formatReminder(tier1.unit_count, tier1.unit_axis, tier1.confidence);
  return { shouldNudge: true, reminder, tier0, tier1 };
}

// ── Hook factory for PMS integration ─────────────────────────────────────────
// PMS calls `analyzeUserMessage` from inside its
// `experimental.chat.messages.transform` hook, which has access to user
// message parts. If parallelization is detected, a system-reminder text part
// is appended to that message in place.

import type { PluginInput } from "@opencode-ai/plugin";

export function createParallelDetectorHook(ctx: PluginInput) {
  const providerClient = ctx.client as unknown as ProviderClient | undefined;

  async function analyzeUserMessage(parts: Array<{ type: string; text?: string }>): Promise<void> {
    try {
      const text = parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n");
      if (!text) return;

      const analyzeOpts: AnalyzePromptOpts = { prompt: text };
      if (providerClient) analyzeOpts.providerClient = providerClient;
      const result = await analyzePrompt(analyzeOpts);

      if (result.shouldNudge && result.reminder) {
        parts.push({
          type: "text",
          text: `<system-reminder>${result.reminder}</system-reminder>`,
        });
      }
    } catch (err) {
      console.error("[parallel-detector] Unexpected error:", err);
    }
  }

  return { analyzeUserMessage };
}
