/**
 * chatToolCatalog — derived view over AgentisToolRegistry.
 *
 * The catalog is what the LLM gets at the start of a chat turn. It mirrors
 * the OpenAI tool format (the most common shape) but is generated entirely
 * from the registry — there is no hand-maintained list to drift.
 *
 * Spec: docs/CHAT-AGENT-LOOP.md.
 */

import type { AgentisToolDefinition } from '@agentis/core';
import type { AgentisToolRegistry } from './agentisToolRegistry.js';

export interface ChatToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export interface ChatToolCatalog {
  tools: ChatToolDefinition[];
  hash: string;
}

export interface ChatToolCatalogOptions {
  /** Restrict to a subset of tool ids. Falsy returns all tools. */
  allow?: string[];
  /** Drop mutating tools (useful for read-only assistant modes). */
  readOnly?: boolean;
}

export function buildChatToolCatalog(
  registry: AgentisToolRegistry,
  opts: ChatToolCatalogOptions = {},
): ChatToolCatalog {
  const allowSet = opts.allow && opts.allow.length > 0 ? new Set(opts.allow) : null;
  const snapshot = registry.catalog();
  const filtered: AgentisToolDefinition[] = [];
  for (const tool of snapshot.tools) {
    if (allowSet && !allowSet.has(tool.id)) continue;
    if (opts.readOnly && tool.mutating) continue;
    filtered.push(tool);
  }
  return {
    tools: filtered.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.id,
        description: t.description,
        parameters: t.inputSchema,
      },
    })),
    hash: snapshot.hash,
  };
}
