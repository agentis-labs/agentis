import {
  AGENT_AFFORDANCES as CORE_AGENT_AFFORDANCES,
  type AgentAffordance as AgentAffordanceKey,
  type AgentRequirements,
} from '@agentis/core';

const AFFORDANCE_LABELS: Record<AgentAffordanceKey, string> = {
  browser: 'Browser',
  codebaseIndex: 'Code index',
  fileSystem: 'Files',
  terminal: 'Terminal',
  computerUse: 'Computer use',
  nativeMcp: 'MCP',
};

export const AGENT_AFFORDANCES = CORE_AGENT_AFFORDANCES.map((key) => ({
  key,
  label: AFFORDANCE_LABELS[key],
}));

export type { AgentAffordanceKey, AgentRequirements };

export interface AdapterCapabilitiesLite {
  affordances?: Partial<Record<AgentAffordanceKey, boolean>> | null;
}

export interface AgentCapabilityRow {
  id: string;
  name: string;
  status?: string | null;
  adapterType?: string | null;
  adapterCapabilities?: AdapterCapabilitiesLite | null;
}

export interface AgentMatchSummary {
  id: string;
  name: string;
  status?: string | null;
  satisfied: boolean;
  provided: string[];
  missing: string[];
}

export function normalizeAgentRequirements(value: unknown): AgentRequirements {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const normalized: AgentRequirements = {};
  for (const affordance of AGENT_AFFORDANCES) {
    if (raw[affordance.key] === true) normalized[affordance.key] = true;
  }
  return normalized;
}

export function requiredAffordanceKeys(requirements: AgentRequirements): AgentAffordanceKey[] {
  return AGENT_AFFORDANCES.map((a) => a.key).filter((key) => requirements[key] === true);
}

export function affordanceLabel(key: AgentAffordanceKey): string {
  return AGENT_AFFORDANCES.find((affordance) => affordance.key === key)?.label ?? key;
}

export function hasAgentRequirements(requirements: AgentRequirements): boolean {
  return requiredAffordanceKeys(requirements).length > 0;
}

export function withRequirement(
  requirements: AgentRequirements,
  key: AgentAffordanceKey,
  enabled: boolean,
): AgentRequirements | undefined {
  const next: AgentRequirements = { ...requirements };
  if (enabled) next[key] = true;
  else delete next[key];
  return hasAgentRequirements(next) ? next : undefined;
}

export function isConnectedAgent(agent: AgentCapabilityRow): boolean {
  const status = String(agent.status ?? '').toLowerCase();
  return status === 'online' || status === 'busy' || status === 'active' || status === 'running';
}

export function agentMatchSummary(agent: AgentCapabilityRow, requirements: AgentRequirements): AgentMatchSummary {
  const required = requiredAffordanceKeys(requirements);
  const affordances = agent.adapterCapabilities?.affordances ?? {};
  const provided = required.filter((key) => affordances[key] === true).map(affordanceLabel);
  const missing = required.filter((key) => affordances[key] !== true).map(affordanceLabel);
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status ?? null,
    satisfied: missing.length === 0,
    provided,
    missing,
  };
}

export function connectedAgentMatches(
  agents: AgentCapabilityRow[],
  requirements: AgentRequirements,
): AgentMatchSummary[] {
  return agents.filter(isConnectedAgent).map((agent) => agentMatchSummary(agent, requirements));
}
