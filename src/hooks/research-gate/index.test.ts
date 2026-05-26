import { describe, expect, mock, test } from 'bun:test';
import { __testing, createResearchGateHook } from './index';

const {
  detectQuestionToOperator,
  hasResearchSection,
  stripCodeBlocks,
  VIOLATION_REMINDER,
  AUTO_CORRECTION_PROMPT,
} = __testing;

// Helper: build a minimal ctx with a mock SDK client for V2 tests
function makeCtx(messagesData: unknown) {
  const promptMock = mock(async () => ({}));
  const messagesMock = mock(async () => ({ data: messagesData }));
  return {
    ctx: {
      client: {
        session: {
          messages: messagesMock,
          prompt: promptMock,
        },
      },
    },
    promptMock,
    messagesMock,
  };
}

describe('research-gate: detectQuestionToOperator', () => {
  test('detects plain question', () => {
    expect(detectQuestionToOperator('Should I do X?')).toBe(true);
  });

  test('detects question at end of paragraph', () => {
    expect(
      detectQuestionToOperator('I did X. Y is done. What do you want next?'),
    ).toBe(true);
  });

  test('ignores ? inside fenced code block', () => {
    const text = '```bash\necho "test?"\n```\nDone.';
    expect(detectQuestionToOperator(text)).toBe(false);
  });

  test('ignores ? inside inline code', () => {
    expect(detectQuestionToOperator('Use `grep "foo?bar"` here.')).toBe(false);
  });

  test('ignores ? inside URL', () => {
    expect(
      detectQuestionToOperator(
        'See https://example.com/api?q=foo for details.',
      ),
    ).toBe(false);
  });

  test('does not re-trigger on its own injected reminder', () => {
    expect(detectQuestionToOperator(VIOLATION_REMINDER)).toBe(false);
  });

  test('empty text → false', () => {
    expect(detectQuestionToOperator('')).toBe(false);
  });

  test('text with no question marks → false', () => {
    expect(detectQuestionToOperator('I did the thing. Done.')).toBe(false);
  });
});

describe('research-gate: hasResearchSection', () => {
  test('detects exact header', () => {
    expect(hasResearchSection('# Foo\n\n## What I researched\n- src 1')).toBe(
      true,
    );
  });

  test('rejects lowercase variant', () => {
    expect(hasResearchSection('## what i researched\n- src 1')).toBe(false);
  });

  test('rejects missing section', () => {
    expect(hasResearchSection('## BLUF\nDoing X.')).toBe(false);
  });
});

describe('research-gate: stripCodeBlocks', () => {
  test('strips fenced blocks', () => {
    expect(stripCodeBlocks('a\n```\n?\n```\nb')).toBe('a\n\nb');
  });

  test('strips inline code', () => {
    expect(stripCodeBlocks('use `?` here')).toBe('use  here');
  });
});

describe('research-gate: createResearchGateHook integration', () => {
  test('injects reminder when assistant asks unresearched question', async () => {
    const hook = createResearchGateHook();
    const output = {
      messages: [
        {
          info: { role: 'user', sessionID: 's1' },
          parts: [{ type: 'text', text: 'do the thing' }],
        },
        {
          info: { role: 'assistant', sessionID: 's1' },
          parts: [
            {
              type: 'text',
              text: 'I did some of it. What do you want next?',
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages.length).toBe(3);
    expect(output.messages[2].info.role).toBe('user');
    expect(output.messages[2].parts[0].text).toContain(
      'RESEARCH-GATE VIOLATION DETECTED',
    );
  });

  test('does NOT inject when research section present', async () => {
    const hook = createResearchGateHook();
    const output = {
      messages: [
        {
          info: { role: 'user', sessionID: 's2' },
          parts: [{ type: 'text', text: 'plan it' }],
        },
        {
          info: { role: 'assistant', sessionID: 's2' },
          parts: [
            {
              type: 'text',
              text:
                '## BLUF\nDoing X.\n\n## What I researched\n- jdormit/opencode-memsearch: pattern\n\nProceed?',
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages.length).toBe(2);
  });

  test('does NOT inject when assistant did not ask a question', async () => {
    const hook = createResearchGateHook();
    const output = {
      messages: [
        {
          info: { role: 'user', sessionID: 's3' },
          parts: [{ type: 'text', text: 'just do it' }],
        },
        {
          info: { role: 'assistant', sessionID: 's3' },
          parts: [{ type: 'text', text: 'Done. Moving on.' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages.length).toBe(2);
  });

  test('does NOT re-inject on top of its own reminder', async () => {
    const hook = createResearchGateHook();
    const output = {
      messages: [
        {
          info: { role: 'assistant', sessionID: 's4' },
          parts: [{ type: 'text', text: VIOLATION_REMINDER }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages.length).toBe(1);
  });

  test('empty messages array → no-op', async () => {
    const hook = createResearchGateHook();
    const output = { messages: [] };
    await hook['experimental.chat.messages.transform']({}, output);
    expect(output.messages.length).toBe(0);
  });
});

describe('research-gate V2: handleEvent auto-correction', () => {
  const violatingMessages = [
    {
      info: { role: 'user', sessionID: 's1' },
      parts: [{ type: 'text', text: 'do the thing' }],
    },
    {
      info: { role: 'assistant', sessionID: 's1' },
      parts: [{ type: 'text', text: 'I did some. What next?' }],
    },
  ];

  const cleanMessages = [
    {
      info: { role: 'user', sessionID: 's2' },
      parts: [{ type: 'text', text: 'plan it' }],
    },
    {
      info: { role: 'assistant', sessionID: 's2' },
      parts: [
        {
          type: 'text',
          text:
            '## BLUF\nDoing X.\n\n## What I researched\n- file.ts\n\nProceed?',
        },
      ],
    },
  ];

  test('fires auto-correction on session.idle when violation present', async () => {
    const { ctx, promptMock } = makeCtx(violatingMessages);
    const hook = createResearchGateHook(ctx);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 's1' } },
    });

    expect(promptMock).toHaveBeenCalledTimes(1);
    const call = promptMock.mock.calls[0][0] as {
      path: { id: string };
      body: { parts: Array<{ text: string }> };
    };
    expect(call.path.id).toBe('s1');
    expect(call.body.parts[0].text).toContain('RESEARCH-GATE AUTO-CORRECTION');
  });

  test('does NOT fire when last assistant has research section', async () => {
    const { ctx, promptMock } = makeCtx(cleanMessages);
    const hook = createResearchGateHook(ctx);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 's2' } },
    });

    expect(promptMock).not.toHaveBeenCalled();
  });

  test('does NOT fire on non-idle events', async () => {
    const { ctx, promptMock } = makeCtx(violatingMessages);
    const hook = createResearchGateHook(ctx);

    await hook.handleEvent({
      event: { type: 'message.updated', properties: { sessionID: 's1' } },
    });

    expect(promptMock).not.toHaveBeenCalled();
  });

  test('fires on session.status with idle subtype', async () => {
    const { ctx, promptMock } = makeCtx(violatingMessages);
    const hook = createResearchGateHook(ctx);

    await hook.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 's1', status: { type: 'idle' } },
      },
    });

    expect(promptMock).toHaveBeenCalledTimes(1);
  });

  test('HARD CAP: only fires once per session (one-shot)', async () => {
    const { ctx, promptMock } = makeCtx(violatingMessages);
    const hook = createResearchGateHook(ctx);

    // First idle → fires
    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 's1' } },
    });
    expect(promptMock).toHaveBeenCalledTimes(1);

    // Second idle (still violating) → does NOT fire again
    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 's1' } },
    });
    expect(promptMock).toHaveBeenCalledTimes(1);

    // Third idle on same session → still capped
    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 's1' } },
    });
    expect(promptMock).toHaveBeenCalledTimes(1);
  });

  test('different sessions each get their own one-shot', async () => {
    // Both sessions violate
    const { ctx, promptMock, messagesMock } = makeCtx(violatingMessages);
    // Make messages mock return data tagged with the requested sessionID
    messagesMock.mockImplementation(async (args: { path: { id: string } }) => ({
      data: [
        {
          info: { role: 'user', sessionID: args.path.id },
          parts: [{ type: 'text', text: 'go' }],
        },
        {
          info: { role: 'assistant', sessionID: args.path.id },
          parts: [{ type: 'text', text: 'Do you want X?' }],
        },
      ],
    }));
    const hook = createResearchGateHook(ctx);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 'sA' } },
    });
    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 'sB' } },
    });
    // Each session gets its own auto-correction
    expect(promptMock).toHaveBeenCalledTimes(2);

    // Repeats on either session are capped
    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 'sA' } },
    });
    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 'sB' } },
    });
    expect(promptMock).toHaveBeenCalledTimes(2);
  });

  test('handleEvent is a no-op when ctx is omitted (V1-only mode)', async () => {
    const hook = createResearchGateHook(); // no ctx
    // Should not throw
    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 's1' } },
    });
    // No assertion possible (no mock) — just verifying no exception
    expect(true).toBe(true);
  });

  test('handles SDK errors gracefully (does not throw)', async () => {
    const promptMock = mock(async () => ({}));
    const messagesMock = mock(async () => {
      throw new Error('SDK boom');
    });
    const ctx = {
      client: { session: { messages: messagesMock, prompt: promptMock } },
    };
    const hook = createResearchGateHook(ctx);

    // Should swallow the error
    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 's1' } },
    });

    expect(promptMock).not.toHaveBeenCalled();
  });

  test('skips when no assistant message in history', async () => {
    const { ctx, promptMock } = makeCtx([
      {
        info: { role: 'user', sessionID: 's1' },
        parts: [{ type: 'text', text: 'hi' }],
      },
    ]);
    const hook = createResearchGateHook(ctx);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 's1' } },
    });

    expect(promptMock).not.toHaveBeenCalled();
  });

  test('skips when sessionID missing from event', async () => {
    const { ctx, promptMock } = makeCtx(violatingMessages);
    const hook = createResearchGateHook(ctx);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: {} },
    });

    expect(promptMock).not.toHaveBeenCalled();
  });

  test('detectQuestionToOperator does not flag the auto-correction prompt itself', () => {
    // Verify the auto-correction prompt won't loop-trigger
    expect(detectQuestionToOperator(AUTO_CORRECTION_PROMPT)).toBe(false);
  });
});
