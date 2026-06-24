import { useEffect, useState } from 'react';
import type { WorkflowPhase } from '@agentis/core';
import { X } from 'lucide-react';
import { stripPhasePrefix } from './PhaseLayer';

export function PhaseInspector({
  phase,
  nodeTitles,
  onChange,
  onDelete,
  onClose,
}: {
  phase: WorkflowPhase;
  nodeTitles: Map<string, string>;
  onChange: (phase: WorkflowPhase) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(phase);
  useEffect(() => setDraft(phase), [phase]);

  function patch(changes: Partial<WorkflowPhase>) {
    const next = { ...draft, ...changes };
    setDraft(next);
    onChange(next);
  }

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l border-line bg-surface">
      <header className="flex items-start justify-between border-b border-line px-4 py-3">
        <div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-accent">Phase</div>
          <h2 className="mt-1 text-[14px] font-semibold text-text-primary">{stripPhasePrefix(draft.name)}</h2>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary" aria-label="Close phase inspector">
          <X size={15} />
        </button>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <Field label="Name">
          <input value={draft.name} onChange={(event) => patch({ name: event.target.value })} className={inputClass} />
        </Field>
        <Field label="Purpose">
          <textarea rows={3} value={draft.description ?? ''} onChange={(event) => patch({ description: event.target.value || undefined })} className={inputClass} />
        </Field>
        <Field label="Color">
          <div className="flex items-center gap-2">
            <input type="color" value={draft.color} onChange={(event) => patch({ color: event.target.value })} className="h-9 w-12 rounded border border-line bg-surface-2 p-1" />
            <span className="font-mono text-[11px] text-text-muted">{draft.color}</span>
          </div>
        </Field>
        <Field label={`Nodes (${draft.nodeIds.length})`}>
          <div className="divide-y divide-line/60 rounded-lg border border-line bg-canvas/40">
            {draft.nodeIds.map((id) => (
              <div key={id} className="px-2.5 py-2 text-[11px] text-text-secondary">
                {stripPhasePrefix(nodeTitles.get(id) ?? id)}
              </div>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Budget (cents)">
            <input type="number" min={0} value={draft.budgetCents ?? ''} onChange={(event) => patch({ budgetCents: event.target.value ? Number(event.target.value) : undefined })} className={inputClass} />
          </Field>
          <Field label="SLA (minutes)">
            <input type="number" min={1} value={draft.slaDurationMs ? Math.round(draft.slaDurationMs / 60000) : ''} onChange={(event) => patch({ slaDurationMs: event.target.value ? Number(event.target.value) * 60000 : undefined })} className={inputClass} />
          </Field>
        </div>
        <Field label="Approval gate">
          <select
            value={draft.humanGate?.type ?? 'none'}
            onChange={(event) => patch({
              humanGate: event.target.value === 'none'
                ? undefined
                : { ...draft.humanGate, type: event.target.value as 'approve' | 'provide_input' | 'review_output' },
            })}
            className={inputClass}
          >
            <option value="none">No gate</option>
            <option value="approve">Approve before starting</option>
            <option value="provide_input">Request input</option>
            <option value="review_output">Review output</option>
          </select>
        </Field>
        {draft.humanGate && (
          <Field label="Gate message">
            <textarea rows={2} value={draft.humanGate.message ?? ''} onChange={(event) => patch({ humanGate: { ...draft.humanGate!, message: event.target.value || undefined } })} className={inputClass} />
          </Field>
        )}
        <Field label="Success criteria">
          <textarea rows={3} value={draft.successCriteria ?? ''} onChange={(event) => patch({ successCriteria: event.target.value || undefined })} className={inputClass} />
        </Field>
        <Field label="Rollback plan">
          <textarea rows={3} value={draft.rollbackPlan ?? ''} onChange={(event) => patch({ rollbackPlan: event.target.value || undefined })} className={inputClass} />
        </Field>
      </div>
      <footer className="border-t border-line p-3">
        <button type="button" onClick={onDelete} className="h-8 w-full rounded-md border border-danger/30 text-[11px] font-medium text-danger hover:bg-danger/10">
          Remove phase
        </button>
      </footer>
    </aside>
  );
}

const inputClass = 'mt-1 w-full rounded-md border border-line bg-surface-2 px-2.5 py-2 text-[11px] text-text-primary outline-none focus:border-accent';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[10px] font-medium text-text-muted">
      {label}
      {children}
    </label>
  );
}
