/**
 * AppSetupChecklist — purposeful empty state (SURFACE-PAGE-REDESIGN.md §State
 * Variations / Empty State).
 *
 * Replaces the old "No delivered artifacts yet" dead-end. Tells the operator
 * exactly what is missing and where to fix it, then describes what the app
 * does and its domain flow.
 */

import { ArrowRight, Check, X } from 'lucide-react';
import clsx from 'clsx';
import type { SurfaceApp } from './appSurfaceShared';

interface ChecklistItem {
  label: string;
  done: boolean;
  actionLabel?: string;
  onAction?: () => void;
}

export function AppSetupChecklist({
  app,
  onOpenCanvas,
  onOpenConfig,
}: {
  app: SurfaceApp;
  onOpenCanvas: () => void;
  onOpenConfig: () => void;
}) {
  const triggerActive = app.triggers.some((t) => t.status === 'active');
  const items: ChecklistItem[] = [
    { label: 'App installed', done: true },
    {
      label:
        app.dataTables.length > 0
          ? `Data tables provisioned (${app.dataTables.map((t) => t.name).join(', ')})`
          : 'No Data tables declared',
      done: app.dataTables.length > 0,
    },
    {
      label: app.entryWorkflowId ? 'Entry workflow connected' : 'Entry workflow not connected',
      done: !!app.entryWorkflowId,
      actionLabel: 'Open Canvas',
      onAction: onOpenCanvas,
    },
    {
      label: app.agents.length > 0 ? `${app.agents.length} agent${app.agents.length === 1 ? '' : 's'} connected` : 'No agents connected',
      done: app.agents.length > 0,
      actionLabel: 'Connect agent',
      onAction: onOpenCanvas,
    },
    {
      label: triggerActive ? 'Trigger active' : 'Trigger not active',
      done: triggerActive,
      actionLabel: 'Set up trigger',
      onAction: onOpenConfig,
    },
  ];

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-[22px] border border-line bg-surface">
        <div className="border-b border-line px-5 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">Setup checklist</div>
          <div className="mt-0.5 text-[13px] text-text-secondary">
            This app needs a few things before it can run.
          </div>
        </div>
        <div className="divide-y divide-line/70">
          {items.map((item) => (
            <div key={item.label} className="flex items-center gap-3 px-5 py-3">
              <span
                className={clsx(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                  item.done ? 'bg-accent/15 text-accent' : 'border border-line text-text-muted',
                )}
              >
                {item.done ? <Check size={11} /> : <X size={11} />}
              </span>
              <span className={clsx('flex-1 text-[13px]', item.done ? 'text-text-secondary' : 'text-text-primary')}>
                {item.label}
              </span>
              {!item.done && item.actionLabel && item.onAction && (
                <button
                  type="button"
                  onClick={item.onAction}
                  className="inline-flex items-center gap-1 rounded-btn border border-line px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:border-line-strong hover:text-text-primary"
                >
                  {item.actionLabel}
                  <ArrowRight size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-[22px] border border-line bg-surface px-5 py-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">What this app does</div>
        <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
          {app.description?.trim() || `${app.name} has no description in its manifest yet.`}
        </p>
        {app.domains.length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">Domains</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {app.domains.map((domain, index) => (
                <span key={domain.id} className="flex items-center gap-1.5">
                  <span className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[12px] text-text-primary">
                    {domain.name}
                  </span>
                  {index < app.domains.length - 1 && <ArrowRight size={12} className="text-text-muted" />}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
