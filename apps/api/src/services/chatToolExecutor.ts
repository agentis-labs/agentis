/**
 * ChatToolExecutor — CHAT-AGENT-LOOP.md §2.4.
 *
 * Executes tool calls requested by the LLM during a chat turn.
 * Routes through AgentisToolRegistry, the same platform tool plane exposed
 * over /v1/tools and available to workflow/MCP transports.
 */

import { randomUUID } from 'node:crypto';
import type { ChatTurnContext } from '@agentis/core';
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

    const outcome = await this.#deps.registry.execute(
      { id: randomUUID(), toolId: name, arguments: input },
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
