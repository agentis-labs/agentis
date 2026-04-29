import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, workspace } from '../lib/api';
import { useRealtime, rtSubscribe } from '../lib/realtime';
import { usePageContext } from '../components/assistant/Assistant';

interface RunDetail {
  run: {
    id: string;
    workflowId: string;
    status: string;
    runState: { nodeStates: Record<string, { status: string; error?: string }> };
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
  };
}

interface LedgerEvent {
  id: string;
  sequenceNumber: number;
  eventType: string;
  nodeId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<LedgerEvent[]>([]);

  usePageContext({
    label: id ? `Run · ${id.slice(0, 8)}…` : 'Run',
    placeholder: 'Ask why this run behaved this way…',
    prompts: [
      'Why did this run fail?',
      'Summarise what happened so far',
      'Which node took the longest?',
    ],
    href: id ? `/runs/${id}` : undefined,
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const ws = workspace.get();
    if (ws) rtSubscribe('run', { workspaceId: ws, runId: id });
    void load(id);
  }, [id]);

  useRealtime(
    ['node.started', 'node.completed', 'node.failed', 'run.completed', 'run.failed', 'ledger.event'],
    () => id && void load(id),
  );

  async function load(runId: string) {
    const [d, l] = await Promise.all([
      api<RunDetail>(`/v1/runs/${runId}`),
      api<{ events: LedgerEvent[] }>(`/v1/runs/${runId}/ledger?limit=500`),
    ]);
    setDetail(d);
    setEvents(l.events);
  }

  if (!detail) return <div className="p-6 text-sm text-text-muted">Loading run…</div>;
  const ns = detail.run.runState.nodeStates;

  return (
    <div className="grid h-full grid-cols-12 gap-4 p-4">
      <div className="col-span-12 rounded-2xl border border-line bg-surface p-4 shadow-card lg:col-span-4">
        <div className="mb-3 text-xs uppercase tracking-wide text-text-muted">Run</div>
        <div className="font-mono text-xs text-text-muted">{detail.run.id}</div>
        <div className="mt-2 text-xl font-medium">
          <StatusBadge status={detail.run.status} />
        </div>
        <div className="mt-4 space-y-1 text-xs">
          <div className="flex justify-between text-text-muted">
            <span>Created</span>
            <span>{new Date(detail.run.createdAt).toLocaleTimeString()}</span>
          </div>
          {detail.run.startedAt && (
            <div className="flex justify-between text-text-muted">
              <span>Started</span>
              <span>{new Date(detail.run.startedAt).toLocaleTimeString()}</span>
            </div>
          )}
          {detail.run.completedAt && (
            <div className="flex justify-between text-text-muted">
              <span>Completed</span>
              <span>{new Date(detail.run.completedAt).toLocaleTimeString()}</span>
            </div>
          )}
        </div>
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-2 text-xs uppercase tracking-wide text-text-muted">Nodes</div>
          <div className="space-y-1 text-sm">
            {Object.entries(ns).map(([nid, n]) => (
              <div key={nid} className="flex items-center justify-between">
                <span className="font-mono text-xs text-text-muted">{nid}</span>
                <StatusBadge status={n.status} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="col-span-12 rounded-2xl border border-line bg-surface p-4 shadow-card lg:col-span-8">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-text-muted">Ledger</div>
          <div className="text-xs text-text-muted">{events.length} events</div>
        </div>
        <div className="max-h-[70vh] overflow-auto font-mono text-xs">
          {events.map((e) => (
            <div key={e.id} className="border-b border-line/50 py-1">
              <span className="mr-2 text-text-muted">#{e.sequenceNumber.toString().padStart(4, '0')}</span>
              <span className="mr-2 text-accent">{e.eventType}</span>
              {e.nodeId && <span className="mr-2 text-text-muted">{e.nodeId}</span>}
              <span className="text-text-muted">{JSON.stringify(e.payload)}</span>
            </div>
          ))}
          {events.length === 0 && <div className="py-4 text-text-muted">Waiting for first event…</div>}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'COMPLETED' ? 'text-accent border-accent/40 bg-accent/10' :
    status === 'RUNNING' ? 'text-accent border-accent/40 bg-accent/10' :
    status === 'FAILED' ? 'text-danger border-danger/40 bg-danger/10' :
    status === 'WAITING' ? 'text-warn border-warn/40 bg-warn/10' :
    'text-text-muted border-line bg-surface-2';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${tone}`}>
      {status}
    </span>
  );
}
