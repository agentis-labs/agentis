const GATEWAY_TOOL_NAMES = new Set(['agentis.tools.call', 'agentis_tools_call']);

export interface NormalizedToolInvocation {
  /** The operation the agent actually requested. */
  tool: string;
  /** The transport wrapper, present only when the invocation was unwrapped. */
  gatewayTool?: string;
  /** Arguments for the actual operation, not the gateway envelope. */
  input?: unknown;
}

/**
 * Normalize gateway-style tool calls for every operator-facing activity feed.
 * This deliberately does not stringify input: downstream display helpers retain
 * responsibility for clipping and secret redaction.
 */
export function normalizeToolInvocation(name: unknown, input?: unknown): NormalizedToolInvocation {
  const rawName = typeof name === 'string' ? name.trim() : '';
  const fallback = rawName || 'tool';
  if (!GATEWAY_TOOL_NAMES.has(rawName.toLowerCase()) || !input || typeof input !== 'object') {
    return { tool: fallback, ...(input === undefined ? {} : { input }) };
  }

  const envelope = input as Record<string, unknown>;
  const requested = typeof envelope.name === 'string' ? envelope.name.trim() : '';
  if (!requested) return { tool: fallback, ...(input === undefined ? {} : { input }) };
  const actualInput = envelope.arguments ?? envelope.args ?? envelope.input;
  return {
    tool: requested,
    gatewayTool: fallback,
    ...(actualInput === undefined ? {} : { input: actualInput }),
  };
}
