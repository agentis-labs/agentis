/**
 * PhaseCards — the Builder Session's phase plan (ORCHESTRATOR-CREATION-10X §9 Step 2).
 *
 * Renders the Planner's WorkflowPlan as interactive, approvable cards with a live
 * cost meter. Presentational: the parent owns the plan source (the `plan_workflow`
 * tool) and the approve/redesign actions. The live animated canvas build (Step 3)
 * and inline per-phase re-synthesis (the [edit] affordance) are the remaining
 * frontier and intentionally out of scope here.
 */

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Check, Download } from 'lucide-react';

export interface PlanPhaseView {
  name: string;
  description: string;
  nodeKinds: string[];
  agentRole?: string;
  requiredCredential?: string;
  estimatedCostCents: [number, number];
  /** Per-phase model override (set on edit). */
  model?: string;
}

const SPECIALIST_ROLES = [
  'planner', 'researcher', 'coder', 'reviewer', 'analyst',
  'writer', 'monitor', 'architect', 'debugger', 'deployer',
] as const;

export interface WorkflowPlanView {
  archetype: 'atomic' | 'pipeline' | 'orchestrated' | 'enterprise';
  phases: PlanPhaseView[];
  totalEstimatedCostCents: [number, number];
  missingDependencies: string[];
  requiresConfirmation: boolean;
  question?: string;
}

const ROLE_GLYPH: Record<string, string> = {
  planner: '◆', researcher: '◎', coder: '⌨', reviewer: '⚖', analyst: '▤',
  writer: '✎', monitor: '◉', architect: '⌗', debugger: '☣', deployer: '⬢',
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(3)}`;
}

/** Plan export (ORCH Phase 5) — download the plan as reusable JSON. */
function exportPlan(plan: WorkflowPlanView): void {
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `workflow-plan-${plan.archetype}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function PhaseCards({
  plan,
  onApproveAll,
  onRedesign,
  editable,
  onChange,
}: {
  plan: WorkflowPlanView;
  onApproveAll?: () => void;
  onRedesign?: () => void;
  /** Enable inline per-phase editing (description / specialist / model). */
  editable?: boolean;
  /** Called with the updated phases when an editable card changes. */
  onChange?: (phases: PlanPhaseView[]) => void;
}) {
  const [approved, setApproved] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const allApproved = approved.size === plan.phases.length && plan.phases.length > 0;

  function patchPhase(i: number, patch: Partial<PlanPhaseView>) {
    onChange?.(plan.phases.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }

  const [min, max] = plan.totalEstimatedCostCents;
  const costLabel = useMemo(
    () => (min === max ? `${dollars(min)}/run` : `${dollars(min)} – ${dollars(max)}/run`),
    [min, max],
  );
  // Live cost meter — subtotal of the phases approved so far.
  const approvedCost = useMemo<[number, number]>(() => {
    let lo = 0; let hi = 0;
    plan.phases.forEach((p, i) => { if (approved.has(i)) { lo += p.estimatedCostCents[0]; hi += p.estimatedCostCents[1]; } });
    return [lo, hi];
  }, [plan.phases, approved]);

  function toggle(i: number) {
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          Plan · {plan.archetype} · {plan.phases.length} phase{plan.phases.length === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-2">
          {approved.size > 0 && (
            <span className="text-[10px] text-success" title="Cost of approved phases">
              {approved.size}/{plan.phases.length} approved · {dollars(approvedCost[0])}–{dollars(approvedCost[1])}
            </span>
          )}
          <span className="text-[11px] font-medium text-text-secondary">{costLabel}</span>
          <button type="button" onClick={() => exportPlan(plan)} title="Export plan as JSON" className="text-text-muted hover:text-accent">
            <Download size={12} />
          </button>
        </div>
      </div>

      {plan.phases.map((phase, i) => {
        const isApproved = approved.has(i);
        return (
          <div
            key={i}
            className={clsx(
              'rounded-md border bg-surface-2 p-2.5 transition-colors',
              isApproved ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-line',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[12px] font-medium text-text-primary">
                  Phase {i + 1}: {phase.name}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-text-muted">
                  {phase.agentRole && (
                    <span className="inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5">
                      <span>{ROLE_GLYPH[phase.agentRole] ?? '•'}</span>{phase.agentRole}
                    </span>
                  )}
                  <span>{phase.nodeKinds.join(' · ')}</span>
                  {phase.requiredCredential && (
                    <span className="text-warn">needs {phase.requiredCredential}</span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-text-secondary">{phase.description}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {editable && (
                  <button
                    type="button"
                    onClick={() => setEditing(editing === i ? null : i)}
                    className={clsx('inline-flex h-6 items-center rounded-btn border px-2 text-[10px]', editing === i ? 'border-accent text-accent' : 'border-line text-text-secondary hover:bg-surface')}
                  >
                    {editing === i ? 'Done' : 'Edit'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => toggle(i)}
                  className={clsx(
                    'inline-flex h-6 items-center gap-1 rounded-btn border px-2 text-[10px]',
                    isApproved ? 'border-emerald-500/60 text-success' : 'border-line text-text-secondary hover:bg-surface',
                  )}
                >
                  <Check size={11} /> {isApproved ? 'Approved' : 'Approve'}
                </button>
              </div>
            </div>

            {editable && editing === i && (
              <div className="mt-2 flex flex-col gap-2 rounded border border-line bg-surface p-2">
                <label className="text-[10px] uppercase tracking-wider text-text-muted">Instructions</label>
                <textarea
                  rows={2}
                  className="w-full rounded-input border border-line bg-surface-2 px-2 py-1 text-[11px] text-text-primary"
                  value={phase.description}
                  onChange={(e) => patchPhase(i, { description: e.target.value })}
                />
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="text-[10px] uppercase tracking-wider text-text-muted">Specialist</label>
                    <select
                      className="mt-0.5 w-full rounded-input border border-line bg-surface-2 px-2 py-1 text-[11px] text-text-primary"
                      value={phase.agentRole ?? ''}
                      onChange={(e) => patchPhase(i, { agentRole: e.target.value || undefined })}
                    >
                      <option value="">— none —</option>
                      {SPECIALIST_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className="text-[10px] uppercase tracking-wider text-text-muted">Model</label>
                    <input
                      className="mt-0.5 w-full rounded-input border border-line bg-surface-2 px-2 py-1 text-[11px] text-text-primary"
                      placeholder="(default)"
                      value={phase.model ?? ''}
                      onChange={(e) => patchPhase(i, { model: e.target.value || undefined })}
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="mt-1 text-right text-[10px] text-text-muted">
              {phase.estimatedCostCents[0] === phase.estimatedCostCents[1]
                ? dollars(phase.estimatedCostCents[0])
                : `${dollars(phase.estimatedCostCents[0])} – ${dollars(phase.estimatedCostCents[1])}`}
              /run
            </div>
          </div>
        );
      })}

      {plan.missingDependencies.length > 0 && (
        <p className="text-[10px] text-warn">
          Needs setup: {plan.missingDependencies.join(', ')}
        </p>
      )}
      {plan.question && (
        <p className="text-[11px] italic text-text-secondary">{plan.question}</p>
      )}

      {(onApproveAll || onRedesign) && (
        <div className="mt-1 flex items-center gap-2">
          {onApproveAll && (
            <button
              type="button"
              onClick={onApproveAll}
              className="inline-flex h-7 items-center gap-1 rounded-btn bg-accent px-3 text-[11px] font-medium text-canvas hover:opacity-90"
            >
              <Check size={12} /> {allApproved ? 'Build it' : 'Approve all & build'}
            </button>
          )}
          {onRedesign && (
            <button
              type="button"
              onClick={onRedesign}
              className="inline-flex h-7 items-center rounded-btn border border-line px-3 text-[11px] text-text-secondary hover:bg-surface-2"
            >
              Redesign
            </button>
          )}
        </div>
      )}
    </div>
  );
}
