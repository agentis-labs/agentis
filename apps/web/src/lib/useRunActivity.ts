import { useEffect, useRef, useState } from 'react';
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
 * LAYER 1/2 consumer: the live activity stream for one run, newest-first.
 *
 * Subscribes to the run room, BACK-FILLS the replayable tail from
 * `GET /v1/runs/:id/activity` (so a surface opened mid-run shows recent
 * reasoning/steps immediately — never "EVENTS 0"), then merges live events.
 * Works over whichever transport `useRealtime` has (socket or SSE fallback).
 * This is the single hook every run surface (monitor, inspector, triage) uses.
 */
export function useRunActivity(
  runId: string | null | undefined,
  opts?: { nodeTitle?: (id: string) => string | undefined; cap?: number },
): RealtimeActivity[] {
  const [feed, setFeed] = useState<RealtimeActivity[]>([]);
  const seqRef = useRef(0);
  const nodeTitleRef = useRef(opts?.nodeTitle);
  nodeTitleRef.current = opts?.nodeTitle;
  const cap = opts?.cap ?? 80;

  useEffect(() => {
    setFeed([]);
    seqRef.current = 0;
    if (!runId) return;
    const unsubscribe = rtSubscribe('run', { runId });
    let cancelled = false;
    void api<{ activity: RunActivityEnvelope[] }>(`/v1/runs/${runId}/activity`)
      .then((res) => {
        if (cancelled) return;
        const historical = (res.activity ?? [])
          .map((env) => describeRealtimeActivity(env, { nodeTitle: nodeTitleRef.current }))
          .filter((a): a is RealtimeActivity => Boolean(a) && a!.runId === runId)
          .map((a, i) => ({ ...a, id: `bf:${a.id}:${i}` }))
          .reverse(); // newest-first
        if (historical.length === 0) return;
        setFeed((current) => {
          const seen = new Set(current.map((c) => c.id));
          return [...current, ...historical.filter((h) => !seen.has(h.id))].slice(0, cap);
        });
      })
      .catch(() => { /* back-fill is best-effort */ });
    return () => { cancelled = true; unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useRealtime([...REALTIME_ACTIVITY_EVENTS], (env) => {
    if (!runId) return;
    const activity = describeRealtimeActivity(env, { nodeTitle: nodeTitleRef.current });
    if (!activity || activity.runId !== runId) return;
    seqRef.current += 1;
    setFeed((current) => [{ ...activity, id: `${activity.id}:${seqRef.current}` }, ...current].slice(0, cap));
  });

  return feed;
}

/** The single most-recent meaningful activity item for a run (for compact rows). */
export function latestRunActivity(feed: RealtimeActivity[]): RealtimeActivity | null {
  return feed[0] ?? null;
}
