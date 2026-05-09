/**
 * ChatToolExecutor — runs a tool call inside a chat session.
 *
 * Thin shim around AgentisToolRegistry that supplies the chat-specific
 * `AgentisToolContext` and records the call in the conversation message
 * stream so the operator (and later, replay) can see what the agent did.
 *
 * Spec: docs/CHAT-AGENT-LOOP.md.
 */

import type {
  AgentisToolCallRequest,
  AgentisToolCallResult,
  AgentisToolContext,
} from '@agentis/core';
import type { AgentisToolRegistry } from './agentisToolRegistry.js';
import type { Logger } from '../logger.js';

export interface ChatToolExecutionInput {
  workspaceId: string;
  userId: string;
  ambientId: string | null;
  conversationId: string;
  /** Optional run id when the chat thread is bound to a workflow run. */
  runId?: string;
  call: AgentisToolCallRequest;
}

export class ChatToolExecutor {
  constructor(
    private readonly registry: AgentisToolRegistry,
    private readonly logger: Logger,
  ) {}

  async execute(input: ChatToolExecutionInput): Promise<AgentisToolCallResult> {
    const ctx: AgentisToolContext = {
      workspaceId: input.workspaceId,
      userId: input.userId,
      ambientId: input.ambientId,
      conversationId: input.conversationId,
      runId: input.runId,
      caller: 'chat',
    };
    const result = await this.registry.execute(input.call, ctx);
    if (!result.ok) {
      this.logger.warn('chat.tool_call_failed', {
        toolId: input.call.toolId,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        conversationId: input.conversationId,
      });
    }
    return result;
  }
}
