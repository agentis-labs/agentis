import { useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle, ArrowRight, Check, ChevronDown, ChevronUp, CircleOff, GitBranch,
  Loader2, Pencil, Plus, Save, ShieldCheck, Trash2, X,
} from 'lucide-react';
import { REALTIME_EVENTS, type AppWorkflowSummary } from '@agentis/core';
import {
  appsApi,
  type AppCompileReport,
  type AppDoctorReport,
  type AppOrchestrationRule,
  type AppOrchestrationRuleInput,
} from '../../../lib/appsApi';

type MappingRow = { id: string; target: string; source: string };

type RuleDraft = AppOrchestrationRuleInput & {
  inputRows: MappingRow[];
};

const EVENT_OPTIONS: Array<{ value: AppOrchestrationRuleInput['eventType']; label: string; meaning: string }> = [
  { value: 'run.accomplished', label: 'Business outcome accomplished', meaning: 'Definition of done passed' },
  { value: 'run.completed', label: 'Execution completed', meaning: 'Run stopped cleanly; not proof of success' },
  { value: 'run.failed', label: 'Run failed', meaning: 'Execution reached a failure state' },
  { value: 'node.completed', label: 'Node completed', meaning: 'A selected node completed' },
  { value: 'node.failed', label: 'Node failed', meaning: 'A selected node failed' },
];

const EMPTY_MAPPING = (): MappingRow => ({ id: crypto.randomUUID(), target: '', source: '' });

function draftFromRule(rule?: AppOrchestrationRule, workflows: AppWorkflowSummary[] = []): RuleDraft {
  return {
    sourceWorkflowId: rule?.sourceWorkflowId ?? workflows[0]?.id ?? '',
    targetWorkflowId: rule?.targetWorkflowId ?? workflows[1]?.id ?? workflows[0]?.id ?? '',
    eventType: (rule?.eventType as AppOrchestrationRuleInput['eventType']) ?? 'run.accomplished',
    sourceNodeId: rule?.sourceNodeId ?? null,
    filterExpression: rule?.filterExpression ?? null,
    coalescePolicy: (rule?.coalescePolicy as AppOrchestrationRuleInput['coalescePolicy']) ?? 'coalesce_pending',
    catchupPolicy: rule?.catchupPolicy ?? 'enqueue_missed_with_cap:5',
    enabled: rule?.enabled ?? true,
    inputRows: Object.entries(rule?.inputMapping ?? {}).map(([target, source]) => ({ id: crypto.randomUUID(), target, source })),
  };
}

function validateDraft(draft: RuleDraft): string[] {
  const errors: string[] = [];
  if (!draft.sourceWorkflowId) errors.push('Choose a source workflow.');
  if (!draft.targetWorkflowId) errors.push('Choose a target workflow.');
  if (draft.sourceWorkflowId === draft.targetWorkflowId && draft.coalescePolicy === 'always_enqueue') {
    errors.push('A self-triggering rule must coalesce pending work or keep only the latest event.');
  }
  if ((draft.filterExpression?.length ?? 0) > 2_000) errors.push('Filter expressions are limited to 2,000 characters.');
  if ((draft.eventType === 'node.completed' || draft.eventType === 'node.failed') && !draft.sourceNodeId?.trim()) {
    errors.push('Node events require a source node id.');
  }
  const targets = new Set<string>();
  for (const row of draft.inputRows) {
    if (!row.target.trim() && !row.source.trim()) continue;
    if (!row.target.trim() || !row.source.trim()) errors.push('Every input mapping needs both a target key and source event path.');
    if (targets.has(row.target.trim())) errors.push(`Target input “${row.target.trim()}” is mapped more than once.`);
    targets.add(row.target.trim());
  }
  return [...new Set(errors)];
}

function toPayload(draft: RuleDraft): AppOrchestrationRuleInput {
  const inputMapping = Object.fromEntries(
    draft.inputRows
      .map((row) => [row.target.trim(), row.source.trim()] as const)
      .filter(([target, source]) => target && source),
  );
  return {
    sourceWorkflowId: draft.sourceWorkflowId,
    targetWorkflowId: draft.targetWorkflowId,
    eventType: draft.eventType,
    sourceNodeId: draft.sourceNodeId?.trim() || null,
    filterExpression: draft.filterExpression?.trim() || null,
    inputMapping,
    coalescePolicy: draft.coalescePolicy,
    catchupPolicy: draft.catchupPolicy,
    enabled: draft.enabled,
  };
}

export function OrchestrationRuleControlPlane({
  appId,
  workflows,
  rules,
  doctor,
  compiler,
  onChanged,
}: {
  appId: string;
  workflows: AppWorkflowSummary[];
  rules: AppOrchestrationRule[];
  doctor: AppDoctorReport | null;
  compiler: AppCompileReport | null;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleById = useMemo(() => new Map(workflows.map((workflow) => [workflow.id, workflow.title])), [workflows]);
  const enabled = rules.filter((rule) => rule.enabled);
  const successGated = enabled.filter((rule) => rule.eventType === REALTIME_EVENTS.RUN_ACCOMPLISHED);
  const blockers = compiler?.executionBlockerCount ?? (doctor ? doctor.summary.critical + doctor.summary.error : null);
  const proofPending = compiler?.evidencePendingCount ?? 0;
  const compileReady = compiler?.readyForExecution ?? doctor?.readyForUnattended ?? false;

  const mutate = async (key: string, operation: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await operation();
      setEditing(null);
      setConfirmDelete(null);
      try {
        await onChanged();
      } catch (cause) {
        setError(cause instanceof Error
          ? `Rule persisted, but the control plane could not refresh: ${cause.message}`
          : 'Rule persisted, but the control plane could not refresh.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not persist the orchestration rule.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mb-3 overflow-hidden rounded-[12px] border border-line bg-surface-2/60" aria-label="Executable orchestration rules">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-3.5 py-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid h-8 w-8 place-items-center rounded-[8px] border border-line bg-canvas text-text-secondary shadow-sm">
            <GitBranch size={15} />
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">Executable control plane</div>
            <div className="mt-0.5 text-[12px] text-text-secondary">Persisted subscriptions only. Every line below can start real work.</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Metric label="dependencies" value={doctor?.topology.dependencyEdges ?? 0} />
          <Metric label="rules live" value={enabled.length} />
          <Metric label="success-gated" value={successGated.length} success />
          {compiler || doctor ? (
            <span className={clsx(
              'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[10px] font-semibold uppercase tracking-[0.08em]',
              compiler?.ready
                ? 'border-success/30 bg-success-soft text-success'
                : compileReady
                  ? 'border-warn/30 bg-warn-soft text-warn'
                : 'border-danger/30 bg-danger-soft text-danger',
            )} title={compiler?.ready ? 'Compiler verified the target readiness' : compileReady ? 'Execution is allowed; target evidence is still pending' : `${blockers} blocking compile findings`}>
              {compiler?.ready ? <ShieldCheck size={12} /> : <AlertTriangle size={12} />}
              {compiler?.ready ? 'Target ready' : compileReady ? `${proofPending} proof pending` : `${blockers} blockers`}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => { setEditing('new'); setConfirmDelete(null); setError(null); }}
            className="inline-flex h-7 items-center gap-1.5 rounded-btn bg-text-primary px-2.5 text-[11px] font-semibold text-canvas transition-opacity hover:opacity-85"
          >
            <Plus size={12} /> New event rule
          </button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="flex items-start gap-2 border-b border-danger/20 bg-danger-soft px-3.5 py-2 text-[11px] text-danger">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {error}
        </div>
      ) : null}

      {editing === 'new' ? (
        <RuleForm
          workflows={workflows}
          initial={draftFromRule(undefined, workflows)}
          busy={busy === 'new'}
          onCancel={() => setEditing(null)}
          onSave={(payload) => mutate('new', () => appsApi.createOrchestrationRule(appId, payload))}
        />
      ) : null}

      {rules.length === 0 && editing !== 'new' ? (
        <div className="grid place-items-center px-4 py-8 text-center">
          <CircleOff size={19} className="text-text-muted" />
          <div className="mt-2 text-[12px] font-medium text-text-primary">No executable event rules</div>
          <div className="mt-1 max-w-md text-[11px] leading-relaxed text-text-muted">Dependencies can order operator-started workflows, but unattended progression requires a persisted event rule.</div>
        </div>
      ) : (
        <div className="divide-y divide-line/80">
          {rules.map((rule, index) => {
            const isEditing = editing === rule.id;
            const warning = rule.eventType === REALTIME_EVENTS.RUN_COMPLETED;
            return (
              <div key={rule.id} className={clsx(!rule.enabled && 'opacity-60')}>
                <div className="group grid grid-cols-[20px_minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 px-3.5 py-2.5">
                  <span className="font-mono text-[9px] tabular-nums text-text-disabled">{String(index + 1).padStart(2, '0')}</span>
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-semibold text-text-primary">{titleById.get(rule.sourceWorkflowId) ?? rule.sourceWorkflowId}</div>
                    <div className="mt-0.5 truncate font-mono text-[9px] text-text-muted">{rule.sourceNodeId ? `node:${rule.sourceNodeId}` : 'workflow output'}</div>
                  </div>
                  <div className="flex min-w-[142px] flex-col items-center">
                    <span className={clsx(
                      'rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold',
                      rule.eventType === REALTIME_EVENTS.RUN_ACCOMPLISHED
                        ? 'border-success/30 bg-success-soft text-success'
                        : warning
                          ? 'border-warn/30 bg-warn-soft text-warn'
                          : 'border-line bg-canvas text-text-secondary',
                    )}>{rule.eventType}</span>
                    <div className="mt-1 flex w-full items-center"><span className="h-px flex-1 bg-line" /><ArrowRight size={10} className="text-text-muted" /></div>
                  </div>
                  <div className="min-w-0 text-right">
                    <div className="truncate text-[12px] font-semibold text-text-primary">{titleById.get(rule.targetWorkflowId) ?? rule.targetWorkflowId}</div>
                    <div className="mt-0.5 font-mono text-[9px] text-text-muted">{Object.keys(rule.inputMapping).length} mapped inputs · {rule.coalescePolicy}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => mutate(`toggle:${rule.id}`, () => appsApi.updateOrchestrationRule(appId, rule.id, { enabled: !rule.enabled }))}
                      className={clsx(
                        'relative h-5 w-9 rounded-full border transition-colors disabled:opacity-50',
                        rule.enabled ? 'border-success/40 bg-success-soft' : 'border-line bg-canvas',
                      )}
                      aria-label={`${rule.enabled ? 'Disable' : 'Enable'} rule from ${titleById.get(rule.sourceWorkflowId) ?? rule.sourceWorkflowId}`}
                      aria-pressed={rule.enabled}
                    >
                      <span className={clsx('absolute top-[3px] h-3 w-3 rounded-full transition-all', rule.enabled ? 'left-[19px] bg-success' : 'left-[3px] bg-text-muted')} />
                    </button>
                    <button type="button" onClick={() => { setEditing(isEditing ? null : rule.id); setConfirmDelete(null); setError(null); }} className="grid h-7 w-7 place-items-center rounded-btn text-text-muted hover:bg-canvas hover:text-text-primary" aria-label={`Edit rule from ${titleById.get(rule.sourceWorkflowId) ?? rule.sourceWorkflowId}`}>
                      {isEditing ? <ChevronUp size={13} /> : <Pencil size={12} />}
                    </button>
                    {confirmDelete === rule.id ? (
                      <button type="button" disabled={busy !== null} onClick={() => mutate(`delete:${rule.id}`, () => appsApi.deleteOrchestrationRule(appId, rule.id))} className="inline-flex h-7 items-center gap-1 rounded-btn bg-danger px-2 text-[10px] font-semibold text-white disabled:opacity-50" aria-label="Confirm delete rule">
                        {busy === `delete:${rule.id}` ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Confirm
                      </button>
                    ) : (
                      <button type="button" onClick={() => { setConfirmDelete(rule.id); setEditing(null); }} className="grid h-7 w-7 place-items-center rounded-btn text-text-muted hover:bg-danger-soft hover:text-danger" aria-label={`Delete rule from ${titleById.get(rule.sourceWorkflowId) ?? rule.sourceWorkflowId}`}><Trash2 size={12} /></button>
                    )}
                  </div>
                </div>
                {warning ? (
                  <div className="mx-3.5 mb-2 flex items-start gap-1.5 rounded-btn border border-warn/20 bg-warn-soft/70 px-2 py-1.5 text-[10px] text-warn">
                    <AlertTriangle size={10} className="mt-0.5 shrink-0" /> Execution completion does not prove the business objective. Use run.accomplished for success-gated progression.
                  </div>
                ) : null}
                {isEditing ? (
                  <RuleForm
                    workflows={workflows}
                    initial={draftFromRule(rule, workflows)}
                    busy={busy === rule.id}
                    onCancel={() => setEditing(null)}
                    onSave={(payload) => mutate(rule.id, () => appsApi.updateOrchestrationRule(appId, rule.id, payload))}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {compiler && !compiler.readyForExecution && compiler.checks.some((finding) => finding.status === 'block') ? (
        <div className="border-t border-danger/20 bg-danger-soft/50 px-3.5 py-2">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-danger">Compile blocking findings</div>
          {compiler.checks.filter((finding) => finding.status === 'block').slice(0, 5).map((finding) => (
            <div key={finding.id} className="flex items-start gap-2 py-0.5 text-[10px] text-danger">
              <AlertTriangle size={10} className="mt-0.5 shrink-0" />
              <span><strong>{finding.layer}</strong> · {finding.summary}</span>
            </div>
          ))}
        </div>
      ) : doctor && !doctor.readyForUnattended && doctor.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'error') ? (
        <div className="border-t border-danger/20 bg-danger-soft/50 px-3.5 py-2">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-danger">Doctor blocking findings</div>
          {doctor.findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'error').slice(0, 3).map((finding) => (
            <div key={finding.id} className="flex items-start gap-2 py-0.5 text-[10px] text-danger">
              <AlertTriangle size={10} className="mt-0.5 shrink-0" />
              <span><strong>{finding.layer}</strong> · {finding.summary}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value, success = false }: { label: string; value: number; success?: boolean }) {
  return <span className={clsx('font-mono text-[10px] tabular-nums text-text-muted', success && 'text-success')}><strong className="font-semibold text-current">{value}</strong> {label}</span>;
}

function RuleForm({ workflows, initial, busy, onCancel, onSave }: {
  workflows: AppWorkflowSummary[];
  initial: RuleDraft;
  busy: boolean;
  onCancel: () => void;
  onSave: (payload: AppOrchestrationRuleInput) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const errors = validateDraft(draft);
  const isNodeEvent = draft.eventType === 'node.completed' || draft.eventType === 'node.failed';
  const selectClass = 'h-8 w-full rounded-btn border border-line bg-canvas px-2 text-[11px] text-text-primary outline-none transition-colors focus:border-accent/50';
  const inputClass = 'h-8 w-full rounded-btn border border-line bg-canvas px-2 font-mono text-[10.5px] text-text-primary outline-none placeholder:text-text-disabled focus:border-accent/50';

  return (
    <form
      className="border-t border-line bg-canvas/70 px-3.5 py-3"
      onSubmit={(event) => { event.preventDefault(); if (errors.length === 0) onSave(toPayload(draft)); }}
    >
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">Rule specification</div>
          <div className="mt-0.5 text-[11px] text-text-secondary">Event → gate → mapped target input</div>
        </div>
        <button type="button" onClick={onCancel} className="grid h-7 w-7 place-items-center rounded-btn text-text-muted hover:bg-surface-2 hover:text-text-primary" aria-label="Close rule editor"><X size={13} /></button>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Field label="Source workflow">
          <select aria-label="Source workflow" className={selectClass} value={draft.sourceWorkflowId} onChange={(event) => setDraft({ ...draft, sourceWorkflowId: event.target.value })}>
            <option value="">Choose source…</option>
            {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.title}</option>)}
          </select>
        </Field>
        <Field label="Event">
          <select aria-label="Rule event" className={selectClass} value={draft.eventType} onChange={(event) => setDraft({ ...draft, eventType: event.target.value as RuleDraft['eventType'] })}>
            {EVENT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <span className={clsx('text-[9px]', draft.eventType === 'run.completed' ? 'text-warn' : 'text-text-muted')}>{EVENT_OPTIONS.find((option) => option.value === draft.eventType)?.meaning}</span>
        </Field>
        <Field label="Target workflow">
          <select aria-label="Target workflow" className={selectClass} value={draft.targetWorkflowId} onChange={(event) => setDraft({ ...draft, targetWorkflowId: event.target.value })}>
            <option value="">Choose target…</option>
            {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.title}</option>)}
          </select>
        </Field>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Field label="Source node id" hint={isNodeEvent ? 'Required for node events' : 'Optional event scope'}>
          <input aria-label="Source node id" className={inputClass} disabled={!isNodeEvent} placeholder={isNodeEvent ? 'qualify-output' : 'workflow-level'} value={draft.sourceNodeId ?? ''} onChange={(event) => setDraft({ ...draft, sourceNodeId: event.target.value })} />
        </Field>
        <Field label="Coalescing" hint="Controls duplicate pending events">
          <select aria-label="Coalescing policy" className={selectClass} value={draft.coalescePolicy} onChange={(event) => setDraft({ ...draft, coalescePolicy: event.target.value as RuleDraft['coalescePolicy'] })}>
            <option value="coalesce_pending">Coalesce pending</option>
            <option value="latest_only">Latest event only</option>
            <option value="always_enqueue">Always enqueue</option>
          </select>
        </Field>
        <Field label="Restart catch-up" hint="What happens to missed events">
          <select aria-label="Catch-up policy" className={selectClass} value={draft.catchupPolicy} onChange={(event) => setDraft({ ...draft, catchupPolicy: event.target.value })}>
            <option value="enqueue_missed_with_cap:5">Replay up to 5 missed</option>
            <option value="enqueue_missed_with_cap:25">Replay up to 25 missed</option>
            <option value="latest_only">Replay latest only</option>
            <option value="none">Do not replay</option>
          </select>
        </Field>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1.35fr]">
        <Field label="Filter expression" hint="Optional; evaluated against the source event">
          <textarea aria-label="Filter expression" className="min-h-[76px] w-full resize-y rounded-btn border border-line bg-canvas px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-text-primary outline-none placeholder:text-text-disabled focus:border-accent/50" placeholder="payload.score >= 0.8" value={draft.filterExpression ?? ''} onChange={(event) => setDraft({ ...draft, filterExpression: event.target.value })} />
        </Field>
        <Field label="Target input mapping" hint="Target key ← source event path">
          <div className="space-y-1.5">
            {draft.inputRows.map((row) => (
              <div key={row.id} className="grid grid-cols-[1fr_16px_1fr_24px] items-center gap-1.5">
                <input aria-label="Target input key" className={inputClass} placeholder="leadId" value={row.target} onChange={(event) => setDraft({ ...draft, inputRows: draft.inputRows.map((item) => item.id === row.id ? { ...item, target: event.target.value } : item) })} />
                <span className="text-center text-[10px] text-text-muted">←</span>
                <input aria-label="Source event path" className={inputClass} placeholder="payload.output.lead.id" value={row.source} onChange={(event) => setDraft({ ...draft, inputRows: draft.inputRows.map((item) => item.id === row.id ? { ...item, source: event.target.value } : item) })} />
                <button type="button" onClick={() => setDraft({ ...draft, inputRows: draft.inputRows.filter((item) => item.id !== row.id) })} className="grid h-6 w-6 place-items-center rounded text-text-muted hover:bg-danger-soft hover:text-danger" aria-label="Remove input mapping"><X size={11} /></button>
              </div>
            ))}
            <button type="button" onClick={() => setDraft({ ...draft, inputRows: [...draft.inputRows, EMPTY_MAPPING()] })} className="inline-flex h-7 items-center gap-1 text-[10px] font-medium text-text-secondary hover:text-text-primary"><Plus size={11} /> Add mapping</button>
          </div>
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <div className="min-w-0 flex-1">
          {errors.length > 0 ? (
            <div className="flex items-start gap-1.5 text-[10px] text-danger"><AlertTriangle size={10} className="mt-0.5 shrink-0" /><span>{errors.join(' ')}</span></div>
          ) : (
            <div className="flex items-center gap-1.5 text-[10px] text-success"><ShieldCheck size={11} /> Locally valid. Server validation remains authoritative.</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-[10px] text-text-secondary">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} className="accent-[var(--color-accent)]" /> Enabled after save
          </label>
          <button type="button" onClick={onCancel} className="h-8 rounded-btn border border-line px-3 text-[11px] text-text-secondary hover:bg-surface-2">Cancel</button>
          <button type="submit" disabled={busy || errors.length > 0} className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-text-primary px-3 text-[11px] font-semibold text-canvas transition-opacity hover:opacity-85 disabled:opacity-40">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Persist rule
          </button>
        </div>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center justify-between gap-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-text-muted">
        {label}{hint ? <span className="normal-case tracking-normal text-text-disabled">{hint}</span> : null}
      </span>
      {children}
    </div>
  );
}
