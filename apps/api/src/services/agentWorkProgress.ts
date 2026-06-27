import { REALTIME_EVENTS, REALTIME_ROOMS, type AppAgentActivity, type ChatDelta } from '@agentis/core';
import type { EventBus } from '../event-bus.js';

type ChatActivity = Extract<ChatDelta, { type: 'activity' }>;
type ChatToolCall = Extract<ChatDelta, { type: 'tool_call' }>;
type ChatToolResult = Extract<ChatDelta, { type: 'tool_result' }>;

export interface AgentWorkContext {
  workspaceId: string;
  ambientId?: string | null;
  agentId?: string;
  agentName?: string | null;
  conversationId?: string;
  clientTurnId?: string;
  taskId?: string;
  workflowId?: string;
  runId?: string;
  nodeId?: string;
}

export interface AgentWorkStepInput extends AgentWorkContext {
  phase?: string;
  step?: string;
  description: string;
  detail?: string;
  progress?: { completed?: number; total?: number; label?: string } | null;
  at?: string;
}

export function publishAgentWorkStep(bus: EventBus, input: AgentWorkStepInput): void {
  const description = clipRealtimeText(input.description);
  if (!description) return;
  const correlationId = workCorrelationId(input);
  bus.publish(REALTIME_ROOMS.workspace(input.workspaceId), REALTIME_EVENTS.AGENT_WORK_STEP, {
    workspaceId: input.workspaceId,
    ambientId: input.ambientId ?? undefined,
    agentId: input.agentId,
    agentName: input.agentName ?? undefined,
    conversationId: input.conversationId,
    clientTurnId: input.clientTurnId,
    taskId: input.taskId,
    workflowId: input.workflowId,
    runId: input.runId,
    nodeId: input.nodeId,
    phase: input.phase ?? 'progress',
    step: input.step ?? 'agent_task',
    description,
    detail: input.detail ? clipRealtimeText(input.detail) : undefined,
    progress: input.progress ?? undefined,
    at: input.at ?? new Date().toISOString(),
  }, correlationId);
}

export function publishChatDeltaProgress(bus: EventBus, ctx: AgentWorkContext, delta: ChatDelta): void {
  if (delta.type === 'activity') {
    publishActivityProgress(bus, ctx, delta);
    return;
  }
  if (delta.type === 'tool_call') {
    publishToolCallProgress(bus, ctx, delta);
    return;
  }
  if (delta.type === 'tool_result') {
    publishToolResultProgress(bus, ctx, delta);
  }
}

export function publishActivityProgress(bus: EventBus, ctx: AgentWorkContext, activity: ChatActivity): void {
  publishAgentWorkStep(bus, {
    ...ctx,
    workflowId: activity.workflowId ?? ctx.workflowId,
    runId: activity.runId ?? ctx.runId,
    nodeId: activity.nodeId ?? ctx.nodeId,
    phase: activity.status === 'error' ? 'fail' : activity.status === 'success' ? 'complete' : activity.phase,
    step: activity.phase,
    description: [activity.label, activity.detail].filter(Boolean).join(' - '),
    at: activity.startedAt,
  });
}

export function publishToolCallProgress(bus: EventBus, ctx: AgentWorkContext, delta: ChatToolCall): void {
  const at = new Date().toISOString();
  const correlationId = workCorrelationId(ctx);
  bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL, {
    workspaceId: ctx.workspaceId,
    ambientId: ctx.ambientId ?? undefined,
    agentId: ctx.agentId,
    agentName: ctx.agentName ?? undefined,
    conversationId: ctx.conversationId,
    clientTurnId: ctx.clientTurnId,
    taskId: ctx.taskId,
    workflowId: ctx.workflowId,
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    tool: delta.name,
    args: delta.args,
    at,
  }, correlationId);
  publishAgentWorkStep(bus, {
    ...ctx,
    phase: 'tool',
    step: delta.name,
    description: `Calling ${delta.name}`,
    at,
  });
}

export function publishToolResultProgress(bus: EventBus, ctx: AgentWorkContext, delta: ChatToolResult): void {
  publishAgentWorkStep(bus, {
    ...ctx,
    phase: delta.error ? 'fail' : 'complete',
    step: delta.name,
    description: delta.error ? `${delta.name} failed: ${delta.error}` : `${delta.name} completed`,
  });
}

/**
 * Publish the resident agent's live activity on an App thread to the App console
 * (LIVING-APPS-10X G9 — co-presence). Dual-published to the App room + the
 * workspace room (the same pattern as DATA_CHANGED) so the live inbox — which
 * subscribes via the workspace room — sees "agent is thinking/typing…". Ephemeral;
 * `state:'idle'` clears the indicator. Best-effort: never throws.
 */
export function publishAppAgentActivity(
  bus: EventBus,
  input: { workspaceId: string; appId: string; conversationId: string; agentId?: string; state: AppAgentActivity['state']; label?: string },
): void {
  const payload: AppAgentActivity = {
    appId: input.appId,
    conversationId: input.conversationId,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    state: input.state,
    ...(input.label ? { label: clipRealtimeText(input.label, 160) } : {}),
    at: new Date().toISOString(),
  };
  bus.publish(REALTIME_ROOMS.app(input.appId), REALTIME_EVENTS.APP_AGENT_ACTIVITY, payload);
  bus.publish(REALTIME_ROOMS.workspace(input.workspaceId), REALTIME_EVENTS.APP_AGENT_ACTIVITY, payload);
}

export function workCorrelationId(ctx: AgentWorkContext): string | undefined {
  return ctx.clientTurnId ?? ctx.taskId ?? ctx.runId ?? ctx.conversationId;
}

export function clipRealtimeText(text: string, max = 2_000): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}
