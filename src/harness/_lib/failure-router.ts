/**
 * failure-router.ts — cost-aware escalation classifier for the three-tier cascade.
 *
 * Tier 0: deterministic regex rules (free, sync)
 * Tier 1: haiku-4-5 classification call (~$0.0001)
 * Fallback: escalate to full opus orchestrator
 *
 * When a subagent dispatch fails 3 times with the same signature, this module
 * classifies the failure and routes 6 of 7 categories WITHOUT touching opus.
 */

import { classify, type ProviderClient, type ClassifyResult } from "./cheap-classifier";

// ── Types ────────────────────────────────────────────────────────────────────

export type FailureCategory =
  | "bad_prompt"                    // same error 3x → poor prompting
  | "task_too_large"                // max_turns hit 3x → task exceeds tier capability
  | "broken_verification"           // verification commands themselves erroring (not test failures)
  | "subagent_hallucination"         // claimed files don't exist 3x
  | "external_dependency_failure"    // network/API/git error 3x → infra issue
  | "ambiguous_criteria"             // criteria couldn't be tested by verification
  | "needs_orchestrator_judgment";   // genuinely complex, escalate

export type SuggestedAction =
  | "rewrite_prompt"           // haiku auto-rewrites prompt against criteria template
  | "split_task"               // re-dispatch with smaller scope
  | "fix_verification"         // surface to orchestrator as INFRA_ISSUE
  | "switch_subagent_tier"     // re-dispatch with higher-capability subagent (m2.7→kimi→sonnet)
  | "retry_with_stricter_prompt"
  | "retry_with_backoff"
  | "escalate_to_orchestrator"; // full opus

export interface FailureLog {
  attempts: Array<{
    attemptNumber: number;
    errorMessage: string;
    errorKind: string;        // e.g. "max_turns", "verification_failed", "tool_error", "provider_error", "timeout"
    signature: string;        // normalized error signature
    claimedFilesModified?: string[];
    claimedFilesExisted?: boolean[]; // parallel array — false = file claimed but missing
  }>;
}

export interface ClassifyFailureResult {
  category: FailureCategory;
  action: SuggestedAction;
  touchesOrchestrator: boolean;
  confidence: number;
  source: "tier0" | "tier1" | "fallback";
  reason?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  "bad_prompt",
  "task_too_large",
  "broken_verification",
  "subagent_hallucination",
  "external_dependency_failure",
  "ambiguous_criteria",
  "needs_orchestrator_judgment",
];

export const SUGGESTED_ACTIONS: readonly SuggestedAction[] = [
  "rewrite_prompt",
  "split_task",
  "fix_verification",
  "switch_subagent_tier",
  "retry_with_stricter_prompt",
  "retry_with_backoff",
  "escalate_to_orchestrator",
];

export const ROUTING_TABLE: Record<FailureCategory, { action: SuggestedAction; touchesOrchestrator: boolean }> = {
  bad_prompt: { action: "rewrite_prompt", touchesOrchestrator: false },
  task_too_large: { action: "switch_subagent_tier", touchesOrchestrator: false },
  broken_verification: { action: "fix_verification", touchesOrchestrator: false }, // surfaces summary only
  subagent_hallucination: { action: "retry_with_stricter_prompt", touchesOrchestrator: false },
  external_dependency_failure: { action: "retry_with_backoff", touchesOrchestrator: false },
  ambiguous_criteria: { action: "escalate_to_orchestrator", touchesOrchestrator: true },
  needs_orchestrator_judgment: { action: "escalate_to_orchestrator", touchesOrchestrator: true },
};

// ── Helper ───────────────────────────────────────────────────────────────────

/** Returns true when all three attempts share the same error signature. */
export function errorSignaturesMatch(attempts: FailureLog["attempts"]): boolean {
  if (attempts.length < 3) return false;
  const last = attempts.slice(-3) as [NonNullable<FailureLog["attempts"][0]>, NonNullable<FailureLog["attempts"][0]>, NonNullable<FailureLog["attempts"][0]>];
  const [a, b, c] = last;
  return a.signature === b.signature && b.signature === c.signature;
}

// ── Tier 0 — deterministic rules ─────────────────────────────────────────────

/**
 * Pure sync tier-0 classifier. Returns null when no deterministic rule fires
 * (caller should escalate to Tier 1 haiku).
 */
export function tier0Classify(failureLog: FailureLog): null | { category: FailureCategory; confidence: 1.0; source: "tier0" } {
  const { attempts } = failureLog;
  if (attempts.length < 3) return null;

  // Last 3 attempts (require exactly 3 for the cascade to have triggered)
  const last3 = attempts.slice(-3);
  const allMaxTurns = last3.every((a) => a.errorKind === "max_turns");
  const allSameSig = errorSignaturesMatch(attempts);

  // Rule: ALL errorKind === "max_turns" for last 3 → task_too_large
  if (allMaxTurns) {
    return { category: "task_too_large", confidence: 1.0, source: "tier0" };
  }

  // Rule: ALL three signature strings identical → bad_prompt
  // Exception: max_turns is more specific → task_too_large (already handled above)
  if (allSameSig) {
    return { category: "bad_prompt", confidence: 1.0, source: "tier0" };
  }

  // Rule: claimedFilesExisted contains false in all 3 of last 3 → subagent_hallucination
  const hallucinationCount = last3.filter((a) =>
    a.claimedFilesExisted !== undefined && a.claimedFilesExisted.includes(false)
  ).length;
  if (hallucinationCount === 3) {
    return { category: "subagent_hallucination", confidence: 1.0, source: "tier0" };
  }

  // Rule: errorMessage matches verifier-spawn pattern AND happens 3 of 3 → broken_verification
  const brokenVerifyCount = last3.filter((a) =>
    /^(verification|verify).*?(error|failed to (run|spawn|exec))/i.test(a.errorMessage) ||
    /(verification|verify).*?(error|failed to (run|spawn|exec))/i.test(a.errorMessage)
  ).length;
  if (brokenVerifyCount === 3) {
    return { category: "broken_verification", confidence: 1.0, source: "tier0" };
  }

  // Rule: errorMessage matches network/API pattern AND happens 3 of 3 → external_dependency_failure
  const extDepCount = last3.filter((a) =>
    /ECONNRESET|ENOTFOUND|EAI_AGAIN|429|503|504|timeout|fetch failed/i.test(a.errorMessage)
  ).length;
  if (extDepCount === 3) {
    return { category: "external_dependency_failure", confidence: 1.0, source: "tier0" };
  }

  return null;
}

// ── Tier 1 — haiku classifier ────────────────────────────────────────────────

const HAIKU_CATEGORIES = FAILURE_CATEGORIES.join(" | ");

const HAIKU_SYSTEM_PROMPT = `You are a failure-classification expert for an autonomous coding agent.
Given a failure log, classify it into exactly one of these categories:
${HAIKU_CATEGORIES}

Return JSON matching this schema exactly:
{
  "category": "<one of the 7 categories above>",
  "confidence": <number 0.0-1.0>,
  "suggested_action": "<one of: rewrite_prompt | split_task | fix_verification | switch_subagent_tier | retry_with_stricter_prompt | retry_with_backoff | escalate_to_orchestrator>",
  "reason": "<one-sentence explanation>"
}

If you are uncertain, set confidence below 0.5 and use "escalate_to_orchestrator". JSON only. No prose. No markdown.`;

/** @internal Visible for testing only — use classifyFailure() for the full cascade. */
export function buildHaikuInput(failureLog: FailureLog): string {
  const lines = failureLog.attempts.map((a, i) => {
    let line = `[${i + 1}] kind=${a.errorKind} sig=${a.signature} msg=${a.errorMessage}`;
    if (a.claimedFilesModified) line += ` claimed=${a.claimedFilesModified.join(",")}`;
    if (a.claimedFilesExisted) line += ` existed=${a.claimedFilesExisted.join(",")}`;
    return line;
  });
  return `Failure log (last ${failureLog.attempts.length} attempts):\n${lines.join("\n")}`;
}

/** @internal Visible for testing — use classifyFailure() for the full cascade. */
export function parseHaikuResult(raw: unknown): { category: FailureCategory; confidence: number; suggested_action: SuggestedAction; reason: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.category !== "string") return null;
  if (typeof obj.confidence !== "number") return null;
  if (typeof obj.suggested_action !== "string") return null;
  if (typeof obj.reason !== "string") return null;
  if (!FAILURE_CATEGORIES.includes(obj.category as FailureCategory)) return null;
  if (obj.confidence < 0 || obj.confidence > 1) return null;
  return {
    category: obj.category as FailureCategory,
    confidence: obj.confidence,
    suggested_action: obj.suggested_action as SuggestedAction,
    reason: obj.reason,
  };
}

async function callHaikuClassifier(
  failureLog: FailureLog,
  providerClient: ProviderClient,
): Promise<ClassifyResult<{ category: string; confidence: number; suggested_action: string; reason: string }>> {
  const input = buildHaikuInput(failureLog);
  return classify({
    input,
    schema: `{ category: string, confidence: number, suggested_action: string, reason: string }`,
    systemPromptOverride: HAIKU_SYSTEM_PROMPT,
    providerClient,
    callerHook: "failure-router",
  });
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Full three-tier cascade classifier.
 *
 * Tier 0 (sync regex) → Tier 1 (haiku) → Fallback (needs_orchestrator_judgment)
 *
 * Tier 0 and Tier 1 both short-circuit: once a rule fires or haiku succeeds,
 * we return immediately without touching more expensive tiers.
 */
export async function classifyFailure(opts: {
  failureLog: FailureLog;
  providerClient?: ProviderClient;
}): Promise<ClassifyFailureResult> {
  const { failureLog, providerClient } = opts;

  // ── Tier 0 ──────────────────────────────────────────────────────────────────
  const tier0Result = tier0Classify(failureLog);
  if (tier0Result !== null) {
    const { category, confidence, source } = tier0Result;
    const routing = ROUTING_TABLE[category];
    return {
      category,
      action: routing.action,
      touchesOrchestrator: routing.touchesOrchestrator,
      confidence,
      source,
    };
  }

  // ── Tier 1 — haiku ───────────────────────────────────────────────────────────
  if (providerClient) {
    const haikuResult = await callHaikuClassifier(failureLog, providerClient);
    if (haikuResult.ok) {
      const parsed = parseHaikuResult(haikuResult.data);
      if (parsed !== null && parsed.confidence >= 0.5 && FAILURE_CATEGORIES.includes(parsed.category)) {
        const routing = ROUTING_TABLE[parsed.category];
        return {
          category: parsed.category,
          action: routing.action,
          touchesOrchestrator: routing.touchesOrchestrator,
          confidence: parsed.confidence,
          source: "tier1",
          reason: parsed.reason,
        };
      }
    }
  }

  // ── Fallback ─────────────────────────────────────────────────────────────────
  // Safe default: escalate to opus for genuinely uncertain cases
  const routing = ROUTING_TABLE["needs_orchestrator_judgment"];
  return {
    category: "needs_orchestrator_judgment",
    action: routing.action,
    touchesOrchestrator: routing.touchesOrchestrator,
    confidence: 0.0,
    source: "fallback",
  };
}
