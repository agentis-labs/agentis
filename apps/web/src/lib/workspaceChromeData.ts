import { useEffect, useSyncExternalStore } from 'react';
// §PERF-BOOT — subpath import; see lib/realtime.ts.
import { REALTIME_EVENTS } from '@agentis/core/events';
import { api, workspace as workspaceStore } from './api';
import { useRealtime } from './realtime';
import type {
  WorkspaceActivityRow,
  WorkspaceApproval,
  WorkspaceFleetOverview,
  WorkspaceNotification,
} from './workspaceData';

export interface WorkspaceChromeSnapshot {
  workspaceId: string | null;
  loading: boolean;
  approvals: WorkspaceApproval[];
  fleet: WorkspaceFleetOverview | null;
  latestActivity: WorkspaceActivityRow | null;
  notifications: WorkspaceNotification[];
  counts: {
    liveAgents: number;
    activeRuns: number;
  };
  updatedAt: number;
}

interface WorkspaceChromeResponse {
  workspaceId: string;
  approvals?: WorkspaceApproval[];
  fleet?: WorkspaceFleetOverview | null;
  latestActivity?: WorkspaceActivityRow | null;
  notifications?: WorkspaceNotification[];
  counts?: {
    liveAgents?: number;
    activeRuns?: number;
  };
}

const EMPTY_CHROME_SNAPSHOT: WorkspaceChromeSnapshot = {
  workspaceId: null,
  loading: true,
  approvals: [],
  fleet: null,
  latestActivity: null,
  notifications: [],
  counts: { liveAgents: 0, activeRuns: 0 },
  updatedAt: 0,
};

const WORKSPACE_CHROME_REFRESH_EVENTS = [
  REALTIME_EVENTS.RUN_CREATED,
  REALTIME_EVENTS.RUN_RUNNING,
  REALTIME_EVENTS.RUN_PAUSED,
  REALTIME_EVENTS.RUN_CANCELLED,
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
  REALTIME_EVENTS.ACTIVITY_CREATED,
] as const;

let snapshot = EMPTY_CHROME_SNAPSHOT;
let inflight: Promise<void> | null = null;
let refreshTimer: number | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function setSnapshot(next: WorkspaceChromeSnapshot) {
  snapshot = next;
  emit();
}

function keepPreviousForWorkspace(workspaceId: string | null): WorkspaceChromeSnapshot {
  if (snapshot.workspaceId === workspaceId) return snapshot;
  return { ...EMPTY_CHROME_SNAPSHOT, workspaceId, loading: true };
}

function normalizeChromeResponse(response: WorkspaceChromeResponse, workspaceId: string): WorkspaceChromeSnapshot {
  const liveAgents = Number(response.counts?.liveAgents ?? 0);
  const activeRuns = Number(response.counts?.activeRuns ?? response.fleet?.runs.active ?? 0);
  return {
    workspaceId,
    loading: false,
    approvals: response.approvals ?? [],
    fleet: response.fleet ?? null,
    latestActivity: response.latestActivity ?? null,
    notifications: response.notifications ?? [],
    counts: {
      liveAgents: Number.isFinite(liveAgents) ? liveAgents : 0,
      activeRuns: Number.isFinite(activeRuns) ? activeRuns : 0,
    },
    updatedAt: Date.now(),
  };
}

export function getWorkspaceChromeSnapshot() {
  return snapshot;
}

export function subscribeWorkspaceChromeSnapshot(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function refreshWorkspaceChromeSnapshot(): Promise<void> {
  const workspaceId = workspaceStore.get();
  if (!workspaceId) {
    setSnapshot({ ...EMPTY_CHROME_SNAPSHOT, loading: false });
    return;
  }
  if (inflight) return inflight;

  const base = keepPreviousForWorkspace(workspaceId);
  const firstLoadForWorkspace = base.workspaceId !== workspaceId || base.updatedAt === 0;
  setSnapshot({ ...base, workspaceId, loading: firstLoadForWorkspace });

  inflight = (async () => {
    try {
      const response = await api<WorkspaceChromeResponse>('/v1/dashboard/chrome');
      setSnapshot(normalizeChromeResponse(response, workspaceId));
    } catch {
      setSnapshot({ ...keepPreviousForWorkspace(workspaceId), workspaceId, loading: false });
    }
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

export function scheduleWorkspaceChromeRefresh(delayMs = 80) {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refreshWorkspaceChromeSnapshot();
  }, delayMs);
}

export function useWorkspaceChromeData(): WorkspaceChromeSnapshot {
  const current = useSyncExternalStore(
    subscribeWorkspaceChromeSnapshot,
    getWorkspaceChromeSnapshot,
    getWorkspaceChromeSnapshot,
  );

  useEffect(() => {
    void refreshWorkspaceChromeSnapshot();
    const onWorkspaceChanged = () => {
      setSnapshot({ ...EMPTY_CHROME_SNAPSHOT, workspaceId: workspaceStore.get(), loading: true });
      void refreshWorkspaceChromeSnapshot();
    };
    window.addEventListener('agentis:workspace-changed', onWorkspaceChanged);
    return () => window.removeEventListener('agentis:workspace-changed', onWorkspaceChanged);
  }, []);

  useRealtime([...WORKSPACE_CHROME_REFRESH_EVENTS], () => {
    scheduleWorkspaceChromeRefresh();
  });

  return current;
}
