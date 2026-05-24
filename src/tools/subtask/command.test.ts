import { describe, expect, test } from 'bun:test';
import { createSubtaskCommandManager } from './command';
import { createSubtaskState } from './state';

function createContext() {
  return {
    directory: '/tmp/test',
    client: {},
  } as any;
}

describe('createSubtaskCommandManager', () => {
  test('registers the /subtask command', () => {
    const manager = createSubtaskCommandManager(
      createContext(),
      createSubtaskState(),
    );
    const config: Record<string, unknown> = {};

    manager.registerCommand(config);

    const commands = config.command as Record<string, { template: string }>;
    expect(commands.subtask).toBeDefined();
    expect(commands.subtask.template).toContain('focused subtask worker');
    expect(commands.subtask.template).toContain('Do not broaden it');
    expect(commands.subtask.template).toContain('$ARGUMENTS');
  });

  test('marks child sessions of subtask workers with the same source', () => {
    const state = createSubtaskState();
    state.markSession('ses_worker', 'ses_source');
    const manager = createSubtaskCommandManager(createContext(), state);

    manager.handleEvent({
      event: {
        type: 'session.created',
        properties: { info: { id: 'ses_child', parentID: 'ses_worker' } },
      },
    });

    expect(state.sourceFor('ses_child')).toBe('ses_source');
  });

  test('does not mark unrelated child sessions', () => {
    const state = createSubtaskState();
    const manager = createSubtaskCommandManager(createContext(), state);

    manager.handleEvent({
      event: {
        type: 'session.created',
        properties: { info: { id: 'ses_child', parentID: 'ses_parent' } },
      },
    });

    expect(state.isSubtaskSession('ses_child')).toBe(false);
  });

  test('unmarks deleted subtask sessions', () => {
    const state = createSubtaskState();
    state.markSession('ses_worker', 'ses_source');
    const manager = createSubtaskCommandManager(createContext(), state);

    manager.handleEvent({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'ses_worker' } },
      },
    });

    expect(state.isSubtaskSession('ses_worker')).toBe(false);
  });
});
