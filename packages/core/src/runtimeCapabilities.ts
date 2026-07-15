import type {
  AdapterCapabilities,
  AgentAffordance,
  AgentRequirements,
  RuntimeCapabilityDeclaration,
  RuntimeCapabilityId,
  RuntimeCapabilityManifest,
  RuntimeCapabilityRequirements,
  RuntimeCompatibilityResult,
} from './types/adapter.js';

const AFFORDANCE_CAPABILITY: Record<AgentAffordance, RuntimeCapabilityId> = {
  browser: 'execution.browser',
  codebaseIndex: 'workspace.codebase-index',
  fileSystem: 'execution.file-system',
  terminal: 'execution.terminal',
  computerUse: 'execution.computer-use',
  nativeMcp: 'protocol.native-mcp',
};

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function declaration(id: RuntimeCapabilityId, available: boolean): RuntimeCapabilityDeclaration {
  return { id, available, source: 'legacy_projection' };
}

/**
 * Project the V1 AdapterCapabilities shape into the versioned runtime contract.
 * Explicit adapter declarations win, including explicit `available: false`.
 */
export function runtimeCapabilityManifest(
  adapterType: string,
  capabilities: AdapterCapabilities | null | undefined,
): RuntimeCapabilityManifest {
  const legacy: RuntimeCapabilityDeclaration[] = [
    declaration('interaction.chat', capabilities?.interactiveChat === true),
    declaration('interaction.tool-calling', capabilities?.toolCalling === true),
    declaration('execution.file-system', capabilities?.execution?.fileSystem === true || capabilities?.affordances?.fileSystem === true),
    declaration('execution.terminal', capabilities?.execution?.terminal === true || capabilities?.affordances?.terminal === true),
    declaration('execution.browser', capabilities?.execution?.browser === true || capabilities?.affordances?.browser === true),
    declaration('execution.computer-use', capabilities?.affordances?.computerUse === true),
    // Network access has security implications and was not represented by the
    // legacy shape. Never infer it from an HTTP transport or browser; adapters
    // must advertise `execution.network` explicitly when the task may use it.
    declaration('execution.network', false),
    declaration('execution.long-running', capabilities?.execution?.longRunning === true),
    declaration('execution.pausable', capabilities?.execution?.pausable === true),
    declaration('workspace.codebase-index', capabilities?.affordances?.codebaseIndex === true),
    declaration('protocol.native-mcp', capabilities?.affordances?.nativeMcp === true || capabilities?.toolForwarding === 'mcp_native'),
    declaration('memory.inject', capabilities?.memory?.injectable === true),
    declaration('memory.ingest', capabilities?.memory?.ingestible === true),
  ];

  const merged = new Map<RuntimeCapabilityId, RuntimeCapabilityDeclaration>();
  for (const item of legacy) merged.set(item.id, item);
  for (const item of capabilities?.capabilityManifest ?? []) {
    if (!item?.id || typeof item.id !== 'string') continue;
    merged.set(item.id, { ...item, source: 'advertised' });
  }

  return {
    schemaVersion: 1,
    adapterType,
    capabilities: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)),
    limitations: unique((capabilities?.limitations ?? []).filter((value): value is string => typeof value === 'string')),
  };
}

/** Bridge existing workflow `requires` affordances into the general contract. */
export function runtimeRequirementsFromAgentRequirements(
  requirements: AgentRequirements | null | undefined,
  reason?: string,
): RuntimeCapabilityRequirements | undefined {
  if (!requirements) return undefined;
  const allOf = (Object.entries(AFFORDANCE_CAPABILITY) as Array<[AgentAffordance, RuntimeCapabilityId]>)
    .filter(([affordance]) => requirements[affordance] === true)
    .map(([, capability]) => capability);
  return allOf.length > 0 ? { allOf, ...(reason ? { reason } : {}) } : undefined;
}

/** Pure compatibility evaluation shared by routing, diagnostics, and dispatch. */
export function evaluateRuntimeCompatibility(
  manifest: RuntimeCapabilityManifest,
  requirements: RuntimeCapabilityRequirements | null | undefined,
): RuntimeCompatibilityResult {
  const available = unique(
    manifest.capabilities
      .filter((item) => item.available === true)
      .map((item) => item.id),
  ).sort();
  const availableSet = new Set<RuntimeCapabilityId>(available);
  const required = unique((requirements?.allOf ?? []).filter((id): id is RuntimeCapabilityId => typeof id === 'string' && id.length > 0));
  const anyOf = (requirements?.anyOf ?? [])
    .map((group) => unique(group.filter((id): id is RuntimeCapabilityId => typeof id === 'string' && id.length > 0)))
    // An empty group is unsatisfiable and should never be silently ignored.
    .filter((group, index, groups) => index === groups.findIndex((candidate) => candidate.join('\u0000') === group.join('\u0000')));
  const missing = required.filter((id) => !availableSet.has(id));
  const unsatisfiedAnyOf = anyOf.filter((group) => group.length === 0 || !group.some((id) => availableSet.has(id)));

  return {
    compatible: missing.length === 0 && unsatisfiedAnyOf.length === 0,
    required,
    available,
    missing,
    unsatisfiedAnyOf,
    limitations: [...manifest.limitations],
    ...(requirements?.reason ? { reason: requirements.reason } : {}),
  };
}

export function describeRuntimeCapabilityMismatch(result: RuntimeCompatibilityResult): string {
  const parts: string[] = [];
  if (result.missing.length > 0) parts.push(`missing ${result.missing.join(', ')}`);
  if (result.unsatisfiedAnyOf.length > 0) {
    parts.push(`requires one of ${result.unsatisfiedAnyOf.map((group) => `[${group.join(' | ')}]`).join(', ')}`);
  }
  if (result.reason) parts.push(`task reason: ${result.reason}`);
  return parts.join('; ') || 'runtime is compatible';
}
