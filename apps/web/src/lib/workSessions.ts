import type { ObservabilityEvent } from './observability';
import type { RealtimeActivity } from './realtimeActivity';
import type { WorkspaceActiveRun, WorkspaceFailedRun } from './workspaceData';

export type WorkSessionKind = 'agent' | 'workflow' | 'run' | 'approval' | 'system';
export type WorkSessionStatus = 'active' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'info';

export interface WorkSession {
  id: string;
  kind: WorkSessionKind;
  status: WorkSessionStatus;
  title: string;
  detail: string;
  at: string;
  runId?: string;
  workflowId?: string;
  agentId?: string;
  agentName?: string;
  conversationId?: string;
  clientTurnId?: string;
  primaryNodeId: string | null;
  participantAgentIds: string[];
  participantNames: string[];
  active: boolean;
  progress?: { completed: number; total: number };
  events: RealtimeActivity[];
}

interface BuildWorkSessionsArgs {
  activity: RealtimeActivity[];
  activeRuns?: WorkspaceActiveRun[];
  failedRuns?: WorkspaceFailedRun[];
  observabilityEvents?: ObservabilityEvent[];
  now?: number;
  windowMs?: number;
  limit?: number;
}

const DEFAULT_WINDOW_MS = 30_000;

export function buildWorkSessions({
  activity,
  activeRuns = [],
  failedRuns = [],
  observabilityEvents = [],
  now = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  limit = 12,
}: BuildWorkSessionsArgs): WorkSession[] {
  const sessions = new Map<string, WorkSession>();
  const settled = new Set<string>();
  const failedRunIds = new Set(failedRuns.map((run) => run.id));
  const failedWorkflowIds = new Set(failedRuns.map((run) => run.workflowId).filter(Boolean) as string[]);
  const liveRuns = activeRuns.filter((run) => !failedRunIds.has(run.id) && !failedWorkflowIds.has(run.workflowId));
  const activeRunById = new Map(liveRuns.map((run) => [run.id, run]));

  for (const item of activity) {
    if (!isSessionActivity(item)) continue;
    const key = sessionKey(item);
    if (!key) continue;
    const terminal = isTerminalActivity(item);
    const settledBefore = settled.has(key);
    if (terminal) settled.add(key);
    const existing = sessions.get(key);
    const run = item.runId ? activeRunById.get(item.runId) : undefined;
    const session = existing ?? createSession(key, item, run, now, windowMs, settled.has(key));
    appendSessionEvent(session, item);
    if (!settledBefore || terminal) session.status = sessionStatusFromActivity(item, session.status);
    session.active = !settled.has(key) && isRecent(item.at, now, windowMs) && isActiveStatus(session.status);
    if (item.progress) session.progress = item.progress;
    if (!settledBefore && (!session.detail || isRecent(item.at, now, windowMs))) session.detail = item.detail || item.title;
    sessions.set(key, session);
  }

  for (const run of liveRuns) {
    if (!isActiveRun(run)) continue;
    const key = `run:${run.id}`;
    if (sessions.has(key)) continue;
    sessions.set(key, {
      id: key,
      kind: 'run',
      status: 'active',
      title: run.workflowName,
      detail: run.currentStep ?? 'Running now',
      at: run.startedAt,
      runId: run.id,
      workflowId: run.workflowId,
      primaryNodeId: `workflow-${run.workflowId}`,
      participantAgentIds: unique(run.agents?.map((agent) => agent.id) ?? []),
      participantNames: unique(run.agents?.map((agent) => agent.name).filter(Boolean) ?? []),
      active: true,
      progress: run.totalSteps ? { completed: run.stepIndex ?? 0, total: run.totalSteps } : undefined,
      events: [],
    });
  }

  for (const event of observabilityEvents) {
    if (!isActiveObservationLike(event, now, windowMs)) continue;
    const key = observationSessionKey(event);
    if (!key) continue;
    const item = realtimeActivityFromObservation(event);
    const existing = sessions.get(key);
    if (existing) {
      appendSessionEvent(existing, item);
      existing.status = observationSessionStatus(event);
      existing.active = isActiveObservationLike(event, now, windowMs) && isActiveStatus(existing.status);
      existing.detail = event.summary || event.detail || event.title;
      if (event.progress) existing.progress = normalizeObservationProgress(event.progress);
      continue;
    }
    sessions.set(key, createObservationSession(key, event, item));
  }

  return Array.from(sessions.values())
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

export function liveNodeIdsFromSessions(sessions: WorkSession[]): { agentIds: Set<string>; workflowIds: Set<string> } {
  const agentIds = new Set<string>();
  const workflowIds = new Set<string>();
  for (const session of sessions) {
    if (!session.active) continue;
    if (session.workflowId) {
      workflowIds.add(session.workflowId);
      continue;
    }
    if (session.agentId) agentIds.add(session.agentId);
  }
  return { agentIds, workflowIds };
}

export function captionMapFromSessions(sessions: WorkSession[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const session of sessions) {
    if (!session.active || !session.detail) continue;
    if (session.workflowId && !map.has(`workflow-${session.workflowId}`)) {
      map.set(`workflow-${session.workflowId}`, session.detail);
    } else if (session.agentId && !map.has(`agent-${session.agentId}`)) {
      map.set(`agent-${session.agentId}`, session.detail);
    }
  }
  return map;
}

function createSession(
  key: string,
  item: RealtimeActivity,
  run: WorkspaceActiveRun | undefined,
  now: number,
  windowMs: number,
  settled: boolean,
): WorkSession {
  const runBacked = Boolean(item.runId || item.workflowId);
  const workflowId = item.workflowId ?? run?.workflowId;
  const title = run?.workflowName
    ?? (runBacked ? workflowTitleFromActivity(item) : item.agentName ?? item.title)
    ?? 'Agent work';
  return {
    id: key,
    kind: item.runId ? 'run' : workflowId ? 'workflow' : item.agentId ? 'agent' : 'system',
    status: sessionStatusFromActivity(item, 'info'),
    title,
    detail: item.detail || item.title,
    at: item.at,
    runId: item.runId ?? run?.id,
    workflowId,
    agentId: runBacked ? undefined : item.agentId,
    agentName: runBacked ? undefined : item.agentName,
    conversationId: item.conversationId,
    clientTurnId: item.clientTurnId,
    primaryNodeId: workflowId ? `workflow-${workflowId}` : item.agentId ? `agent-${item.agentId}` : null,
    participantAgentIds: unique([
      ...(run?.agents?.map((agent) => agent.id) ?? []),
      item.agentId,
    ].filter(Boolean) as string[]),
    participantNames: unique([
      ...(run?.agents?.map((agent) => agent.name) ?? []),
      item.agentName,
    ].filter(Boolean) as string[]),
    active: !settled && isRecent(item.at, now, windowMs) && !isTerminalActivity(item),
    progress: item.progress ?? (run?.totalSteps ? { completed: run.stepIndex ?? 0, total: run.totalSteps } : undefined),
    events: [],
  };
}

function appendSessionEvent(session: WorkSession, item: RealtimeActivity): void {
  session.events.push(item);
  session.at = session.at.localeCompare(item.at) > 0 ? session.at : item.at;
  if (item.agentId && !session.participantAgentIds.includes(item.agentId)) session.participantAgentIds.push(item.agentId);
  if (item.agentName && !session.participantNames.includes(item.agentName)) session.participantNames.push(item.agentName);
}

function sessionKey(item: RealtimeActivity): string | null {
  if (item.runId) return `run:${item.runId}`;
  if (item.workflowId) return `workflow:${item.workflowId}`;
  if (item.conversationId) return `conversation:${item.conversationId}:${item.clientTurnId ?? 'turn'}`;
  if (item.agentId) return `agent:${item.agentId}`;
  return null;
}

function observationSessionKey(event: ObservabilityEvent): string | null {
  if (event.runId) return `run:${event.runId}`;
  if (event.workflowId) return `workflow:${event.workflowId}`;
  const raw = event.rawPayloadRedacted;
  const conversationId = stringFromRecord(raw, ['conversationId']);
  const clientTurnId = stringFromRecord(raw, ['clientTurnId']);
  if (conversationId) return `conversation:${conversationId}:${clientTurnId ?? 'turn'}`;
  if (event.correlationId) return `correlation:${event.correlationId}`;
  if (event.agentId) return `agent:${event.agentId}`;
  return event.id ? `event:${event.id}` : null;
}

function createObservationSession(key: string, event: ObservabilityEvent, item: RealtimeActivity): WorkSession {
  const status = observationSessionStatus(event);
  const workflowId = event.workflowId ?? undefined;
  const agentId = event.agentId ?? undefined;
  return {
    id: key,
    kind: event.runId ? 'run' : workflowId ? 'workflow' : agentId ? 'agent' : event.kind === 'approval' ? 'approval' : 'system',
    status,
    title: agentId ? event.title : event.title || 'Agent work',
    detail: event.summary || event.detail || event.title,
    at: event.createdAt,
    runId: event.runId ?? undefined,
    workflowId,
    agentId: event.runId || workflowId ? undefined : agentId,
    conversationId: stringFromRecord(event.rawPayloadRedacted, ['conversationId']),
    clientTurnId: stringFromRecord(event.rawPayloadRedacted, ['clientTurnId']),
    primaryNodeId: workflowId ? `workflow-${workflowId}` : agentId ? `agent-${agentId}` : null,
    participantAgentIds: agentId ? [agentId] : [],
    participantNames: [],
    active: isActiveStatus(status),
    progress: normalizeObservationProgress(event.progress),
    events: [item],
  };
}

function realtimeActivityFromObservation(event: ObservabilityEvent): RealtimeActivity {
  return {
    id: `obs:${event.id}`,
    event: event.sourceEvent,
    kind: event.kind === 'tool' ? 'tool' : event.kind === 'approval' ? 'approval' : event.kind === 'run' ? 'run' : event.kind === 'node' ? 'node' : 'agent',
    tone: event.status === 'failed' ? 'danger' : event.status === 'completed' ? 'success' : event.status === 'waiting' || event.status === 'blocked' ? 'warn' : 'accent',
    title: event.title,
    detail: event.summary || event.detail || event.title,
    at: event.createdAt,
    runId: event.runId ?? undefined,
    workflowId: event.workflowId ?? undefined,
    taskId: stringFromRecord(event.rawPayloadRedacted, ['taskId', 'planId']),
    nodeId: event.nodeId ?? undefined,
    agentId: event.agentId ?? undefined,
    conversationId: stringFromRecord(event.rawPayloadRedacted, ['conversationId']),
    clientTurnId: stringFromRecord(event.rawPayloadRedacted, ['clientTurnId']),
    phase: event.status,
    tool: stringFromRecord(event.rawPayloadRedacted, ['tool', 'toolName', 'name', 'command']),
    progress: normalizeObservationProgress(event.progress),
    raw: event.rawPayloadRedacted,
  };
}

function observationSessionStatus(event: ObservabilityEvent): WorkSessionStatus {
  if (event.status === 'started' || event.status === 'progress') return 'active';
  return event.status;
}

function isSessionActivity(item: RealtimeActivity): boolean {
  if (item.kind === 'status') return false;
  if (item.kind === 'message') return Boolean(item.agentId || item.runId || item.workflowId);
  return item.kind === 'run'
    || item.kind === 'node'
    || item.kind === 'agent'
    || item.kind === 'tool'
    || item.kind === 'progress'
    || item.kind === 'approval';
}

function isTerminalActivity(item: RealtimeActivity): boolean {
  const phase = item.phase?.toLowerCase();
  return item.event.endsWith('completed')
    || item.event.endsWith('failed')
    || item.event.endsWith('cancelled')
    || item.event.endsWith('canceled')
    || phase === 'complete'
    || phase === 'completed'
    || phase === 'fail'
    || phase === 'failed'
    || phase === 'canceled'
    || phase === 'cancelled'
    || item.tone === 'success'
    || item.tone === 'danger';
}

function sessionStatusFromActivity(item: RealtimeActivity, fallback: WorkSessionStatus): WorkSessionStatus {
  if (item.tone === 'danger') return 'failed';
  if (item.tone === 'success') return 'completed';
  const phase = item.phase?.toLowerCase();
  if (phase === 'canceled' || phase === 'cancelled' || item.event.endsWith('canceled') || item.event.endsWith('cancelled')) return 'failed';
  if (item.tone === 'warn') return item.kind === 'approval' ? 'waiting' : 'blocked';
  if (item.kind === 'status' || item.tone === 'muted') return fallback;
  return 'active';
}

function isActiveStatus(status: WorkSessionStatus): boolean {
  return status === 'active' || status === 'waiting' || status === 'blocked';
}

function isRecent(value: string, now: number, windowMs: number): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= now - windowMs;
}

function isActiveRun(run: WorkspaceActiveRun): boolean {
  return run.status.toLowerCase() === 'running' || run.status.toLowerCase() === 'queued' || run.status.toLowerCase() === 'paused';
}

function isActiveObservationLike(event: ObservabilityEvent, now: number, windowMs: number): boolean {
  if (!isRecent(event.createdAt, now, windowMs)) return false;
  if (looksTerminalOrHistorical(event.title) || looksTerminalOrHistorical(event.summary) || looksTerminalOrHistorical(event.detail ?? '')) return false;
  return event.status === 'started' || event.status === 'progress' || event.status === 'waiting' || event.status === 'blocked';
}

function normalizeObservationProgress(progress: ObservabilityEvent['progress']): { completed: number; total: number } | undefined {
  if (!progress || progress.completed == null || progress.total == null) return undefined;
  return { completed: progress.completed, total: progress.total };
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function workflowTitleFromActivity(item: RealtimeActivity): string {
  const rawTitle = stringFromRecord(item.raw, ['workflowName', 'workflowTitle']);
  if (rawTitle) return rawTitle;
  if (item.nodeTitle) return item.nodeTitle;
  if (item.workflowId) return `Workflow ${item.workflowId.slice(0, 8)}`;
  return item.title;
}

function stringFromRecord(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function looksTerminalOrHistorical(value: string): boolean {
  return /\b(completed|finished|failed|updated|changed|resolved|cancelled|canceled)\b/i.test(value);
}
