import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, streamSse, workspace as workspaceStore } from './api';
import { rtSubscribe, useRealtime } from './realtime';

export type ObservabilityStatus = 'started' | 'progress' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'info';
export type ObservabilityKind =
  | 'run'
  | 'node'
  | 'agent'
  | 'tool'
  | 'handoff'
  | 'approval'
  | 'brain'
  | 'artifact'
  | 'listener'
  | 'budget'
  | 'workflow'
  | 'system';

export interface ObservabilityEvent {
  id: string;
  workspaceId: string;
  sequenceNumber: number;
  scopeType: string;
  scopeId: string | null;
  kind: ObservabilityKind;
  status: ObservabilityStatus;
  title: string;
  summary: string;
  detail: string | null;
  actorType: string | null;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  runId: string | null;
  workflowId: string | null;
  agentId: string | null;
  nodeId: string | null;
  approvalId: string | null;
  correlationId: string | null;
  parentEventId: string | null;
  progress: { completed?: number; total?: number; label?: string } | null;
  evidence: Array<Record<string, unknown>>;
  rawPayloadRedacted: Record<string, unknown>;
  sourceEvent: string;
  createdAt: string;
}

export interface ActivityStreamScope {
  type?: 'workspace' | 'run' | 'agent' | 'workflow' | 'brain';
  id?: string | null;
  limit?: number;
}

export interface ActivityStreamState {
  events: ObservabilityEvent[];
  connected: boolean;
  loading: boolean;
}

export type ObservationTone = 'accent' | 'success' | 'warn' | 'danger' | 'muted';

export function useActivityStream(scope: ActivityStreamScope = {}): ActivityStreamState {
  const [events, setEvents] = useState<ObservabilityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(() => workspaceStore.get());
  const scopeType = scope.type ?? 'workspace';
  const scopeId = scope.id ?? null;
  const cap = scope.limit ?? 160;
  const maxSequenceRef = useRef(0);
  const scopeRef = useRef({ workspaceId, scopeType, scopeId });
  scopeRef.current = { workspaceId, scopeType, scopeId };

  useEffect(() => {
    const handleWorkspaceChange = () => setWorkspaceId(workspaceStore.get());
    window.addEventListener('agentis:workspace-changed', handleWorkspaceChange);
    return () => window.removeEventListener('agentis:workspace-changed', handleWorkspaceChange);
  }, []);

  useEffect(() => {
    if (!workspaceId) return undefined;
    switch (scopeType) {
      case 'run':
        return scopeId ? rtSubscribe('run', { runId: scopeId }) : undefined;
      case 'agent':
        return scopeId ? rtSubscribe('agent', { agentId: scopeId }) : undefined;
      case 'workflow':
        return scopeId ? rtSubscribe('workflow', { workflowId: scopeId }) : undefined;
      default:
        return rtSubscribe('workspace', { workspaceId });
    }
  }, [scopeId, scopeType, workspaceId]);

  useEffect(() => {
    maxSequenceRef.current = 0;
    setEvents([]);
    if (!workspaceId) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    void api<{ events: ObservabilityEvent[] }>(eventsPath({ scopeType, scopeId, limit: cap }))
      .then((result) => {
        if (cancelled) return;
        mergeEvents(result.events ?? [], cap, setEvents, maxSequenceRef);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [cap, scopeId, scopeType, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return undefined;
    const controller = new AbortController();
    void streamLoop({
      signal: controller.signal,
      cap,
      getAfterSequence: () => maxSequenceRef.current,
      path: (afterSequence) => eventsPath({ scopeType, scopeId, limit: cap, stream: true, afterSequence }),
      onConnected: setConnected,
      onEvents: (incoming) => mergeEvents(incoming, cap, setEvents, maxSequenceRef),
    });
    return () => {
      controller.abort();
      setConnected(false);
    };
  }, [cap, scopeId, scopeType, workspaceId]);

  useRealtime([REALTIME_EVENTS.OBSERVABILITY_EVENT], (env) => {
    const event = asObservabilityEvent(env.payload);
    if (!event || !matchesScope(event, scopeRef.current)) return;
    mergeEvents([event], cap, setEvents, maxSequenceRef);
  });

  return useMemo(() => ({ events, connected, loading }), [connected, events, loading]);
}

export function isActiveObservation(event: ObservabilityEvent): boolean {
  return event.status === 'started'
    || event.status === 'progress'
    || event.status === 'waiting'
    || event.status === 'blocked';
}

export function observationTone(event: Pick<ObservabilityEvent, 'status'>): ObservationTone {
  if (event.status === 'failed') return 'danger';
  if (event.status === 'waiting' || event.status === 'blocked') return 'warn';
  if (event.status === 'completed') return 'success';
  if (event.status === 'info') return 'muted';
  return 'accent';
}

function eventsPath(args: {
  scopeType: string;
  scopeId: string | null;
  limit: number;
  stream?: boolean;
  afterSequence?: number;
}): string {
  const params = new URLSearchParams();
  params.set('scope', args.scopeType);
  params.set('limit', String(args.limit));
  if (args.scopeId) params.set('scopeId', args.scopeId);
  if (args.afterSequence && args.afterSequence > 0) params.set('afterSequence', String(args.afterSequence));
  return `/v1/observability/${args.stream ? 'stream' : 'events'}?${params.toString()}`;
}

async function streamLoop(args: {
  signal: AbortSignal;
  cap: number;
  getAfterSequence: () => number;
  path: (afterSequence: number) => string;
  onConnected: (connected: boolean) => void;
  onEvents: (events: ObservabilityEvent[]) => void;
}): Promise<void> {
  while (!args.signal.aborted) {
    let opened = false;
    try {
      opened = true;
      args.onConnected(true);
      await streamSse(
        args.path(args.getAfterSequence()),
        { signal: args.signal },
        {
          onEvent: (event, data) => {
            if (event === 'heartbeat') return;
            const incoming = asObservabilityEvent(data);
            if (incoming) args.onEvents([incoming]);
          },
        },
      );
    } catch (err) {
      if (!args.signal.aborted) console.warn('[agentis] observability stream disconnected', err);
    } finally {
      if (opened) args.onConnected(false);
    }
    if (!args.signal.aborted) await sleep(1_500, args.signal);
  }
}

function mergeEvents(
  incoming: ObservabilityEvent[],
  cap: number,
  setEvents: Dispatch<SetStateAction<ObservabilityEvent[]>>,
  maxSequenceRef: MutableRefObject<number>,
): void {
  const valid = incoming.filter((event): event is ObservabilityEvent => Boolean(asObservabilityEvent(event)));
  if (valid.length === 0) return;
  for (const event of valid) {
    maxSequenceRef.current = Math.max(maxSequenceRef.current, event.sequenceNumber);
  }
  setEvents((current) => {
    const byId = new Map<string, ObservabilityEvent>();
    for (const event of current) byId.set(event.id, event);
    for (const event of valid) byId.set(event.id, event);
    return [...byId.values()]
      .sort((a, b) => {
        if (a.sequenceNumber !== b.sequenceNumber) return b.sequenceNumber - a.sequenceNumber;
        return b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, cap);
  });
}

function matchesScope(event: ObservabilityEvent, scope: { workspaceId: string | null; scopeType: string; scopeId: string | null }): boolean {
  if (scope.workspaceId && event.workspaceId !== scope.workspaceId) return false;
  switch (scope.scopeType) {
    case 'run': return Boolean(scope.scopeId) && event.runId === scope.scopeId;
    case 'agent': return Boolean(scope.scopeId) && event.agentId === scope.scopeId;
    case 'workflow': return Boolean(scope.scopeId) && event.workflowId === scope.scopeId;
    case 'brain': return event.kind === 'brain';
    default: return true;
  }
}

function asObservabilityEvent(value: unknown): ObservabilityEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<ObservabilityEvent>;
  return typeof record.id === 'string'
    && typeof record.workspaceId === 'string'
    && typeof record.sequenceNumber === 'number'
    ? record as ObservabilityEvent
    : null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}



