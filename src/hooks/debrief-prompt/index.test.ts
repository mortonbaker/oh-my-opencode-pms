import { describe, expect, test } from 'bun:test';
import { __testing, createDebriefPromptHook } from './index';

const { REMINDER_TEXT } = __testing;

describe('debrief-prompt hook', () => {
  test('does not fire below MIN_MESSAGES', () => {
    const h = createDebriefPromptHook({ minMessages: 10, minIdleMs: 1 });
    for (let i = 0; i < 9; i++) h.onChatMessage('s1');
    h.handleEvent({ type: 'session.idle', properties: { sessionID: 's1' } });
    const s = h.__state.get('s1')!;
    expect(s.pendingInject).toBe(false);
  });

  test('does not fire below MIN_IDLE_MS', () => {
    const h = createDebriefPromptHook({ minMessages: 1, minIdleMs: 60_000 });
    h.onChatMessage('s1'); // sets lastMessageAt to now
    h.handleEvent({ type: 'session.idle', properties: { sessionID: 's1' } });
    const s = h.__state.get('s1')!;
    expect(s.pendingInject).toBe(false);
  });

  test('fires when all conditions met', () => {
    const h = createDebriefPromptHook({ minMessages: 3, minIdleMs: 1 });
    for (let i = 0; i < 3; i++) h.onChatMessage('s2');
    // wait > 1ms
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    h.handleEvent({ type: 'session.idle', properties: { sessionID: 's2' } });
    expect(h.__state.get('s2')!.pendingInject).toBe(true);
  });

  test('suppresses after a single prompt (once per session)', async () => {
    const h = createDebriefPromptHook({ minMessages: 1, minIdleMs: 1 });
    h.onChatMessage('s3');
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    h.handleEvent({ type: 'session.idle', properties: { sessionID: 's3' } });

    // Trigger the transform once — sets prompted=true
    const messages = [{ info: { role: 'user', sessionID: 's3' }, parts: [] }];
    await h['experimental.chat.messages.transform']({}, { messages });
    expect(messages.length).toBe(2);
    expect(messages[1].parts[0].text).toBe(REMINDER_TEXT);

    // Idle again — should NOT re-fire
    h.handleEvent({ type: 'session.idle', properties: { sessionID: 's3' } });
    const m2 = [{ info: { role: 'user', sessionID: 's3' }, parts: [] }];
    await h['experimental.chat.messages.transform']({}, { messages: m2 });
    expect(m2.length).toBe(1);
  });

  test('markDebriefed suppresses any future nudge', () => {
    const h = createDebriefPromptHook({ minMessages: 1, minIdleMs: 1 });
    h.onChatMessage('s4');
    h.markDebriefed('s4');
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    h.handleEvent({ type: 'session.idle', properties: { sessionID: 's4' } });
    expect(h.__state.get('s4')!.pendingInject).toBe(false);
  });

  test('handleEvent ignores non-idle events', () => {
    const h = createDebriefPromptHook({ minMessages: 1, minIdleMs: 1 });
    h.onChatMessage('s5');
    h.handleEvent({ type: 'session.created', properties: { sessionID: 's5' } });
    expect(h.__state.get('s5')!.pendingInject).toBe(false);
  });

  test('transform on empty messages is no-op', async () => {
    const h = createDebriefPromptHook({ minMessages: 1, minIdleMs: 1 });
    const messages: any[] = [];
    await h['experimental.chat.messages.transform']({}, { messages });
    expect(messages.length).toBe(0);
  });
});
