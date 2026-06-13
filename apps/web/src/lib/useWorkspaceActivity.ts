import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { rtSubscribe, useRealtime } from './realtime';
import {
  REALTIME_ACTIVITY_EVENTS,
  describeRealtimeActivity,
  type RealtimeActivity,
} from './realtimeActivity';

interface RunActivityEnvelope {
  event: string;
  payload: Record<string, unknown>;
  emittedAt: string;
}

/**
 * Workspace-wide live activity spine — the single feed that powers Mission
 * Control and the canvas's "what is the orchestrator doing right now" liveness.
 *
 * Where `useRunActivity` watches ONE run, this watches the whole workspace:
 * it subscribes to the workspace room + every activity event (run/node/agent
 * work-step/tool-call/message/approval), maps each through the shared
 * `describeRealtimeActivity`, and keeps a capped, deduped, newest-first feed.
 *
 * It also back-fills the replayable tail of currently-active runs so a freshly
 * opened canvas isn't blank mid-work. Pass the active runs you already have
 * (from `useWorkspaceData`) so we don't refetch the list.
 */
export function useWorkspaceActivity(
  activeRunIds: string[],
  opts?: { cap?: number; nodeTitle?: (id: string) => string | undefined },
): RealtimeActivity[] {
  const [feed, setFeed] = useState<RealtimeActivity[]>([]);
  const seqRef = useRef(0);
  const nodeTitleRef = useRef(opts?.nodeTitle);
  nodeTitleRef.current = opts?.nodeTitle;
  const cap = opts?.cap ?? 120;
  // Stable key so the back-fill effect only reruns when the *set* changes.
  const runKey = [...activeRunIds].sort().join(',');

  useEffect(() => {
    const unsubscribe = rtSubscribe('workspace', {});
    return () => unsubscribe();
  }, []);

  // Back-fill the replayable tail of each active run (best-effort, parallel).
  useEffect(() => {
    if (!runKey) return;
    let cancelled = false;
    const ids = runKey.split(',').filter(Boolean);
    void Promise.allSettled(
      ids.map((id) => api<{ activity: RunActivityEnvelope[] }>(`/v1/runs/${id}/activity`)),
    ).then((results) => {
      if (cancelled) return;
      const historical: RealtimeActivity[] = [];
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        for (const env of result.value.activity ?? []) {
          const activity = describeRealtimeActivity(env, { nodeTitle: nodeTitleRef.current });
          if (activity) historical.push(activity);
        }
      }
      if (historical.length === 0) return;
      historical.sort((a, b) => b.at.localeCompare(a.at)); // newest-first
      setFeed((current) => {
        const seen = new Set(current.map((c) => c.id));
        const merged = [...current];
        for (const h of historical) {
          if (seen.has(h.id)) continue;
          seen.add(h.id);
          merged.push({ ...h, id: `bf:${h.id}` });
        }
        merged.sort((a, b) => b.at.localeCompare(a.at));
        return merged.slice(0, cap);
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, cap]);

  useRealtime([...REALTIME_ACTIVITY_EVENTS], (env) => {
    const activity = describeRealtimeActivity(env, { nodeTitle: nodeTitleRef.current });
    if (!activity) return;
    seqRef.current += 1;
    setFeed((current) => {
      // Dedup against the immediate previous head (back-to-back identical ids).
      const next = { ...activity, id: `${activity.id}:${seqRef.current}` };
      return [next, ...current].slice(0, cap);
    });
  });

  return feed;
}

export interface WorkspaceRequestStatus {
  /** True while an agent/run is actively emitting work (the orchestrator is busy). */
  busy: boolean;
  /** A short, human label for the current focus (e.g. the latest step detail). */
  label: string | null;
  /** The most recent activity item, for compact headers. */
  latest: RealtimeActivity | null;
}

/**
 * Kinds that mean "real work is executing" — runs, node transitions, tool
 * calls, progress. Deliberately EXCLUDES 'agent'/'message'/'status': those
 * include ambient chatter (status pings, chat-memory "learning from this
 * conversation" steps) that must never light up the canvas or mark the
 * workspace busy. Mission Control's full stream still shows everything;
 * this filter only gates *liveness*.
 */
const WORK_KINDS = new Set<RealtimeActivity['kind']>(['run', 'node', 'tool', 'progress']);
const BUSY_WINDOW_MS = 20_000;

function isWork(a: RealtimeActivity): boolean {
  return WORK_KINDS.has(a.kind);
}
function isTerminal(a: RealtimeActivity): boolean {
  return a.event.endsWith('completed') || a.event.endsWith('failed');
}

/** Is the workspace mid-work, and what's the current focus? */
export function workspaceRequestStatus(feed: RealtimeActivity[]): WorkspaceRequestStatus {
  const cutoff = Date.now() - BUSY_WINDOW_MS;
  // The newest WORK item decides — ambient agent/message chatter is ignored.
  const latestWork = feed.find((a) => isWork(a)) ?? null;
  if (!latestWork) return { busy: false, label: null, latest: null };
  const recent = new Date(latestWork.at).getTime() >= cutoff;
  return {
    busy: recent && !isTerminal(latestWork),
    label: latestWork.detail || latestWork.title || null,
    latest: latestWork,
  };
}

/** Ids (agentId/workflowId) currently doing WORK — drives canvas node/edge liveness. */
export function useLiveNodeIds(feed: RealtimeActivity[], windowMs = BUSY_WINDOW_MS): {
  agentIds: Set<string>;
  workflowIds: Set<string>;
} {
  return useMemo(() => {
    const agentIds = new Set<string>();
    const workflowIds = new Set<string>();
    const cutoff = Date.now() - windowMs;
    // A terminal event CLEARS liveness for its ids (newest-first feed: the
    // first mention of an id wins, so a workflow whose latest event is
    // run.completed never re-lights from older started events).
    const settled = new Set<string>();
    for (const a of feed) {
      if (new Date(a.at).getTime() < cutoff) break; // feed is newest-first
      if (!isWork(a)) continue;
      const keys = [a.agentId && `a:${a.agentId}`, a.workflowId && `w:${a.workflowId}`].filter(Boolean) as string[];
      if (isTerminal(a)) {
        for (const k of keys) settled.add(k);
        continue;
      }
      if (a.agentId && !settled.has(`a:${a.agentId}`)) agentIds.add(a.agentId);
      if (a.workflowId && !settled.has(`w:${a.workflowId}`)) workflowIds.add(a.workflowId);
    }
    return { agentIds, workflowIds };
  }, [feed, windowMs]);
}

/** Shared predicate so caption/liveness consumers apply the same definition of "work". */
export function isWorkActivity(a: RealtimeActivity): boolean {
  return isWork(a) && !isTerminal(a);
}
