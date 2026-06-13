import { REALTIME_EVENTS } from '@agentis/core';
import type { RealtimeEnvelope } from './realtime';

export type RealtimeActivityKind =
  | 'run'
  | 'node'
  | 'agent'
  | 'tool'
  | 'message'
  | 'approval'
  | 'status'
  | 'progress';

export type RealtimeActivityTone = 'accent' | 'success' | 'warn' | 'danger' | 'muted';

export interface RealtimeActivity {
  id: string;
  event: string;
  kind: RealtimeActivityKind;
  tone: RealtimeActivityTone;
  title: string;
  detail: string;
  at: string;
  runId?: string;
  workflowId?: string;
  nodeId?: string;
  nodeTitle?: string;
  agentId?: string;
  agentName?: string;
  approvalId?: string;
  progress?: { completed: number; total: number };
  raw: Record<string, unknown>;
}

export const REALTIME_ACTIVITY_EVENTS = [
  REALTIME_EVENTS.RUN_CREATED,
  REALTIME_EVENTS.RUN_RUNNING,
  REALTIME_EVENTS.RUN_COMPLETED,
  REALTIME_EVENTS.RUN_FAILED,
  REALTIME_EVENTS.NODE_STARTED,
  REALTIME_EVENTS.NODE_COMPLETED,
  REALTIME_EVENTS.NODE_FAILED,
  REALTIME_EVENTS.NODE_RETRY_SCHEDULED,
  REALTIME_EVENTS.NODE_WAITING_FOR_INPUT,
  REALTIME_EVENTS.LOOP_PROGRESS,
  REALTIME_EVENTS.APPROVAL_REQUESTED,
  REALTIME_EVENTS.APPROVAL_RESOLVED,
  REALTIME_EVENTS.AGENT_WORK_STEP,
  REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL,
  REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE,
  REALTIME_EVENTS.AGENT_STATUS_CHANGED,
  REALTIME_EVENTS.CANVAS_BUILD_COMPLETE,
] as const;

export function describeRealtimeActivity(
  env: RealtimeEnvelope,
  options: { nodeTitle?: (nodeId: string) => string | undefined } = {},
): RealtimeActivity | null {
  const payload = isRecord(env.payload) ? env.payload : {};
  const runId = stringField(payload, ['runId']);
  const workflowId = stringField(payload, ['workflowId']);
  const nodeId = stringField(payload, ['nodeId', 'taskId']);
  const nodeTitle = nodeId ? options.nodeTitle?.(nodeId) : undefined;
  const agentId = stringField(payload, ['agentId']);
  const agentName = stringField(payload, ['agentName', 'actorName']);
  const approvalId = stringField(payload, ['approvalId', 'id']);
  const at = stringField(payload, ['at', 'timestamp']) ?? env.emittedAt;
  const baseId = [
    env.event,
    at,
    runId,
    nodeId,
    agentId,
    approvalId,
    stringField(payload, ['phase', 'status', 'tool']),
  ].filter(Boolean).join(':');

  const base = {
    id: baseId,
    event: env.event,
    at,
    runId,
    workflowId,
    nodeId,
    nodeTitle,
    agentId,
    agentName,
    approvalId,
    raw: payload,
  };

  switch (env.event) {
    case REALTIME_EVENTS.RUN_CREATED:
    case REALTIME_EVENTS.RUN_RUNNING: {
      const status = stringField(payload, ['status']);
      const waiting = status === 'WAITING' || status === 'waiting' || status === 'paused';
      return {
        ...base,
        kind: 'run',
        tone: waiting ? 'warn' : 'accent',
        title: waiting
          ? stringField(payload, ['workflowName', 'title']) ?? 'Run paused'
          : stringField(payload, ['workflowName', 'title']) ?? 'Run started',
        detail: waiting
          ? stringField(payload, ['reason', 'blockedReason', 'currentStep', 'status']) ?? 'Execution is waiting for operator action.'
          : stringField(payload, ['currentStep', 'status']) ?? 'Execution is underway.',
      };
    }
    case REALTIME_EVENTS.RUN_COMPLETED:
      return {
        ...base,
        kind: 'run',
        tone: 'success',
        title: stringField(payload, ['workflowName', 'title']) ?? 'Run completed',
        detail: stringField(payload, ['summary', 'result']) ?? 'Execution completed successfully.',
      };
    case REALTIME_EVENTS.RUN_FAILED:
      return {
        ...base,
        kind: 'run',
        tone: 'danger',
        title: stringField(payload, ['workflowName', 'title']) ?? 'Run failed',
        detail: stringField(payload, ['error', 'failedNode', 'reason']) ?? 'The latest run needs attention.',
      };
    case REALTIME_EVENTS.CANVAS_BUILD_COMPLETE:
      return {
        ...base,
        kind: 'status',
        tone: 'success',
        title: 'Workflow ready',
        detail: 'The workflow build completed.',
      };
    case REALTIME_EVENTS.NODE_STARTED:
      return {
        ...base,
        kind: 'node',
        tone: 'accent',
        title: nodeTitle ?? 'Node started',
        detail: 'Executing node.',
      };
    case REALTIME_EVENTS.NODE_COMPLETED:
      return {
        ...base,
        kind: 'node',
        tone: 'success',
        title: nodeTitle ?? 'Node completed',
        detail: stringField(payload, ['outputPreview', 'summary']) ?? 'Output produced.',
      };
    case REALTIME_EVENTS.NODE_FAILED:
      return {
        ...base,
        kind: 'node',
        tone: 'danger',
        title: nodeTitle ?? 'Node failed',
        detail: stringField(payload, ['error', 'reason', 'detail']) ?? 'Execution failed at this node.',
      };
    case REALTIME_EVENTS.NODE_RETRY_SCHEDULED:
      return {
        ...base,
        kind: 'node',
        tone: 'warn',
        title: nodeTitle ?? 'Retry scheduled',
        detail: stringField(payload, ['reason', 'detail']) ?? 'The engine will retry this node.',
      };
    case REALTIME_EVENTS.NODE_WAITING_FOR_INPUT:
      return {
        ...base,
        kind: 'node',
        tone: 'warn',
        title: nodeTitle ?? 'Waiting for input',
        detail: stringField(payload, ['summary', 'detail']) ?? 'Human input is required before continuing.',
      };
    case REALTIME_EVENTS.LOOP_PROGRESS: {
      const completed = numberField(payload, ['completed', 'done']);
      const total = numberField(payload, ['total']);
      return {
        ...base,
        kind: 'progress',
        tone: 'accent',
        title: nodeTitle ?? 'Loop progress',
        detail: completed != null && total != null ? `${completed} / ${total}` : 'Loop advanced.',
        progress: completed != null && total != null ? { completed, total } : undefined,
      };
    }
    case REALTIME_EVENTS.APPROVAL_REQUESTED:
      return {
        ...base,
        kind: 'approval',
        tone: 'warn',
        title: stringField(payload, ['agentName', 'title']) ?? 'Approval requested',
        detail: stringField(payload, ['summary', 'workflowName']) ?? 'Operator input is required.',
      };
    case REALTIME_EVENTS.APPROVAL_RESOLVED:
      return {
        ...base,
        kind: 'approval',
        tone: 'muted',
        title: 'Approval resolved',
        detail: stringField(payload, ['status', 'summary', 'decision']) ?? 'The pending question has been handled.',
      };
    case REALTIME_EVENTS.AGENT_WORK_STEP: {
      const phase = stringField(payload, ['phase']);
      const text = stringField(payload, ['description', 'text', 'summary', 'step', 'message']) ?? 'Working';
      return {
        ...base,
        kind: 'agent',
        tone: phase === 'fail' ? 'danger' : phase === 'complete' ? 'success' : 'accent',
        title: agentName ?? nodeTitle ?? 'Agent update',
        detail: text,
        progress: normalizeProgress(payload.progress),
      };
    }
    case REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL: {
      const tool = stringField(payload, ['tool', 'toolName', 'name', 'command']) ?? 'tool call';
      return {
        ...base,
        kind: 'tool',
        tone: 'accent',
        title: agentName ?? 'Tool call',
        detail: tool,
      };
    }
    case REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE: {
      const message = stringField(payload, ['message', 'text', 'line']);
      if (!message) return null;
      return {
        ...base,
        kind: 'message',
        tone: 'muted',
        title: agentName ?? 'Agent message',
        detail: message,
      };
    }
    case REALTIME_EVENTS.AGENT_STATUS_CHANGED:
      return {
        ...base,
        kind: 'status',
        tone: 'muted',
        title: agentName ?? 'Agent status changed',
        detail: stringField(payload, ['status', 'nextStatus']) ?? 'Status updated.',
      };
    default:
      return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stringField(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function numberField(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeProgress(value: unknown): { completed: number; total: number } | undefined {
  if (!isRecord(value)) return undefined;
  const completed = numberField(value, ['completed', 'done']);
  const total = numberField(value, ['total']);
  if (completed == null || total == null || total <= 0) return undefined;
  return { completed, total };
}
