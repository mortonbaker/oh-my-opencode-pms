/**
 * dispatch-judge.ts — Component 3 of the opencode-harness three-tier cascade.
 *
 * Hooks `tool.execute.after` for `task` tool calls (subagent returns).
 * Tier 0: re-execute dispatch's verification commands + schema-validate output + git-diff
 *         check claimed file modifications.
 * Tier 1: LLM-as-judge only when Tier 0 passes but output shape is ambiguous.
 */

import { classify, type ProviderClient } from "./_lib/cheap-classifier";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";

// ── Public types ─────────────────────────────────────────────────────────────

export interface JudgeOpts {
  /** The original dispatch prompt (the orchestrator's `task` tool prompt) */
  dispatchPrompt: string;
  /** The subagent's returned text */
  subagentOutput: string;
  /** Working directory for verification commands and git operations */
  repoRoot: string;
  /** Git SHA before subagent ran — for diff-based file-change verification */
  gitShaBefore: string;
  /** Provider client for Tier 1 calls */
  providerClient?: ProviderClient;
  /** Override execa for testing */
  exec?: ExecFn;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number },
) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type JudgeResult =
  | { result: "passed"; source: "tier0" | "tier1" }
  | {
      result: "failed";
      source: "tier0" | "tier1";
      reason: string;
      failedCommand?: string;
      failedFile?: string;
      failedField?: string;
      commandStderr?: string;
    }
  | { result: "skipped"; source: "tier0"; reason: string }
  | { result: "ambiguous"; source: "tier1"; reason: string };

export interface DispatchSections {
  verificationCommands: string[];
  expectedOutputShape: string;
  successCriteria: string[];
  skipReason?: "read_only" | "research_only" | "prose_only";
}

// ── Tier-1 result schema ─────────────────────────────────────────────────────

interface TierOneJudgeResult {
  criteria_met: boolean;
  failed_criteria_indices: number[];
  confidence: number;
  reason: string;
}

const JUDGE_SCHEMA = `{
  "criteria_met": "boolean",
  "failed_criteria_indices": "array",
  "confidence": "number",
  "reason": "string"
}`;

const JUDGE_SYSTEM_PROMPT = `You are a dispatch judge. Evaluate whether the subagent output meets the success criteria provided.
Return JSON matching the schema exactly. Be strict: only return criteria_met=true if the output clearly satisfies ALL criteria.`;

// ── Section parsing ───────────────────────────────────────────────────────────

/**
 * Split a dispatch prompt into its required sections.
 * Reuse logic shape from criteria-validator.ts but written locally for decoupled design.
 */
export function parseDispatchSections(prompt: string): DispatchSections {
  // Helper to extract a section block - capture until we hit a line that is exactly ## heading
  // We match: heading line + newline + content (lazy, stops at next ## line or end)
  const extractSection = (heading: string): string => {
    // Strategy: find the heading, then capture content line by line
    // A section ends when we encounter a line starting with ## (with possible leading whitespace)
    const lines = prompt.split("\n");
    let inSection = false;
    const sectionLines: string[] = [];

    for (const line of lines) {
      if (!inSection) {
        // Check if this line matches the heading (case-insensitive, with optional whitespace)
        const headingRegex = new RegExp(`^${heading}`, "i");
        if (headingRegex.test(line)) {
          inSection = true;
        }
        continue;
      }

      // Check if this line starts a new section (## followed by word)
      if (/^\s*##\s+\w/.test(line)) {
        break; // we've reached the next section
      }
      sectionLines.push(line);
    }

    const raw = sectionLines.join("\n");
    // Strip fence markers - opening fence line and closing fence line
    return raw
      .replace(/^```[^\n]*\n/, "") // opening fence line at start (incl newline)
      .replace(/\n```[^\n]*\n?$/, "") // closing fence line at end (optional trailing newline)
      .replace(/```[^\n]*$/, "") // closing fence line at end without preceding newline
      .trim();
  };

  const verificationSection = extractSection("##\\s*Verification Commands");
  const expectedOutputShape = extractSection("##\\s*Expected Output Shape");
  const successCriteriaSection = extractSection("##\\s*Success Criteria");

  // Extract checklist bullets from success criteria
  const checkboxes: string[] = [];
  const checkboxRegex = /^- \[[ x]\]\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = checkboxRegex.exec(successCriteriaSection)) !== null) {
    const captured = match[1];
    if (captured) checkboxes.push(captured.trim());
  }

  // Extract shell commands from verification section
  // The verificationSection is already cleaned of fence markers, so split by newlines
  const commands: string[] = [];

  // Try fence extraction first (if fences are still present)
  const fenceRegex = /```(?:sh|bash)?\n([\s\S]*?)\n```/g;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(verificationSection)) !== null) {
    const captured = fenceMatch[1];
    if (captured) {
      const lines = captured.split("\n").filter((l) => l.trim().length > 0);
      commands.push(...lines);
    }
  }

  // If no fenced commands found, treat each line as a command
  if (commands.length === 0 && verificationSection.trim()) {
    const lines = verificationSection.split("\n").filter((l) => l.trim().length > 0);
    commands.push(...lines);
  }

  // Check for skip annotations: verificationCommands: [] paired with read_only/research_only/prose_only
  // Note: we look for the annotation word with word boundaries, but the annotation might be
  // directly attached to text (e.g., "research_only" in a sentence)
  const annotationRegex =
    /verificationCommands:\s*\[\][\s\S]*?\b(read_only|research_only|prose_only)\b/i;
  const annotationMatch = prompt.match(annotationRegex);

  // Fallback: also search for the annotation words directly in case boundary fails
  const lowerPrompt = prompt.toLowerCase();
  let skipReason: "read_only" | "research_only" | "prose_only" | undefined;
  if (annotationMatch) {
    const ann = annotationMatch[1]?.toLowerCase();
    if (ann === "read_only") skipReason = "read_only";
    else if (ann === "research_only") skipReason = "research_only";
    else if (ann === "prose_only") skipReason = "prose_only";
  } else if (lowerPrompt.includes("read_only")) {
    skipReason = "read_only";
  } else if (lowerPrompt.includes("research_only")) {
    skipReason = "research_only";
  } else if (lowerPrompt.includes("prose_only")) {
    skipReason = "prose_only";
  }

  const result: DispatchSections = {
    verificationCommands: commands,
    expectedOutputShape,
    successCriteria: checkboxes,
  };
  if (skipReason) result.skipReason = skipReason;

  return result;
}

// ── File claim extraction ────────────────────────────────────────────────────

/**
 * Extract file paths explicitly claimed as modified/created/edited in subagent output.
 */
export function extractClaimedFiles(subagentOutput: string): string[] {
  const files: string[] = [];
  // Match: "created file foo.ts" or "modified `bar.ts`" or 'wrote "path/go.ts"' etc.
  // Note: longer extensions (tsx, jsx) must come before shorter ones (ts, js) in alternation
  const regex =
    /(?:created|modified|wrote|edited|added)\s+(?:file\s+)?[`"']?([\w/-]+\.(?:tsx|jsx|ts|js|md|json|sh|ps1|rs|py|go|yaml|yml|toml))[`"']?/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(subagentOutput)) !== null) {
    const captured = match[1];
    if (captured) files.push(captured);
  }
  return [...new Set(files)]; // deduplicate
}

// ── Shape field extraction ───────────────────────────────────────────────────

/**
 * Extract field names from "## Expected Output Shape" text.
 * Looks for bullet lines like "- field_name: type" or "* key: value".
 */
export function extractShapeFields(shapeText: string): string[] {
  const fields: string[] = [];
  // Match lines like: "- fieldName: type" or "* keyName: value" at start of line
  const regex = /^[-*]\s+([\w-]+)\s*:/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(shapeText)) !== null) {
    const captured = match[1];
    if (captured) fields.push(captured);
  }
  return fields;
}

// ── Command timeout helper ────────────────────────────────────────────────────

/** Returns milliseconds timeout for a given verification command. */
export function commandTimeoutFor(cmd: string): number {
  const lower = cmd.toLowerCase();
  if (/typescript|tsc/.test(lower)) return 180_000;
  if (/eslint/.test(lower)) return 120_000;
  if (/vitest|jest|test/.test(lower)) return 180_000;
  if (/cargo\s+(test|build)/.test(lower)) return 180_000;
  return 180_000; // default for everything else
}

// ── Text truncation helper ────────────────────────────────────────────────────

const TRUNCATE_MARKER = "\n[... truncated for judge ...]\n";

/** Truncate text to maxChars, inserting a marker if truncation occurred. */
export function truncateForJudge(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATE_MARKER;
}

// ── Tier 0 — deterministic verification ──────────────────────────────────────

async function tier0Judge(opts: JudgeOpts): Promise<{
  passed: boolean;
  result: JudgeResult;
}> {
  const { dispatchPrompt, subagentOutput, repoRoot, exec } = opts;

  // Step 0a — parse dispatch prompt
  const sections = parseDispatchSections(dispatchPrompt);

  // Step 0b — re-run verification commands (unless skip annotation present)
  if (sections.skipReason) {
    return {
      passed: true,
      result: { result: "skipped", source: "tier0", reason: sections.skipReason },
    };
  }

  if (sections.verificationCommands.length > 0 && exec) {
    for (const cmd of sections.verificationCommands) {
      const timeout = commandTimeoutFor(cmd);
      try {
        // Parse command string into cmd + args
        const parts = cmd.trim().split(/\s+/);
        const actualCmd = parts[0] ?? cmd;
        const args = parts.slice(1);

        const runResult = await exec(actualCmd, args, {
          cwd: repoRoot,
          timeout,
        });

        if (runResult.exitCode !== 0) {
          return {
            passed: false,
            result: {
              result: "failed",
              source: "tier0",
              reason: `command_failed:${cmd}`,
              failedCommand: cmd,
              commandStderr: runResult.stderr,
            },
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          passed: false,
          result: {
            result: "failed",
            source: "tier0",
            reason: `command_failed:${cmd}`,
            failedCommand: cmd,
            commandStderr: msg,
          },
        };
      }
    }
  }

  // Step 0c — git diff check claimed file changes
  if (exec) {
    const claimedFiles = extractClaimedFiles(subagentOutput);
    for (const file of claimedFiles) {
      // Check if file is modified (exit 1 = changed, exit 0 = unchanged)
      const diffResult = await exec("git", ["diff", "--quiet", "HEAD", "--", file], {
        cwd: repoRoot,
        timeout: 30_000,
      });
      if (diffResult.exitCode === 0) {
        // File is unchanged — this is a hallucination
        return {
          passed: false,
          result: {
            result: "failed",
            source: "tier0",
            reason: `claimed_file_unchanged:${file}`,
            failedFile: file,
          },
        };
      }

      // Also verify file appears in git status (covers untracked/created files)
      const statusResult = await exec(
        "git",
        ["status", "--porcelain", "--", file],
        { cwd: repoRoot, timeout: 30_000 },
      );
      if (statusResult.exitCode !== 0 && statusResult.stdout.trim() === "") {
        // File not in git status at all — may be hallucinated
        return {
          passed: false,
          result: {
            result: "failed",
            source: "tier0",
            reason: `claimed_file_unchanged:${file}`,
            failedFile: file,
          },
        };
      }
    }
  }

  // Step 0d — schema/shape sanity check
  const shapeFields = extractShapeFields(sections.expectedOutputShape);
  if (shapeFields.length > 0) {
    // Check that all field names appear in subagent output (case-insensitive)
    const outputLower = subagentOutput.toLowerCase();
    for (const field of shapeFields) {
      if (!outputLower.includes(field.toLowerCase())) {
        return {
          passed: false,
          result: {
            result: "failed",
            source: "tier0",
            reason: `missing_field:${field}`,
            failedField: field,
          },
        };
      }
    }
  }

  return { passed: true, result: { result: "passed", source: "tier0" } };
}

// ── Tier 1 — LLM-as-judge ─────────────────────────────────────────────────────

async function tier1Judge(
  opts: JudgeOpts,
  sections: DispatchSections,
): Promise<JudgeResult> {
  const { subagentOutput, providerClient } = opts;

  if (!providerClient) {
    return {
      result: "ambiguous",
      source: "tier1",
      reason: "no provider client available for Tier 1 evaluation",
    };
  }

  const truncatedOutput = truncateForJudge(subagentOutput, 4000);

  const input = `Success Criteria:
${sections.successCriteria.map((c) => `- [ ] ${c}`).join("\n")}

Subagent Output:
${truncatedOutput}`;

  const result = await classify<TierOneJudgeResult>({
    input,
    schema: JUDGE_SCHEMA,
    systemPromptOverride: JUDGE_SYSTEM_PROMPT,
    providerClient,
  });

  if (!result.ok) {
    return {
      result: "ambiguous",
      source: "tier1",
      reason: `classifier call failed: ${result.error}`,
    };
  }

  const data = result.data;

  if (data.confidence < 0.5) {
    return {
      result: "ambiguous",
      source: "tier1",
      reason: `low confidence (${data.confidence}): ${data.reason}`,
    };
  }

  if (!data.criteria_met) {
    const failedCriteria = data.failed_criteria_indices
      .map((i) => sections.successCriteria[i] ?? `index ${i}`)
      .join(", ");
    return {
      result: "failed",
      source: "tier1",
      reason: `criteria not met: ${failedCriteria}. ${data.reason}`,
    };
  }

  return { result: "passed", source: "tier1" };
}

// ── Main judge function ───────────────────────────────────────────────────────

/**
 * Judge a subagent dispatch result.
 *
 * Tier 0: deterministic verification (command re-run, git diff, shape check)
 * Tier 1: LLM-as-judge (only when Tier 0 passed but shape ambiguous)
 */
export async function judgeDispatch(opts: JudgeOpts): Promise<JudgeResult> {
  const sections = parseDispatchSections(opts.dispatchPrompt);

  // Run Tier 0
  const tier0 = await tier0Judge(opts);

  // If Tier 0 already failed, do NOT call Tier 1 (cost discipline)
  if (!tier0.passed) {
    return tier0.result;
  }

  // If Tier 0 skipped (read_only / research_only / prose_only), return early
  if (tier0.result.result === "skipped") {
    return tier0.result;
  }

  // Tier 0 passed — check if shape is ambiguous (no extractable fields)
  const shapeFields = extractShapeFields(sections.expectedOutputShape);
  const shapeAmbiguous = shapeFields.length === 0;

  if (shapeAmbiguous) {
    // Only call Tier 1 when Tier 0 passed but shape is ambiguous
    return tier1Judge(opts, sections);
  }

  // Tier 0 passed and shape is not ambiguous (has extractable fields)
  // All deterministic checks passed
  return tier0.result;
}

// ── Hook factory for PMS integration ─────────────────────────────────────────

export function createDispatchJudgeHook(ctx: PluginInput) {
  const providerClient = ctx.client as unknown as ProviderClient | undefined;
  return {
    "tool.execute.after": async (
      input: { tool: string; args?: Record<string, unknown> },
      output: { output: unknown },
    ) => {
      if (input.tool !== "task") return;
      const args = input.args;
      if (!args || typeof args !== "object") return;

      const dispatchPrompt = args.prompt as string | undefined;
      if (!dispatchPrompt) return;

      const resultObj = output.output;
      let subagentOutput = "";
      if (typeof resultObj === "string") {
        subagentOutput = resultObj;
      } else if (resultObj && typeof resultObj === "object") {
        const obj = resultObj as Record<string, unknown>;
        subagentOutput =
          (obj.output as string) ?? (obj.text as string) ?? JSON.stringify(obj);
      }

      const gitShaBefore = (args.git_sha_before as string) ?? "HEAD";
      const repoRoot = (args.repo_root as string) ?? ".";

      const judgeResult = await judgeDispatch({
        dispatchPrompt,
        subagentOutput,
        repoRoot,
        gitShaBefore,
        ...(providerClient ? { providerClient } : {}),
      });

      if (judgeResult.result === "failed") {
        let reminder = `<system-reminder>Dispatch judge found issue: ${judgeResult.reason}`;
        if (judgeResult.failedCommand) reminder += ` | Command: ${judgeResult.failedCommand}`;
        if (judgeResult.failedFile) reminder += ` | File: ${judgeResult.failedFile}`;
        if (judgeResult.failedField) reminder += ` | Field: ${judgeResult.failedField}`;
        if (judgeResult.commandStderr) reminder += ` | Stderr: ${judgeResult.commandStderr.slice(0, 200)}`;
        reminder += `</system-reminder>`;

        const out = output.output;
        output.output =
          typeof out === "string" ? out + "\n" + reminder : reminder;
      }
    },
  };
}
