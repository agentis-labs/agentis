import { Check, Circle, Clock3, ListChecks } from 'lucide-react';
import { projectPlanSteps, type ChatPlan } from '@agentis/core';
import clsx from 'clsx';

export function DurablePlanCard({ plan, recovered = false }: { plan: ChatPlan; recovered?: boolean }) {
  const track = projectPlanSteps(plan);
  return (
    <section className="mb-2 overflow-hidden rounded-xl border border-accent/25 bg-canvas/55 shadow-[0_14px_35px_-30px_rgba(139,92,246,0.75)]">
      <header className="flex items-start gap-2.5 border-b border-line/70 px-3 py-2.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><ListChecks size={14} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-[12px] font-semibold text-text-primary">{plan.title}</h3>
            <span className="rounded-full border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-text-muted">{plan.status}</span>
            {recovered && <span className="text-[9px] uppercase tracking-wide text-accent">Recovered plan</span>}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-text-secondary">{plan.objective}</p>
        </div>
      </header>
      {track.steps.length > 0 && (
        <div className="space-y-1.5 px-3 py-2.5">
          {track.steps.map((step) => (
            <div key={step.id} className="flex items-start gap-2 text-[11px]">
              {step.status === 'done'
                ? <Check size={12} className="mt-0.5 shrink-0 text-emerald-400" />
                : step.status === 'running'
                  ? <Clock3 size={12} className="mt-0.5 shrink-0 text-accent" />
                  : <Circle size={10} className={clsx('mt-0.5 shrink-0', step.status === 'failed' ? 'text-danger' : 'text-text-muted')} />}
              <span className={clsx('leading-snug', step.status === 'done' ? 'text-text-muted line-through' : 'text-text-secondary')}>{step.label}</span>
            </div>
          ))}
        </div>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line/60 px-3 py-2 font-mono text-[9px] text-text-muted">
        <span>Task {plan.id}</span>
        <span>Updated {new Date(plan.updatedAt).toLocaleString()}</span>
      </footer>
      {(plan.acceptanceCriteria?.length ?? 0) > 0 && (
        <details className="border-t border-line/60 px-3 py-2 text-[10px] text-text-secondary">
          <summary className="cursor-pointer select-none font-medium text-text-muted">Acceptance criteria ({plan.acceptanceCriteria!.length})</summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">{plan.acceptanceCriteria!.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
