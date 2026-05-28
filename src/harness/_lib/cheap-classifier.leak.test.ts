/**
 * cheap-classifier.leak.test.ts — regression proof for the ephemeral-session leak.
 *
 * Root cause (confirmed 2026-05-28): providerClientFromOpencode() cleans up its
 * ephemeral classifier session in a `finally` block by EXTRACTING the delete
 * method into a bare variable first:
 *
 *     const maybeDelete = client.session.delete;   // unbound — loses `this`
 *     if (typeof maybeDelete === 'function') {
 *       await maybeDelete({...}).catch(() => {});
 *     }
 *
 * In @opencode-ai/sdk, `session.delete` is a PROTOTYPE method on a `Session`
 * class instance whose body dereferences `this._client`:
 *
 *     delete(options) { return (options.client ?? this._client).delete({...}); }
 *
 * Calling the extracted reference unbound makes `this` undefined, so
 * `this._client` throws a SYNCHRONOUS TypeError before the promise (and its
 * `.catch`) ever exists. The throw is swallowed by the surrounding try/catch,
 * the delete silently never happens, and every classifier session leaks.
 *
 * `session.create` / `session.prompt` are unaffected because they're invoked as
 * proper method calls (`client.session.create(...)`), which preserve `this`.
 *
 * These tests use a fake client that mirrors the SDK's class-instance shape
 * (prototype methods that read `this._client`) so the binding behaviour is
 * faithful. Zero network, zero real sessions — safe to run anywhere.
 */

import { describe, expect, test } from 'bun:test';
import { providerClientFromOpencode } from './cheap-classifier';

/**
 * Mirrors @opencode-ai/sdk's `Session` class: prototype methods that read
 * `this._client`. Tracks created vs deleted session ids so a leak is
 * observable as created > deleted.
 */
class FakeSdkSession {
  _client: unknown;
  created: string[] = [];
  deleted: string[] = [];

  constructor(client: unknown) {
    this._client = client;
  }

  create(_opts: unknown): Promise<{ data: { id: string } }> {
    // Faithful to the SDK: reads this._client. Method-invocation keeps `this`.
    void (this._client as object).toString();
    const id = `ses_fake_${this.created.length + 1}`;
    this.created.push(id);
    return Promise.resolve({ data: { id } });
  }

  prompt(
    _opts: unknown,
  ): Promise<{ data: { parts: Array<{ type: string; text: string }> } }> {
    void (this._client as object).toString();
    return Promise.resolve({
      data: { parts: [{ type: 'text', text: '{"ok":true}' }] },
    });
  }

  delete(opts: { path: { id: string } }): Promise<unknown> {
    // Faithful to the SDK line 228: `(options.client ?? this._client).delete`.
    // When invoked unbound, `this` is undefined and the next line throws a
    // synchronous TypeError — exactly the production failure.
    void (this._client as object).toString();
    this.deleted.push(opts.path.id);
    return Promise.resolve({});
  }
}

function makeCtx(session: FakeSdkSession) {
  return {
    client: { session },
    directory: '/tmp/leak-test',
  } as never;
}

const GEN_ARGS = {
  model: 'anthropic/claude-haiku-4-5',
  system: 'classifier',
  user: 'classify this',
  maxTokens: 256,
  temperature: 0,
};

describe('cheap-classifier ephemeral session cleanup (anti-leak guard)', () => {
  test('GUARD: a single classify call deletes the session it created', async () => {
    const session = new FakeSdkSession({ marker: 'real-client' });
    const provider = providerClientFromOpencode(makeCtx(session));

    const result = await provider.generate(GEN_ARGS);

    // The classify round-trip itself succeeds (create + prompt keep `this`).
    expect(result.text).toBe('{"ok":true}');
    expect(session.created).toHaveLength(1);

    // Fixed behaviour: delete is invoked as a bound method on client.session,
    // so `this._client` resolves and the ephemeral session is cleaned up.
    // If the unbound-extraction bug ever returns, `this` is undefined, delete
    // throws synchronously, is swallowed, and this drops to 0 — failing here.
    expect(session.deleted).toHaveLength(1);
    expect(session.deleted[0]).toBe(session.created[0]);
  });

  test('GUARD: N classify calls delete all N sessions (no linear leak)', async () => {
    const session = new FakeSdkSession({ marker: 'real-client' });
    const provider = providerClientFromOpencode(makeCtx(session));

    const N = 25;
    for (let i = 0; i < N; i++) {
      await provider.generate(GEN_ARGS);
    }

    expect(session.created).toHaveLength(N);
    // Every session is reclaimed. The unbounded, never-reclaimed growth that
    // drove opencode-web to ~14.6G + OOM is gone when created === deleted.
    expect(session.deleted).toHaveLength(N);
  });

  test('CONTROL: calling delete as a bound method DOES clean up (the fix)', async () => {
    // Demonstrates the intended behaviour the fix must achieve: invoking
    // delete as `session.delete(...)` (method call, `this` preserved) removes
    // the session. This is the green-state spec for the one-line fix.
    const session = new FakeSdkSession({ marker: 'real-client' });
    const id = (await session.create({})).data.id;
    await session.delete({ path: { id } });

    expect(session.created).toHaveLength(1);
    expect(session.deleted).toHaveLength(1);
    expect(session.deleted[0]).toBe(id);
  });
});
