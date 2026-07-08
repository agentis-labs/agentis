import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';



interface Subscription {
  id: string;
  sourceWorkflowId: string;
  targetWorkflowId: string;
  eventType: string;
  sourceNodeId: string | null;
  filterExpression: string | null;
  inputMapping: Record<string, string>;
  coalescePolicy: string;
  catchupPolicy: string;
  enabled: boolean;
}

interface WorkflowOption {
  id: string;
  title?: string;
  name?: string;
}

interface EventChainsPanelProps {
  workflowId: string;
}

const EVENT_TYPES = [
  { value: 'run.completed', label: 'Run completed' },
  { value: 'run.failed', label: 'Run failed' },
] as const;

const COALESCE_POLICIES = [
  { value: 'always_enqueue', label: 'Always enqueue (no coalescing)' },
  { value: 'coalesce_pending', label: 'Coalesce â€” skip if one pending' },
  { value: 'latest_only', label: 'Latest only â€” drop earlier pending' },
] as const;

export function EventChainsPanel({ workflowId }: EventChainsPanelProps) {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<'incoming' | 'outgoing' | null>(null);
  const [draftSource, setDraftSource] = useState('');
  const [draftTarget, setDraftTarget] = useState('');
  const [draftEvent, setDraftEvent] = useState<string>('run.completed');
  const [draftFilter, setDraftFilter] = useState('');
  const [draftCoalesce, setDraftCoalesce] = useState<string>('always_enqueue');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    void Promise.all([
      api<{ subscriptions: Subscription[] }>('/v1/scheduler/subscriptions').catch(() => ({ subscriptions: [] })),
      api<{ workflows: WorkflowOption[] }>('/v1/workflows').catch(() => ({ workflows: [] })),
    ]).then(([s, w]) => {
      setSubs(s.subscriptions);
      setWorkflows(w.workflows);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const incoming = subs.filter((s) => s.targetWorkflowId === workflowId);
  const outgoing = subs.filter((s) => s.sourceWorkflowId === workflowId);

  function startCreate(direction: 'incoming' | 'outgoing') {
    setCreating(direction);
    if (direction === 'incoming') {
      setDraftSource('');
      setDraftTarget(workflowId);
    } else {
      setDraftSource(workflowId);
      setDraftTarget('');
    }
    setDraftEvent('run.completed');
    setDraftFilter('');
    setDraftCoalesce('always_enqueue');
    setError(null);
  }

  async function commitCreate() {
    if (!draftSource || !draftTarget) {
      setError('Pick both source and target workflows.');
      return;
    }
    if (draftSource === draftTarget) {
      setError('A workflow cannot trigger itself (use a subflow node instead).');
      return;
    }
    try {
      await api('/v1/scheduler/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          sourceWorkflowId: draftSource,
          targetWorkflowId: draftTarget,
          eventType: draftEvent,
          filterExpression: draftFilter.trim() ? draftFilter.trim() : null,
          inputMapping: {},
          coalescePolicy: draftCoalesce,
          catchupPolicy: 'enqueue_missed_with_cap:5',
          enabled: true,
        }),
      });
      setCreating(null);
      refresh();
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Could not save subscription');
    }
  }

  async function remove(id: string) {
    await api(`/v1/scheduler/subscriptions/${id}`, { method: 'DELETE' }).catch(() => {});
    refresh();
  }

  async function toggle(sub: Subscription) {
    await api(`/v1/scheduler/subscriptions/${sub.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !sub.enabled }),
    }).catch(() => {});
    refresh();
  }

  function labelFor(id: string): string {
    const wf = workflows.find((w) => w.id === id);
    return wf?.title ?? wf?.name ?? id.slice(0, 8);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto">
      {loading ? (
        <div className="text-[12px] text-text-muted">Loadingâ€¦</div>
      ) : (
        <>
          {/* Incoming */}
          <Section
            title="Run after another workflow"
            hint="When the source workflow fires the chosen event, this workflow is enqueued."
            onAdd={() => startCreate('incoming')}
          >
            {incoming.length === 0 ? (
              <EmptyState text="Not chained from any workflow." />
            ) : (
              <ul className="space-y-1.5">
                {incoming.map((sub) => (
                  <SubscriptionRow key={sub.id} sub={sub} labelFor={labelFor} arrow="from" onToggle={toggle} onRemove={remove} />
                ))}
              </ul>
            )}
          </Section>

          {/* Outgoing */}
          <Section
            title="Trigger another workflow when this one fires an event"
            hint="When this workflow fires the chosen event, the target workflow is enqueued."
            onAdd={() => startCreate('outgoing')}
          >
            {outgoing.length === 0 ? (
              <EmptyState text="Doesn't trigger any other workflow." />
            ) : (
              <ul className="space-y-1.5">
                {outgoing.map((sub) => (
                  <SubscriptionRow key={sub.id} sub={sub} labelFor={labelFor} arrow="to" onToggle={toggle} onRemove={remove} />
                ))}
              </ul>
            )}
          </Section>

          {creating && (
            <div className="rounded-md border border-accent/40 bg-surface-2 p-2.5">
              <div className="mb-2 text-[11px] font-medium text-text-primary">
                {creating === 'incoming' ? 'Run this workflow afterâ€¦' : 'When this workflow fires, also runâ€¦'}
              </div>
              <div className="grid gap-2">
                {creating === 'incoming' ? (
                  <Field label="Source workflow">
                    <select className={inputCls} value={draftSource} onChange={(e) => setDraftSource(e.target.value)}>
                      <option value="">â€” Pick a workflow â€”</option>
                      {workflows.filter((w) => w.id !== workflowId).map((wf) => (
                        <option key={wf.id} value={wf.id}>{labelFor(wf.id)}</option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <Field label="Target workflow">
                    <select className={inputCls} value={draftTarget} onChange={(e) => setDraftTarget(e.target.value)}>
                      <option value="">â€” Pick a workflow â€”</option>
                      {workflows.filter((w) => w.id !== workflowId).map((wf) => (
                        <option key={wf.id} value={wf.id}>{labelFor(wf.id)}</option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label="On event">
                  <select className={inputCls} value={draftEvent} onChange={(e) => setDraftEvent(e.target.value)}>
                    {EVENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </Field>
                <Field label="Filter (optional)" hint="JS condition evaluated against the event payload.">
                  <input
                    type="text"
                    className={inputCls + ' font-mono'}
                    placeholder="payload.runId && payload.status === 'COMPLETED'"
                    value={draftFilter}
                    onChange={(e) => setDraftFilter(e.target.value)}
                  />
                </Field>
                <Field label="Coalescing policy">
                  <select className={inputCls} value={draftCoalesce} onChange={(e) => setDraftCoalesce(e.target.value)}>
                    {COALESCE_POLICIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </Field>
              </div>
              {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void commitCreate()}
                  className="inline-flex h-7 items-center rounded-btn bg-accent px-3 text-[11px] font-semibold text-canvas hover:bg-accent-hover"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setCreating(null)}
                  className="inline-flex h-7 items-center rounded-btn border border-line bg-surface px-3 text-[11px] text-text-secondary hover:border-accent/40 hover:text-text-primary"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const inputCls = 'h-7 w-full rounded-input border border-line bg-canvas px-2 text-[11px] text-text-primary focus:border-accent focus:outline-none';

function Section({ title, hint, onAdd, children }: { title: string; hint?: string; onAdd: () => void; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-medium text-text-primary">{title}</div>
          {hint && <div className="text-[10px] text-text-muted">{hint}</div>}
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-secondary hover:border-accent hover:text-accent"
        >
          <Plus size={11} /> Add
        </button>
      </div>
      {children}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-line bg-surface-2 px-2 py-2 text-center text-[11px] text-text-muted">
      {text}
    </div>
  );
}

function SubscriptionRow({
  sub,
  labelFor,
  arrow,
  onToggle,
  onRemove,
}: {
  sub: Subscription;
  labelFor: (id: string) => string;
  arrow: 'from' | 'to';
  onToggle: (sub: Subscription) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const eventLabel = EVENT_TYPES.find((t) => t.value === sub.eventType)?.label ?? sub.eventType;
  const partnerId = arrow === 'from' ? sub.sourceWorkflowId : sub.targetWorkflowId;
  return (
    <li className={clsx(
      'flex items-center gap-2 rounded-md border bg-surface-2 px-2 py-1.5 text-[11px]',
      sub.enabled ? 'border-line' : 'border-line/40 opacity-60',
    )}>
      <span className="truncate text-text-primary">{labelFor(partnerId)}</span>
      <ChevronRight size={11} className="shrink-0 text-text-muted" />
      <span className="truncate text-text-secondary">{eventLabel}</span>
      <div className="ml-auto flex items-center gap-1">
        <label className="inline-flex cursor-pointer items-center gap-1 text-[10px] text-text-muted">
          <input
            type="checkbox"
            checked={sub.enabled}
            onChange={() => void onToggle(sub)}
            className="rounded border-line bg-canvas accent-accent"
          />
          on
        </label>
        <button
          type="button"
          onClick={() => void onRemove(sub.id)}
          className="rounded p-0.5 text-text-muted hover:bg-danger/10 hover:text-danger"
          aria-label="Remove subscription"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </li>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-0.5 block text-[10px] font-medium text-text-secondary">{label}</label>
      {children}
      {hint && <p className="mt-0.5 text-[9px] text-text-muted">{hint}</p>}
    </div>
  );
}



