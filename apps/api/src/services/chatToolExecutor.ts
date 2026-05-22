/**
 * ChatToolExecutor — CHAT-AGENT-LOOP.md §2.4.
 *
 * Executes tool calls requested by the LLM during a chat turn.
 * Routes through AgentisToolRegistry, the same platform tool plane exposed
 * over /v1/tools and available to workflow/MCP transports.
 */

import { randomUUID } from 'node:crypto';
import type { AgentisToolDefinition, ChatTurnContext } from '@agentis/core';
import type { Logger } from '../logger.js';
import type { AgentisToolRegistry } from './agentisToolRegistry.js';

export interface ChatToolExecutorDeps {
  registry: AgentisToolRegistry;
  logger?: Logger;
}

export class ChatToolExecutor {
  static #deps: ChatToolExecutorDeps | null = null;

  static configure(deps: ChatToolExecutorDeps | null): void {
    this.#deps = deps;
  }

  static definition(name: string): AgentisToolDefinition | undefined {
    return this.#deps?.registry.get(name);
  }

  /**
   * The set of tool ids the registry can actually execute. Used to filter the
   * advertised chat catalog so the model never sees (and wastes a turn calling)
   * a tool that isn't registered. Empty when the registry isn't configured —
   * callers must treat empty as "don't filter" to avoid hiding everything.
   */
  static registeredIds(): Set<string> {
    if (!this.#deps) return new Set();
    return new Set(this.#deps.registry.catalog().tools.map((tool) => tool.id));
  }

  static requiresConfirmation(name: string): boolean {
    if (name.startsWith('workflow.')) return true;
    const definition = this.definition(name);
    return Boolean(definition?.mutating && !definition.autoExecute);
  }

  /**
   * Execute a single tool call by name.
   *
   * Returns `{ data }` on success or `{ error }` on failure.
   * Never throws — the LLM handles errors better with a structured result.
   */
  static async run(
    name: string,
    args: unknown,
    ctx: ChatTurnContext,
  ): Promise<{ data?: unknown; error?: string }> {
    if (!this.#deps) {
      return { error: `Tool "${name}" is not available because the Agentis tool registry is not configured.` };
    }

    const input = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};

    // Dynamic per-workflow tools surface as `workflow.<id>`. Rewrite them to
    // the generic agentis.workflow.run handler with the id pulled from the
    // tool name and the model's args passed straight through as inputs.
    let toolId = name;
    let toolInput = input;
    if (name.startsWith('workflow.')) {
      const workflowId = name.slice('workflow.'.length);
      toolId = 'agentis.workflow.run';
      toolInput = { workflowId, inputs: input };
    }

    const outcome = await this.#deps.registry.execute(
      { id: randomUUID(), toolId, arguments: toolInput },
      {
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId ?? null,
        agentId: ctx.agentId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        viewport: ctx.viewport ?? null,
        caller: 'chat',
      },
    );

    if (outcome.ok) {
      return { data: outcome.output };
    }

    const error = outcome.errorMessage ?? `Tool "${name}" failed.`;
    this.#deps.logger?.warn('chat.tool_call.failed', {
      tool: name,
      code: outcome.errorCode,
      error,
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
    });
    return { error };
  }
}
