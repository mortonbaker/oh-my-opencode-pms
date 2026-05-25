/**
 * research-gate — deterministic post-turn enforcement of the
 * SOCRR/BLUF response discipline (docs/RESPONSE_TEMPLATE.md).
 *
 * RULE the operator set: "If you ask me a question and you haven't already
 * researched best practices, that should never make it to the surface."
 *
 * IMPLEMENTATION: this hook scans the most recent assistant message at the
 * top of every outgoing chat-request transform. If the message asks the
 * operator a question (contains a top-level `?` outside code blocks) AND
 * lacks a `## What I researched` section, an emergency
 * <system-reminder> is prepended to the outgoing messages array. The
 * orchestrator sees the reminder on its next turn and self-corrects by
 * either (a) deleting the question (it was unnecessary) or (b) running
 * the research now via @researcher and surfacing the answer with the
 * required section.
 *
 * EVERY violation is logged to ~/.local/share/agent-memory/events.jsonl
 * as `type=research_gate_violation` so weekly compaction surfaces drift.
 *
 * This is V1: post-facto detection + auto-correction reminder. V2 may
 * upgrade to hard-block at `chat.params` once the SDK exposes response
 * rewriting.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  // Skip if this IS the violation reminder echoing back
  if (text.includes('RESEARCH-GATE VIOLATION DETECTED')) return false;

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
}): Promise<void> {
  try {
    await mkdir(EVENTS_LOG_DIR, { recursive: true });
    const row = {
      ts: new Date().toISOString(),
      machine: process.env.HOSTNAME || process.env.COMPUTERNAME || 'unknown',
      agent: detail.agent || 'unknown',
      session: detail.sessionID || 'unknown',
      type: 'research_gate_violation',
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
 * Public: create the experimental.chat.messages.transform handler.
 */
export function createResearchGateHook() {
  return {
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
  };
}

// Re-export internals for testing
export const __testing = {
  HOOK_NAME,
  REQUIRED_SECTION,
  VIOLATION_REMINDER,
  EVENTS_LOG_FILE,
  detectQuestionToOperator,
  hasResearchSection,
  stripCodeBlocks,
  extractText,
};
