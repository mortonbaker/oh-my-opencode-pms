import { describe, expect, test } from 'bun:test';
import { __testing, createTtsSpeakCommand } from './tts-speak';

const { buildOutputPath } = __testing;

describe('/tts-speak: buildOutputPath', () => {
  test('writes under /tmp with opencode-tts prefix so tts-bridge picks it up', () => {
    const p = buildOutputPath(1700000000000);
    expect(p).toMatch(/^\/tmp\/opencode-tts-1700000000000-speak\.mp3$/);
  });

  test('different timestamps produce different paths', () => {
    expect(buildOutputPath(1)).not.toBe(buildOutputPath(2));
  });
});

describe('/tts-speak: createTtsSpeakCommand', () => {
  test('registers under command.tts-speak', () => {
    const cmd = createTtsSpeakCommand();
    const config: { command?: Record<string, unknown> } = {};
    cmd.registerCommand(config);
    expect(config.command).toBeDefined();
    expect(config.command!['tts-speak']).toBeDefined();
    const reg = config.command!['tts-speak'] as { template: string; description: string };
    expect(reg.template.length).toBeGreaterThan(10);
    expect(reg.description).toContain('tts-bridge');
  });

  test('OVERRIDES existing registration (pms takes precedence over opencode-tts)', () => {
    const cmd = createTtsSpeakCommand();
    const config: { command?: Record<string, unknown> } = {
      command: { 'tts-speak': { template: 'old-template-from-opencode-tts' } },
    };
    cmd.registerCommand(config);
    expect((config.command!['tts-speak'] as { template: string }).template).not.toBe(
      'old-template-from-opencode-tts',
    );
  });

  test('handleCommandExecuteBefore ignores other commands', async () => {
    const cmd = createTtsSpeakCommand();
    const output = { parts: [{ type: 'text', text: 'untouched' }] };
    await cmd.handleCommandExecuteBefore(
      { command: 'something-else', sessionID: 's', arguments: 'x' },
      output,
    );
    expect(output.parts.length).toBe(1);
    expect(output.parts[0].text).toBe('untouched');
  });

  test('handleCommandExecuteBefore with empty args returns usage', async () => {
    const cmd = createTtsSpeakCommand();
    const output = { parts: [] as Array<{ type: string; text?: string }> };
    await cmd.handleCommandExecuteBefore(
      { command: 'tts-speak', sessionID: 's', arguments: '   ' },
      output,
    );
    expect(output.parts.length).toBe(1);
    expect(output.parts[0].text).toContain('Usage:');
  });
});
