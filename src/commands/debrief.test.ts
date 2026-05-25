import { describe, expect, test } from 'bun:test';
import { __testing, buildDebriefBody, createDebriefCommand } from './debrief';

const { REMINDER_FOR_ORCHESTRATOR } = __testing;

describe('/debrief: buildDebriefBody', () => {
  test('emits frontmatter + required sections', () => {
    const body = buildDebriefBody({
      sessionID: 'sess_abc123',
      hoursBack: 6,
      operatorNotes: 'note one',
      events: [
        {
          ts: '2026-05-25T20:00:00.000Z',
          machine: 'atlas01',
          type: 'pattern',
          text: 'A pattern that worked',
        },
      ],
      decisions: ['0007-foo.md'],
      machine: 'atlas01',
    });
    expect(body).toContain('session: sess_abc123');
    expect(body).toContain('type: session_debrief');
    expect(body).toContain('# Session debrief');
    expect(body).toContain('## Operator notes');
    expect(body).toContain('note one');
    expect(body).toContain('## Recent events by type');
    expect(body).toContain('### pattern (1)');
    expect(body).toContain('A pattern that worked');
    expect(body).toContain('## ADR decisions in window');
    expect(body).toContain('0007-foo.md');
    expect(body).toContain('## Classification checklist');
  });

  test('handles empty events / no operator notes gracefully', () => {
    const body = buildDebriefBody({
      sessionID: 's',
      hoursBack: 1,
      operatorNotes: '',
      events: [],
      decisions: [],
      machine: 'm',
    });
    expect(body).not.toContain('## Operator notes');
    expect(body).toContain('_(no events in window)_');
    expect(body).not.toContain('## ADR decisions in window');
  });

  test('long event text gets truncated', () => {
    const longText = 'x'.repeat(200);
    const body = buildDebriefBody({
      sessionID: 's',
      hoursBack: 1,
      operatorNotes: '',
      events: [{ ts: '2026-05-25T00:00:00Z', machine: 'm', type: 'fact', text: longText }],
      decisions: [],
      machine: 'm',
    });
    expect(body).toContain('...');
    expect(body).not.toContain(longText);
  });
});

describe('/debrief: createDebriefCommand', () => {
  test('registers under command.debrief', () => {
    const cmd = createDebriefCommand();
    const config: { command?: Record<string, unknown> } = {};
    cmd.registerCommand(config);
    expect(config.command).toBeDefined();
    expect(config.command!.debrief).toBeDefined();
    const r = config.command!.debrief as { template: string; description: string };
    expect(r.template).toContain('debrief');
    expect(r.description).toContain('debrief');
  });

  test('idempotent registration', () => {
    const cmd = createDebriefCommand();
    const config: { command?: Record<string, unknown> } = {
      command: { debrief: { template: 'existing' } },
    };
    cmd.registerCommand(config);
    expect((config.command!.debrief as { template: string }).template).toBe('existing');
  });

  test('handleCommandExecuteBefore ignores other commands', async () => {
    const cmd = createDebriefCommand();
    const output = { parts: [{ type: 'text', text: 'untouched' }] };
    await cmd.handleCommandExecuteBefore(
      { command: 'something-else', sessionID: 's', arguments: '' },
      output,
    );
    expect(output.parts.length).toBe(1);
    expect(output.parts[0].text).toBe('untouched');
  });
});

describe('/debrief: REMINDER_FOR_ORCHESTRATOR', () => {
  test('contains the routing instructions for next turn', () => {
    expect(REMINDER_FOR_ORCHESTRATOR).toContain('system-reminder');
    expect(REMINDER_FOR_ORCHESTRATOR).toContain('Auto-write each classified item');
    expect(REMINDER_FOR_ORCHESTRATOR).toContain('agent-mem append');
    expect(REMINDER_FOR_ORCHESTRATOR).toContain('retroactively delete');
  });
});
