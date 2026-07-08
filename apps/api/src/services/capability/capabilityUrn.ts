/**
 * Capability URN — the addressing scheme for the chat capability plane
 * (RADICAL-EFFICIENCY-CHAT-CAPABILITY-PLANE §2).
 *
 * A URN names any addressable "capability atom" in the workspace at any depth,
 * so chat/agent intent can target not just an app or a whole workflow but a
 * specific execution node or phase inside it — the substrate the router then
 * maps onto workflow.run / replay-from-node / agent dispatch / MCP call.
 *
 *   app:<appId>
 *   app:<appId>/wf:<workflowId>
 *   app:<appId>/wf:<workflowId>/node:<nodeId>
 *   app:<appId>/wf:<workflowId>/phase:<phaseId>
 *   wf:<workflowId>                         (workflow addressed directly)
 *   wf:<workflowId>/node:<nodeId>
 *   wf:<workflowId>/phase:<phaseId>
 *   agent:<agentId>
 *   skill:<skillId>
 *   mcp:<slug>__<toolName>
 *   coll:<appId>/<collection>
 *
 * IDs are UUIDs or slugs — they never contain `:` or `/`, which are the only
 * structural delimiters, so parsing is unambiguous. MCP tool ids keep their
 * native `<slug>__<tool>` shape inside the `mcp:` value.
 */

import { AgentisError } from '@agentis/core';

export type CapabilityKind =
  | 'app'
  | 'workflow'
  | 'node'
  | 'phase'
  | 'agent'
  | 'skill'
  | 'mcp_tool'
  | 'collection';

export interface CapabilityUrn {
  kind: CapabilityKind;
  appId?: string;
  workflowId?: string;
  nodeId?: string;
  phaseId?: string;
  agentId?: string;
  skillId?: string;
  /** Namespaced `<slug>__<tool>` for a bridged MCP tool. */
  mcpTool?: string;
  collection?: string;
  /** The canonical string form. */
  raw: string;
}

interface Segment {
  prefix: string;
  value: string;
}

function splitSegment(segment: string): Segment {
  const idx = segment.indexOf(':');
  if (idx <= 0 || idx === segment.length - 1) {
    throw new AgentisError('VALIDATION_FAILED', `capability urn segment '${segment}' must be '<prefix>:<id>'`);
  }
  return { prefix: segment.slice(0, idx), value: segment.slice(idx + 1) };
}

/**
 * Parse a capability URN into its typed parts. Throws VALIDATION_FAILED on any
 * malformed input so a bad target fails loud with an instructive message the
 * agent can correct, rather than silently resolving to the wrong thing.
 */
export function parseCapabilityUrn(raw: unknown): CapabilityUrn {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new AgentisError('VALIDATION_FAILED', 'capability urn must be a non-empty string');
  }
  const text = raw.trim();
  const segments = text.split('/');
  const head = splitSegment(segments[0]!);

  // ── Top-level single-segment kinds ────────────────────────────────────────
  switch (head.prefix) {
    case 'agent':
      requireDepth(text, segments, 1);
      return { kind: 'agent', agentId: head.value, raw: text };
    case 'skill':
      requireDepth(text, segments, 1);
      return { kind: 'skill', skillId: head.value, raw: text };
    case 'mcp':
      requireDepth(text, segments, 1);
      return { kind: 'mcp_tool', mcpTool: head.value, raw: text };
    case 'coll': {
      // coll:<appId>/<collection>
      requireDepth(text, segments, 2);
      const collection = segments[1]!;
      if (!collection) throw malformed(text);
      return { kind: 'collection', appId: head.value, collection, raw: text };
    }
    case 'app':
      return parseAppRooted(text, segments, head);
    case 'wf':
      return parseWorkflowRooted(text, segments, 0, { raw: text });
    default:
      throw new AgentisError(
        'VALIDATION_FAILED',
        `unknown capability urn prefix '${head.prefix}' in '${text}' (expected app|wf|agent|skill|mcp|coll)`,
      );
  }
}

function parseAppRooted(text: string, segments: string[], head: Segment): CapabilityUrn {
  const base: Partial<CapabilityUrn> = { appId: head.value };
  if (segments.length === 1) {
    return { kind: 'app', appId: head.value, raw: text };
  }
  // app:<appId>/wf:<workflowId>[/node|phase:...]
  const second = splitSegment(segments[1]!);
  if (second.prefix !== 'wf') {
    throw new AgentisError('VALIDATION_FAILED', `capability urn '${text}': after app: expected wf:, got ${second.prefix}:`);
  }
  return parseWorkflowRooted(text, segments, 1, base);
}

function parseWorkflowRooted(
  text: string,
  segments: string[],
  wfIndex: number,
  base: Partial<CapabilityUrn>,
): CapabilityUrn {
  const wf = splitSegment(segments[wfIndex]!);
  const workflowId = wf.value;
  const depth = segments.length - wfIndex;
  if (depth === 1) {
    return { kind: 'workflow', ...base, workflowId, raw: text };
  }
  if (depth === 2) {
    const leaf = splitSegment(segments[wfIndex + 1]!);
    if (leaf.prefix === 'node') return { kind: 'node', ...base, workflowId, nodeId: leaf.value, raw: text };
    if (leaf.prefix === 'phase') return { kind: 'phase', ...base, workflowId, phaseId: leaf.value, raw: text };
    throw new AgentisError('VALIDATION_FAILED', `capability urn '${text}': after wf: expected node:|phase:, got ${leaf.prefix}:`);
  }
  throw malformed(text);
}

function requireDepth(text: string, segments: string[], expected: number): void {
  if (segments.length !== expected) throw malformed(text);
}

function malformed(text: string): AgentisError {
  return new AgentisError('VALIDATION_FAILED', `malformed capability urn '${text}'`);
}

/** True when `raw` parses as a capability URN — never throws. */
export function isCapabilityUrn(raw: unknown): boolean {
  try {
    parseCapabilityUrn(raw);
    return true;
  } catch {
    return false;
  }
}

// ── Builders — the single source of truth for the canonical string form. ────

export function appUrn(appId: string): string {
  return `app:${appId}`;
}

export function workflowUrn(workflowId: string, appId?: string | null): string {
  return appId ? `app:${appId}/wf:${workflowId}` : `wf:${workflowId}`;
}

export function nodeUrn(workflowId: string, nodeId: string, appId?: string | null): string {
  return `${workflowUrn(workflowId, appId)}/node:${nodeId}`;
}

export function phaseUrn(workflowId: string, phaseId: string, appId?: string | null): string {
  return `${workflowUrn(workflowId, appId)}/phase:${phaseId}`;
}

export function agentUrn(agentId: string): string {
  return `agent:${agentId}`;
}

export function skillUrn(skillId: string): string {
  return `skill:${skillId}`;
}

export function mcpToolUrn(namespacedToolId: string): string {
  // The bridge id is already `mcp__<slug>__<tool>`; strip the leading `mcp__`
  // so the URN value is the bare `<slug>__<tool>` and re-adds cleanly on invoke.
  const value = namespacedToolId.startsWith('mcp__') ? namespacedToolId.slice('mcp__'.length) : namespacedToolId;
  return `mcp:${value}`;
}

export function collectionUrn(appId: string, collection: string): string {
  return `coll:${appId}/${collection}`;
}

/** Recover the bridge tool id (`mcp__<slug>__<tool>`) from an mcp_tool URN. */
export function mcpBridgeIdFromUrn(urn: CapabilityUrn): string {
  if (urn.kind !== 'mcp_tool' || !urn.mcpTool) {
    throw new AgentisError('VALIDATION_FAILED', `urn '${urn.raw}' is not an mcp_tool urn`);
  }
  return `mcp__${urn.mcpTool}`;
}
