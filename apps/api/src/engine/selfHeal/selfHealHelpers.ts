/**
 * Pure free-function helpers for the self-heal controller (extracted from
 * WorkflowEngine). Dependency-light; shared by the controller and the engine.
 */
import { type ToolDefinition, type WorkflowGraph, type WorkflowGraphPatch, type WorkflowNode } from '@agentis/core';
import { and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { RunningContext } from '../WorkflowEngine.js';

export function selfHealAttemptCount(ctx: RunningContext, nodeId: string): number {
  const current = ctx.selfHealAttempts.get(nodeId);
  if (typeof current === 'number') return current;
  const persisted = ctx.state.selfHealAttempts?.[nodeId];
  const normalized = typeof persisted === 'number' && Number.isFinite(persisted) && persisted > 0
    ? Math.floor(persisted)
    : 0;
  if (normalized > 0) ctx.selfHealAttempts.set(nodeId, normalized);
  return normalized;
}
export function recordSelfHealAttempt(ctx: RunningContext, nodeId: string): number {
  const next = selfHealAttemptCount(ctx, nodeId) + 1;
  ctx.selfHealAttempts.set(nodeId, next);
  ctx.state.selfHealAttempts = { ...(ctx.state.selfHealAttempts ?? {}), [nodeId]: next };
  return next;
}
/**
 * Which node kinds self-healing may repair. Output-recovery and runtime-rebind
 * are agent-specific, but the STRUCTURAL repair path (diagnose → patch node
 * config → re-dispatch) is generic, so any re-dispatchable node qualifies. Only
 * `trigger` (the run's entry, not a runtime step) is excluded — a failure there
 * is not something a graph patch can fix.
 */
export function isSelfHealableNode(node: WorkflowNode): boolean {
  return node.config.kind !== 'trigger';
}
/**
 * A node failed because its agent has no working runtime (the most common
 * long-run failure: a CLI/process dropped, a pinned agent was never connected,
 * the adapter is offline). This class is repaired DETERMINISTICALLY — rebind the
 * runtime or reroute to the healer — never by an LLM graph patch, so it costs no
 * tokens.
 */
export function isRuntimeBindingFailure(error: string): boolean {
  return /no connected runtime|has no connected runtime|ADAPTER_UNAVAILABLE|adapter is (?:not connected|offline)|agent is offline|no runtime|runtime not connected/i.test(error);
}
export function capabilityGapReason(error: string): string | null {
  const matched =
    /(provider is not configured|is not configured|is not wired(?: in this runtime)?|are not enabled in this runtime|is not (?:available|enabled) in this runtime|requires (?:a |an )?[\w.+-]+ (?:interpreter|binary|runtime)(?: on PATH)?|requires [\w.+-]+ on PATH)/i.test(
      error,
    );
  if (!matched) return null;
  return error.replace(/\s+/g, ' ').trim().slice(0, 180);
}
/**
 * A CONFIG gap — the step failed because required CONFIGURATION isn't set (an
 * environment variable, a working directory, a credential/token), NOT because
 * the graph is wrong. Like a capability gap, no graph edit or agent swap can
 * supply it, so structural self-heal is pointless (it just burns replans and
 * emits "could not derive a grounded repair"). The failing extension's own
 * message usually carries the remedy verbatim, so we surface it as the fix.
 * Returns the trimmed reason+remedy, or null when the failure may genuinely be
 * graph/data-class.
 */
export function configGapReason(error: string): string | null {
  const e = (error ?? '').replace(/\s+/g, ' ').trim();
  const matched =
    /requires (?:a |an )?(?:working directory|environment variable|configuration|config|credential|directory|api key|token)/i.test(e)
    || /\bset [A-Z][A-Z0-9_]{3,}\b/.test(e)
    || /\bpass (?:workingDir|storesDir|working directory)\b/i.test(e)
    || /environment variable [\w.$-]+ (?:is )?(?:not set|missing|required|undefined|empty)/i.test(e)
    || /(?:credential|api key|token|secret|env(?:ironment)? var(?:iable)?) (?:is )?(?:missing|not set|not configured|required|undefined)/i.test(e);
  if (!matched) return null;
  return e.slice(0, 240);
}
export function declaredOutputKeys(node: WorkflowNode): string[] {
  const config = node.config as { kind?: string; outputKeys?: unknown };
  if (config.kind !== 'agent_task' && config.kind !== 'agent_session' && config.kind !== 'planner') return [];
  return Array.isArray(config.outputKeys)
    ? config.outputKeys.filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
    : [];
}
/** Shared full-graph diff used by recovery application and rollback. */
export function graphDiffPatch(base: WorkflowGraph, target: WorkflowGraph, baseGraphRevision: number): WorkflowGraphPatch {
  const beforeNodes = new Map(base.nodes.map((node) => [node.id, node] as const));
  const afterNodes = new Map(target.nodes.map((node) => [node.id, node] as const));
  const beforeEdges = new Map(base.edges.map((edge) => [edge.id, edge] as const));
  const afterEdges = new Map(target.edges.map((edge) => [edge.id, edge] as const));
  return {
    patchId: randomUUID(),
    reason: 'self_heal',
    baseGraphRevision,
    addNodes: target.nodes.filter((node) => !beforeNodes.has(node.id)),
    updateNodes: target.nodes.filter((node) => {
      const before = beforeNodes.get(node.id);
      return Boolean(before && JSON.stringify(before) !== JSON.stringify(node));
    }),
    removeNodeIds: base.nodes.filter((node) => !afterNodes.has(node.id)).map((node) => node.id),
    addEdges: target.edges.filter((edge) => !beforeEdges.has(edge.id)),
    removeEdgeIds: base.edges.filter((edge) => !afterEdges.has(edge.id)).map((edge) => edge.id),
  };
}
export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export function toolInputSchemaToChatParameters(schemaValue: unknown): ToolDefinition['parameters'] {
  if (schemaValue && typeof schemaValue === 'object' && !Array.isArray(schemaValue)) {
    const schemaRecord = schemaValue as Record<string, unknown>;
    const properties = schemaRecord.properties && typeof schemaRecord.properties === 'object' && !Array.isArray(schemaRecord.properties)
      ? schemaRecord.properties as ToolDefinition['parameters']['properties']
      : {};
    const required = Array.isArray(schemaRecord.required) ? schemaRecord.required.map(String) : undefined;
    return {
      type: 'object',
      properties,
      ...(required && required.length > 0 ? { required } : {}),
    };
  }
  return { type: 'object', properties: {} };
}
