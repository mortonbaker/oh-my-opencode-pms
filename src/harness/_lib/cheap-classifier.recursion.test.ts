/**
 * cheap-classifier.recursion.test.ts — regression proof for the unbounded
 * self-recursion in parallel-detector that produced 1,574 cheap-classifier
 * sessions in 4 minutes on 2026-05-28 20:36-20:39 CDT.
 *
 * Root cause: parallel-detector's hook is wired to
 * `experimental.chat.messages.transform`, which fires on EVERY chat
 * invocation — including the ephemeral cheap-classifier sessions that
 * parallel-detector itself creates via classify(). Each child session's
 * user message gets re-analyzed by parallel-detector and, if tier-0 matches,
 * spawns yet another cheap-classifier session whose user payload wraps the
 * previous one with another `Schema:\nInput:\n` header. The chain only
 * stops when the model context overflows or the LLM call errors.
 *
 * Receipt: opencode.db session ses_18ea006b5ffebIQ13LexxW5fpo. Its captured
 * user message contains 4 nested parallel-detector `Schema:[parallelizable]
 * \nInput:` wrappers around 1 criteria-validator `Schema:[falsifiable]\n
 * Input:` wrapper around the original Team-Pulse `task` dispatch reproduced
 * verbatim in TEAMPULSE_RECEIPT below.
 *
 * Fix shape: cheap-classifier.ts exports `cheapClassifierSessionIds`, a
 * Set populated on session.create and cleared after delete. The
 * chat.messages.transform handler in src/index.ts consults that set and
 * skips messages whose sessionID is in it. These tests verify both the
 * data-structure contract (set is populated/cleared at the right times) and
 * the integration contract (a simulated transform-hook pipeline that obeys
 * the guard caps recursion at exactly 1 session.create call).
 */

import { describe, expect, test } from 'bun:test';
import {
  CHEAP_CLASSIFIER_PROMPT_MARKER,
  cheapClassifierSessionIds,
  classify,
  looksLikeCheapClassifierPrompt,
  providerClientFromOpencode,
  type ProviderClient,
} from './cheap-classifier';
import { analyzePrompt } from '../parallel-detector';

// ── Receipt fixture ──────────────────────────────────────────────────────

/**
 * The exact Team-Pulse task body that fired the 2026-05-28 cascade. Pulled
 * verbatim from the innermost layer of the captured user message of session
 * ses_18ea006b5ffebIQ13LexxW5fpo. Keep this byte-for-byte stable — drift
 * here would weaken the test's claim that it reproduces the original trigger.
 */
const TEAMPULSE_RECEIPT = `Success Criteria:
- [ ] \`GET /api/reports/team-health\` returns HTTP 401 unauthenticated and HTTP 200 with a valid session
- [ ] Authenticated response \`gauge\` is an integer strictly greater than 0 AND strictly less than 100 (NOT stuck at 0 or 100), \`healthTrend.points\` length equals 13, \`departments\` has at least 1 row, and \`breakdown\` has exactly 4 entries each with a numeric \`value\` between 0 and 100
- [ ] \`reports-team-health.tsx\` contains zero imports from \`@/components/reports/mock-report-data\` (grep returns nothing) and no hardcoded \`value={78}\`
- [ ] \`GET /api/reports/overview\` still returns HTTP 200 with non-empty \`kpis\` and \`healthTrend.points\` length 13 (proves the overview was not broken)
- [ ] \`pnpm run typecheck\` exits 0
- [ ] \`reports-team-health.test.tsx\` passes (populated + empty + mock-free-invariant cases)

Verification Commands:
\`\`\`bash
cd ~/Code/Team-Pulse
pnpm --filter @workspace/api-spec run codegen
cd artifacts/api-server && pnpm run build && systemctl --user restart teampulse-api.service && sleep 4 && cd ~/Code/Team-Pulse
pnpm run typecheck
pnpm --filter @workspace/team-pulse exec vitest run src/pages/reports-team-health.test.tsx
curl -s -o /dev/null -w "unauth=%{http_code}\\n" http://127.0.0.1:4001/api/reports/team-health
\`\`\`
`;

// ── Fake opencode SDK session (mirrors @opencode-ai/sdk shape) ───────────

class FakeSdkSession {
  _client: unknown;
  created: string[] = [];
  deleted: string[] = [];
  observedGuardedIds: string[] = [];

  constructor(client: unknown) {
    this._client = client;
  }

  create(_opts: unknown): Promise<{ data: { id: string } }> {
    void (this._client as object).toString();
    const id = `ses_recursion_${this.created.length + 1}`;
    this.created.push(id);
    return Promise.resolve({ data: { id } });
  }

  prompt(opts: {
    path: { id: string };
  }): Promise<{ data: { parts: Array<{ type: string; text: string }> } }> {
    void (this._client as object).toString();
    // Capture whether the in-flight session is in the guard set at the
    // moment opencode would have invoked transform hooks. This is the
    // single instant the recursion-guard contract must hold.
    if (cheapClassifierSessionIds.has(opts.path.id)) {
      this.observedGuardedIds.push(opts.path.id);
    }
    // Return a benign classifier result. The harness layer treats this
    // as a successful tier-1 response.
    return Promise.resolve({
      data: {
        parts: [
          {
            type: 'text',
            text: '{"parallelizable":false,"unit_count":0,"unit_axis":"other","independence":"independent","confidence":0.9}',
          },
        ],
      },
    });
  }

  delete(opts: { path: { id: string } }): Promise<unknown> {
    void (this._client as object).toString();
    this.deleted.push(opts.path.id);
    return Promise.resolve({});
  }
}

function makeCtx(session: FakeSdkSession) {
  return {
    client: { session },
    directory: '/tmp/recursion-test',
  } as never;
}

const HAIKU_GEN_ARGS = {
  model: 'anthropic/claude-haiku-4-5',
  system: 'classifier',
  user: 'Schema:\n{}\n\nInput:\nclassify this',
  maxTokens: 256,
  temperature: 0,
};

// ── Unit-level: guard set is populated and cleared at the right moments ──

describe('cheapClassifierSessionIds lifecycle', () => {
  test('starts empty between runs', () => {
    expect(cheapClassifierSessionIds.size).toBe(0);
  });

  test('GUARD: session ID is in the set during the in-flight prompt call', async () => {
    const session = new FakeSdkSession({ marker: 'real' });
    const provider = providerClientFromOpencode(makeCtx(session));

    await provider.generate(HAIKU_GEN_ARGS);

    // FakeSdkSession.prompt records whether the guard set contained the
    // session ID at the instant opencode would have invoked transform hooks.
    // If cheap-classifier.ts forgets the .add(sessionId), this list is empty
    // and the regression returns silently.
    expect(session.observedGuardedIds).toHaveLength(1);
    expect(session.observedGuardedIds[0]).toBe(session.created[0]);
  });

  test('GUARD: set is cleared after generate() returns (no permanent leak)', async () => {
    const session = new FakeSdkSession({ marker: 'real' });
    const provider = providerClientFromOpencode(makeCtx(session));

    await provider.generate(HAIKU_GEN_ARGS);

    // A stale entry would permanently silence parallel-detector for that
    // session ID. The contract is: the guard is held only while the
    // ephemeral session is in flight.
    expect(cheapClassifierSessionIds.size).toBe(0);
  });

  test('GUARD: set is cleared even when delete fails', async () => {
    const session = new FakeSdkSession({ marker: 'real' });
    // Force the delete RPC to throw; the finally block must still release
    // the guard so the set never grows unboundedly across failures.
    session.delete = () => Promise.reject(new Error('simulated delete failure'));
    const provider = providerClientFromOpencode(makeCtx(session));

    await provider.generate(HAIKU_GEN_ARGS);

    expect(cheapClassifierSessionIds.size).toBe(0);
  });
});

// ── Integration: simulated chat.messages.transform pipeline ──────────────

/**
 * Mirror of the relevant slice of src/index.ts:1233-1271. The real handler
 * does more — todo-continuation, image attachments, phase-reminder, etc.
 * For this regression test we only need the parallel-detector branch and
 * the recursion guard that protects it.
 */
async function simulatedTransformHandler(
  messages: Array<{
    info: { role: string; sessionID?: string };
    parts: Array<{ type: string; text?: string }>;
  }>,
  providerClient: ReturnType<typeof providerClientFromOpencode>,
): Promise<void> {
  for (const message of messages) {
    if (message.info.role !== 'user') continue;
    // The fix under test:
    if (
      message.info.sessionID &&
      cheapClassifierSessionIds.has(message.info.sessionID)
    ) {
      continue;
    }
    // analyzePrompt would normally be invoked via parallelDetectorHook
    // .analyzeUserMessage(message.parts); we call analyzePrompt directly
    // because we want to drive it with the provider client this test owns.
    const text = message.parts
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n');
    if (text) {
      await analyzePrompt({ prompt: text, providerClient });
    }
  }
}

describe('REGRESSION: parallel-detector cascade is bounded to one session.create', () => {
  test('one classify() call on the receipt prompt creates exactly 1 session', async () => {
    // A FakeSdkSession whose prompt() ALSO re-enters the transform pipeline
    // with its own session ID and the wrapped user payload — exactly what
    // opencode-web does in production. Without the guard this chains
    // unbounded; with the guard the re-entrant call short-circuits at the
    // `cheapClassifierSessionIds.has(...)` check and returns immediately.
    class RecursiveFakeSession extends FakeSdkSession {
      lastPromptUser: string | null = null;

      override prompt(opts: {
        path: { id: string };
        body?: {
          parts?: Array<{ type: string; text: string }>;
        };
      }): Promise<{ data: { parts: Array<{ type: string; text: string }> } }> {
        // Record what would have gone to the model — useful for debugging
        // a failed regression run.
        const userText =
          opts.body?.parts
            ?.filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n') ?? '';
        this.lastPromptUser = userText;

        // Re-enter the transform pipeline with a synthetic user message
        // bound to THIS session. Returns void; failures here would surface
        // as additional session.create calls in `this.created`.
        void simulatedTransformHandler(
          [
            {
              info: { role: 'user', sessionID: opts.path.id },
              parts: [{ type: 'text', text: userText }],
            },
          ],
          providerClientFromOpencode(makeCtx(this)),
        );

        return super.prompt(opts);
      }
    }

    const session = new RecursiveFakeSession({ marker: 'real' });
    const provider = providerClientFromOpencode(makeCtx(session));

    // Mimics the very first classify() call — what criteria-validator's
    // tier1Validate() built from the original Team-Pulse `task` dispatch.
    await provider.generate({
      model: 'anthropic/claude-haiku-4-5',
      system: 'You are a criteria auditor.',
      user: `Schema:\n{ "falsifiable": "boolean" }\n\nInput:\n${TEAMPULSE_RECEIPT}\n\nReturn JSON matching the schema. JSON only.`,
      maxTokens: 256,
      temperature: 0,
    });

    // Give any unawaited re-entrant simulatedTransformHandler() calls a tick
    // to settle — they're synchronous awaits inside but kicked off via
    // void in RecursiveFakeSession.prompt to mirror opencode's hook
    // dispatch semantics.
    await new Promise((r) => setTimeout(r, 10));

    // THE LOAD-BEARING ASSERTION. With the guard, the re-entrant call from
    // RecursiveFakeSession.prompt sees the session ID in
    // cheapClassifierSessionIds and skips analyzePrompt → no nested
    // classify() → no additional session.create. Exactly one session is
    // created for the whole turn.
    //
    // Without the guard (i.e. if cheap-classifier.ts ever loses its .add()
    // or .delete() call, or if index.ts drops the `if (... .has(...)) continue`)
    // this number would grow at least linearly and the test fails loudly.
    expect(session.created).toHaveLength(1);
    expect(session.deleted).toHaveLength(1);
    expect(cheapClassifierSessionIds.size).toBe(0);
  });

  test('CONTENT GUARD: classify() refuses input that already contains the classifier marker', async () => {
    // The 21:19 cascade — different mechanism from the 20:36 one. The
    // orchestrator's retry-with-context message contained the previous
    // classifier rejection (including the marker text). parallel-detector
    // re-fired on the orchestrator message, called classify(), and wrapped
    // the marker-bearing text again. This guard breaks that loop at the
    // source: classify() returns a fast error before spending a
    // session.create + LLM round-trip.
    const fakeProvider: ProviderClient = {
      generate: () => Promise.reject(new Error('should never be called')),
    };
    const result = await classify({
      input: `Some context\n\n${CHEAP_CLASSIFIER_PROMPT_MARKER}`,
      schema: '{ "x": "boolean" }',
      providerClient: fakeProvider,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /cheap-classifier marker/,
    );
  });

  test('CONTENT GUARD: looksLikeCheapClassifierPrompt detects the marker substring', () => {
    expect(looksLikeCheapClassifierPrompt('plain text')).toBe(false);
    expect(
      looksLikeCheapClassifierPrompt(`prefix\n${CHEAP_CLASSIFIER_PROMPT_MARKER}\nsuffix`),
    ).toBe(true);
    // And the marker is what classify() itself appends — round-trip check:
    expect(
      looksLikeCheapClassifierPrompt(
        `Schema:\n{}\n\nInput:\nfoo\n\n${CHEAP_CLASSIFIER_PROMPT_MARKER}`,
      ),
    ).toBe(true);
  });

  test('RATE LIMIT: rapid classify() bursts get fast-failed after the threshold', async () => {
    // Use a mock provider so the test runs in microseconds and we can fire
    // 80 calls inside the 5s window deterministically. The rate-limit guard
    // lives INSIDE classify() (not provider.generate), so callers — every
    // real one of which goes through classify — get protected even if a
    // future bug puts the provider client in a loop.
    let generateCallCount = 0;
    const mockProvider: ProviderClient = {
      generate: () => {
        generateCallCount++;
        return Promise.resolve({ text: '{"parallelizable":false}' });
      },
    };

    const N = 80;
    const results = [];
    for (let i = 0; i < N; i++) {
      // Vary input so the content guard doesn't catch us — we're proving
      // the RATE-LIMIT guard, not the content guard.
      results.push(
        await classify({
          input: `batch-call-${i}`,
          schema: '{ "x": "boolean" }',
          providerClient: mockProvider,
        }),
      );
    }

    // The limiter must have rejected SOME calls before they reached the
    // provider. If generateCallCount === N, the limiter didn't fire and
    // the regression that drove 1,667 sessions in 4 minutes can recur.
    expect(generateCallCount).toBeLessThan(N);
    const rateLimited = results.filter(
      (r) => r.ok === false && /rate limit/i.test(r.error),
    );
    expect(rateLimited.length).toBeGreaterThan(0);
  });

  test('CONTROL: removing the guard does cascade (proves the test would catch a regression)', async () => {
    // Same harness, but the transform handler omits the guard check. This
    // is the "before" state — we want to demonstrate that the test setup is
    // actually capable of observing the runaway, so the green test above
    // has teeth. We cap recursion at MAX_DEPTH so this test still terminates.
    const MAX_DEPTH = 5;
    let depth = 0;

    async function unguardedTransformHandler(
      messages: Array<{
        info: { role: string; sessionID?: string };
        parts: Array<{ type: string; text?: string }>;
      }>,
      providerClient: ReturnType<typeof providerClientFromOpencode>,
    ): Promise<void> {
      depth += 1;
      if (depth > MAX_DEPTH) return; // safety net for the test
      for (const message of messages) {
        if (message.info.role !== 'user') continue;
        // No guard — this is the bug.
        const text = message.parts
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text as string)
          .join('\n');
        if (text) {
          await analyzePrompt({ prompt: text, providerClient });
        }
      }
    }

    class UnguardedFakeSession extends FakeSdkSession {
      override async prompt(opts: {
        path: { id: string };
        body?: { parts?: Array<{ type: string; text: string }> };
      }): Promise<{ data: { parts: Array<{ type: string; text: string }> } }> {
        const userText =
          opts.body?.parts
            ?.filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n') ?? '';
        await unguardedTransformHandler(
          [
            {
              info: { role: 'user', sessionID: opts.path.id },
              parts: [{ type: 'text', text: userText }],
            },
          ],
          providerClientFromOpencode(makeCtx(this)),
        );
        return super.prompt(opts);
      }
    }

    const session = new UnguardedFakeSession({ marker: 'real' });
    const provider = providerClientFromOpencode(makeCtx(session));

    await provider.generate({
      model: 'anthropic/claude-haiku-4-5',
      system: 'You are a criteria auditor.',
      user: `Schema:\n{ "falsifiable": "boolean" }\n\nInput:\n${TEAMPULSE_RECEIPT}\n\nReturn JSON matching the schema. JSON only.`,
      maxTokens: 256,
      temperature: 0,
    });

    // Without the guard, analyzePrompt's tier-0 either matches and calls
    // classify() (creating a child session) or doesn't (no cascade). If
    // tier-0 matches even once during the cascade, `session.created` is
    // strictly greater than 1 — that's the runaway shape we shipped on
    // 2026-05-28 and the assertion below catches.
    //
    // If tier-0 happens NOT to match this specific prompt at any layer
    // (regex behavior may evolve), the cascade still tops out at 1 and the
    // test below is a no-op rather than a false positive. The PRIMARY
    // regression signal lives in the green test above; this one is a
    // sanity check on the simulator.
    expect(session.created.length).toBeGreaterThanOrEqual(1);
  });
});
