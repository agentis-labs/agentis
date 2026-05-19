import { useEffect, useSyncExternalStore } from 'react';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, workspace as workspaceStore } from './api';
import { useRealtime } from './realtime';

export interface WorkspaceUser {
  name: string;
}

export interface WorkspaceAgent {
  id: string;
  name: string;
  status?: string;
  role?: string | null;
  reportsTo?: string | null;
  runtimeModel?: string | null;
  adapterType?: string | null;
  colorHex?: string | null;
  avatarGlyph?: string | null;
  spaceId?: string | null;
  spaceName?: string | null;
  currentTaskId?: string | null;
  description?: string | null;
  lastHeartbeatAt?: string | null;
}

export interface WorkspaceApproval {
  id: string;
  agentName?: string;
  workflowName?: string;
  summary?: string;
  runId?: string;
  createdAt: string;
}

export interface WorkspaceActiveRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  currentStep?: string;
  totalSteps?: number;
  stepIndex?: number;
  startedAt: string;
  agents?: Array<{ id: string; name: string }>;
}

export interface WorkspaceFailedRun {
  id: string;
  workflowName?: string;
  failedNode?: string;
  finishedAt?: string;
}

export interface WorkspaceArtifact {
  id: string;
  title: string;
  agent?: string;
  agentId?: string | null;
  workflowId?: string | null;
  createdAt: string;
  thumbUrl?: string | null;
  thumbnailUrl?: string | null;
  kind?: 'html' | 'image' | 'doc' | 'code' | 'data';
  type?: 'html' | 'image' | 'document' | 'code' | 'data';
}

export interface WorkspaceSpace {
  id: string;
  name: string;
  slug: string;
  color?: string | null;
  colorHex?: string;
  iconGlyph?: string | null;
  appCount?: number;
}

export interface WorkspaceFleetOverview {
  runs: { active: number };
  gateways: { total: number; connected: number };
  approvals: { pending: number };
}

export interface WorkspaceActivityRow {
  id: string;
  summary: string;
  createdAt: string;
}

export interface WorkspaceNotification {
  id: string;
  type: 'approval' | 'failure' | 'completion' | 'info' | 'setup';
  title: string;
  context: string;
  timestamp: string;
  workflowId?: string;
  workflowName?: string;
  runId?: string;
  agentName?: string;
  approvalId?: string;
  actionLabel?: string;
  actionEvent?: string;
  actionPayload?: Record<string, unknown>;
}

export interface WorkspaceSnapshot {
  workspaceId: string | null;
  loading: boolean;
  me: WorkspaceUser | null;
  agents: WorkspaceAgent[];
  approvals: WorkspaceApproval[];
  activeRuns: WorkspaceActiveRun[];
  failedRuns: WorkspaceFailedRun[];
  artifacts: WorkspaceArtifact[];
  spaces: WorkspaceSpace[];
  fleet: WorkspaceFleetOverview | null;
  latestActivity: WorkspaceActivityRow | null;
  notifications: WorkspaceNotification[];
  counts: {
    liveAgents: number;
    activeRuns: number;
  };
  updatedAt: number;
}

const EMPTY_SNAPSHOT: WorkspaceSnapshot = {
  workspaceId: null,
  loading: true,
  me: null,
  agents: [],
  approvals: [],
  activeRuns: [],
  failedRuns: [],
  artifacts: [],
  spaces: [],
  fleet: null,
  latestActivity: null,
  notifications: [],
  counts: { liveAgents: 0, activeRuns: 0 },
  updatedAt: 0,
};

export const WORKSPACE_DATA_REFRESH_EVENTS = [
  REALTIME_EVENTS.RUN_CREATED,
  REALTIME_EVENTS.RUN_RUNNING,
  REALTIME_EVENTS.RUN_COMPLETED,
  REALTIME_EVENTS.RUN_FAILED,
  REALTIME_EVENTS.RUN_RECOVERED,
  REALTIME_EVENTS.APPROVAL_REQUESTED,
  REALTIME_EVENTS.APPROVAL_RESOLVED,
  REALTIME_EVENTS.AGENT_CREATED,
  REALTIME_EVENTS.AGENT_UPDATED,
  REALTIME_EVENTS.AGENT_STATUS_CHANGED,
  REALTIME_EVENTS.AGENT_HEARTBEAT,
  REALTIME_EVENTS.GATEWAY_CONNECTED,
  REALTIME_EVENTS.GATEWAY_DISCONNECTED,
  REALTIME_EVENTS.GATEWAY_DEGRADED,
  REALTIME_EVENTS.ARTIFACT_CREATED,
  REALTIME_EVENTS.ARTIFACT_UPDATED,
  REALTIME_EVENTS.ARTIFACT_DELETED,
  REALTIME_EVENTS.SPACE_CREATED,
  REALTIME_EVENTS.SPACE_UPDATED,
  REALTIME_EVENTS.SPACE_DELETED,
  REALTIME_EVENTS.ACTIVITY_CREATED,
] as const;

const ACTIVE_RUN_STATUSES = new Set(['RUNNING', 'running']);
const LIVE_AGENT_STATUSES = new Set(['online', 'active', 'running']);

let snapshot = EMPTY_SNAPSHOT;
let inflight: Promise<void> | null = null;
let refreshTimer: number | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function setSnapshot(next: WorkspaceSnapshot) {
  snapshot = next;
  emit();
}

function keepPreviousForWorkspace(workspaceId: string | null): WorkspaceSnapshot {
  if (snapshot.workspaceId === workspaceId) return snapshot;
  return { ...EMPTY_SNAPSHOT, workspaceId, loading: true };
}

function fulfilled<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function normalizeArtifact(raw: WorkspaceArtifact): WorkspaceArtifact {
  return {
    ...raw,
    thumbUrl: raw.thumbUrl ?? raw.thumbnailUrl ?? null,
    kind: raw.kind ?? (raw.type === 'document' ? 'doc' : raw.type),
  };
}

function deriveNotifications(
  approvals: WorkspaceApproval[],
  failedRuns: WorkspaceFailedRun[],
  agents: WorkspaceAgent[],
  spaces: WorkspaceSpace[],
): WorkspaceNotification[] {
  const setup: WorkspaceNotification[] = [];
  const rest: WorkspaceNotification[] = [];

  const hasOrchestrator = agents.some((a) => (a.role ?? '').toLowerCase().includes('orchestrator'));
  if (!hasOrchestrator) {
    setup.push({
      id: 'setup-orchestrator',
      type: 'setup',
      title: 'Commission your orchestrator',
      context: 'The orchestrator routes goals, approvals, and command across the workspace.',
      timestamp: new Date().toISOString(),
      actionLabel: 'Commission orchestrator',
      actionEvent: 'agentis:commission-orchestrator',
    });
  }

  const managerlessSpaces = spaces.filter(
    (space) => !agents.some((a) => (a.role ?? '').toLowerCase().includes('manager') && a.spaceId === space.id),
  );
  if (managerlessSpaces.length > 0) {
    const first = managerlessSpaces[0];
    if (first) {
      setup.push({
        id: 'setup-managers',
        type: 'setup',
        title: managerlessSpaces.length === 1
          ? `${first.name} needs a manager`
          : `${managerlessSpaces.length} spaces need managers`,
        context: 'Spaces run more predictably with a coordinator above their workers and workflows.',
        timestamp: new Date().toISOString(),
        actionLabel: `Add manager for ${first.name}`,
        actionEvent: 'agentis:commission-manager',
        actionPayload: { spaceId: first.id },
      });
    }
  }

  for (const approval of approvals) {
    rest.push({
      id: `approval-${approval.id}`,
      type: 'approval',
      title: 'Approval needed',
      context: approval.summary || `${approval.workflowName ?? 'workflow'} - ${approval.agentName ?? 'agent'}`,
      timestamp: approval.createdAt,
      runId: approval.runId,
      workflowName: approval.workflowName,
      agentName: approval.agentName,
      approvalId: approval.id,
    });
  }
  for (const run of failedRuns) {
    rest.push({
      id: `failed-${run.id}`,
      type: 'failure',
      title: 'Workflow failed',
      context: `${run.workflowName ?? 'Workflow'}${run.failedNode ? ` - failed at ${run.failedNode}` : ''}`,
      timestamp: run.finishedAt ?? new Date().toISOString(),
      runId: run.id,
      workflowName: run.workflowName,
    });
  }
  const sorted = rest.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return [...setup, ...sorted].slice(0, 8);
}

function deriveCounts(agents: WorkspaceAgent[], activeRuns: WorkspaceActiveRun[]) {
  return {
    liveAgents: agents.filter((agent) => LIVE_AGENT_STATUSES.has(agent.status ?? '')).length,
    activeRuns: activeRuns.filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length,
  };
}

export function getWorkspaceSnapshot() {
  return snapshot;
}

export function subscribeWorkspaceSnapshot(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function refreshWorkspaceSnapshot(): Promise<void> {
  const workspaceId = workspaceStore.get();
  if (!workspaceId) {
    setSnapshot({ ...EMPTY_SNAPSHOT, loading: false });
    return;
  }
  if (inflight) return inflight;

  const base = keepPreviousForWorkspace(workspaceId);
  const firstLoadForWorkspace = base.workspaceId !== workspaceId || base.updatedAt === 0;
  setSnapshot({ ...base, workspaceId, loading: firstLoadForWorkspace });

  inflight = (async () => {
    const [meRes, agentsRes, approvalsRes, activeRunsRes, failedRunsRes, artifactsRes, fleetRes, activityRes, spacesRes] =
      await Promise.allSettled([
        api<{ user: WorkspaceUser }>('/v1/auth/me'),
        api<{ agents: WorkspaceAgent[] }>('/v1/agents'),
        api<{ approvals: WorkspaceApproval[] }>('/v1/approvals?status=pending'),
        api<{ runs: WorkspaceActiveRun[] }>('/v1/runs?status=running&limit=5'),
        api<{ runs: WorkspaceFailedRun[] }>('/v1/runs?status=failed&limit=5'),
        api<{ artifacts: WorkspaceArtifact[] }>('/v1/artifacts?limit=6'),
        api<WorkspaceFleetOverview>('/v1/dashboard/fleet-overview'),
        api<{ events: WorkspaceActivityRow[] }>('/v1/activity?limit=1'),
        api<{ spaces: WorkspaceSpace[] }>('/v1/spaces'),
      ]);

    const previous = keepPreviousForWorkspace(workspaceId);
    const me = fulfilled(meRes, { user: previous.me ?? { name: 'operator' } }).user ?? null;
    const agents = fulfilled(agentsRes, { agents: previous.agents }).agents ?? [];
    const approvals = fulfilled(approvalsRes, { approvals: previous.approvals }).approvals ?? [];
    const activeRuns = fulfilled(activeRunsRes, { runs: previous.activeRuns }).runs ?? [];
    const failedRuns = fulfilled(failedRunsRes, { runs: previous.failedRuns }).runs ?? [];
    const artifacts = (fulfilled(artifactsRes, { artifacts: previous.artifacts }).artifacts ?? []).map(normalizeArtifact);
    const fleet = fleetRes.status === 'fulfilled' ? fleetRes.value : previous.fleet;
    const latestActivity = fulfilled(activityRes, { events: previous.latestActivity ? [previous.latestActivity] : [] }).events[0] ?? null;
    const spaces = fulfilled(spacesRes, { spaces: previous.spaces }).spaces ?? [];

    setSnapshot({
      workspaceId,
      loading: false,
      me,
      agents,
      approvals,
      activeRuns,
      failedRuns,
      artifacts,
      spaces,
      fleet,
      latestActivity,
      notifications: deriveNotifications(approvals, failedRuns, agents, spaces),
      counts: deriveCounts(agents, activeRuns),
      updatedAt: Date.now(),
    });
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

export function scheduleWorkspaceSnapshotRefresh(delayMs = 80) {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refreshWorkspaceSnapshot();
  }, delayMs);
}

export function useWorkspaceData(): WorkspaceSnapshot {
  const current = useSyncExternalStore(
    subscribeWorkspaceSnapshot,
    getWorkspaceSnapshot,
    getWorkspaceSnapshot,
  );

  useEffect(() => {
    void refreshWorkspaceSnapshot();
    const onWorkspaceChanged = () => {
      setSnapshot({ ...EMPTY_SNAPSHOT, workspaceId: workspaceStore.get(), loading: true });
      void refreshWorkspaceSnapshot();
    };
    window.addEventListener('agentis:workspace-changed', onWorkspaceChanged);
    return () => window.removeEventListener('agentis:workspace-changed', onWorkspaceChanged);
  }, []);

  useRealtime([...WORKSPACE_DATA_REFRESH_EVENTS], () => {
    scheduleWorkspaceSnapshotRefresh();
  });

  return current;
}
