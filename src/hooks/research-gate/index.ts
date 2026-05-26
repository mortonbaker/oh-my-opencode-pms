/**
 * research-gate — deterministic enforcement of the SOCRR/BLUF response
 * discipline (docs/RESPONSE_TEMPLATE.md).
 *
 * RULE the operator set: "If you ask me a question and you haven't already
 * researched best practices, that should never make it to the surface."
 *
 * V2 (auto-correction) — primary path:
 *   - Listens for `session.idle` events.
 *   - When the most recent assistant message contains a question AND lacks
 *     `## What I researched`, calls `client.session.prompt(...)` with a
 *     silent "redo this turn" reminder. The model immediately produces a
 *     follow-up turn that researches + responds properly.
 *   - HARD-CAPPED at 1 auto-correction per session. After that, the V1
 *     fallback (below) is the only enforcement, so the operator sees the
 *     violation directly.
 *
 * V1 (post-facto reminder) — fallback path:
 *   - Hook on `experimental.chat.messages.transform`. Fires when the user
 *     sends their next turn. If V2 didn't already fire (or has been
 *     consumed), prepends a `<system-reminder>` so the orchestrator's
 *     next response acknowledges and self-corrects.
 *
 * EVERY violation is logged to ~/.local/share/agent-memory/events.jsonl
 * as `type=research_gate_violation` so weekly compaction surfaces drift.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';

interface MessageInfo {
  role: string;
  agent?: string;
  sessionID?: string;
}

interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

interface TransformInput {
  // Empty per opencode SDK convention; we read from output.messages
  [key: string]: unknown;
}

interface TransformOutput {
  messages: MessageWithParts[];
}

interface EventInput {
  event: {
    type: string;
    properties?: Record<string, unknown>;
  };
}

const HOOK_NAME = 'research-gate';
const REQUIRED_SECTION = '## What I researched';

const EVENTS_LOG_DIR = join(homedir(), '.local', 'share', 'agent-memory');
const EVENTS_LOG_FILE = join(EVENTS_LOG_DIR, 'events.jsonl');

const VIOLATION_REMINDER =
  '<system-reminder>\n' +
  'RESEARCH-GATE VIOLATION DETECTED.\n' +
  '\n' +
  'Your previous response asked the operator one or more questions, but it\n' +
  'did NOT contain a `## What I researched` section. The operator has set a\n' +
  'hard rule: questions without prior research are not allowed to surface.\n' +
  '\n' +
  'Required action on your NEXT response, before doing anything else:\n' +
  '1. If the question is answerable via tool calls (read/grep/glob/ls/web\n' +
  '   /docs/skill), CANCEL the question and do the tool call now.\n' +
  '2. If the question is answerable via canonical best-practice lookup,\n' +
  '   dispatch @researcher with a focused query, then surface the call\n' +
  '   with `## What I researched` + `## BLUF` populated per\n' +
  '   docs/RESPONSE_TEMPLATE.md.\n' +
  '3. If the question genuinely requires operator intent (irreversible,\n' +
  '   policy-level), re-phrase as a BLUF call with a default: "I will do\n' +
  '   X unless you stop me" — NOT an open question.\n' +
  '\n' +
  'Acknowledge this reminder explicitly. Do NOT pretend it did not arrive.\n' +
  '</system-reminder>';

// V2 auto-correction prompt — injected via client.session.prompt() to
// trigger an immediate follow-up assistant turn. Distinct from the V1
// reminder because this prompt asks the model to REDO the turn silently,
// not acknowledge a violation.
const AUTO_CORRECTION_PROMPT =
  '<system-reminder>\n' +
  'RESEARCH-GATE AUTO-CORRECTION (one-shot, fires before operator sees your\n' +
  'previous response).\n' +
  '\n' +
  'Your immediately-previous response asked the operator a question without\n' +
  'a `## What I researched` section. Per the operator\'s hard rule, that is\n' +
  'not allowed to surface. You get exactly ONE auto-redo: this turn.\n' +
  '\n' +
  'Required action NOW (no preamble, no apology):\n' +
  '1. Identify the question(s) you asked.\n' +
  '2. For each, run the tool calls (read/grep/glob/ls/web/docs/skill) needed\n' +
  '   to answer it yourself, OR confirm via lookup that it truly requires\n' +
  '   operator intent (irreversible, policy-level).\n' +
  '3. Reply with `## What I researched` (cite specific files / URLs / docs\n' +
  '   touched) and `## BLUF` (the answer + a defaulted action like "I will\n' +
  '   do X unless you stop me"), NOT another open question.\n' +
  '\n' +
  'This auto-correction is one-shot per session. If you violate again, the\n' +
  'V1 fallback fires and the operator sees the violation reminder directly.\n' +
  '</system-reminder>';

/**
 * Strip code blocks and inline code so `?` inside a code example
 * doesn't trigger a false positive.
 */
function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
}

/**
 * Detect if assistant text contains a question directed at the operator.
 * False-positive guards:
 *   - skip `?` inside fenced code blocks and inline code
 *   - skip `?` that is part of a URL or query string
 *   - skip rhetorical "?" inside the LITERAL system-reminder (this hook's
 *     own injected text)
 */
export function detectQuestionToOperator(text: string): boolean {
  if (!text) return false;
  // Skip if this IS the violation reminder or auto-correction echoing back
  if (text.includes('RESEARCH-GATE VIOLATION DETECTED')) return false;
  if (text.includes('RESEARCH-GATE AUTO-CORRECTION')) return false;

  const cleaned = stripCodeBlocks(text);

  // Remove URLs (which often contain `?`)
  const noUrls = cleaned.replace(/https?:\/\/\S+/g, '');

  // Now look for any `?` that's followed by whitespace or end-of-string
  // and preceded by at least one alphanumeric (i.e. a real sentence ending)
  return /[A-Za-z0-9][^?\n]*\?(\s|$)/.test(noUrls);
}

/**
 * Check whether the assistant message claims to have researched.
 */
export function hasResearchSection(text: string): boolean {
  return text.includes(REQUIRED_SECTION);
}

/**
 * Extract the text content from a MessageWithParts.
 */
function extractText(msg: MessageWithParts): string {
  return msg.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n');
}

/**
 * Append a violation record to the cross-machine events log.
 * Best-effort: never throw, never block the chat path.
 */
async function logViolation(detail: {
  sessionID?: string;
  agent?: string;
  excerpt: string;
  tier: 'v1-reminder' | 'v2-auto-correction';
}): Promise<void> {
  try {
    await mkdir(EVENTS_LOG_DIR, { recursive: true });
    const row = {
      ts: new Date().toISOString(),
      machine: process.env.HOSTNAME || process.env.COMPUTERNAME || 'unknown',
      agent: detail.agent || 'unknown',
      session: detail.sessionID || 'unknown',
      type: 'research_gate_violation',
      tier: detail.tier,
      text: detail.excerpt.slice(0, 500),
    };
    await appendFile(EVENTS_LOG_FILE, `${JSON.stringify(row)}\n`, {
      flag: 'a',
    });
  } catch {
    // best-effort log; do not interfere with chat path
  }
}

/**
 * Per-session state for V2 auto-correction. Tracks whether this session
 * has already consumed its one-shot auto-correction.
 *
 * Unbounded growth in theory; in practice opencode sessions are bounded
 * per process lifetime, and a Map of sessionIDs (~36 chars) is negligible.
 */
interface SessionState {
  autoCorrected: boolean;
  // Set while an auto-correction prompt is in flight, to avoid duplicate
  // fires from rapid back-to-back idle events.
  injectionInFlight: boolean;
}

/**
 * SDK client shape used by V2. Narrowed to just what we need.
 */
interface SessionClient {
  messages: (args: {
    path: { id: string };
  }) => Promise<{ data?: unknown }>;
  prompt: (args: {
    path: { id: string };
    body: {
      parts: Array<{ type: string; text: string }>;
      noReply?: boolean;
    };
  }) => Promise<unknown>;
}

interface NarrowCtx {
  client: { session: SessionClient };
}

/**
 * Public: create the research-gate hook.
 *
 * @param ctx - opencode plugin input (gives us `client.session.prompt`)
 *              for V2 auto-correction. If omitted, V2 is disabled and
 *              only the V1 transform path runs (used by unit tests).
 */
export function createResearchGateHook(ctx?: NarrowCtx | PluginInput) {
  const sessionStates = new Map<string, SessionState>();

  function getSessionState(sessionID: string): SessionState {
    let s = sessionStates.get(sessionID);
    if (!s) {
      s = { autoCorrected: false, injectionInFlight: false };
      sessionStates.set(sessionID, s);
    }
    return s;
  }

  /**
   * V2 — fires on `session.idle`. Checks the most recent assistant message
   * via the SDK; if it violates the gate and this session hasn't already
   * been auto-corrected, injects a redo prompt.
   */
  async function handleEvent(input: EventInput): Promise<void> {
    if (!ctx) return;
    const { event } = input;
    if (!event) return;

    const properties = event.properties ?? {};
    const isIdle =
      event.type === 'session.idle' ||
      (event.type === 'session.status' &&
        (properties.status as { type?: string } | undefined)?.type === 'idle');
    if (!isIdle) return;

    const sessionID = properties.sessionID as string | undefined;
    if (!sessionID) return;

    const state = getSessionState(sessionID);

    // Hard cap: one-shot per session
    if (state.autoCorrected) return;

    // Deduplicate: don't fire while one is already in flight
    if (state.injectionInFlight) return;

    // Fetch messages via SDK
    let messages: MessageWithParts[];
    try {
      const result = await ctx.client.session.messages({
        path: { id: sessionID },
      });
      messages = (result?.data as MessageWithParts[]) ?? [];
    } catch {
      return; // best-effort; never block
    }
    if (messages.length === 0) return;

    // Find most recent assistant message
    let lastAssistant: MessageWithParts | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.info?.role === 'assistant') {
        lastAssistant = messages[i];
        break;
      }
    }
    if (!lastAssistant) return;

    const text = extractText(lastAssistant);
    if (!detectQuestionToOperator(text)) return;
    if (hasResearchSection(text)) return;

    // Violation. Auto-correct.
    state.autoCorrected = true;
    state.injectionInFlight = true;

    void logViolation({
      sessionID,
      agent: lastAssistant.info.agent,
      excerpt: text.slice(0, 500),
      tier: 'v2-auto-correction',
    });

    try {
      await ctx.client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: 'text', text: AUTO_CORRECTION_PROMPT }],
        },
      });
    } catch {
      // best-effort; if injection fails, V1 fallback catches it on next user turn
    } finally {
      state.injectionInFlight = false;
    }
  }

  return {
    /**
     * V1 — fallback enforcement on the next outgoing chat transform.
     * Only fires if V2 didn't already inject for this session
     * (i.e. the auto-correction was already consumed, so a SECOND
     * violation in the same session falls through to V1).
     */
    'experimental.chat.messages.transform': async (
      _input: TransformInput,
      output: TransformOutput,
    ): Promise<void> => {
      const { messages } = output;
      if (messages.length === 0) return;

      // Find the most recent assistant message
      let lastAssistantIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].info.role === 'assistant') {
          lastAssistantIdx = i;
          break;
        }
      }
      if (lastAssistantIdx === -1) return;

      const text = extractText(messages[lastAssistantIdx]);
      const askedQuestion = detectQuestionToOperator(text);
      const claimedResearch = hasResearchSection(text);

      // VIOLATION: asked a question without research section
      if (askedQuestion && !claimedResearch) {
        // Log to events.jsonl (best-effort)
        void logViolation({
          sessionID: messages[lastAssistantIdx].info.sessionID,
          agent: messages[lastAssistantIdx].info.agent,
          excerpt: text.slice(0, 500),
          tier: 'v1-reminder',
        });

        // Inject the reminder as a fresh user-role system reminder
        // so the orchestrator sees it at the top of the next turn.
        // Following the same shape as phase-reminder injection:
        const reminderMessage: MessageWithParts = {
          info: {
            role: 'user',
            sessionID: messages[lastAssistantIdx].info.sessionID,
          },
          parts: [{ type: 'text', text: VIOLATION_REMINDER }],
        };

        // Insert right after the offending assistant message so the model
        // sees it immediately preceding any new user input.
        messages.splice(lastAssistantIdx + 1, 0, reminderMessage);
      }
    },

    /**
     * V2 — auto-correction on session.idle. Wired from src/index.ts
     * inside the unified event handler.
     */
    handleEvent,
  };
}

// Re-export internals for testing
export const __testing = {
  HOOK_NAME,
  REQUIRED_SECTION,
  VIOLATION_REMINDER,
  AUTO_CORRECTION_PROMPT,
  EVENTS_LOG_FILE,
  detectQuestionToOperator,
  hasResearchSection,
  stripCodeBlocks,
  extractText,
};
