

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Wrench, AlertTriangle, Search, PencilRuler, ListChecks, Boxes, Sparkles, XCircle } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import { useRealtime } from '../../lib/realtime';

interface Repair { rule: number; kind: string; message: string }
interface Critique { rule: number; severity: 'info' | 'warn' | 'error'; message: string }

const PHASE_ORDER = ['analyzing', 'drafting', 'repairing', 'reviewing', 'building', 'complete'] as const;
type Phase = (typeof PHASE_ORDER)[number];
const PHASE_LABEL: Record<Phase, string> = {
  analyzing: 'Analyzing request',
  drafting: 'Drafting the graph',
  repairing: 'Repairing structure',
  reviewing: 'Reviewing vs grammar',
  building: 'Placing nodes',
  complete: 'Complete',
};
const PHASE_ICON: Record<Phase, typeof Search> = {
  analyzing: Search, drafting: PencilRuler, repairing: Wrench, reviewing: ListChecks, building: Boxes, complete: Sparkles,
};

export function WorkflowBuildTimeline({ runId }: { runId: string }) {
  const [phase, setPhase] = useState<Phase | null>(null);
  const [details, setDetails] = useState<Partial<Record<Phase, string>>>({});
  const [repairs, setRepairs] = useState<Repair[]>([]);
  const [critiques, setCritiques] = useState<Critique[]>([]);
  const [open, setOpen] = useState(true);

  const [blocked, setBlocked] = useState<string | null>(null);

  useEffect(() => {
    setPhase(null);
    setDetails({});
    setRepairs([]);
    setCritiques([]);
    setBlocked(null);
    setOpen(true);
  }, [runId]);

  useRealtime([REALTIME_EVENTS.WORKFLOW_BUILD_PHASE], (env) => {
    const p = env.payload as { runId?: string; phase?: string; detail?: string } | undefined;
    if (!p || p.runId !== runId || !p.phase) return;
    // The build refused (AI-only creation, no model / invalid model output).
    if (p.phase === 'blocked') {
      setBlocked(p.detail ?? 'Could not build this workflow.');
      return;
    }
    setPhase(p.phase as Phase);
    if (p.phase === 'complete') setOpen(false);
    if (p.detail) setDetails((prev) => ({ ...prev, [p.phase as Phase]: p.detail }));
  });
  useRealtime([REALTIME_EVENTS.WORKFLOW_BUILD_REPAIR], (env) => {
    const p = env.payload as { runId?: string; repair?: Repair } | undefined;
    if (!p || p.runId !== runId || !p.repair) return;
    setRepairs((prev) => [...prev, p.repair!]);
  });
  useRealtime([REALTIME_EVENTS.WORKFLOW_BUILD_CRITIQUE], (env) => {
    const p = env.payload as { runId?: string; critique?: Critique } | undefined;
    if (!p || p.runId !== runId || !p.critique) return;
    setCritiques((prev) => [...prev, p.critique!]);
  });

  if (blocked) {
    return (
      <div className="mt-2 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/5 px-3 py-2.5 text-[12px]">
        <XCircle size={14} className="mt-0.5 shrink-0 text-danger" />
        <div>
          <div className="font-semibold text-text-primary">Couldn't build this workflow</div>
          <div className="mt-0.5 text-text-secondary">{blocked}</div>
        </div>
      </div>
    );
  }

  if (!phase) return null;
  const currentIdx = PHASE_ORDER.indexOf(phase);
  const done = phase === 'complete';

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-line/40 bg-surface/50 text-[12px] backdrop-blur-md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 border-b border-line/20 bg-surface-2/50 px-3 py-2 text-left text-[10px] uppercase tracking-wide text-text-muted hover:text-text"
        aria-expanded={open}
      >
        {done ? <CheckCircle2 size={12} className="text-accent" /> : <Loader2 size={12} className="animate-spin text-accent" />}
        <span className="font-semibold">{done ? 'Build complete' : 'Build trace'}</span>
        {(repairs.length > 0 || critiques.length > 0) && (
          <span className="ml-1 normal-case text-text-muted">
            {repairs.length > 0 ? `· ${repairs.length} repair${repairs.length === 1 ? '' : 's'}` : ''}
            {critiques.length > 0 ? ` · ${critiques.length} critique${critiques.length === 1 ? '' : 's'}` : ''}
          </span>
        )}
        <span className="ml-auto">{open ? '–' : '+'}</span>
      </button>

      {open && (
        <div className="space-y-2 px-3 py-2.5">
          <ol className="space-y-1">
            {PHASE_ORDER.map((ph, idx) => {
              if (idx > currentIdx) return null;
              const Icon = PHASE_ICON[ph];
              const isCurrent = idx === currentIdx && !done;
              return (
                <li key={ph} className="flex items-baseline gap-2">
                  <span className={isCurrent ? 'text-accent' : 'text-text-muted'}>
                    {isCurrent ? <Loader2 size={11} className="inline animate-spin" /> : <Icon size={11} className="inline" />}
                  </span>
                  <span className="text-text-primary">{PHASE_LABEL[ph]}</span>
                  {details[ph] && <span className="text-text-muted">— {details[ph]}</span>}
                </li>
              );
            })}
          </ol>

          {repairs.length > 0 && (
            <ul className="space-y-1 border-t border-line/20 pt-2">
              {repairs.map((r, i) => (
                <li key={`r${i}`} className="flex items-baseline gap-2 text-text-secondary">
                  <Wrench size={11} className="mt-0.5 shrink-0 text-amber-500" />
                  <span><span className="font-medium text-text-primary">Rule {r.rule}</span> — {r.message}</span>
                </li>
              ))}
            </ul>
          )}

          {critiques.length > 0 && (
            <ul className="space-y-1 border-t border-line/20 pt-2">
              {critiques.map((c, i) => (
                <li key={`c${i}`} className="flex items-baseline gap-2">
                  <AlertTriangle size={11} className={`mt-0.5 shrink-0 ${c.severity === 'error' ? 'text-danger' : c.severity === 'warn' ? 'text-amber-500' : 'text-text-muted'}`} />
                  <span className="text-text-secondary"><span className="font-medium text-text-primary">Rule {c.rule}</span> — {c.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}



