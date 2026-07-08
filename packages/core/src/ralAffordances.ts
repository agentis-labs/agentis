import {
  AGENT_AFFORDANCES,
  type AdapterCapabilities,
  type AgentAffordance,
  type AgentRequirements,
} from './types/adapter.js';

export type RalAffordanceCategory = 'runtime' | 'workspace' | 'control' | 'protocol';

export interface RalAffordanceMetadata {
  key: AgentAffordance;
  label: string;
  shortLabel: string;
  description: string;
  category: RalAffordanceCategory;
  warning: string;
}

export const RAL_AFFORDANCE_METADATA: Record<AgentAffordance, RalAffordanceMetadata> = {
  browser: {
    key: 'browser',
    label: 'Native browser',
    shortLabel: 'Browser',
    description: 'Controls a live Chromium/browser runtime through the harness.',
    category: 'runtime',
    warning: 'Requires a connected runtime that advertises native browser control.',
  },
  codebaseIndex: {
    key: 'codebaseIndex',
    label: 'Code index',
    shortLabel: 'Index',
    description: 'Uses a harness-provided semantic code index.',
    category: 'workspace',
    warning: 'Requires a connected runtime that advertises code-index access.',
  },
  fileSystem: {
    key: 'fileSystem',
    label: 'Files',
    shortLabel: 'Files',
    description: 'Reads or writes files in the workspace through the runtime.',
    category: 'workspace',
    warning: 'Requires a connected runtime with workspace file access.',
  },
  terminal: {
    key: 'terminal',
    label: 'Terminal',
    shortLabel: 'Terminal',
    description: 'Runs shell commands or scripts through the runtime.',
    category: 'control',
    warning: 'Requires a connected runtime with terminal execution.',
  },
  computerUse: {
    key: 'computerUse',
    label: 'Computer use',
    shortLabel: 'Computer',
    description: 'Controls desktop applications through the host computer.',
    category: 'runtime',
    warning: 'Requires a connected runtime that advertises computer-use control.',
  },
  nativeMcp: {
    key: 'nativeMcp',
    label: 'Native MCP',
    shortLabel: 'MCP',
    description: 'Uses Agentis MCP tools directly from the harness.',
    category: 'protocol',
    warning: 'Requires a connected runtime with native MCP access.',
  },
};

export const RAL_AFFORDANCES = AGENT_AFFORDANCES.map((key) => RAL_AFFORDANCE_METADATA[key]);

/**
 * Supply-side affordances a runtime advertises for a given stored config WITHOUT
 * a live connection. Mirrors each adapter's `capabilities().affordances`, so the
 * canvas, readiness, and routing can reason about an agent's powers even while it
 * is offline. This MUST mirror each adapter's `capabilities().affordances`
 * (apps/api/src/adapters/*Adapter.ts) — change both together when a runtime's
 * advertised affordances change.
 */
export function configuredAffordances(
  adapterType: string | null | undefined,
  config?: Record<string, unknown> | null,
): Partial<Record<AgentAffordance, boolean>> {
  switch (adapterType) {
    case 'openclaw':
      return { browser: true, computerUse: true, terminal: true };
    case 'codex':
      // loading the Codex browser config (CodexAdapterConfig.browser).
      return config?.browser === true
        ? { fileSystem: true, terminal: true, browser: true, computerUse: true }
        : { fileSystem: true, terminal: true };
    case 'claude_code':
      return { fileSystem: true, terminal: true, nativeMcp: true };
    case 'cursor':
      return { codebaseIndex: true, fileSystem: true, terminal: true };
    case 'hermes_agent':
      return { fileSystem: true, terminal: true };
    case 'antigravity':
      return { fileSystem: true, terminal: true, nativeMcp: true };
    default:
      return {};
  }
}

/**
 * The ceiling of affordances a runtime COULD advertise with the right config —
 * lets the UI tell "this runtime can be ENABLED for X" apart from "this runtime
 * can NEVER do X". Only Codex has a latent affordance (native browser/computer-
 * use via its `browser` opt-in); every other runtime's ceiling equals its
 * configured set.
 */
export function potentialAffordances(adapterType: string | null | undefined): Partial<Record<AgentAffordance, boolean>> {
  if (adapterType === 'codex') return { fileSystem: true, terminal: true, browser: true, computerUse: true };
  return configuredAffordances(adapterType, null);
}

export interface RalAgentCapabilityRow {
  id: string;
  name: string;
  status?: string | null;
  adapterType?: string | null;
  config?: Record<string, unknown> | null;
  adapterCapabilities?: { affordances?: AdapterCapabilities['affordances'] | null } | null;
  /** Server-computed supply view; when absent it is derived from adapterType + config. */
  configuredAffordances?: Partial<Record<AgentAffordance, boolean>> | null;
  potentialAffordances?: Partial<Record<AgentAffordance, boolean>> | null;
}

/**
 * How an agent relates to a node's RAL requirement:
 * - `ready`          — connected AND its live runtime advertises everything required.
 * - `offline_capable`— its configured runtime would satisfy it, but it isn't connected now.
 * - `enablable`      — a config change (e.g. Codex native browser) could satisfy it.
 * - `incapable`      — this runtime can never provide a required affordance.
 */
export type RalMatchState = 'ready' | 'offline_capable' | 'enablable' | 'incapable';

export interface RalAgentMatchSummary {
  id: string;
  name: string;
  status?: string | null;
  adapterType?: string | null;
  satisfied: boolean;
  state: RalMatchState;
  provided: string[];
  providedKeys: AgentAffordance[];
  missing: string[];
  missingKeys: AgentAffordance[];
  /** Affordances this agent could gain via a config change (drives "Enable …" actions). */
  enablable: string[];
  enablableKeys: AgentAffordance[];
}

export function normalizeAgentRequirements(value: unknown): AgentRequirements {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const normalized: AgentRequirements = {};
  for (const key of AGENT_AFFORDANCES) {
    if (raw[key] === true) normalized[key] = true;
  }
  return normalized;
}

export function requiredAffordanceKeys(requirements: AgentRequirements | undefined): AgentAffordance[] {
  if (!requirements) return [];
  return AGENT_AFFORDANCES.filter((key) => requirements[key] === true);
}

export function hasAgentRequirements(requirements: AgentRequirements | undefined): boolean {
  return requiredAffordanceKeys(requirements).length > 0;
}

export function affordanceLabel(key: AgentAffordance): string {
  return RAL_AFFORDANCE_METADATA[key]?.label ?? key;
}

export function affordanceDescription(key: AgentAffordance): string {
  return RAL_AFFORDANCE_METADATA[key]?.description ?? key;
}

export function describeAgentRequirements(requirements: AgentRequirements | undefined): string {
  return requiredAffordanceKeys(requirements).map(affordanceLabel).join(', ');
}

export function agentSatisfiesRequirements(
  capabilities: Pick<AdapterCapabilities, 'affordances'> | null | undefined,
  requirements: AgentRequirements | undefined,
): boolean {
  const required = requiredAffordanceKeys(requirements);
  if (required.length === 0) return true;
  const affordances = capabilities?.affordances ?? {};
  return required.every((key) => affordances[key] === true);
}

export function withAgentRequirement(
  requirements: AgentRequirements,
  key: AgentAffordance,
  enabled: boolean,
): AgentRequirements | undefined {
  const next: AgentRequirements = { ...requirements };
  if (enabled) next[key] = true;
  else delete next[key];
  return hasAgentRequirements(next) ? next : undefined;
}

export function isConnectedAgent(agent: RalAgentCapabilityRow): boolean {
  const status = String(agent.status ?? '').toLowerCase();
  return status === 'online' || status === 'busy' || status === 'active' || status === 'running';
}

function rowConfiguredAffordances(agent: RalAgentCapabilityRow): Partial<Record<AgentAffordance, boolean>> {
  if (agent.configuredAffordances) return agent.configuredAffordances;
  if (agent.adapterType) return configuredAffordances(agent.adapterType, agent.config ?? null);
  return agent.adapterCapabilities?.affordances ?? {};
}

function rowPotentialAffordances(agent: RalAgentCapabilityRow): Partial<Record<AgentAffordance, boolean>> {
  if (agent.potentialAffordances) return agent.potentialAffordances;
  if (agent.adapterType) return potentialAffordances(agent.adapterType);
  return rowConfiguredAffordances(agent);
}

export function agentMatchSummary(
  agent: RalAgentCapabilityRow,
  requirements: AgentRequirements,
): RalAgentMatchSummary {
  const required = requiredAffordanceKeys(requirements);
  const live = agent.adapterCapabilities?.affordances ?? {};
  const configured = rowConfiguredAffordances(agent);
  const potential = rowPotentialAffordances(agent);
  const connected = isConnectedAgent(agent);

  const providedKeys = required.filter((key) => live[key] === true);
  const missingKeys = required.filter((key) => live[key] !== true);
  // Affordances the agent doesn't have configured but could turn on (e.g. Codex
  // native browser) — only the ones this requirement actually needs.
  const enablableKeys = required.filter((key) => configured[key] !== true && potential[key] === true);

  const liveSatisfied = connected && missingKeys.length === 0;
  const configuredSatisfied = required.every((key) => configured[key] === true);
  const potentialSatisfied = required.every((key) => potential[key] === true);

  let state: RalMatchState;
  if (liveSatisfied) state = 'ready';
  else if (configuredSatisfied) state = 'offline_capable';
  else if (potentialSatisfied) state = 'enablable';
  else state = 'incapable';

  return {
    id: agent.id,
    name: agent.name,
    status: agent.status ?? null,
    adapterType: agent.adapterType ?? null,
    satisfied: liveSatisfied,
    state,
    providedKeys,
    provided: providedKeys.map(affordanceLabel),
    missingKeys,
    missing: missingKeys.map(affordanceLabel),
    enablableKeys,
    enablable: enablableKeys.map(affordanceLabel),
  };
}

const RAL_MATCH_STATE_RANK: Record<RalMatchState, number> = {
  ready: 0,
  offline_capable: 1,
  enablable: 2,
  incapable: 3,
};

/**
 * Match a requirement against ALL workspace agents (not just connected ones),
 * ranked by how readily each could satisfy it: ready → offline_capable →
 * enablable → incapable. This is what lets the canvas show a real path to a
 * green node (connect this one, or enable native browser on that one) instead of
 * a dead "no connected runtime advertises X".
 */
export function agentRequirementMatches(
  agents: RalAgentCapabilityRow[],
  requirements: AgentRequirements,
): RalAgentMatchSummary[] {
  return agents
    .map((agent) => agentMatchSummary(agent, requirements))
    .sort((a, b) => RAL_MATCH_STATE_RANK[a.state] - RAL_MATCH_STATE_RANK[b.state] || a.name.localeCompare(b.name));
}

export function connectedAgentMatches(
  agents: RalAgentCapabilityRow[],
  requirements: AgentRequirements,
): RalAgentMatchSummary[] {
  return agents.filter(isConnectedAgent).map((agent) => agentMatchSummary(agent, requirements));
}



