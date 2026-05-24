// Agent names — PMS pantheon
//
// Forked from oh-my-opencode-slim. The 5 slim specialist roles
// (explorer/librarian/oracle/designer/fixer) were renamed/repurposed to
// the PMS roster (researcher/judge/qa-reviewer/builder + new architect).
// observer, council, councillor are kept as infrastructure agents:
//   - observer: vision analysis (powers the image-hook)
//   - council:  multi-LLM consensus engine
//   - councillor: internal per-model executor for council
//
// Legacy slim names are accepted as aliases so existing user configs
// keep working — they get re-mapped to the PMS equivalents.
export const AGENT_ALIASES: Record<string, string> = {
  // legacy slim → PMS
  explore: 'researcher',
  explorer: 'researcher',
  librarian: 'researcher',
  oracle: 'judge',
  designer: 'qa-reviewer',
  fixer: 'builder',
  // primary alias
  orchestrator: 'project-manager',
};

export const SUBAGENT_NAMES = [
  'architect',
  'builder',
  'judge',
  'qa-reviewer',
  'researcher',
  'observer',
  'council',
  'councillor',
] as const;

export const ORCHESTRATOR_NAME = 'project-manager' as const;

export const ALL_AGENT_NAMES = [ORCHESTRATOR_NAME, ...SUBAGENT_NAMES] as const;

// Agent name type (for use in DEFAULT_MODELS)
export type AgentName = (typeof ALL_AGENT_NAMES)[number];

// Subagent delegation rules: which agents can spawn which subagents
// project-manager: can spawn all PMS specialists + observer + council
// architect/judge/researcher/qa-reviewer: leaf nodes (read-only or
//   single-step roles). Cannot delegate further.
// builder: leaf node — does the work, doesn't sub-delegate
// observer: leaf node — vision analysis only
// councillor: internal — only CouncilManager spawns it
export const ORCHESTRATABLE_AGENTS = [
  'architect',
  'builder',
  'judge',
  'qa-reviewer',
  'researcher',
  'observer',
  'council',
] as const;

/** Agents that cannot be disabled even if listed in disabled_agents config. */
export const PROTECTED_AGENTS = new Set(['project-manager', 'councillor']);

/**
 * Get the list of orchestratable agents, excluding any disabled agents.
 * This is used for delegation validation at runtime.
 */
export function getOrchestratableAgents(
  disabledAgents?: Set<string>,
): string[] {
  return ORCHESTRATABLE_AGENTS.filter((name) => !disabledAgents?.has(name));
}

export const SUBAGENT_DELEGATION_RULES: Record<AgentName, readonly string[]> = {
  'project-manager': ORCHESTRATABLE_AGENTS,
  architect: [],
  builder: [],
  judge: [],
  'qa-reviewer': [],
  researcher: [],
  observer: [],
  council: [],
  councillor: [],
};

// Default models for each agent. project-manager is undefined so its
// model resolves at runtime via the priority fallback chain from the
// user's pantheon config (preset.<name>.model array).
//
// Subscription-only slugs (no OpenCode Zen, no OpenRouter):
//   anthropic/*               — Claude Max OAuth (verified via `opencode models`)
//   xiaomi-token-plan-sgp/*   — Xiaomi token plan
//   minimax-coding-plan/*     — Minimax token plan (fallback)
//
// google/* skipped — gemini-cli OAuth not registered as opencode provider;
// architect/judge use claude-opus / claude-sonnet for diversity within
// the Claude Max subscription. Re-add Gemini once gemini-cli wrapper exists.
//
// xiaomi-token-plan-sgp/mimo-v2-flash returns empty silently — not used.
// All subagents → MiMo-V2.5-Pro primary (Anthropic clobbered role MDs even after
// plugin patches). Minimax fallback. project-manager → Opus via Max subscription
// (bridge handles that path).
export const DEFAULT_MODELS: Record<AgentName, string | undefined> = {
  'project-manager': undefined,
  architect: 'xiaomi-token-plan-sgp/mimo-v2.5-pro',
  builder: 'xiaomi-token-plan-sgp/mimo-v2.5-pro',
  judge: 'xiaomi-token-plan-sgp/mimo-v2.5-pro',
  'qa-reviewer': 'xiaomi-token-plan-sgp/mimo-v2.5-pro',
  researcher: 'xiaomi-token-plan-sgp/mimo-v2.5-pro',
  observer: 'xiaomi-token-plan-sgp/mimo-v2.5-pro',
  council: 'anthropic/claude-opus-4-7',
  councillor: 'xiaomi-token-plan-sgp/mimo-v2.5-pro',
};

// Polling configuration
export const POLL_INTERVAL_MS = 500;
export const POLL_INTERVAL_SLOW_MS = 1000;
export const POLL_INTERVAL_BACKGROUND_MS = 2000;

// Timeouts
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
export const MAX_POLL_TIME_MS = 5 * 60 * 1000; // 5 minutes
export const FALLBACK_FAILOVER_TIMEOUT_MS = 15_000;

// Subagent depth limits
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;

// Workflow reminders
export const PHASE_REMINDER_TEXT = `!IMPORTANT! Recall the workflow rules:
Understand → choose the best parallelized path based on your capabilities and agents delegation rules → recall session reuse rules → execute → verify.
If delegating, launch the specialist in the same turn you mention it !END!`;

// Tmux pane spawn delay (ms) — gives TmuxSessionManager time to create pane
export const TMUX_SPAWN_DELAY_MS = 500;

// Stagger delay (ms) between parallel councillor launches to avoid tmux collisions
export const COUNCILLOR_STAGGER_MS = 250;

// Polling stability
export const STABLE_POLLS_THRESHOLD = 3;

/** Agents that are disabled by default. Users must explicitly enable them
 *  by removing from disabled_agents and configuring an appropriate model. */
export const DEFAULT_DISABLED_AGENTS: string[] = ['observer'];
