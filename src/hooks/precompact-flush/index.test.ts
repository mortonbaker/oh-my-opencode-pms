import { describe, expect, test } from 'bun:test';
import { __testing, createPrecompactFlushHook } from './index';

const { FLUSH_INSTRUCTION } = __testing;

describe('precompact-flush', () => {
  test('appends flush instruction to output.context', async () => {
    const hook = createPrecompactFlushHook();
    const output = { context: [] as string[] };
    await hook['experimental.session.compacting'](
      { sessionID: 'sess_test_1' },
      output,
    );
    expect(output.context.length).toBe(1);
    expect(output.context[0]).toBe(FLUSH_INSTRUCTION);
  });

  test('does not replace existing prompt', async () => {
    const hook = createPrecompactFlushHook();
    const output = { context: ['existing-context'], prompt: 'custom-prompt' };
    await hook['experimental.session.compacting'](
      { sessionID: 'sess_test_2' },
      output,
    );
    expect(output.context.length).toBe(2);
    expect(output.context[0]).toBe('existing-context');
    expect(output.prompt).toBe('custom-prompt');
  });

  test('flush instruction references all key memory types', () => {
    expect(FLUSH_INSTRUCTION).toContain('preference');
    expect(FLUSH_INSTRUCTION).toContain('decision');
    expect(FLUSH_INSTRUCTION).toContain('topology');
    expect(FLUSH_INSTRUCTION).toContain('workflow');
    expect(FLUSH_INSTRUCTION).toContain('## Durable memories');
  });

  test('flush instruction has explicit INCLUDE and EXCLUDE rules', () => {
    expect(FLUSH_INSTRUCTION).toContain('INCLUDE');
    expect(FLUSH_INSTRUCTION).toContain('EXCLUDE');
    expect(FLUSH_INSTRUCTION).toContain('Failure modes');
    expect(FLUSH_INSTRUCTION).toContain('Exploration paths');
  });
});
