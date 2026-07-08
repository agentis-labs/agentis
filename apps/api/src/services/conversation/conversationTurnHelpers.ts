/**
 * Conversation turn helpers (extracted from routes/conversations.ts).
 *
 * Pure serialization + streamed-chat metadata capture for a conversation turn,
 * plus the turn value-types. Framework-free (no HTTP/request state), so they
 * live in the conversation domain and the route stays a thin transport shell.
 */
import { type ChatDelta, type ChatFinishReason, type ChatTurnTrace, type ViewportContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { randomUUID } from 'node:crypto';

export type ConversationMessageRow = typeof schema.conversationMessages.$inferSelect;
export type AgentRow = typeof schema.agents.$inferSelect;
export type QueueRow = typeof schema.conversationMessageQueue.$inferSelect;
export interface PersistedToolCallData {
  id: string;
  name: string;
  status: 'running' | 'success' | 'error';
  args?: unknown;
  result?: unknown;
  error?: string | null;
  durationMs?: number | null;
}
export interface StreamedChatMetadata {
  turn: ChatTurnTrace;
  activity: Array<Extract<ChatDelta, { type: 'activity' }>>;
  toolCalls: PersistedToolCallData[];
  toolStartedAt: Map<string, number>;
  workflowId: string | null;
  runId: string | null;
  runTitle: string | null;
  confirmation: (Omit<Extract<ChatDelta, { type: 'confirmation_required' }>, 'type'> & { status: 'pending' }) | null;
}

export function serializeConversationMessage(message: ConversationMessageRow) {
  return {
    id: message.id,
    role: message.authorType,
    authorType: message.authorType,
    authorId: message.authorId,
    body: message.body,
    metadata: message.metadata ?? {},
    deliveryStatus: message.deliveryStatus,
    createdAt: message.createdAt,
  };
}

export function serializeQueueItem(item: QueueRow) {
  return {
    id: item.id,
    conversationId: item.conversationId,
    workspaceId: item.workspaceId,
    text: item.text,
    attachments: item.attachments ?? null,
    createdAt: item.createdAt,
    position: item.position,
    status: item.status,
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function workflowIdFromViewport(viewport: ViewportContext | null | undefined): string | undefined {
  if (!viewport) return undefined;
  if (viewport.resourceKind === 'workflow' && viewport.resourceId) return viewport.resourceId;
  if (typeof viewport.metadata?.workflowId === 'string') return viewport.metadata.workflowId;
  return undefined;
}

export function serializeScopeAgent(agent: AgentRow) {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    colorHex: agent.colorHex,
    reportsTo: agent.reportsTo,
  };
}

export function isAdapterErrorDelta(delta: ChatDelta): delta is Extract<ChatDelta, { type: 'tool_result' }> & { error: string } {
  return delta.type === 'tool_result'
    && delta.id === 'adapter'
    && delta.name === 'adapter.chat'
    && typeof delta.error === 'string'
    && delta.error.trim().length > 0;
}

export function createStreamedChatMetadata(
  clientTurnId: string = randomUUID(),
  startedAt = new Date().toISOString(),
): StreamedChatMetadata {
  return {
    turn: {
      clientTurnId,
      startedAt,
      status: 'running',
    },
    activity: [],
    toolCalls: [],
    toolStartedAt: new Map(),
    workflowId: null,
    runId: null,
    runTitle: null,
    confirmation: null,
  };
}

export function finalizeTurnTrace(
  state: StreamedChatMetadata,
  finishReason: ChatFinishReason,
  completedAt: string,
  durationMs: number,
): void {
  state.turn = {
    ...state.turn,
    completedAt,
    durationMs,
    finishReason,
    status: finishReason === 'error'
      ? 'failed'
      : finishReason === 'max_turns' || finishReason === 'length'
        ? 'stopped'
        : 'completed',
  };
}

export function relevantTurnError(state: StreamedChatMetadata, adapterError: string | null): string {
  const toolError = [...state.toolCalls]
    .reverse()
    .find((call) => call.status === 'error' && call.name !== 'adapter.chat')
    ?.error
    ?.trim();
  return toolError
    || adapterError?.trim()
    || 'The agent runtime failed before it could complete the chat turn.';
}

export function captureChatDeltaMetadata(state: StreamedChatMetadata, delta: ChatDelta): void {
  if (delta.type === 'activity') {
    state.activity = [...state.activity.filter((entry) => entry.id !== delta.id), delta].slice(-80);
    if (delta.workflowId) state.workflowId = delta.workflowId;
    if (delta.runId) state.runId = delta.runId;
    return;
  }
  if (delta.type === 'thinking') return;
  if (delta.type === 'tool_call') {
    state.toolStartedAt.set(delta.id, Date.now());
    state.toolCalls = [
      ...state.toolCalls.filter((entry) => entry.id !== delta.id),
      {
        id: delta.id,
        name: delta.name,
        status: 'running',
        args: delta.args,
      },
    ];
    return;
  }
  if (delta.type === 'tool_result') {
    const startedAt = state.toolStartedAt.get(delta.id);
    const durationMs = startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : null;
    const previous = state.toolCalls.find((entry) => entry.id === delta.id);
    state.toolCalls = [
      ...state.toolCalls.filter((entry) => entry.id !== delta.id),
      {
        id: delta.id,
        name: delta.name,
        status: delta.error ? 'error' : 'success',
        args: previous?.args,
        result: delta.result,
        error: delta.error ?? null,
        durationMs,
      },
    ];
    const build = workflowBuildMetadataFromResult(delta.result);
    if (build) {
      state.workflowId = build.workflowId;
      state.runId = build.runId;
      state.runTitle = build.title ?? state.runTitle;
    }
    return;
  }
  if (delta.type === 'confirmation_required') {
    state.confirmation = {
      turnId: delta.turnId,
      toolCall: delta.toolCall,
      title: delta.title,
      body: delta.body,
      impact: delta.impact,
      confirmLabel: delta.confirmLabel,
      cancelLabel: delta.cancelLabel,
      expiresAt: delta.expiresAt,
      status: 'pending',
    };
  }
}

export function buildPersistedChatMetadata(
  source: 'chat_loop' | 'chat_confirmation',
  state: StreamedChatMetadata,
  clientTurnId?: string | null,
): Record<string, unknown> {
  return {
    source,
    ...(clientTurnId ? { clientTurnId } : {}),
    turn: state.turn,
    ...(state.activity.length > 0 ? { activity: state.activity } : {}),
    ...(state.toolCalls.length > 0 ? { toolCalls: state.toolCalls } : {}),
    ...(state.workflowId ? { workflowId: state.workflowId } : {}),
    ...(state.runId ? { runId: state.runId } : {}),
    ...(state.runTitle ? { runTitle: state.runTitle } : {}),
    ...(state.confirmation ? { confirmation: state.confirmation } : {}),
  };
}

export function workflowBuildMetadataFromResult(result: unknown): { workflowId: string; runId: string; title?: string } | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as { workflowId?: unknown; runId?: unknown; title?: unknown };
  if (typeof value.workflowId !== 'string' || !value.workflowId.trim()) return null;
  if (typeof value.runId !== 'string' || !value.runId.trim()) return null;
  return {
    workflowId: value.workflowId,
    runId: value.runId,
    ...(typeof value.title === 'string' && value.title.trim() ? { title: value.title.trim() } : {}),
  };
}
