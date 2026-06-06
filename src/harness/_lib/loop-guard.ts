/**
 * loop-guard.ts — deterministic harness-owned recursion defense.
 *
 * Solves the bug class confirmed twice on 2026-05-28:
 *   - 20:36 cascade: parallel-detector re-firing on cheap-classifier sessions
 *     (1,574 sessions / 4 min, fixed by 0c56ae7)
 *   - 21:19 cascade: orchestrator quoting classifier rejections back into
 *     its retry context, causing parallel-detector to wrap again
 *     (1,667 sessions / 4 min, fixed by dfd9d51)
 *
 * Canonical pattern: provenance markers (Auto-Submitted email loop pattern,
 * RFC 3834) using opencode's existing session IDs as the idempotency key
 * namespace (Stripe-idempotency pattern). Plus TTL/hop count (IP TTL, RFC
 * 791) as a content-mutation-resistant backstop.
 *
 * Design principle: the HARNESS owns these markers. We emit them, we read
 * them. The LLM is never trusted to preserve, paraphrase, or reason about
 * them — it just passes the tags through verbatim (which LLMs reliably do
 * for opaque HTML-shaped tokens). All loop-detection logic runs in
 * deterministic code on the message stream both directions.
 *
 * Every guard trip emits a structured `[HARNESS-LOOP-GUARD]` line — single
 * line, grep-able, includes a process-lifetime evidence counter so an
 * occasional false positive is visibly different from a cascading failure.
 */

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// ── Harness-mark tag (Pattern 2/3 — provenance marker using session IDs) ──

/**
 * Wrapping element name for harness-injected content. Distinctive enough
 * that any text containing `<harness-mark` is almost certainly a previous
 * harness injection being quoted back at us.
 */
export const HARNESS_MARK_TAG_NAME = "harness-mark";

/**
 * Wrap `content` in a `<harness-mark>` element with deterministic
 * provenance attributes. Output is the only authoritative way to inject
 * text into orchestrator context that downstream guards can recognize.
 *
 *   emitHarnessMark({
 *     hook: 'parallel-detector',
 *     sourceSession: 'ses_xyz',
 *     content: 'PARALLELIZATION DETECTED (...)',
 *   })
 *   →  <harness-mark hook="parallel-detector" source-session="ses_xyz"
 *        emitted-at="1780021200000">PARALLELIZATION DETECTED (...)</harness-mark>
 */
export function emitHarnessMark(args: {
  hook: string;
  sourceSession?: string;
  content: string;
}): string {
  const attrs = [`hook="${escapeAttr(args.hook)}"`];
  if (args.sourceSession) {
    attrs.push(`source-session="${escapeAttr(args.sourceSession)}"`);
    recordHarnessEmission(args.sourceSession, args.hook);
  }
  attrs.push(`emitted-at="${Date.now()}"`);
  return `<${HARNESS_MARK_TAG_NAME} ${attrs.join(" ")}>${args.content}</${HARNESS_MARK_TAG_NAME}>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Parse all `<harness-mark>` elements out of `text`. Returns the
 * structured metadata for each. Robust to quoting variants (the LLM may
 * re-emit tags inside its own response; we still recognize them).
 */
export interface HarnessMark {
  hook: string;
  sourceSession?: string;
  emittedAt?: number;
  /** The content between the opening and closing tag. */
  content: string;
}

const HARNESS_MARK_REGEX = new RegExp(
  `<${HARNESS_MARK_TAG_NAME}\\s+([^>]*)>([\\s\\S]*?)<\\/${HARNESS_MARK_TAG_NAME}>`,
  "g",
);
const ATTR_REGEX = /([a-zA-Z-]+)="([^"]*)"/g;

export function extractHarnessMarks(text: string): HarnessMark[] {
  const marks: HarnessMark[] = [];
  let m: RegExpExecArray | null;
  // Reset state for global regex
  HARNESS_MARK_REGEX.lastIndex = 0;
  while ((m = HARNESS_MARK_REGEX.exec(text)) !== null) {
    const attrText = m[1] ?? "";
    const content = m[2] ?? "";
    const attrs: Record<string, string> = {};
    let am: RegExpExecArray | null;
    ATTR_REGEX.lastIndex = 0;
    while ((am = ATTR_REGEX.exec(attrText)) !== null) {
      attrs[am[1]!] = am[2]!;
    }
    if (typeof attrs.hook === "string") {
      const mark: HarnessMark = { hook: attrs.hook, content };
      if (attrs["source-session"]) mark.sourceSession = attrs["source-session"];
      if (attrs["emitted-at"]) {
        const n = Number(attrs["emitted-at"]);
        if (Number.isFinite(n)) mark.emittedAt = n;
      }
      marks.push(mark);
    }
  }
  return marks;
}

/**
 * True if `text` contains at least one `<harness-mark>` tag (any hook).
 * Fast pre-check — callers that don't need the parsed metadata should use
 * this before reaching for extractHarnessMarks.
 */
export function containsHarnessMark(text: string): boolean {
  return text.includes(`<${HARNESS_MARK_TAG_NAME} `);
}

// ── Source-session registry ───────────────────────────────────────────────

/**
 * Process-lifetime record of every session ID we've ever emitted a
 * harness-mark for. Bounded by HARNESS_EMISSION_MAX_ENTRIES — older entries
 * are pruned on insertion (cheap LRU-ish; we don't need strict LRU).
 *
 * This lets a guard ask "did any prior turn's harness output come from
 * this session ID?" which is what catches the quoted-retry case: the
 * orchestrator quotes the harness-mark verbatim, the tag still names the
 * original source session, and we recognize it.
 */
interface EmissionRecord {
  hook: string;
  emittedAt: number;
}

const HARNESS_EMISSION_MAX_ENTRIES = 10_000;
const harnessEmittedSessions = new Map<string, EmissionRecord>();

export function recordHarnessEmission(sessionId: string, hook: string): void {
  if (harnessEmittedSessions.size >= HARNESS_EMISSION_MAX_ENTRIES) {
    // Drop the oldest insertion (Map iteration is insertion order).
    const oldestKey = harnessEmittedSessions.keys().next().value;
    if (oldestKey) harnessEmittedSessions.delete(oldestKey);
  }
  harnessEmittedSessions.set(sessionId, { hook, emittedAt: Date.now() });
}

export function isKnownHarnessSourceSession(sessionId: string): boolean {
  return harnessEmittedSessions.has(sessionId);
}

/** Test-only escape hatch. Do not call from production paths. */
export function _resetHarnessEmissionsForTests(): void {
  harnessEmittedSessions.clear();
}

// ── Content-hash idempotency cache (Pattern 3 — Stripe idempotency) ───────

/**
 * Cache of recent classify() results keyed by sha256(input). If a classify
 * call comes in with the same input we just processed, return the cached
 * result instead of spending another LLM round-trip. Catches the case
 * where the orchestrator retries verbatim AND the case where two
 * concurrent task dispatches happen to classify the same payload.
 */
const IDEMPOTENCY_TTL_MS = 30_000;
const IDEMPOTENCY_MAX_ENTRIES = 1_000;
const idempotencyCache = new Map<
  string,
  { result: unknown; cachedAt: number }
>();

export function hashClassifyInput(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function idempotencyLookup<T>(key: string): T | null {
  const entry = idempotencyCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(key);
    return null;
  }
  return entry.result as T;
}

export function idempotencyStore<T>(key: string, result: T): void {
  if (idempotencyCache.size >= IDEMPOTENCY_MAX_ENTRIES) {
    const oldest = idempotencyCache.keys().next().value;
    if (oldest) idempotencyCache.delete(oldest);
  }
  idempotencyCache.set(key, { result, cachedAt: Date.now() });
}

/** Test-only. */
export function _resetIdempotencyCacheForTests(): void {
  idempotencyCache.clear();
}

// ── Structured loud-log on every gate trip ────────────────────────────────

/**
 * Layer identifier for the trip log. Numbers match the plan agreed with
 * operator 2026-05-28: 1=TTL, 2=provenance-marker, 3=idempotency-cache,
 * 4=rate-limit. Logs are grep-able as `[HARNESS-LOOP-GUARD] layer=N`.
 */
export type GuardLayer = 1 | 2 | 3 | 4;

const evidenceCounters: Record<GuardLayer, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };

export function getEvidenceCounter(layer: GuardLayer): number {
  return evidenceCounters[layer];
}

/** Test-only. */
export function _resetEvidenceCountersForTests(): void {
  evidenceCounters[1] = 0;
  evidenceCounters[2] = 0;
  evidenceCounters[3] = 0;
  evidenceCounters[4] = 0;
}

export interface TripContext {
  layer: GuardLayer;
  hook: string;
  tripReason: string;
  orchestratorSession?: string;
  sourceSession?: string;
  turnId?: string;
  depth?: number;
  rateWindowCount?: number;
  contentPreview?: string;
}

/**
 * Emit a single-line structured log on every guard trip. Goes to stderr
 * (captured by journalctl AND opencode log). The `[HARNESS-LOOP-GUARD]`
 * prefix is the only string callers need to remember for filtering.
 *
 *   journalctl --user -u opencode-web.service -f | grep HARNESS-LOOP-GUARD
 *
 * Format invariants:
 *   - Single line, no embedded newlines (content-preview is truncated +
 *     newlines stripped).
 *   - Every field is `key=value` for trivial parsing.
 *   - evidence-counter accumulates per process so 1 trip vs 100 trips/min
 *     is visibly distinguishable in the log stream.
 */
export function tripLoopGuard(ctx: TripContext): void {
  evidenceCounters[ctx.layer] += 1;
  const fields: string[] = [
    `layer=${ctx.layer}`,
    `hook=${ctx.hook}`,
    `trip-reason="${escapeLogValue(ctx.tripReason)}"`,
    `evidence-counter=${evidenceCounters[ctx.layer]}`,
  ];
  if (ctx.orchestratorSession)
    fields.push(`orchestrator-session=${ctx.orchestratorSession}`);
  if (ctx.sourceSession) fields.push(`source-session=${ctx.sourceSession}`);
  if (ctx.turnId) fields.push(`turn-id=${ctx.turnId}`);
  if (typeof ctx.depth === "number") fields.push(`depth=${ctx.depth}`);
  if (typeof ctx.rateWindowCount === "number")
    fields.push(`rate-window-count=${ctx.rateWindowCount}`);
  if (ctx.contentPreview) {
    const trimmed = ctx.contentPreview
      .replace(/[\r\n]+/g, " ")
      .slice(0, 200);
    fields.push(`content-preview="${escapeLogValue(trimmed)}"`);
  }
  // 2026-05-28 empirical finding: opencode's plugin runtime swallows
  // console.warn/console.error output — it reaches NEITHER journalctl
  // NOR opencode's own log file. We bypass that by appending directly to
  // a file every harness writer can grep. console.warn is kept as a
  // best-effort secondary (in case future opencode versions surface it).
  const line = `[HARNESS-LOOP-GUARD] ${new Date().toISOString()} ${fields.join(" ")}\n`;
  try {
    appendFileSync("/tmp/harness-loop-guard.log", line);
  } catch {
    // Swallow file errors — never let logging break the guard path.
  }
  console.warn(line.trimEnd());
}

function escapeLogValue(s: string): string {
  return s.replace(/"/g, "\\\"");
}
