import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, X, XCircle } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import clsx from 'clsx';
import { WorkflowBuildTimeline } from './WorkflowBuildTimeline';
import { useRealtime } from '../../lib/realtime';

const PHASES = ['analyzing', 'drafting', 'repairing', 'reviewing', 'building', 'complete'] as const;
type Phase = (typeof PHASES)[number];

const PHASE_LABEL: Record<Phase, string> = {
  analyzing: 'Analyzing request',
  drafting: 'Drafting graph',
  repairing: 'Repairing structure',
  reviewing: 'Reviewing grammar',
  building: 'Placing nodes',
  complete: 'Ready',
};

export function StickyBuildBanner({
  runId,
  workflowId,
  blocked,
  onOpenCanvas,
}: {
  runId: string;
  workflowId?: string;
  blocked?: boolean;
  onOpenCanvas?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [phase, setPhase] = useState<Phase>('analyzing');
  const [detail, setDetail] = useState('');

  useEffect(() => {
    setExpanded(false);
    setPhase('analyzing');
    setDetail('');
  }, [runId]);

  useRealtime([REALTIME_EVENTS.WORKFLOW_BUILD_PHASE], (env) => {
    const payload = env.payload as { runId?: string; phase?: string; detail?: string } | undefined;
    if (!payload?.runId || payload.runId !== runId) return;
    if (payload.phase && PHASES.includes(payload.phase as Phase)) setPhase(payload.phase as Phase);
    if (payload.detail) setDetail(payload.detail);
  });

  if (blocked) {
    return (
      <div className="sticky top-0 z-20 mb-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] shadow-sm backdrop-blur-sm">
        <XCircle size={13} className="shrink-0 text-danger" />
        <span className="font-medium text-danger">Workflow build blocked</span>
      </div>
    );
  }

  const phaseIndex = Math.max(0, PHASES.indexOf(phase));
  const progress = Math.round(((phaseIndex + 1) / PHASES.length) * 100);

  return (
    <div className="sticky top-0 z-20 mb-2 overflow-hidden rounded-lg border border-accent/25 bg-surface/95 text-[11px] shadow-[0_4px_20px_-8px_rgba(0,0,0,0.4)] backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-surface-2/50"
        aria-expanded={expanded}
      >
        <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-text-primary">{PHASE_LABEL[phase]}</span>
          {detail && <span className="block truncate text-[10px] text-text-muted">{detail}</span>}
        </span>
        {workflowId && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenCanvas?.();
            }}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-accent transition hover:bg-accent/10 active:scale-[0.98]"
          >
            Open canvas
          </button>
        )}
        <span className="text-text-muted">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      <div className="grid grid-cols-6 gap-px bg-line/30" aria-hidden>
        {PHASES.map((item, index) => (
          <span
            key={item}
            className={clsx('h-0.5 transition-colors duration-300', index <= phaseIndex ? 'bg-accent' : 'bg-surface-3')}
            title={PHASE_LABEL[item]}
          />
        ))}
      </div>
      <div className="sr-only">Workflow build progress {progress}%</div>

      {expanded && (
        <div className="border-t border-line/30 px-3 pb-2.5 pt-1.5">
          <WorkflowBuildTimeline runId={runId} />
        </div>
      )}
    </div>
  );
}

export function CompletedBuildBanner({
  workflowId,
  nodeCount,
  onOpenCanvas,
  onDismiss,
}: {
  workflowId: string;
  nodeCount?: number;
  onOpenCanvas?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div className="sticky top-0 z-20 mb-2 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/8 px-3 py-2 text-[11px] shadow-sm backdrop-blur-sm">
      <CheckCircle2 size={13} className="shrink-0 text-accent" />
      <span className="font-medium text-text-primary">
        Workflow ready{nodeCount ? ` · ${nodeCount} nodes` : ''}
      </span>
      {workflowId && (
        <button
          type="button"
          onClick={onOpenCanvas}
          className="ml-1 rounded-md bg-accent px-2 py-0.5 text-[10px] font-semibold text-canvas transition hover:bg-accent/90 active:scale-[0.98]"
        >
          Open canvas
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto grid h-5 w-5 place-items-center rounded text-text-muted/60 transition hover:bg-surface-2 hover:text-text-muted"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
