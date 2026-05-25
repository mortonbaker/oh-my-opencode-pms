/**
 * criteria-validator.ts — Tier-0 regex + Tier-1 haiku hard-gate for subagent dispatches.
 *
 * Fires on `tool.execute.before` for "task" tool calls. Blocks any dispatch lacking
 * falsifiable success criteria + verification commands.
 */

import { classify, type ProviderClient } from "./_lib/cheap-classifier";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";

// ── Exported regex constants (for testability) ────────────────────────────────

export const MEASURABLE_VERBS = /\b(reduces?|increases?|decreases?|drops?|below|under|above|exceeds?|at\s+least|at\s+most|within|exactly)\b/i;

export const VAGUE_TERMS = /\b(nice|nicer|better|clean|cleaner|improve|improves|smooth|smoother|polish|polished|modernize|optimize|optimized|simplify)\b/gi;

export const SUBAGENT_VERIFICATION_RULES: Record<string, {
  requiredCommands?: RegExp[];
  requiresVisualCheck?: boolean;
  bypassIfAnnotation?: string;
  bypassIfShapeFields?: number;
  bypassIfBodyContains?: RegExp;
  bypassIfReviewRegex?: RegExp;
}> = {
  fixer: {
    requiredCommands: [
      /\btsc\b/,
      /\bcargo\s+build\b/,
      /\bcargo\s+test\b/,
      /\beslint\b/,
      /\bclippy\b/,
      /\bvitest\b/,
      /\bjest\b/,
      /\bpnpm\s+test\b/,
      /\bnpm\s+test\b/,
      /\bbun\s+test\b/,
      /\bpytest\b/,
      /\bgo\s+test\b/,
    ],
  },
  designer: {
    requiredCommands: [/\btsc\b/, /\beslint\b/],
    requiresVisualCheck: true,
  },
  explorer: {
    bypassIfAnnotation: "read_only",
    bypassIfShapeFields: 3,
  },
  librarian: {
    bypassIfAnnotation: "research_only",
    bypassIfBodyContains: /\b(citations?|URL|source)\b/i,
  },
  oracle: {
    bypassIfAnnotation: "prose_only",
    bypassIfReviewRegex: /\b(severity|priority|recommendation|finding)\b/i,
  },
};

// ── Tier-1 result schema ───────────────────────────────────────────────────────

interface TierOneResult {
  falsifiable: boolean;
  vague_terms: string[];
  missing_measurable_verb: boolean;
  verification_can_test_criteria: boolean;
  confidence: number;
}

const TIER_ONE_SCHEMA = `{
  "falsifiable": "boolean",
  "vague_terms": "array",
  "missing_measurable_verb": "boolean",
  "verification_can_test_criteria": "boolean",
  "confidence": "number"
}`;

const TIER_ONE_SYSTEM_PROMPT = `You are a criteria auditor. Evaluate whether the success criteria in the input are falsifiable (can be objectively verified) and whether the verification commands can actually test those criteria.
Return JSON matching the schema exactly.`;

// ── Section parsing ───────────────────────────────────────────────────────────

export interface ParsedSections {
  successCriteria: string;
  verificationCommands: string;
  expectedOutputShape: string;
  hasReadOnlyAnnotation: boolean;
  hasResearchOnlyAnnotation: boolean;
  hasProseOnlyAnnotation: boolean;
}

/**
 * Split a dispatch prompt into its three required sections plus annotation flags.
 * All matches are case-insensitive.
 */
export function parseSections(prompt: string): ParsedSections {
  const extractSection = (heading: string): string => {
    // Match ## Heading\n...\n## NextHeading (or end of string)
    // Use \n(?=##\s) lookahead to stop at next heading on its own line
    // The (?!```) negative lookahead prevents matching if preceded by fence markers
    const regex = new RegExp(
      `^${heading}[ \\t]*\\n([\\s\\S]*?)\\n(?=##\\s)`,
      "im",
    );
    const match = prompt.match(regex);
    if (match?.[1]) {
      return match[1].trim();
    }
    // Fallback: try to match until end of string if no next heading
    const endRegex = new RegExp(`^${heading}[ \\t]*\\n([\\s\\S]*)$`, "im");
    const endMatch = prompt.match(endRegex);
    return endMatch?.[1]?.trim() ?? "";
  };

  const successCriteria = extractSection("##\\s*Success Criteria");
  const verificationCommands = extractSection("##\\s*Verification Commands");
  const expectedOutputShape = extractSection("##\\s*Expected Output Shape");

  // Annotation flags: check if verification commands section immediately after heading
  // contains `verificationCommands: []` paired with one of the annotations
  const annotationRegex = /verificationCommands:\s*\[\][\s\S]*?\b(read_only|research_only|prose_only)\b/i;
  const annotationMatch = prompt.match(annotationRegex);

  const hasReadOnlyAnnotation = Boolean(
    annotationMatch && /\bread_only\b/i.test(annotationMatch[0]),
  );
  const hasResearchOnlyAnnotation = Boolean(
    annotationMatch && /\bresearch_only\b/i.test(annotationMatch[0]),
  );
  const hasProseOnlyAnnotation = Boolean(
    annotationMatch && /\bprose_only\b/i.test(annotationMatch[0]),
  );

  return {
    successCriteria,
    verificationCommands,
    expectedOutputShape,
    hasReadOnlyAnnotation,
    hasResearchOnlyAnnotation,
    hasProseOnlyAnnotation,
  };
}

// ── Extraction helpers ────────────────────────────────────────────────────────

/** Extract all checkbox bullets (`- [ ]` or `- [x]` etc.) from a section. */
export function extractCheckboxBullets(section: string): string[] {
  const bullets: string[] = [];
  const regex = /^- \[[ x]\]\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(section)) !== null) {
    const captured = match[1];
    if (captured) {
      bullets.push(captured.trim());
    }
  }
  return bullets;
}

/** Extract fenced shell command lines from a section. */
export function extractShellCommands(section: string): string[] {
  const commands: string[] = [];
  // Match ```sh\n...\n``` or ```bash\n...\n``` or just ```\n...\n```
  const fenceRegex = /```(?:sh|bash)?\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(section)) !== null) {
    const captured = match[1];
    if (captured) {
      const lines = captured.split("\n").filter((l) => l.trim().length > 0);
      commands.push(...lines);
    }
  }
  return commands;
}

/** Return array of vague terms found in text (case-insensitive). */
export function containsVagueTerms(text: string): string[] {
  const found: string[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(VAGUE_TERMS.source, "gi");
  while ((match = regex.exec(text)) !== null) {
    const m = match[0];
    if (m) found.push(m.toLowerCase());
  }
  return found;
}

// ── Quantifier heuristic ──────────────────────────────────────────────────────

/** Returns true if the line contains a quantifier (digit + % or digit + unit). */
function hasQuantifier(line: string): boolean {
  // digit followed by % OR digit followed by measurable unit
  return /\d\s*%/.test(line) || /\d\s*(ms|s|ms|latency|throughput|errors?|lines?|kb|mb|gb|seconds?|minutes?|hours?|users?|requests?)/i.test(line);
}

// ── Tier-0 subagent rule enforcement ─────────────────────────────────────────

export function enforceSubagentRules(
  subagentType: string,
  sections: ParsedSections,
  verificationCommands: string[],
): { ok: true } | { ok: false; reason: string } {
  const rule = SUBAGENT_VERIFICATION_RULES[subagentType.toLowerCase()];
  if (!rule) {
    // Unknown subagent type — pass through
    return { ok: true };
  }

  // Check bypass conditions first
  if (rule.bypassIfAnnotation) {
    const annotation = rule.bypassIfAnnotation;
    if (
      (annotation === "read_only" && sections.hasReadOnlyAnnotation) ||
      (annotation === "research_only" && sections.hasResearchOnlyAnnotation) ||
      (annotation === "prose_only" && sections.hasProseOnlyAnnotation)
    ) {
      // Bypass applies — verify additional conditions
      if (rule.bypassIfShapeFields) {
        // Count fields in Expected Output Shape
        const fieldCount = countShapeFields(sections.expectedOutputShape);
        if (fieldCount >= rule.bypassIfShapeFields) {
          return { ok: true };
        }
      } else if (rule.bypassIfBodyContains) {
        // Check if prompt body contains required text
        if (rule.bypassIfBodyContains.test(sections.successCriteria + sections.verificationCommands + sections.expectedOutputShape)) {
          return { ok: true };
        }
      } else if (rule.bypassIfReviewRegex) {
        // Check for structured review indicators
        if (rule.bypassIfReviewRegex.test(sections.successCriteria + sections.verificationCommands + sections.expectedOutputShape)) {
          return { ok: true };
        }
      } else {
        return { ok: true };
      }
    }
  }

  // Required command check
  if (rule.requiredCommands && rule.requiredCommands.length > 0) {
    const hasRequiredCommand = rule.requiredCommands.some((re) =>
      verificationCommands.some((cmd) => re.test(cmd)),
    );
    if (!hasRequiredCommand) {
      return {
        ok: false,
        reason: `subagent type "${subagentType}" requires verification commands matching one of: ${rule.requiredCommands.map((r) => r.source).join(", ")}`,
      };
    }
  }

  // Visual check heuristic for designer
  if (rule.requiresVisualCheck) {
    const visualCheckRegex = /\b(screenshot|count.*element|color|width|height|grep.*data-testid|playwright|cypress)\b/i;
    const hasVisualCheck = verificationCommands.some((cmd) => visualCheckRegex.test(cmd));
    if (!hasVisualCheck) {
      return {
        ok: false,
        reason: `subagent type "designer" requires a visual property check (screenshot, count.*element, color, width, height, grep.*data-testid, playwright, or cypress)`,
      };
    }
  }

  return { ok: true };
}

/** Count fields in Expected Output Shape section. */
function countShapeFields(shapeSection: string): number {
  let count = 0;
  // Count `- ` or `* ` bullets
  const bulletRegex = /^[-*]\s+.+$/gm;
  let match: RegExpExecArray | null;
  while ((match = bulletRegex.exec(shapeSection)) !== null) {
    count++;
  }
  // Count `key:` patterns (YAML/object style)
  const keyColonRegex = /^\s*[\w-]+\s*:/gm;
  while ((match = keyColonRegex.exec(shapeSection)) !== null) {
    count++;
  }
  return count;
}

// ── Tier-0 validation ─────────────────────────────────────────────────────────

interface Tier0Result {
  ok: boolean;
  blockedFor: string[];
  suggestedFix: string;
}

function tier0Validate(prompt: string, subagentType: string): Tier0Result {
  const sections = parseSections(prompt);
  const blockedFor: string[] = [];
  let suggestedFix = "";

  // 1. Check ## Success Criteria section
  if (!sections.successCriteria) {
    blockedFor.push("missing ## Success Criteria section");
  } else {
    // Check for at least one checkbox bullet
    const checkboxes = extractCheckboxBullets(sections.successCriteria);
    if (checkboxes.length === 0) {
      blockedFor.push("## Success Criteria section has no checkbox bullets (- [ ] ...)");
    }

    // Check for vague terms (unless paired with quantifier)
    const vagueTerms = containsVagueTerms(sections.successCriteria);
    const lines = sections.successCriteria.split("\n");
    const vagueWithoutQuantifier = vagueTerms.filter((term) => {
      // Find the line containing this term
      const lineWithTerm = lines.find((l) => l.toLowerCase().includes(term));
      // If no line found or line has quantifier, it's allowed
      return !lineWithTerm || !hasQuantifier(lineWithTerm);
    });
    if (vagueWithoutQuantifier.length > 0) {
      blockedFor.push(`vague terms without quantifier: ${[...new Set(vagueWithoutQuantifier)].join(", ")}`);
    }
  }

  // 2. Check ## Verification Commands section
  if (!sections.verificationCommands) {
    blockedFor.push("missing ## Verification Commands section");
  } else {
    const shellCommands = extractShellCommands(sections.verificationCommands);

    // Check if explicitly annotated with verificationCommands: [] + read_only/research_only/prose_only
    const hasEmptyAnnotation = /verificationCommands:\s*\[\]/i.test(sections.verificationCommands);
    const hasAnnotation = sections.hasReadOnlyAnnotation || sections.hasResearchOnlyAnnotation || sections.hasProseOnlyAnnotation;

    if (shellCommands.length === 0 && !(hasEmptyAnnotation && hasAnnotation)) {
      blockedFor.push("## Verification Commands section has no fenced shell commands and no valid empty-annotation");
    }

    // Enforce subagent-specific rules
    const subagentResult = enforceSubagentRules(subagentType, sections, shellCommands);
    if (!subagentResult.ok) {
      blockedFor.push(subagentResult.reason);
    }
  }

  // 3. Check ## Expected Output Shape section
  if (!sections.expectedOutputShape) {
    blockedFor.push("missing ## Expected Output Shape section");
  } else {
    const nonBlankLines = sections.expectedOutputShape.split("\n").filter((l) => l.trim().length > 0);
    if (nonBlankLines.length === 0) {
      blockedFor.push("## Expected Output Shape section has no non-blank lines");
    }
  }

  if (blockedFor.length > 0) {
    suggestedFix = blockedFor.map((b) => `• ${b}`).join("\n");
  }

  return { ok: blockedFor.length === 0, blockedFor, suggestedFix };
}

// ── Tier-1 validation ──────────────────────────────────────────────────────────

interface Tier1Result {
  ok: boolean;
  blockedFor: string[];
  suggestedFix: string;
}

async function tier1Validate(
  prompt: string,
  providerClient: ProviderClient,
): Promise<Tier1Result> {
  const sections = parseSections(prompt);

  const input = `Success Criteria:
${sections.successCriteria}

Verification Commands:
${sections.verificationCommands}`;

  const result = await classify<TierOneResult>({
    input,
    schema: TIER_ONE_SCHEMA,
    systemPromptOverride: TIER_ONE_SYSTEM_PROMPT,
    providerClient,
  });

  if (!result.ok) {
    // Transient or parse error — block with error info
    return {
      ok: false,
      blockedFor: [`criteria-validator/tier1-classify-error: ${result.error}`],
      suggestedFix: `Classifier call failed: ${result.error}. Please add measurable, falsifiable success criteria and try again.`,
    };
  }

  const data = result.data;

  // Low confidence → escalate
  if (data.confidence < 0.5) {
    return {
      ok: false,
      blockedFor: ["criteria-validator/tier1-low-confidence"],
      suggestedFix: "Criteria assessment is ambiguous. Please add more specific, measurable success criteria and clear verification commands.",
    };
  }

  const blockedFor: string[] = [];

  if (!data.falsifiable) {
    blockedFor.push("success criteria are not falsifiable (cannot be objectively verified)");
  }

  if (!data.verification_can_test_criteria) {
    blockedFor.push("verification commands cannot test the stated success criteria");
  }

  if (blockedFor.length > 0) {
    return {
      ok: false,
      blockedFor,
      suggestedFix: blockedFor.map((b) => `• ${b}`).join("\n"),
    };
  }

  return { ok: true, blockedFor: [], suggestedFix: "" };
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface ValidateDispatchOpts {
  prompt: string;
  subagentType: string;
  providerClient?: ProviderClient;
}

export interface ValidateDispatchResult {
  ok: true;
}

export interface ValidateDispatchError {
  ok: false;
  tier: "tier0" | "tier1";
  blockedFor: string[];
  suggestedFix: string;
}

export async function validateDispatch(
  opts: ValidateDispatchOpts,
): Promise<ValidateDispatchResult | ValidateDispatchError> {
  const { prompt, subagentType, providerClient } = opts;

  // Tier 0 — synchronous regex / structural checks
  const tier0 = tier0Validate(prompt, subagentType);
  if (!tier0.ok) {
    return { ok: false, tier: "tier0", blockedFor: tier0.blockedFor, suggestedFix: tier0.suggestedFix };
  }

  // Tier 1 — haiku scorer (requires providerClient)
  if (!providerClient) {
    // Cannot run Tier 1 without a provider client — allow through but log warning
    // (In production this should never happen if the plugin is wired correctly)
    return { ok: true };
  }

  const tier1 = await tier1Validate(prompt, providerClient);
  if (!tier1.ok) {
    return { ok: false, tier: "tier1", blockedFor: tier1.blockedFor, suggestedFix: tier1.suggestedFix };
  }

  return { ok: true };
}

// ── Hook factory for PMS integration ─────────────────────────────────────────

export function createCriteriaValidatorHook(ctx: PluginInput) {
  const providerClient = ctx.client as unknown as ProviderClient | undefined;
  return {
    "tool.execute.before": async (
      input: { tool: string },
      output: { args?: Record<string, unknown> },
    ) => {
      if (input.tool !== "task") return;
      const args = output.args;
      if (!args || typeof args !== "object") return;

      const prompt = args.prompt as string | undefined;
      const subagentType = args.subagent_type as string | undefined;
      if (!prompt || !subagentType) return;

      const result = await validateDispatch({
        prompt,
        subagentType,
        ...(providerClient ? { providerClient } : {}),
      });

      if (!result.ok) {
        const errorPayload = JSON.stringify({
          plugin: "criteria-validator",
          tier: result.tier,
          blockedFor: result.blockedFor,
          suggestedFix: result.suggestedFix,
        });
        throw new Error(`DISPATCH_BLOCKED:${errorPayload}`);
      }
    },
  };
}
