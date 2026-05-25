import {
  type AgentName,
  getAgentOverride,
  McpNameSchema,
  type PluginConfig,
} from '.';

/** Default MCPs per agent — "*" means all MCPs, "!item" excludes specific MCPs.
 *
 *  PMS pantheon assignments:
 *    project-manager: all MCPs (full coordination access)
 *    researcher:      external docs/search (websearch, context7, grep_app)
 *                     — folds slim's old "librarian" capability
 *    architect:       none by default (research goes through researcher)
 *    builder:         none (focused on writing code)
 *    judge:           none (focused on review)
 *    qa-reviewer:     none (focused on evidence)
 *    observer:        none (visual analysis is local)
 *    council/councillor: none (each councillor inherits its model's capabilities)
 */

export const DEFAULT_AGENT_MCPS: Record<AgentName, string[]> = {
  'project-manager': ['*', '!context7'],
  architect: [],
  builder: [],
  judge: [],
  'qa-reviewer': [],
  researcher: ['websearch', 'context7', 'grep_app'],
  synthesizer: [],
  triage: [],
  observer: [],
  council: [],
  councillor: [],
};

/**
 * Parse a list with wildcard and exclusion syntax.
 */
export function parseList(items: string[], allAvailable: string[]): string[] {
  if (!items || items.length === 0) {
    return [];
  }

  const allow = items.filter((i) => !i.startsWith('!'));
  const deny = items.filter((i) => i.startsWith('!')).map((i) => i.slice(1));

  if (deny.includes('*')) {
    return [];
  }

  if (allow.includes('*')) {
    return allAvailable.filter((item) => !deny.includes(item));
  }

  return allow.filter(
    (item) => !deny.includes(item) && allAvailable.includes(item),
  );
}

/**
 * Get available MCP names from schema and config.
 */
export function getAvailableMcpNames(config?: PluginConfig): string[] {
  const builtinMcps = McpNameSchema.options;
  const disabled = new Set(config?.disabled_mcps ?? []);
  return builtinMcps.filter((name) => !disabled.has(name));
}

/**
 * Get the MCP list for an agent (from config or defaults).
 */
export function getAgentMcpList(
  agentName: string,
  config?: PluginConfig,
): string[] {
  const agentConfig = getAgentOverride(config, agentName);
  if (agentConfig?.mcps !== undefined) {
    return agentConfig.mcps;
  }

  const defaultMcps = DEFAULT_AGENT_MCPS[agentName as AgentName];
  return defaultMcps ?? [];
}
