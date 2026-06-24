import {
  HAL_AFFORDANCES,
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
  type HalAgentCapabilityRow as AgentCapabilityRow,
  type HalAgentMatchSummary as AgentMatchSummary,
  type HalMatchState,
} from '@agentis/core';

export const AGENT_AFFORDANCES = HAL_AFFORDANCES;

export type { AgentAffordanceKey, AgentRequirements };

export interface AdapterCapabilitiesLite {
  affordances?: Partial<Record<AgentAffordanceKey, boolean>> | null;
}

export type { AgentCapabilityRow, AgentMatchSummary, HalMatchState };

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
