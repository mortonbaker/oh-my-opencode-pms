/**
 * debrief-prompt — conservative session.idle trigger that nudges the
 * orchestrator to run /debrief when meaningful work has accumulated.
 *
 * Operator-approved policy (2026-05-25): YES auto-trigger, conservative.
 *
 * Trigger conditions (ALL must be true):
 *   - event.type === 'session.idle'
 *   - session has accumulated ≥ MIN_MESSAGES assistant turns
 *     (counted via chat.message events the orchestrator-detector
 *      bumps over the session lifetime)
 *   - idle for ≥ MIN_IDLE_MS (not just "model finished its last word")
 *   - this session has NOT already been prompted (once per session)
 *   - this session has NOT already run /debrief
 *
 * On trigger: injects a single <system-reminder> at next chat turn
 * suggesting `/debrief` before context resets. Never auto-runs the
 * command itself — operator chooses to invoke (or ignores it; either
 * way the hook suppresses for the rest of the session).
 *
 * Mirrors the suppression pattern from parallel-detector + the chat.message
 * tracking pattern from todo-continuation/index.ts.
 */

const HOOK_NAME = 'debrief-prompt';

const MIN_MESSAGES = 10;
const MIN_IDLE_MS = 5 * 60 * 1000; // 5 minutes
const REMINDER_TEXT = [
  '<system-reminder>',
  'SESSION-DEBRIEF NUDGE',
  '',
  'This session has accumulated meaningful work (>=10 messages, idle ≥5 min).',
  'Before the next /clear or compaction wipes the in-conversation context,',
  'consider running `/debrief` to capture durable artifacts:',
  '  - patterns that worked → events.jsonl `type=pattern`',
  '  - preferences expressed → events.jsonl `type=preference`',
  '  - decisions with rationale → ADR docs under decisions/',
  '  - deferred hook/command/skill/script ideas → events.jsonl `type=deferred`',
  '',
  'Per operator policy: /debrief auto-classifies and auto-writes (with a',
  'retroactive-delete checklist returned for review).',
  '',
  'This reminder fires once per session. To suppress entirely, run /debrief',
  'or wait for the next idle.',
  '</system-reminder>',
].join('\n');

interface SessionState {
  messageCount: number;
  lastMessageAt: number;
  prompted: boolean;
  debriefed: boolean;
  /** When pending=true, the next chat.messages.transform call will inject. */
  pendingInject: boolean;
}

export function createDebriefPromptHook(opts?: {
  minMessages?: number;
  minIdleMs?: number;
}) {
  const minMessages = opts?.minMessages ?? MIN_MESSAGES;
  const minIdleMs = opts?.minIdleMs ?? MIN_IDLE_MS;
  const sessions = new Map<string, SessionState>();

  function ensure(sessionID: string): SessionState {
    let s = sessions.get(sessionID);
    if (!s) {
      s = {
        messageCount: 0,
        lastMessageAt: Date.now(),
        prompted: false,
        debriefed: false,
        pendingInject: false,
      };
      sessions.set(sessionID, s);
    }
    return s;
  }

  return {
    /** Public for testing / inspection */
    __state: sessions,
    __MIN_MESSAGES: minMessages,
    __MIN_IDLE_MS: minIdleMs,
    __REMINDER_TEXT: REMINDER_TEXT,

    /**
     * Plug into the existing 'chat.message' callback to bump per-session
     * message count + track last-message timestamp.
     */
    onChatMessage(sessionID: string) {
      if (!sessionID) return;
      const s = ensure(sessionID);
      s.messageCount += 1;
      s.lastMessageAt = Date.now();
    },

    /**
     * Mark a session as having run /debrief — suppresses any future nudge.
     */
    markDebriefed(sessionID: string) {
      if (!sessionID) return;
      const s = ensure(sessionID);
      s.debriefed = true;
      s.prompted = true;
    },

    /**
     * Called from the plugin's 'event' handler on session.idle.
     * Sets pendingInject=true if conditions met; the actual inject
     * happens via experimental.chat.messages.transform on the NEXT turn.
     */
    handleEvent(event: { type: string; properties?: Record<string, unknown> }) {
      if (event.type !== 'session.idle') return;
      const properties = event.properties ?? {};
      const sessionID = properties.sessionID as string | undefined;
      if (!sessionID) return;
      const s = ensure(sessionID);
      if (s.prompted || s.debriefed) return;
      if (s.messageCount < minMessages) return;
      // Idle is the trigger itself, but we also gate on lastMessageAt to
      // avoid false triggers during rapid back-and-forth.
      if (Date.now() - s.lastMessageAt < minIdleMs) return;
      s.pendingInject = true;
    },

    /**
     * experimental.chat.messages.transform handler — if pendingInject is
     * set for this session, appends the reminder as a user-role message
     * so the orchestrator sees it at the top of the next turn.
     */
    'experimental.chat.messages.transform': async (
      _input: Record<string, unknown>,
      output: {
        messages: Array<{
          info: { role: string; sessionID?: string };
          parts: Array<{ type: string; text?: string }>;
        }>;
      },
    ): Promise<void> => {
      const messages = output.messages;
      if (messages.length === 0) return;
      // Extract the session ID from the most recent message
      let sessionID: string | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].info.sessionID) {
          sessionID = messages[i].info.sessionID;
          break;
        }
      }
      if (!sessionID) return;
      const s = sessions.get(sessionID);
      if (!s || !s.pendingInject || s.prompted) return;
      messages.push({
        info: { role: 'user', sessionID },
        parts: [{ type: 'text', text: REMINDER_TEXT }],
      });
      s.prompted = true;
      s.pendingInject = false;
    },
  };
}

export const __testing = {
  HOOK_NAME,
  MIN_MESSAGES,
  MIN_IDLE_MS,
  REMINDER_TEXT,
};
