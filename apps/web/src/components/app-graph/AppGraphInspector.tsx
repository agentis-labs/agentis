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

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Trash2 } from 'lucide-react';
import type {
  AppGraphNode,
  AppGraphNodeConfig,
  AppGraphNodeType,
  AppGraphReferenceScope,
} from '@agentis/core';
import { Button } from '../shared/Button';

interface InspectorProps {
  node: AppGraphNode | null;
  references: AppGraphReferenceScope;
  onChange: (node: AppGraphNode) => void;
  onDelete: (nodeId: string) => void;
}

export function AppGraphInspector({ node, references, onChange, onDelete }: InspectorProps) {
  const nav = useNavigate();
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
            <Field label="Description">
              <textarea
                rows={3}
                value={cfg.description ?? ''}
                onChange={(e) => updateConfig({ description: e.target.value })}
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Entry workflow">
              <WorkflowSelect
                value={cfg.entryWorkflowId}
                workflows={references.workflows}
                onChange={(v) => updateConfig({ entryWorkflowId: v })}
              />
            </Field>
          </>
        )}

        {(cfg.kind === 'entry_workflow' || cfg.kind === 'workflow_module') && (
          <>
            <Field label="Workflow">
              <WorkflowSelect
                value={cfg.workflowId}
                workflows={references.workflows}
                onChange={(v) => updateConfig({ workflowId: v ?? '' })}
              />
            </Field>
            {cfg.workflowId && (
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<ArrowUpRight size={12} />}
                onClick={() => nav(`/workflows/${cfg.workflowId}`)}
              >
                Open workflow
              </Button>
            )}
          </>
        )}

        {cfg.kind === 'agent_group' && (
          <>
            <Field label="Group key">
              <input
                type="text"
                value={cfg.groupKey}
                onChange={(e) => updateConfig({ groupKey: e.target.value })}
                placeholder="sdr / qa / triage"
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Role">
              <input
                type="text"
                value={cfg.role ?? ''}
                onChange={(e) => updateConfig({ role: e.target.value })}
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Agents">
              <MultiSelect
                value={cfg.agentIds ?? []}
                options={references.agents.map((a) => ({ id: a.id, label: a.name }))}
                onChange={(ids) => updateConfig({ agentIds: ids })}
              />
            </Field>
          </>
        )}

        {cfg.kind === 'knowledge_source' && (
          <Field label="Dataset">
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
            <Field label="Service">
              <input
                type="text"
                value={cfg.service}
                onChange={(e) => updateConfig({ service: e.target.value })}
                placeholder="hubspot / slack / notion"
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Label">
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
          <Field label="Policy key">
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
            <Field label="Output key">
              <input
                type="text"
                value={cfg.outputKey ?? ''}
                onChange={(e) => updateConfig({ outputKey: e.target.value })}
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Format">
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
          </>
        )}

        {cfg.kind === 'scheduler' && (
          <>
            <Field label="Schedule">
              <input
                type="text"
                value={cfg.schedule}
                onChange={(e) => updateConfig({ schedule: e.target.value })}
                placeholder="0 9 * * 1-5 (cron) or 'every weekday morning'"
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Trigger ID (optional)">
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
            <Field label="Channel">
              <input
                type="text"
                value={cfg.channel}
                onChange={(e) => updateConfig({ channel: e.target.value })}
                placeholder="email / slack / telegram"
                className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Direction">
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
          <Field label="Scope">
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
          <Field label="Pinned topic">
            <input
              type="text"
              value={cfg.topic ?? ''}
              onChange={(e) => updateConfig({ topic: e.target.value })}
              className="w-full rounded-md border border-line bg-bg-base px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
            />
          </Field>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </div>
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
