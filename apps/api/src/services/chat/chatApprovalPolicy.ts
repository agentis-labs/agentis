import type {
  AgentisToolApprovalPolicy,
  AgentisToolDefinition,
  ApprovalSensitivity,
  ChatPermissionMode,
  ToolRiskLevel,
} from '@agentis/core';

export interface ToolApprovalDecision {
  requiresApproval: boolean;
  riskLevel: ToolRiskLevel;
  policy: AgentisToolApprovalPolicy;
  reason: string;
}

const RANK: Record<ToolRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const ASK_THRESHOLD: Record<ApprovalSensitivity, ToolRiskLevel> = {
  cautious: 'medium',
  balanced: 'high',
  autonomous: 'critical',
};

/** Security/irreversibility floor for legacy definitions awaiting inline metadata. */
const CRITICAL_LEGACY_TOOLS = new Set([
  'agentis.approval.resolve',
  'agentis.connection.grant',
  'agentis.code.execute',
]);

const HIGH_LEGACY_TOOLS = new Set([
  'agentis.app.delete',
  'agentis.agents.delete',
  'agentis.data.delete',
  'agentis.space.delete',
  'agentis.workflow.delete',
  'agentis.run.cancel',
  'agentis.workflow.cancel',
  'agentis.integration.call',
  'agentis.mcp.call',
  'agentis.mcp.add',
  'agentis.component.install',
  'agentis.deploy',
  'agentis.workflow.revision.promote',
  'agentis.browser.session.action',
  'agentis.conversation.outreach',
]);

/**
 * Transitional defaults for dynamic and legacy tools. New tools should declare
 * `definition.approval`; unknown mutations intentionally fail safe as high risk.
 */
export function resolveToolApprovalPolicy(
  name: string,
  definition?: AgentisToolDefinition,
): AgentisToolApprovalPolicy {
  if (definition?.approval) return definition.approval;
  if (!definition?.mutating && !name.startsWith('workflow.')) {
    return { riskLevel: 'low', reversible: true, externalSideEffects: false };
  }
  if (name.startsWith('workflow.') || name === 'agentis.workflow.run') {
    return { riskLevel: 'medium', reversible: false, externalSideEffects: true };
  }
  if (CRITICAL_LEGACY_TOOLS.has(name) || name.startsWith('agentis.command.')) {
    return { riskLevel: 'critical', reversible: false, externalSideEffects: true };
  }
  if (HIGH_LEGACY_TOOLS.has(name)) {
    return { riskLevel: 'high', reversible: false, externalSideEffects: true };
  }
  if (definition?.autoExecute) {
    return { riskLevel: 'medium', reversible: true, externalSideEffects: false };
  }
  // Most Agentis mutations are additive/revisioned workspace work (creating or
  // editing apps, workflows, data, memories, tasks). Balanced Ask must not turn
  // those routine operations into a confirmation wall. Cautious still asks.
  return { riskLevel: 'medium', reversible: false, externalSideEffects: false };
}

export function decideToolApproval(args: {
  name: string;
  definition?: AgentisToolDefinition;
  permissionMode?: ChatPermissionMode;
  sensitivity?: ApprovalSensitivity;
}): ToolApprovalDecision {
  const mode = args.permissionMode ?? 'ask';
  const sensitivity = args.sensitivity ?? 'balanced';
  const policy = resolveToolApprovalPolicy(args.name, args.definition);

  if (mode !== 'ask') {
    return {
      requiresApproval: false,
      riskLevel: policy.riskLevel,
      policy,
      reason: mode === 'plan' ? 'Plan mode blocks mutations separately.' : 'Auto mode delegates approval to the agent.',
    };
  }
  if (!args.definition?.mutating && !args.name.startsWith('workflow.')) {
    return { requiresApproval: false, riskLevel: 'low', policy, reason: 'Read-only action.' };
  }
  if (policy.alwaysConfirm) {
    return { requiresApproval: true, riskLevel: policy.riskLevel, policy, reason: 'Protected action.' };
  }

  const threshold = ASK_THRESHOLD[sensitivity];
  const requiresApproval = RANK[policy.riskLevel] >= RANK[threshold];
  return {
    requiresApproval,
    riskLevel: policy.riskLevel,
    policy,
    reason: requiresApproval
      ? `${policy.riskLevel} risk meets the ${sensitivity} Ask threshold (${threshold}).`
      : `${policy.riskLevel} risk is below the ${sensitivity} Ask threshold (${threshold}).`,
  };
}
