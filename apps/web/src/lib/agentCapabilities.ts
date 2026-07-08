import {
  RAL_AFFORDANCES,
  affordanceLabel,
  agentRequirementMatches,
  configuredAffordances,
  connectedAgentMatches,
  hasAgentRequirements,
  normalizeAgentRequirements,
  potentialAffordances,
  requiredAffordanceKeys,
  withAgentRequirement,
  type AgentAffordance as AgentAffordanceKey,
  type AgentRequirements,
  type RalAgentCapabilityRow as AgentCapabilityRow,
  type RalAgentMatchSummary as AgentMatchSummary,
  type RalMatchState,
} from '@agentis/core';

export const AGENT_AFFORDANCES = RAL_AFFORDANCES;

export type { AgentAffordanceKey, AgentRequirements };

export interface AdapterCapabilitiesLite {
  affordances?: Partial<Record<AgentAffordanceKey, boolean>> | null;
}

export type { AgentCapabilityRow, AgentMatchSummary, RalMatchState };

export {
  affordanceLabel,
  agentRequirementMatches,
  configuredAffordances,
  connectedAgentMatches,
  hasAgentRequirements,
  normalizeAgentRequirements,
  potentialAffordances,
  requiredAffordanceKeys,
};

export const withRequirement = withAgentRequirement;



