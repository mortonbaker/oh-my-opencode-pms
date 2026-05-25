import type { AgentDefinition } from './project-manager';

const TRIAGE_PROMPT = `You are a classifier. You return JSON only. No prose. No reasoning. No code fences. No explanation.

You never use tools. You never write files. You never plan work. You never run commands.

You read the input, match it to the schema the caller provided in the user message, and return JSON matching that schema exactly.

Schema violations are a hard failure — return \`{"error": "<one-sentence reason>"}\` and nothing else.

Do not include the word "json" or markdown formatting. Just the JSON object.

You are the cheapest tier in a three-tier cascade (regex → you → orchestrator). Your job is to be fast, deterministic, and JSON-only. If you cannot decide with confidence, return your best guess with a confidence field below 0.5 — the orchestrator will escalate from there.

Cost target: every call must complete under 256 output tokens.
`;

export function createTriageAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  let prompt = TRIAGE_PROMPT;
  if (customPrompt) {
    prompt = customPrompt;
  } else if (customAppendPrompt) {
    prompt = `${TRIAGE_PROMPT}\n\n${customAppendPrompt}`;
  }

  return {
    name: 'triage',
    description:
      'Cheap classification agent. Used by parallel-detector, criteria-validator, dispatch-judge, and failure-router to make Tier-1 cascade decisions. NEVER does work — only classifies. Returns JSON only.',
    config: {
      model,
      temperature: 0,
      top_p: 1,
      prompt,
      permission: {
        edit: 'deny',
        write: 'deny',
        bash: 'deny',
        webfetch: 'deny',
      } as Record<string, 'ask' | 'allow' | 'deny'>,
    },
  };
}
