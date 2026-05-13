/**
 * AppGraphInspector — selection-aware node editor.
 *
 * Spec: docs/app-canvas/APP-CANVAS-ARCHITECTURE.md §9 (editing model).
 *
 * The inspector switches on AppGraph node kinds — workflow inspector lives
 * elsewhere. For workflow_module / entry_workflow, the inspector exposes a
 * "Open workflow →" affordance that drills into the execution-level canvas
 * (§9.2 drill-down model).
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Trash2, Plus, X } from 'lucide-react';
import type {
  AppGraphNode,
  AppGraphNodeConfig,
  AppGraphNodeType,
  AppGraphReferenceScope,
} from '@agentis/core';
import { Button } from '../shared/Button';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';

interface InspectorProps {
  node: AppGraphNode | null;
  references: AppGraphReferenceScope;
  onChange: (node: AppGraphNode) => void;
  onDelete: (nodeId: string) => void;
}

export function AppGraphInspector({ node, references, onChange, onDelete }: InspectorProps) {
  const nav = useNavigate();
  const toast = useToast();
  const [creatingEntry, setCreatingEntry] = useState(false);
  const [inlineWorkflowId, setInlineWorkflowId] = useState<string | null>(null);
  const cfg = node?.config as AppGraphNodeConfig | undefined;

  if (!node || !cfg) {
    return (
      <div className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-surface">
        <div className="border-b border-line px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Inspector
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 py-8 text-center text-[12px] text-text-muted">
          Select a module to inspect or edit it.
        </div>
      </div>
    );
  }

  function update<K extends keyof AppGraphNode>(key: K, value: AppGraphNode[K]) {
    if (!node) return;
    onChange({ ...node, [key]: value });
  }
  function updateConfig<C extends AppGraphNodeConfig>(patch: Partial<C>) {
    if (!node) return;
    onChange({ ...node, config: { ...(node.config as C), ...patch } as AppGraphNodeConfig });
  }

  /** 10.11: create a blank workflow then auto-bind it as the entry workflow. */
  async function createAndBindEntryWorkflow() {
    if (!node) return;
    setCreatingEntry(true);
    try {
      const created = await api<{ workflow: { id: string; title: string } }>('/v1/workflows', {
        method: 'POST',
        body: JSON.stringify({ title: `${node.title || 'App'} — entry` }),
      });
      const wfId = created.workflow.id;
      updateConfig({ entryWorkflowId: wfId });
      setInlineWorkflowId(wfId);
      toast.success('Entry workflow created');
    } catch (e) {
      toast.error('Could not create workflow', String(e));
    } finally {
      setCreatingEntry(false);
    }
  }

  /** 10.11: create a blank workflow and bind to a workflow_module/entry_workflow node. */
  async function createAndBindWorkflow() {
    if (!node) return;
    setCreatingEntry(true);
    try {
      const created = await api<{ workflow: { id: string; title: string } }>('/v1/workflows', {
        method: 'POST',
        body: JSON.stringify({ title: node.title || 'New workflow' }),
      });
      updateConfig({ workflowId: created.workflow.id });
      setInlineWorkflowId(created.workflow.id);
      toast.success('Workflow created');
    } catch (e) {
      toast.error('Could not create workflow', String(e));
    } finally {
      setCreatingEntry(false);
    }
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            {humanType(node.type)}
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Trash2 size={12} />}
            onClick={() => onDelete(node.id)}
          >
            Delete
          </Button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <Field label="Title">
          <input
            type="text"
            value={node.title}
            onChange={(e) => update('title', e.target.value)}
            className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
          />
        </Field>

        {/* Type-specific fields */}
        {cfg.kind === 'app_core' && (
          <>
            <Field label="Description" hint="One sentence telling operators what this app does for them.">
              <textarea
                rows={3}
                value={cfg.description ?? ''}
                onChange={(e) => updateConfig({ description: e.target.value })}
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Entry workflow" hint="The first workflow that runs when someone uses the app.">
              <WorkflowSelect
                value={cfg.entryWorkflowId}
                workflows={references.workflows}
                onChange={(v) => updateConfig({ entryWorkflowId: v })}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              {cfg.entryWorkflowId ? (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setInlineWorkflowId(cfg.entryWorkflowId ?? null)}
                  >
                    Open and build
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft={<ArrowUpRight size={12} />}
                    onClick={() => nav(`/workflows/${cfg.entryWorkflowId}`)}
                  >
                    Full page
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  iconLeft={<Plus size={12} />}
                  onClick={() => void createAndBindEntryWorkflow()}
                  disabled={creatingEntry}
                >
                  {creatingEntry ? 'Creating…' : 'Create entry workflow'}
                </Button>
              )}
            </div>
          </>
        )}

        {(cfg.kind === 'entry_workflow' || cfg.kind === 'workflow_module') && (
          <>
            <Field label="Workflow" hint="Pick an existing workflow, or create a new one to start fresh.">
              <WorkflowSelect
                value={cfg.workflowId}
                workflows={references.workflows}
                onChange={(v) => updateConfig({ workflowId: v ?? '' })}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              {cfg.workflowId ? (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setInlineWorkflowId(cfg.workflowId)}
                  >
                    Open and build
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft={<ArrowUpRight size={12} />}
                    onClick={() => nav(`/workflows/${cfg.workflowId}`)}
                  >
                    Full page
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  iconLeft={<Plus size={12} />}
                  onClick={() => void createAndBindWorkflow()}
                  disabled={creatingEntry}
                >
                  {creatingEntry ? 'Creating…' : 'Create new workflow'}
                </Button>
              )}
            </div>
          </>
        )}

        {cfg.kind === 'agent_group' && (
          <>
            <Field label="Group key" hint="Short identifier for this team — used in code refs (e.g. 'sdr', 'qa').">
              <input
                type="text"
                value={cfg.groupKey}
                onChange={(e) => updateConfig({ groupKey: e.target.value })}
                placeholder="sdr / qa / triage"
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Role" hint="What this team is responsible for (in plain words).">
              <input
                type="text"
                value={cfg.role ?? ''}
                onChange={(e) => updateConfig({ role: e.target.value })}
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Agents" hint="Pick the agents that participate in this team.">
              <MultiSelect
                value={cfg.agentIds ?? []}
                options={references.agents.map((a) => ({ id: a.id, label: a.name }))}
                onChange={(ids) => updateConfig({ agentIds: ids })}
              />
            </Field>
          </>
        )}

        {cfg.kind === 'knowledge_source' && (
          <Field label="Dataset" hint="The knowledge base this surface reads from.">
            <select
              value={cfg.datasetKey ?? ''}
              onChange={(e) => updateConfig({ datasetKey: e.target.value })}
              className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
            >
              <option value="">— select a dataset —</option>
              {references.datasets.map((d) => (
                <option key={d.key} value={d.key}>{d.label} ({d.key})</option>
              ))}
            </select>
          </Field>
        )}

        {cfg.kind === 'integration_surface' && (
          <>
            <Field label="Service" hint="External system this connects to.">
              <input
                type="text"
                value={cfg.service}
                onChange={(e) => updateConfig({ service: e.target.value })}
                placeholder="hubspot / slack / notion"
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Label" hint="Friendly display name shown on the canvas.">
              <input
                type="text"
                value={cfg.label ?? ''}
                onChange={(e) => updateConfig({ label: e.target.value })}
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
          </>
        )}

        {cfg.kind === 'approval_surface' && (
          <Field label="Policy key" hint="Bind this to a checkpoint policy in your workflow graph.">
            <input
              type="text"
              value={cfg.policyKey ?? ''}
              onChange={(e) => updateConfig({ policyKey: e.target.value })}
              className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
            />
          </Field>
        )}

        {cfg.kind === 'output_surface' && (
          <>
            <Field label="Output name" hint="What operators will see in their results panel.">
              <input
                type="text"
                value={cfg.outputKey ?? ''}
                onChange={(e) => updateConfig({ outputKey: e.target.value })}
                placeholder="booked_meetings / weekly_report / qualified_leads"
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Artifact type" hint="What kind of result is produced — drives how it's rendered.">
              <select
                value={cfg.artifactType ?? ''}
                onChange={(e) => updateConfig({ artifactType: (e.target.value || undefined) as 'document' | 'metric' | 'chart' | 'list' | 'file' | 'decision' | 'custom' | undefined })}
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              >
                <option value="">— choose —</option>
                <option value="document">Document (text, markdown, report)</option>
                <option value="metric">Metric (single number / KPI)</option>
                <option value="chart">Chart (visualisation)</option>
                <option value="list">List (rows of records)</option>
                <option value="file">File (PDF, image, attachment)</option>
                <option value="decision">Decision (yes/no, approval)</option>
                <option value="custom">Custom</option>
              </select>
            </Field>
            {cfg.artifactType === 'metric' && (
              <Field label="Number format" hint="How the metric should be formatted in the UI.">
                <select
                  value={cfg.format ?? ''}
                  onChange={(e) => updateConfig({ format: (e.target.value || undefined) as 'number' | 'currency' | 'percent' | 'text' | undefined })}
                  className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
                >
                  <option value="">—</option>
                  <option value="number">Number</option>
                  <option value="currency">Currency</option>
                  <option value="percent">Percent</option>
                  <option value="text">Text</option>
                </select>
              </Field>
            )}
          </>
        )}

        {cfg.kind === 'scheduler' && (
          <>
            <Field label="Schedule" hint="Cron expression or plain English (e.g. 'every weekday at 9am').">
              <input
                type="text"
                value={cfg.schedule}
                onChange={(e) => updateConfig({ schedule: e.target.value })}
                placeholder="0 9 * * 1-5 (cron) or 'every weekday morning'"
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Trigger ID (optional)" hint="Link this to a saved trigger row.">
              <input
                type="text"
                value={cfg.triggerId ?? ''}
                onChange={(e) => updateConfig({ triggerId: e.target.value })}
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] font-mono text-text-primary outline-none focus:border-accent"
              />
            </Field>
          </>
        )}

        {cfg.kind === 'channel_surface' && (
          <>
            <Field label="Channel" hint="Communication surface this app talks through.">
              <input
                type="text"
                value={cfg.channel}
                onChange={(e) => updateConfig({ channel: e.target.value })}
                placeholder="email / slack / telegram"
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Direction" hint="Whether the app sends, receives, or both.">
              <select
                value={cfg.direction ?? 'both'}
                onChange={(e) => updateConfig({ direction: e.target.value as 'inbound' | 'outbound' | 'both' })}
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              >
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
                <option value="both">Both</option>
              </select>
            </Field>
          </>
        )}

        {cfg.kind === 'memory_surface' && (
          <Field label="Scope" hint="Which memory layer this surface exposes.">
            <select
              value={cfg.scope ?? 'all'}
              onChange={(e) => updateConfig({ scope: e.target.value as 'episodic' | 'app_knowledge' | 'evaluator' | 'all' })}
              className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
            >
              <option value="all">All layers</option>
              <option value="app_knowledge">App knowledge</option>
              <option value="episodic">Episodic memory</option>
              <option value="evaluator">Evaluator examples</option>
            </select>
          </Field>
        )}

        {cfg.kind === 'brain_surface' && (
          <Field label="Pinned topic" hint="What this brain surface focuses on (free text).">
            <input
              type="text"
              value={cfg.topic ?? ''}
              onChange={(e) => updateConfig({ topic: e.target.value })}
              className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
            />
          </Field>
        )}
      </div>

      {inlineWorkflowId && (
        <div className="fixed inset-4 z-[70] flex overflow-hidden rounded-modal border border-line bg-canvas shadow-modal">
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
              <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">Workflow builder</div>
              <Button variant="secondary" size="sm" iconLeft={<ArrowUpRight size={12} />} onClick={() => nav(`/workflows/${inlineWorkflowId}`)}>
                Full page
              </Button>
              <Button variant="ghost" size="sm" aria-label="Close inline workflow" onClick={() => setInlineWorkflowId(null)}>
                <X size={14} />
              </Button>
            </header>
            <iframe
              title="Inline workflow builder"
              src={`/workflows/${inlineWorkflowId}?embed=1`}
              className="min-h-0 flex-1 border-0 bg-canvas"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </div>
      {hint && (
        <div className="mb-1.5 text-[11px] leading-snug text-text-muted">{hint}</div>
      )}
      {children}
    </label>
  );
}

function WorkflowSelect({
  value, workflows, onChange,
}: {
  value: string | undefined;
  workflows: Array<{ id: string; title: string }>;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
    >
      <option value="">— select a workflow —</option>
      {workflows.map((w) => (
        <option key={w.id} value={w.id}>{w.title}</option>
      ))}
    </select>
  );
}

function MultiSelect({
  value, options, onChange,
}: {
  value: string[];
  options: Array<{ id: string; label: string }>;
  onChange: (next: string[]) => void;
}) {
  const set = useMemo(() => new Set(value), [value]);
  function toggle(id: string) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  }
  if (options.length === 0) {
    return (
      <div className="rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[12px] text-text-muted">
        No agents in this app yet.
      </div>
    );
  }
  return (
    <div className="max-h-40 overflow-y-auto rounded-md border border-line bg-bg-base">
      {options.map((o) => (
        <label
          key={o.id}
          className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[12px] text-text-primary hover:bg-surface-2"
        >
          <input
            type="checkbox"
            checked={set.has(o.id)}
            onChange={() => toggle(o.id)}
            className="rounded border-line accent-accent"
          />
          <span className="truncate">{o.label}</span>
        </label>
      ))}
    </div>
  );
}

function humanType(t: AppGraphNodeType): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
