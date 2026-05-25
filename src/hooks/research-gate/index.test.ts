import { describe, expect, test } from 'bun:test';
import { __testing, createResearchGateHook } from './index';

const {
  detectQuestionToOperator,
  hasResearchSection,
  stripCodeBlocks,
  VIOLATION_REMINDER,
} = __testing;

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
