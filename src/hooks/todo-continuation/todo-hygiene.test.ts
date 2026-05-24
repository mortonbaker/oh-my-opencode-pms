import { describe, expect, test } from 'bun:test';
import {
  createTodoHygiene,
  TODO_FINAL_ACTIVE_REMINDER,
  TODO_HYGIENE_REMINDER,
} from './todo-hygiene';

function createState(
  overrides?: Partial<{
    hasOpenTodos: boolean;
    openCount: number;
    inProgressCount: number;
    pendingCount: number;
  }>,
) {
  return {
    hasOpenTodos: overrides?.hasOpenTodos ?? true,
    openCount: overrides?.openCount ?? 1,
    inProgressCount: overrides?.inProgressCount ?? 0,
    pendingCount: overrides?.pendingCount ?? 1,
  };
}

describe('todo hygiene', () => {
  test('new request clears pending state from the previous turn', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => createState(),
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    hook.handleRequestStart({ sessionID: 's1' });

    expect(hook.getPendingReminder('s1')).toBeNull();

    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });

    expect(hook.getPendingReminder('s1')).toBe(TODO_HYGIENE_REMINDER);
  });

  test('does not arm before the current request calls todowrite', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => createState(),
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });

    expect(hook.getPendingReminder('s1')).toBeNull();
  });

  test('arms after the first relevant tool following todowrite', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => createState(),
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });

    expect(hook.getPendingReminder('s1')).toBe(TODO_HYGIENE_REMINDER);
    expect(hook.getPendingReminder('s1')).toBe(TODO_HYGIENE_REMINDER);

    hook.handleRequestStart({ sessionID: 's1' });
    expect(hook.getPendingReminder('s1')).toBeNull();
  });

  test('upgrades to final-active on a later round', async () => {
    let call = 0;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        call++;
        if (call <= 3) return createState();
        return createState({
          openCount: 1,
          inProgressCount: 1,
          pendingCount: 0,
        });
      },
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    expect(hook.getPendingReminder('s1')).toBe(TODO_HYGIENE_REMINDER);

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    expect(hook.getPendingReminder('s1')).toBe(TODO_FINAL_ACTIVE_REMINDER);
  });

  test('todowrite can arm final-active immediately', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () =>
        createState({
          openCount: 1,
          inProgressCount: 1,
          pendingCount: 0,
        }),
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });

    expect(hook.getPendingReminder('s1')).toBe(TODO_FINAL_ACTIVE_REMINDER);
  });

  test('once final-active is armed, later tools skip extra todo lookups in the same round', async () => {
    let calls = 0;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        calls++;
        return createState({
          openCount: 1,
          inProgressCount: 1,
          pendingCount: 0,
        });
      },
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'grep', sessionID: 's1' });

    expect(calls).toBe(1);
  });

  test('shouldInject rejection prevents reset lookup and reminders', async () => {
    let calls = 0;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        calls++;
        return createState({
          openCount: 1,
          inProgressCount: 1,
          pendingCount: 0,
        });
      },
      shouldInject: () => false,
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });

    expect(calls).toBe(0);
    expect(hook.getPendingReminder('s1')).toBeNull();
  });

  test('reading a pending reminder does not inspect todos', async () => {
    let fail = false;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        if (fail) throw new Error('boom');
        return createState();
      },
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    fail = true;

    expect(hook.getPendingReminder('s1')).toBe(TODO_HYGIENE_REMINDER);
  });

  test('todowrite lookup failures do not disable the current request', async () => {
    let fail = false;
    const hook = createTodoHygiene({
      getTodoState: async () => {
        if (fail) throw new Error('boom');
        return createState();
      },
    });

    hook.handleRequestStart({ sessionID: 's1' });
    fail = true;
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    fail = false;
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });

    expect(hook.getPendingReminder('s1')).toBe(TODO_HYGIENE_REMINDER);
  });

  test('session.deleted clears all state', async () => {
    const hook = createTodoHygiene({
      getTodoState: async () => createState(),
    });

    hook.handleRequestStart({ sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'todowrite', sessionID: 's1' });
    await hook.handleToolExecuteAfter({ tool: 'read', sessionID: 's1' });
    hook.handleEvent({
      type: 'session.deleted',
      properties: { info: { id: 's1' } },
    });

    expect(hook.getPendingReminder('s1')).toBeNull();
  });
});
