import { describe, expect, test } from 'bun:test';
import { __testing, buildAdrBody, createRememberCommand } from './remember';

const { slugify } = __testing;

describe('/remember: slugify', () => {
  test('basic ascii', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });
  test('strips special chars', () => {
    expect(slugify("Operator's preference: tabs!")).toBe(
      'operator-s-preference-tabs',
    );
  });
  test('empty → untitled', () => {
    expect(slugify('!!!')).toBe('untitled');
  });
  test('long → truncated to 60', () => {
    const long = 'a'.repeat(120);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });
});

describe('/remember: buildAdrBody', () => {
  test('has frontmatter and required sections', () => {
    const body = buildAdrBody({
      ordinal: 7,
      title: 'Adopt opencode-memsearch as-is',
      text: 'Use the upstream plugin instead of forking. Same author. Same canonical pattern.',
      machine: 'atlas01',
      sessionID: 'sess_abc123',
      agent: 'orchestrator',
    });
    expect(body).toContain('id: ADR-0007');
    expect(body).toContain('title: Adopt opencode-memsearch as-is');
    expect(body).toContain('status: accepted');
    expect(body).toContain('# ADR-0007: Adopt opencode-memsearch as-is');
    expect(body).toContain('## Context');
    expect(body).toContain('## Decision');
    expect(body).toContain('## Consequences');
    expect(body).toContain('## Source');
    expect(body).toContain('sess_abc123');
  });

  test('handles missing sessionID', () => {
    const body = buildAdrBody({
      ordinal: 1,
      title: 't',
      text: 'x',
      machine: 'm',
    });
    expect(body).toContain('manual entry (no session id)');
  });
});

describe('/remember: createRememberCommand', () => {
  test('registers under command.remember with template + description', () => {
    const cmd = createRememberCommand();
    const config: { command?: Record<string, unknown> } = {};
    cmd.registerCommand(config);
    expect(config.command).toBeDefined();
    expect(config.command!.remember).toBeDefined();
    const r = config.command!.remember as {
      template: string;
      description: string;
    };
    expect(r.template).toContain('ADR-style');
    expect(r.description.length).toBeGreaterThan(20);
  });

  test('idempotent registration', () => {
    const cmd = createRememberCommand();
    const config: { command?: Record<string, unknown> } = {
      command: { remember: { template: 'existing', description: 'existing' } },
    };
    cmd.registerCommand(config);
    expect((config.command!.remember as { template: string }).template).toBe(
      'existing',
    );
  });

  test('handleCommandExecuteBefore ignores other commands', async () => {
    const cmd = createRememberCommand();
    const output = { parts: [{ type: 'text', text: 'untouched' }] };
    await cmd.handleCommandExecuteBefore(
      { command: 'something-else', sessionID: 's', arguments: 'x' },
      output,
    );
    expect(output.parts.length).toBe(1);
    expect(output.parts[0].text).toBe('untouched');
  });

  test('handleCommandExecuteBefore with empty args returns usage', async () => {
    const cmd = createRememberCommand();
    const output = { parts: [] as Array<{ type: string; text?: string }> };
    await cmd.handleCommandExecuteBefore(
      { command: 'remember', sessionID: 's', arguments: '   ' },
      output,
    );
    expect(output.parts.length).toBe(1);
    expect(output.parts[0].text).toContain('Usage:');
  });
});
