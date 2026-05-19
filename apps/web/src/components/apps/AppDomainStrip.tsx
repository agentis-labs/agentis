/**
 * AppDomainStrip — live domain status row (SURFACE-PAGE-REDESIGN.md §2).
 *
 * One card per domain declared on the app. Each card resolves a live status
 * (RUNNING / IDLE / SCHEDULED / ERRORED) from its workflows + triggers and
 * shows a one-line last-action summary. Clicking a chip expands the last
 * run's node log inline — no navigation away from the Surface.
 */

import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Hexagon,
  Loader2,
  Radar,
  Repeat,
  Webhook,
  X,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { Skeleton } from '../shared/Skeleton';
import {
  domainTriggerType,
  relativeTime,
  resolveDomainStatus,
  type DomainStatus,
  type SurfaceDomain,
  type SurfaceRun,
  type SurfaceTrigger,
  type SurfaceWorkflow,
} from './appSurfaceShared';

interface RunNode {
  id: string;
  nodeId: string;
  title: string;
  status: 'completed' | 'failed' | 'running' | 'skipped' | 'pending';
  outputSummary?: string;
  error?: string;
}

function TriggerIcon({ type, size = 14 }: { type: string; size?: number }) {
  switch (type) {
    case 'persistent_listener':
      return <Radar size={size} />;
    case 'data_event':
      return <Repeat size={size} />;
    case 'cron':
      return <Clock size={size} />;
    case 'webhook_receiver':
      return <Webhook size={size} />;
    case 'api':
      return <Hexagon size={size} />;
    default:
      return <Zap size={size} />;
  }
}

const STATUS_META: Record<DomainStatus, { label: string; dot: string; text: string }> = {
  running: { label: 'RUNNING', dot: 'bg-warn', text: 'text-warn' },
  idle: { label: 'IDLE', dot: 'bg-surface-3', text: 'text-text-muted' },
  scheduled: { label: 'SCHEDULED', dot: 'bg-accent', text: 'text-accent' },
  errored: { label: 'ERRORED', dot: 'bg-danger', text: 'text-danger' },
};

export function AppDomainStrip({
  domains,
  workflows,
  triggers,
  runs,
}: {
  domains: SurfaceDomain[];
  workflows: SurfaceWorkflow[];
  triggers: SurfaceTrigger[];
  runs: SurfaceRun[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (domains.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex gap-3 overflow-x-auto pb-1">
        {domains.map((domain) => (
          <DomainCard
            key={domain.id}
            domain={domain}
            workflows={workflows.filter((wf) => domain.workflowIds.includes(wf.id))}
            triggers={triggers.filter((t) => domain.workflowIds.includes(t.workflowId))}
            runs={runs.filter((run) => run.workflowId && domain.workflowIds.includes(run.workflowId))}
            expanded={expanded === domain.id}
            onToggle={() => setExpanded((prev) => (prev === domain.id ? null : domain.id))}
          />
        ))}
      </div>
    </section>
  );
}

function DomainCard({
  domain,
  workflows,
  triggers,
  runs,
  expanded,
  onToggle,
}: {
  domain: SurfaceDomain;
  workflows: SurfaceWorkflow[];
  triggers: SurfaceTrigger[];
  runs: SurfaceRun[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const status = resolveDomainStatus(workflows, triggers);
  const meta = STATUS_META[status];
  const triggerType = domainTriggerType(triggers);
  const latestRun = runs[0] ?? null;
  const summary = domainSummary(status, workflows, triggers, latestRun);

  return (
    <div className="min-w-[230px] shrink-0">
      <button
        type="button"
        role="status"
        aria-live="polite"
        aria-label={status === 'running' ? `${domain.name} is running` : `${domain.name} is ${meta.label.toLowerCase()}`}
        onClick={onToggle}
        className={clsx(
          'flex w-full flex-col gap-2 rounded-[18px] border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2/60',
          status === 'errored' ? 'border-danger/30' : status === 'running' ? 'border-warn/30' : 'border-line',
        )}
      >
        <div className="flex items-center gap-2 text-text-muted">
          <TriggerIcon type={triggerType} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">{domain.name}</span>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={clsx(
              'flex h-2 w-2 rounded-full',
              meta.dot,
              status === 'running' && 'animate-pulse',
            )}
          />
          <span className={clsx('text-[10px] font-semibold uppercase tracking-[0.14em]', meta.text)}>
            {meta.label}
          </span>
        </div>
        <div className="truncate text-[11px] text-text-secondary">{summary}</div>
      </button>
      {expanded && <DomainRunLog runId={latestRun?.id ?? null} />}
    </div>
  );
}

function domainSummary(
  status: DomainStatus,
  workflows: SurfaceWorkflow[],
  triggers: SurfaceTrigger[],
  latestRun: SurfaceRun | null,
): string {
  if (status === 'running') {
    const running = workflows.filter((wf) => (wf.status ?? '').toLowerCase() === 'running').length;
    return `${running || 1} task${running === 1 ? '' : 's'} active`;
  }
  if (status === 'errored') {
    return latestRun ? `failed ${relativeTime(latestRun.startedAt)}` : 'last run failed';
  }
  if (status === 'scheduled') {
    const cron = triggers.find((t) => t.triggerType === 'cron' && t.status === 'active');
    return cron?.summary ?? 'awaiting next trigger';
  }
  if (latestRun) return `last run ${relativeTime(latestRun.startedAt)}`;
  const lastRunAt = workflows.map((wf) => wf.lastRunAt).filter(Boolean).sort().pop();
  return lastRunAt ? `last run ${relativeTime(lastRunAt)}` : 'no runs yet';
}

function DomainRunLog({ runId }: { runId: string | null }) {
  const [nodes, setNodes] = useState<RunNode[] | null>(null);

  useEffect(() => {
    if (!runId) {
      setNodes([]);
      return;
    }
    let cancelled = false;
    setNodes(null);
    void api<{ run: { nodes: RunNode[] } }>(`/v1/runs/${runId}`)
      .then((data) => {
        if (!cancelled) setNodes(data.run.nodes ?? []);
      })
      .catch(() => {
        if (!cancelled) setNodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return (
    <div className="mt-2 rounded-[14px] border border-line bg-surface-2 px-3 py-2.5">
      {nodes === null ? (
        <Skeleton height={60} />
      ) : nodes.length === 0 ? (
        <div className="text-[11px] text-text-muted">No run history for this domain yet.</div>
      ) : (
        <div className="space-y-1">
          {nodes.map((node, index) => (
            <div key={node.id || index} className="flex items-center gap-2">
              <NodeDot status={node.status} />
              <span
                className={clsx(
                  'flex-1 truncate text-[11px]',
                  node.status === 'failed' ? 'text-danger' : 'text-text-secondary',
                )}
              >
                {node.title}
                {node.outputSummary && <span className="text-text-muted"> — {node.outputSummary}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NodeDot({ status }: { status: RunNode['status'] }) {
  if (status === 'completed') {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
        <Check size={9} />
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger">
        <X size={9} />
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-accent/40">
        <Loader2 size={9} className="animate-spin text-accent" />
      </span>
    );
  }
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-line">
      <span className="h-1 w-1 rounded-full bg-surface-3" />
    </span>
  );
}
