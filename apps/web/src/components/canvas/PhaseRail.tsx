import { useMemo } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Check, LoaderCircle } from 'lucide-react';
import { derivePhaseStatus, stripPhasePrefix, type PhaseNode, type PhaseSpec } from './PhaseLayer';

/**
 * PhaseRail — the workflow's structure, read as a quiet list.
 *
 * The primary way to comprehend and navigate a multi-phase workflow. Monochrome
 * and minimal: a muted number, the phase name, a small status glyph, and a thin
 * color tick that ties the row to its band on the canvas. No saturated chips.
 * Clicking a row frames + focuses that band and dims the rest of the graph.
 */
interface PhaseRailProps {
  phases: PhaseSpec[];
  nodes: PhaseNode[];
  focusedPhaseId?: string | null;
  onFocusPhase: (phaseId: string) => void;
  onClearFocus: () => void;
  onAskAgentForPhases?: () => void;
}

export function PhaseRail({ phases, nodes, focusedPhaseId, onFocusPhase, onClearFocus, onAskAgentForPhases }: PhaseRailProps) {
  const rows = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return phases.map((phase) => {
      const members = phase.nodeIds.map((id) => byId.get(id)).filter(Boolean) as PhaseNode[];
      return { phase, count: members.length, ...derivePhaseStatus(members) };
    });
  }, [phases, nodes]);

  if (phases.length === 0) {
    return (
      <div className="flex flex-1 flex-col gap-3 px-3 py-4">
        <div className="space-y-1 rounded-lg border border-dashed border-line bg-surface-2/50 px-3 py-3">
          <p className="text-[11px] font-medium text-text-primary">No phases yet</p>
          <p className="text-[11px] leading-relaxed text-text-muted">
            Drag a selection box across any part of two or more nodes, or Ctrl/Cmd-click nodes, then use Create phase.
          </p>
        </div>
        {onAskAgentForPhases && (
          <button
            type="button"
            onClick={onAskAgentForPhases}
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-left text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
          >
            Ask Agentis to organize phases
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col overflow-y-auto px-1.5 py-2">
      <button
        type="button"
        onClick={onClearFocus}
        className={clsx(
          'mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
          !focusedPhaseId ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:bg-surface-2 hover:text-text-primary',
        )}
      >
        <span className="flex-1">All steps</span>
        <span className="text-[10px] tabular-nums text-text-muted">{nodes.length}</span>
      </button>

      {rows.map(({ phase, count, status, pending }, index) => {
        const active = focusedPhaseId === phase.id;
        return (
          <button
            key={phase.id}
            type="button"
            onClick={() => onFocusPhase(phase.id)}
            className={clsx(
              'group flex items-center gap-2.5 rounded-md py-1.5 pl-2 pr-2 text-left transition-colors',
              active ? 'bg-surface-2' : 'hover:bg-surface-2',
            )}
            style={active ? { boxShadow: `inset 2px 0 0 ${phase.color}` } : undefined}
            title={phase.description ? `${stripPhasePrefix(phase.name)} — ${phase.description}` : stripPhasePrefix(phase.name)}
          >
            <span className="w-3.5 shrink-0 text-[11px] tabular-nums text-text-muted">{index + 1}</span>
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: phase.color, opacity: active ? 0.9 : 0.55 }}
              aria-hidden
            />
            <span
              className={clsx(
                'flex-1 truncate text-[12.5px]',
                active ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary',
              )}
            >
              {stripPhasePrefix(phase.name)}
            </span>
            <PhaseStatusGlyph status={status} pending={pending} count={count} />
          </button>
        );
      })}
    </div>
  );
}

function PhaseStatusGlyph({
  status,
  pending,
  count,
}: {
  status: ReturnType<typeof derivePhaseStatus>['status'];
  pending: number;
  count: number;
}) {
  if (pending > 0) {
    return (
      <span className="flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-warn" title={`${pending} need setup`}>
        <AlertTriangle size={11} /> {pending}
      </span>
    );
  }
  if (status === 'running') return <LoaderCircle size={12} className="shrink-0 animate-spin text-accent" />;
  if (status === 'failed') return <AlertTriangle size={12} className="shrink-0 text-danger" />;
  if (status === 'completed') return <Check size={12} className="shrink-0 text-success" />;
  return <span className="text-[10px] tabular-nums text-text-muted">{count}</span>;
}



