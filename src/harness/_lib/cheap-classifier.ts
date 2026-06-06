/**
 * cheap-classifier.ts — shared Tier-1 SLM client used by all four cascade plugins.
 *
 * The pattern: every cascade plugin (parallel-detector, criteria-validator,
 * dispatch-judge, failure-router) follows Tier-0-regex → Tier-1-haiku → Tier-2-orchestrator.
 * Tier 1 is THIS classifier. Single haiku-4-5 call, JSON-only output, ~$0.0001/call.
 *
 * Caller passes:
 *   - the input to classify
 *   - the JSON schema the haiku must satisfy
 *   - optional system-prompt override (default: locked classifier prompt)
 *
 * We return:
 *   - on parse success: { ok: true, data: <parsed JSON matching schema> }
 *   - on parse fail: { ok: false, error: "<reason>", raw: "<raw text>" }
 *   - on rate-limit/transient: { ok: false, error: "transient", raw, retryable: true }
 *
 * The classifier NEVER throws. Callers MUST handle ok=false.
 *
 * Cost-aware: this is the cheapest tier. If it fails, we don't retry haiku — we
 * either fall through to deterministic fallback (caller's choice) or escalate
 * to the orchestrator. NEVER call this in a loop expecting it to "eventually work".
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  containsHarnessMark,
  hashClassifyInput,
  idempotencyLookup,
  idempotencyStore,
  tripLoopGuard,
} from "./loop-guard";

// ── Recursion guard ──────────────────────────────────────────────────────

/**
 * Session IDs of cheap-classifier sessions currently in flight inside this
 * process. Populated immediately after `client.session.create` and removed
 * after `client.session.delete` (or on failure path).
 *
 * Other plugin hooks — most importantly `experimental.chat.messages.transform`
 * in src/index.ts — MUST consult this set and skip work for any message whose
 * `info.sessionID` is in it. Without that guard, parallel-detector fires on
 * the cheap-classifier session it just created, calls classify() again, and
 * recurses unbounded until the wrapped prompt blows the model context.
 *
 * Receipt: opencode.db sessions ses_18ea006b5ffebIQ13LexxW5fpo (2026-05-28
 * 20:36), 1,574 cheap-classifier rows burst-spawned in 4 minutes from a
 * single Team-Pulse `task` dispatch.
 *
 * Process-local. Sessions are only ever accessed through their owning
 * provider call, so cross-process visibility isn't required.
 */
export const cheapClassifierSessionIds = new Set<string>();

// ── Public types ─────────────────────────────────────────────────────────

export interface ClassifyOpts {
  /** The input text to classify */
  input: string;
  /** Inline JSON schema description that the haiku output must match */
  schema: string;
  /** Optional system-prompt override. Default: locked classifier instructions. */
  systemPromptOverride?: string;
  /** Model id. Default: opencode/claude-haiku-4-5 (Claude Max via opencode bridge) */
  model?: string;
  /** Max output tokens. Default: 256. Classifiers should never need more. */
  maxTokens?: number;
  /** Provider client (injected for testing). Default: opencode runtime context. */
  providerClient?: ProviderClient;
  /**
   * Layer-1 hop counter. Default 0. Incremented by any caller that
   * chains a classify() from inside a classify-triggered context. If
   * a call comes in with depth >= MAX_DISPATCH_DEPTH we trip Layer 1.
   *
   * Survives content mutation (lives on the call stack, not in the
   * prompt text). Backstop for the case where Layer 2 markers get
   * stripped by an aggressive paraphrase.
   */
  dispatchDepth?: number;
  /**
   * Optional name of the caller (parallel-detector, criteria-validator,
   * dispatch-judge, failure-router). Used only for diagnostic logging
   * when a guard trips.
   */
  callerHook?: string;
}

/** Layer 1: max recursive classify() depth before we refuse. */
export const MAX_DISPATCH_DEPTH = 3;

export interface ProviderClient {
  generate(args: {
    model: string;
    system: string;
    user: string;
    maxTokens: number;
    temperature: number;
  }): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>;
}

export type ClassifyResult<T = unknown> =
  | { ok: true; data: T; rawText: string; usage?: { inputTokens: number; outputTokens: number } }
  | { ok: false; error: string; rawText: string; retryable: boolean };

// ── Locked system prompt ─────────────────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPT = `You are a classifier. You return JSON only. No prose. No reasoning. No code fences. No explanation.
You never use tools. You never write files. You never plan work.
You read the input, match it to the schema the caller provided, and return JSON matching that schema exactly.
Schema violations are a hard failure — return {"error": "<one-sentence reason>"} and nothing else.
Do not include the word "json" or markdown formatting. Just the JSON object.`;

/**
 * Default classifier model. anthropic/claude-haiku-4-5 routes through Claude
 * Max OAuth (no per-call billing on the user's subscription) and is one of
 * the slugs in MODEL_PREFERENCES.md. Caller can override via opts.model.
 */
export const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
export const DEFAULT_MAX_TOKENS = 256;

/**
 * Parse a "provider/model" slug into the {providerID, modelID} shape
 * opencode's session.prompt expects. Splits on the FIRST '/' so model IDs
 * containing slashes (e.g. xiaomi-token-plan-sgp/mimo-v2.5-pro) round-trip
 * correctly.
 */
function parseModelSlug(
  slug: string,
): { providerID: string; modelID: string } | null {
  const slashIndex = slug.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= slug.length - 1) return null;
  return {
    providerID: slug.slice(0, slashIndex),
    modelID: slug.slice(slashIndex + 1),
  };
}

// ── Content-based recursion guard ────────────────────────────────────────

/**
 * Marker substring that ONLY appears in cheap-classifier user prompts.
 * Built from the literal in `classify()` below — every cheap-classifier
 * user message ends with this exact sentence. Match is fast and unambiguous.
 *
 * If a prompt contains this marker, it's either a previous cheap-classifier
 * payload being fed back to a classifier (recursion) or an orchestrator
 * retry whose context includes a rejection from one. Either way, classify()
 * must not wrap it again — that's the loop we saw on 2026-05-28 21:19.
 */
export const CHEAP_CLASSIFIER_PROMPT_MARKER =
  "Return JSON matching the schema. JSON only.";

/** True if `text` looks like (or contains) a cheap-classifier prompt. */
export function looksLikeCheapClassifierPrompt(text: string): boolean {
  return text.includes(CHEAP_CLASSIFIER_PROMPT_MARKER);
}

// ── Process-wide rate-limit backstop ─────────────────────────────────────

/**
 * Sliding-window counter of classify() invocations. If we exceed
 * RATE_LIMIT_MAX in the last RATE_LIMIT_WINDOW_MS, every subsequent call
 * fast-fails with a transient error until the window drains. This kills
 * any feedback loop (in this module or any future caller) dead — even if
 * the content/sessionID guards have a hole we haven't found yet.
 *
 * Tuned for legitimate batch use: 50 classify calls in 5 seconds covers
 * even an aggressive parallel-dispatch turn; anything beyond is a runaway.
 */
const RATE_LIMIT_WINDOW_MS = 5_000;
const RATE_LIMIT_MAX = 50;
const recentClassifyTimestamps: number[] = [];

function rateLimitTripped(): boolean {
  const now = Date.now();
  while (
    recentClassifyTimestamps.length > 0 &&
    recentClassifyTimestamps[0]! < now - RATE_LIMIT_WINDOW_MS
  ) {
    recentClassifyTimestamps.shift();
  }
  if (recentClassifyTimestamps.length >= RATE_LIMIT_MAX) return true;
  recentClassifyTimestamps.push(now);
  return false;
}

/** Test-only escape hatch. Do not call from production paths. */
export function _resetRateLimitForTests(): void {
  recentClassifyTimestamps.length = 0;
}

// ── Core classifier ──────────────────────────────────────────────────────

/**
 * Single-shot classification call. Cheap. Fail-fast. JSON-only.
 *
 * Schema is passed AS A STRING (TypeScript-style or plain English) — we do
 * not validate against a runtime JSON-schema lib here because the goal is
 * speed + simplicity. Callers validate the parsed shape against their own
 * type guard.
 */
export async function classify<T = unknown>(opts: ClassifyOpts): Promise<ClassifyResult<T>> {
  const {
    input,
    schema,
    systemPromptOverride,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    providerClient,
    dispatchDepth = 0,
    callerHook = "unknown",
  } = opts;

  if (!providerClient) {
    return {
      ok: false,
      error: "no provider client injected — caller must pass providerClient",
      rawText: "",
      retryable: false,
    };
  }

  // INSTRUMENTATION (temp 2026-05-28): file-append because opencode
  // swallows plugin console.* output. Confirms classify() entry and
  // whether either Layer 2 marker check should have fired.
  try {
    const hasMarkerInInput = looksLikeCheapClassifierPrompt(input);
    const hasHarnessTagInInput = containsHarnessMark(input);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:fs").appendFileSync(
      "/tmp/harness-loop-guard.log",
      `[CLASSIFY-DEBUG] ${new Date().toISOString()} caller=${callerHook} depth=${dispatchDepth} inputLen=${input.length} hasLegacy=${hasMarkerInInput} hasMark=${hasHarnessTagInInput}\n`,
    );
  } catch {}

  // ── Layer 1 — TTL / hop count ─────────────────────────────────────────
  // Lives on the call stack, not in the prompt text. Survives any content
  // mutation by the LLM. Backstop for the case where harness-mark tags
  // (Layer 2) get stripped by an aggressive paraphrase.
  if (dispatchDepth >= MAX_DISPATCH_DEPTH) {
    tripLoopGuard({
      layer: 1,
      hook: callerHook,
      tripReason: `dispatch depth ${dispatchDepth} >= ${MAX_DISPATCH_DEPTH}`,
      depth: dispatchDepth,
      contentPreview: input.slice(0, 200),
    });
    return {
      ok: false,
      error: `cheap-classifier: TTL exceeded (depth=${dispatchDepth}, max=${MAX_DISPATCH_DEPTH})`,
      rawText: "",
      retryable: false,
    };
  }

  // ── Layer 2 — provenance-marker detection ─────────────────────────────
  // If the input contains either a) the legacy cheap-classifier substring
  // marker (a prior classify wrapped this text), or b) a `<harness-mark>`
  // tag emitted by ANY harness hook (which means an upstream injection is
  // being quoted back to us), refuse to wrap it again. Two checks because
  // older marker-less injections may still be in flight when this ships.
  const hasLegacyMarker = looksLikeCheapClassifierPrompt(input);
  const hasHarnessMark = containsHarnessMark(input);
  if (hasLegacyMarker || hasHarnessMark) {
    tripLoopGuard({
      layer: 2,
      hook: callerHook,
      tripReason: hasHarnessMark
        ? "input contains <harness-mark> from a prior injection"
        : "input contains cheap-classifier marker substring",
      depth: dispatchDepth,
      contentPreview: input.slice(0, 200),
    });
    return {
      ok: false,
      error: "input contains harness provenance marker — refusing to re-wrap",
      rawText: "",
      retryable: false,
    };
  }

  // ── Layer 3 — content-hash idempotency cache ──────────────────────────
  // Same (system + input) within IDEMPOTENCY_TTL_MS → return cached result
  // without spending another LLM round-trip. Catches verbatim-retry loops
  // AND legitimate duplicate work (two concurrent task dispatches with the
  // same body).
  const cacheKey = hashClassifyInput(
    `${systemPromptOverride ?? "DEFAULT"}\n${schema}\n${input}`,
  );
  const cached = idempotencyLookup<ClassifyResult<T>>(cacheKey);
  if (cached) {
    tripLoopGuard({
      layer: 3,
      hook: callerHook,
      tripReason: "idempotency cache hit — returning cached classify result",
      depth: dispatchDepth,
      contentPreview: input.slice(0, 200),
    });
    return cached;
  }

  // ── Layer 4 — process-wide rate limit ─────────────────────────────────
  // Last-ditch circuit breaker. Should not normally fire if 1-3 are
  // working. If it does, that itself is a signal of an undiagnosed loop
  // — trip log will show the call sites involved.
  if (rateLimitTripped()) {
    tripLoopGuard({
      layer: 4,
      hook: callerHook,
      tripReason: `>${RATE_LIMIT_MAX} classify() calls in ${RATE_LIMIT_WINDOW_MS}ms`,
      depth: dispatchDepth,
      rateWindowCount: recentClassifyTimestamps.length,
      contentPreview: input.slice(0, 200),
    });
    return {
      ok: false,
      error: `cheap-classifier rate limit tripped (>${RATE_LIMIT_MAX} calls in ${RATE_LIMIT_WINDOW_MS}ms)`,
      rawText: "",
      retryable: true,
    };
  }

  const system = systemPromptOverride ?? DEFAULT_SYSTEM_PROMPT;
  const user = `Schema:\n${schema}\n\nInput:\n${input}\n\n${CHEAP_CLASSIFIER_PROMPT_MARKER}`;

  let response: { text: string; usage?: { inputTokens: number; outputTokens: number } };
  try {
    response = await providerClient.generate({
      model,
      system,
      user,
      maxTokens,
      temperature: 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isRateLimit = /rate.?limit|429|quota|throttle/i.test(msg);
    const isTransient = isRateLimit || /timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(msg);
    return {
      ok: false,
      error: msg,
      rawText: "",
      retryable: isTransient,
    };
  }

  const rawText = response.text.trim();

  // Strip common wrapping the model might emit despite instructions
  const stripped = stripJsonWrapping(rawText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `JSON parse failed: ${msg}`,
      rawText,
      retryable: false,
    };
  }

  // Caller is responsible for shape validation. We just confirm it parsed.
  const result: ClassifyResult<T> = {
    ok: true,
    data: parsed as T,
    rawText,
  };
  if (response.usage) result.usage = response.usage;
  // Layer 3: store the successful result so an immediate retry with the
  // same input returns instantly without another LLM round-trip.
  idempotencyStore(cacheKey, result);
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Strip ```json ... ``` fences and surrounding prose if the model ignored
 * the JSON-only instruction. Returns the most-likely-JSON substring.
 */
export function stripJsonWrapping(text: string): string {
  let s = text.trim();

  // ```json ... ``` or ``` ... ```
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch?.[1]) {
    s = fenceMatch[1].trim();
  }

  // If there's prose before/after the JSON object, extract the first {...} or [...]
  const objMatch = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (objMatch?.[1]) {
    s = objMatch[1];
  }

  return s.trim();
}

/**
 * Convenience: validate that parsed JSON has all required keys with expected
 * primitive types. Returns null if valid, error string otherwise.
 *
 * For complex shapes the caller should write a proper type guard.
 */
export function validateShape(
  data: unknown,
  required: Record<string, "string" | "number" | "boolean" | "array" | "object">,
): string | null {
  if (typeof data !== "object" || data === null) return "data is not an object";
  const obj = data as Record<string, unknown>;

  for (const [key, expectedType] of Object.entries(required)) {
    if (!(key in obj)) return `missing key: ${key}`;
    const val = obj[key];
    const actualType = Array.isArray(val) ? "array" : typeof val;
    if (actualType !== expectedType) {
      return `key "${key}": expected ${expectedType}, got ${actualType}`;
    }
  }
  return null;
}

/**
 * Build a real ProviderClient from the opencode plugin context.
 *
 * Implementation mirrors src/tools/smartfetch/secondary-model.ts: spawn an
 * ephemeral session bound to a small model (haiku), send the prompt, read
 * back the assistant text, then delete the session. Cheap, deterministic,
 * no streaming, no tool use.
 *
 * Used by the harness cascade plugins (parallel-detector, criteria-validator,
 * dispatch-judge) for their Tier-1 classifier calls. Tests inject mock
 * ProviderClients instead.
 */
export function providerClientFromOpencode(
  ctx: Parameters<NonNullable<Plugin>>[0],
): ProviderClient {
  const client = (ctx as PluginInput).client;
  const directory =
    (ctx as PluginInput).directory ?? process.cwd();

  return {
    generate: async ({ model, system, user, maxTokens: _maxTokens, temperature: _temperature }) => {
      // Parse model slug into the {providerID, modelID} shape opencode expects.
      const modelRef = parseModelSlug(model);
      if (!modelRef) {
        throw new Error(
          `cheap-classifier: invalid model slug "${model}" (expected provider/model)`,
        );
      }

      // 1. Create an ephemeral session for the classifier call.
      const session = (await (client as unknown as {
        session: {
          create: (args: unknown) => Promise<unknown>;
          prompt: (args: unknown) => Promise<unknown>;
          delete?: (args: unknown) => Promise<unknown>;
        };
      }).session.create({
        responseStyle: 'data',
        throwOnError: true,
        query: { directory },
        body: { title: 'cheap-classifier' },
      })) as { data?: { id?: string }; id?: string };

      const sessionId = session?.data?.id ?? session?.id;
      if (!sessionId) {
        throw new Error('cheap-classifier session.create returned no id');
      }

      // Register the in-flight session so downstream chat.messages.transform
      // hooks (parallel-detector, etc.) skip it. See cheapClassifierSessionIds
      // above for the recursion-guard rationale.
      cheapClassifierSessionIds.add(sessionId);

      try {
        // 2. Prompt with system + user message. Disable tools — classifiers
        //    should never call them. Force JSON-only output via the system
        //    prompt the caller provides.
        const result = (await (client as unknown as {
          session: { prompt: (args: unknown) => Promise<unknown> };
        }).session.prompt({
          responseStyle: 'data',
          throwOnError: true,
          path: { id: sessionId },
          query: { directory },
          body: {
            model: modelRef,
            system,
            tools: {}, // disable all tools — classifier is text-in/JSON-out
            parts: [{ type: 'text', text: user }],
          },
        })) as
          | { data?: { parts?: Array<{ type?: string; text?: string }> } }
          | { parts?: Array<{ type?: string; text?: string }> };

        // 3. Extract assistant text from the response parts.
        const parts =
          (result as { data?: { parts?: Array<{ type?: string; text?: string }> } })?.data?.parts ??
          (result as { parts?: Array<{ type?: string; text?: string }> })?.parts ??
          [];
        const text = parts
          .map((part) => (part?.type === 'text' ? (part.text ?? '') : ''))
          .join('')
          .trim();

        return { text };
      } finally {
        // 4. Best-effort cleanup. Not all opencode versions expose
        //    session.delete on the plugin client; ignore if unavailable.
        //
        //    CRITICAL: invoke delete as a METHOD on `client.session`
        //    (sessionApi.delete(...)), NOT by extracting it into a bare
        //    variable first. In @opencode-ai/sdk, session.delete is a
        //    prototype method whose body dereferences `this._client`; an
        //    unbound reference makes `this` undefined and throws a synchronous
        //    TypeError before the promise (and its .catch) exist, so cleanup
        //    silently never runs and every ephemeral session leaks (~400KB
        //    resident heap each → unbounded server growth → OOM).
        //    Regression guard: cheap-classifier.leak.test.ts.
        try {
          const sessionApi = (client as unknown as {
            session: { delete?: (args: unknown) => Promise<unknown> };
          }).session;
          if (typeof sessionApi.delete === 'function') {
            await sessionApi
              .delete({
                path: { id: sessionId },
                query: { directory },
                throwOnError: false,
              })
              .catch(() => {});
          }
        } catch {
          // best-effort
        }
        // Always release the guard, even if the delete RPC threw. The set is
        // only consulted by chat.messages.transform; a stale entry would
        // permanently silence parallel-detector for that session ID.
        cheapClassifierSessionIds.delete(sessionId);
      }
    },
  };
}
