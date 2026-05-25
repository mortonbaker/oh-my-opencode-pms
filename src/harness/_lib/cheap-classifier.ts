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
}

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

export const DEFAULT_MODEL = "opencode/claude-haiku-4-5";
export const DEFAULT_MAX_TOKENS = 256;

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
  } = opts;

  if (!providerClient) {
    return {
      ok: false,
      error: "no provider client injected — caller must pass providerClient",
      rawText: "",
      retryable: false,
    };
  }

  const system = systemPromptOverride ?? DEFAULT_SYSTEM_PROMPT;
  const user = `Schema:\n${schema}\n\nInput:\n${input}\n\nReturn JSON matching the schema. JSON only.`;

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
            model,
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
        try {
          const maybeDelete = (client as unknown as {
            session: { delete?: (args: unknown) => Promise<unknown> };
          }).session.delete;
          if (typeof maybeDelete === 'function') {
            await maybeDelete({
              path: { id: sessionId },
              query: { directory },
              throwOnError: false,
            }).catch(() => {});
          }
        } catch {
          // best-effort
        }
      }
    },
  };
}
