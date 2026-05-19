import { useEffect, useMemo, useState } from 'react';
import { Code2, LayoutTemplate, Search } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { SkillCombobox } from './SkillCombobox';
import type { InstalledSkillOption } from './SkillCombobox';

export interface InspectorSelection {
  kind: 'node' | 'edge' | null;
  nodeType?: string;
  nodeId?: string;
  data?: Record<string, unknown>;
}

interface AgentRow { id: string; name: string; }
interface SkillRow { id: string; slug: string; name: string; runtime?: string; }
interface WorkflowRow { id: string; title?: string; name?: string; isReusable?: boolean; }
interface KnowledgeBaseRow { id: string; name: string; description?: string | null; }

const KIND_LABEL: Record<string, string> = {
  trigger: 'Trigger',
  agent_task: 'Agent task',
  skill_task: 'Skill',
  skill: 'Skill',
  approval: 'Approval',
  checkpoint: 'Approval',
  router: 'Branch',
  branch: 'Branch',
  merge: 'Merge',
  subflow: 'Subflow',
  knowledge: 'Knowledge',
  webhook: 'Webhook',
  wait: 'Wait / Timer',
  variables: 'Variables',
  scratchpad: 'Scratchpad',
};

export function ContextInspector({
  selection,
  onClose,
  onSave,
  className,
}: {
  selection: InspectorSelection;
  onClose: () => void;
  onSave?: (data: Record<string, unknown>) => void;
  className?: string;
}) {
  const [jsonMode, setJsonMode] = useState(false);
  const [editData, setEditData] = useState<Record<string, unknown>>(selection.data ?? {});
  const [jsonText, setJsonText] = useState(JSON.stringify(selection.data ?? {}, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Lazy-load reference data (agents/skills/workflows) when the form needs it.
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseRow[]>([]);

  const kind = ((editData.kind as string | undefined) ?? selection.nodeType ?? '').toLowerCase();
  const needsAgents = kind === 'agent_task' || kind === 'agenttask';
  const needsSkills = kind === 'skill_task' || kind === 'skill';
  const needsWorkflows = kind === 'subflow';
  const needsKnowledge = kind === 'knowledge';

  useEffect(() => {
    const d = selection.data ?? {};
    setEditData(d);
    setJsonText(JSON.stringify(d, null, 2));
    setJsonError(null);
    setJsonMode(false);
  }, [selection.nodeId, selection.kind]);

  useEffect(() => {
    if (needsAgents && agents.length === 0) {
      void api<{ agents: AgentRow[] }>('/v1/agents').then((d) => setAgents(d.agents ?? [])).catch(() => {});
    }
    if (needsSkills && skills.length === 0) {
      void api<{ skills: SkillRow[] }>('/v1/skills').then((d) => setSkills(d.skills ?? [])).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    if (needsWorkflows && workflows.length === 0) {
      void api<{ workflows: WorkflowRow[] }>('/v1/workflows?isReusable=true').then((d) => setWorkflows(d.workflows ?? [])).catch(() => {});
    }
    if (needsKnowledge && knowledgeBases.length === 0) {
      void api<{ knowledgeBases: KnowledgeBaseRow[] }>('/v1/knowledge-bases').then((d) => setKnowledgeBases(d.knowledgeBases ?? [])).catch(() => {});
    }
  }, [needsAgents, needsSkills, needsWorkflows, needsKnowledge, agents.length, skills.length, workflows.length, knowledgeBases.length]);

  if (!selection.kind) return null;

  function update(patch: Record<string, unknown>) {
    setEditData((prev) => {
      const next = { ...prev, ...patch };
      setJsonText(JSON.stringify(next, null, 2));
      return next;
    });
  }

  function handleJsonChange(val: string) {
    setJsonText(val);
    try {
      setEditData(JSON.parse(val) as Record<string, unknown>);
      setJsonError(null);
    } catch {
      setJsonError('Invalid JSON');
    }
  }

  function handleSave() {
    if (jsonError) return;
    onSave?.(editData);
  }

  const hasChanges = JSON.stringify(editData) !== JSON.stringify(selection.data ?? {});
  const headingLabel = KIND_LABEL[kind] ?? selection.nodeType ?? 'Node';

  return (
    <aside className={clsx('flex w-80 shrink-0 flex-col border-l border-line bg-surface text-xs', className)}>
      <header className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <div className="min-w-0">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            {selection.kind === 'node' ? 'Node' : 'Edge'}
          </span>
          <div className="text-subheading text-text-primary">{headingLabel}</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { setJsonMode((v) => !v); setJsonError(null); }}
            title={jsonMode ? 'Form view' : 'JSON view'}
            className={clsx(
              'rounded p-1 transition-colors',
              jsonMode ? 'text-accent' : 'text-text-muted hover:text-text-primary',
            )}
          >
            {jsonMode ? <LayoutTemplate size={12} /> : <Code2 size={12} />}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close inspector"
            className="rounded p-1 text-text-muted hover:text-accent"
          >
            ×
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-3 py-3">
        {jsonMode ? (
          <div>
            <textarea
              value={jsonText}
              onChange={(e) => handleJsonChange(e.target.value)}
              rows={20}
              spellCheck={false}
              className={clsx(
                'w-full resize-none rounded-md border bg-surface-2 p-2 font-mono text-[11px] text-text-primary focus:outline-none focus:border-accent',
                jsonError ? 'border-danger' : 'border-line',
              )}
            />
            {jsonError && <div className="mt-1 text-[11px] text-danger">{jsonError}</div>}
          </div>
        ) : (
          <>
            <NodeForm
              kind={kind}
              data={editData}
              update={update}
              agents={agents}
              skills={skills}
              workflows={workflows}
              knowledgeBases={knowledgeBases}
              onSkillsChange={() => {
                void api<{ skills: SkillRow[] }>('/v1/skills')
                  .then((d) => setSkills(d.skills ?? []))
                  .catch(() => {});
              }}
            />
            {selection.nodeId && (
              <div className="mb-4 rounded-input border border-line bg-surface-2 p-3">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={editData.isOutput === true}
                    onChange={(e) => update({ isOutput: e.target.checked ? true : undefined })}
                    className="mt-0.5 rounded border-line bg-surface accent-accent"
                  />
                  <span>
                    <span className="block text-[12px] font-medium text-text-primary">
                      Use as workflow output
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-text-muted">
                      When any node is marked, the Output tab shows only marked nodes from the latest completed run.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </>
        )}

        {selection.nodeId && !jsonMode && (
          <div className="mt-4 border-t border-line/60 pt-3">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Node ID</div>
            <div className="mt-0.5 break-all font-mono text-[10px] text-text-secondary">{selection.nodeId}</div>
          </div>
        )}
      </div>

      {onSave && (
        <footer className="flex items-center justify-end gap-2 border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={!hasChanges || !!jsonError}
            className="inline-flex h-7 items-center rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </footer>
      )}
    </aside>
  );
}

// ─── Per-kind form renderer ────────────────────────────────────────────────

interface NodeFormProps {
  kind: string;
  data: Record<string, unknown>;
  update: (patch: Record<string, unknown>) => void;
  agents: AgentRow[];
  skills: SkillRow[];
  workflows: WorkflowRow[];
  knowledgeBases: KnowledgeBaseRow[];
  onSkillsChange?: () => void;
}

function NodeForm({ kind, data, update, agents, skills, workflows, knowledgeBases, onSkillsChange }: NodeFormProps) {
  switch (kind) {
    case 'trigger':
      return <TriggerForm data={data} update={update} />;
    case 'agent_task':
      return <AgentTaskForm data={data} update={update} agents={agents} />;
    case 'skill':
    case 'skill_task':
      return <SkillForm data={data} update={update} skills={skills} onSkillsChange={onSkillsChange} />;
    case 'approval':
    case 'checkpoint':
      return <ApprovalForm data={data} update={update} />;
    case 'router':
    case 'branch':
      return <BranchForm data={data} update={update} />;
    case 'subflow':
      return <SubflowForm data={data} update={update} workflows={workflows} />;
    case 'knowledge':
      return <KnowledgeNodeForm data={data} update={update} knowledgeBases={knowledgeBases} />;
    case 'webhook':
      return <WebhookForm data={data} update={update} />;
    case 'wait':
      return <WaitForm data={data} update={update} />;
    case 'variables':
    case 'scratchpad':
      return <VariablesForm data={data} update={update} />;
    default:
      // Fallback: render generic key/value editors for unknown kinds.
      return <GenericForm data={data} update={update} />;
  }
}

// ─── Reusable atoms ────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-[11px] font-medium text-text-secondary">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[10px] text-text-muted">{hint}</p>}
    </div>
  );
}

const inputCls =
  'h-8 w-full rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';
const selectCls = inputCls;
const textareaCls =
  'w-full resize-none rounded-input border border-line bg-surface-2 px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// ─── Per-kind forms ────────────────────────────────────────────────────────

function TriggerForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  const triggerType = asStr(data.triggerType) || 'manual';
  return (
    <>
      <Field label="Trigger type" hint="How should this workflow start?">
        <select
          className={selectCls}
          value={triggerType}
          onChange={(e) => update({ triggerType: e.target.value })}
        >
          <option value="manual">Manual</option>
          <option value="cron">Schedule (cron)</option>
          <option value="webhook">Webhook</option>
          <option value="persistent_listener">Persistent listener</option>
        </select>
      </Field>
      {triggerType === 'cron' && (
        <Field label="Schedule" hint="Cron expression — e.g., '0 9 * * 1' for every Monday at 9am.">
          <input
            type="text"
            className={inputCls}
            placeholder="0 9 * * 1"
            value={asStr(data.schedule)}
            onChange={(e) => update({ schedule: e.target.value })}
          />
        </Field>
      )}
    </>
  );
}

function AgentTaskForm({ data, update, agents }: { data: Record<string, unknown>; update: NodeFormProps['update']; agents: AgentRow[] }) {
  return (
    <>
      <Field label="Agent" hint="Which agent should handle this task?">
        <select
          className={selectCls}
          value={asStr(data.agentId)}
          onChange={(e) => update({ agentId: e.target.value })}
        >
          <option value="">— Pick an agent —</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Prompt" hint="What you want the agent to do.">
        <textarea
          className={textareaCls}
          rows={5}
          placeholder="Describe the task in plain English…"
          value={asStr(data.prompt)}
          onChange={(e) => update({ prompt: e.target.value })}
        />
      </Field>
    </>
  );
}

function SkillForm({ data, update, skills, onSkillsChange }: { data: Record<string, unknown>; update: NodeFormProps['update']; skills: SkillRow[]; onSkillsChange?: () => void }) {
  const installed: InstalledSkillOption[] = skills.map((s) => ({
    id: s.id,
    name: s.name,
    runtime: s.runtime,
  }));
  return (
    <Field label="Skill" hint="Pick a typed deterministic skill.">
      <SkillCombobox
        value={asStr(data.skillId)}
        installed={installed}
        onChange={(skillId) => update({ skillId })}
        onInstalledChange={onSkillsChange}
      />
    </Field>
  );
}

function ApprovalForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  const mode = asStr(data.approvalMode) || 'manual';
  return (
    <>
      <Field label="Mode" hint="Manual review, or auto-approve after a timeout?">
        <select
          className={selectCls}
          value={mode}
          onChange={(e) => update({ approvalMode: e.target.value })}
        >
          <option value="manual">Wait for human review</option>
          <option value="auto_after_timeout">Auto-approve after timeout</option>
        </select>
      </Field>
      {mode === 'auto_after_timeout' && (
        <Field label="Timeout (ms)">
          <input
            type="number"
            className={inputCls}
            value={typeof data.timeoutMs === 'number' ? data.timeoutMs : ''}
            onChange={(e) => update({ timeoutMs: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
        </Field>
      )}
    </>
  );
}

function BranchForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  const mode = asStr(data.routingMode) || 'first_match';
  return (
    <>
      <Field label="Routing" hint="Choose how branches are picked.">
        <select className={selectCls} value={mode} onChange={(e) => update({ routingMode: e.target.value })}>
          <option value="first_match">First branch that matches</option>
          <option value="all_matching">All branches that match (fan-out)</option>
          <option value="llm_route">Let an LLM decide</option>
        </select>
      </Field>
      <Field label="Condition" hint="Expression evaluated against the node's input. (Edit branches list in JSON view for advanced setups.)">
        <input
          type="text"
          className={inputCls}
          placeholder='e.g., output.score > 0.8'
          value={asStr(data.condition)}
          onChange={(e) => update({ condition: e.target.value })}
        />
      </Field>
    </>
  );
}

function SubflowForm({ data, update, workflows }: { data: Record<string, unknown>; update: NodeFormProps['update']; workflows: WorkflowRow[] }) {
  return (
    <Field label="Embedded workflow" hint="Pick a reusable workflow to run as a step here.">
      <select
        className={selectCls}
        value={asStr(data.workflowId)}
        onChange={(e) => update({ workflowId: e.target.value })}
      >
        <option value="">— Pick a workflow —</option>
        {workflows.map((w) => (
          <option key={w.id} value={w.id}>{w.title ?? w.name ?? 'Untitled'}</option>
        ))}
      </select>
    </Field>
  );
}

function KnowledgeNodeForm({ data, update, knowledgeBases }: { data: Record<string, unknown>; update: NodeFormProps['update']; knowledgeBases: KnowledgeBaseRow[] }) {
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<Array<{ id: string; content: string; score: number }>>([]);
  const queryMode = asStr(data.queryMode) || 'static';
  const knowledgeBaseId = asStr(data.knowledgeBaseId);
  const query = asStr(data.query);
  const topK = typeof data.topK === 'number' ? data.topK : 5;

  async function testRetrieval() {
    if (!knowledgeBaseId || !query.trim()) return;
    setTesting(true);
    try {
      const response = await api<{ results: Array<{ id: string; content: string; score: number }> }>(`/v1/knowledge-bases/${knowledgeBaseId}/search`, {
        method: 'POST',
        body: JSON.stringify({ query: query.trim(), topK }),
      });
      setResults(response.results ?? []);
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <Field label="Knowledge base">
        <select className={selectCls} value={knowledgeBaseId} onChange={(e) => update({ knowledgeBaseId: e.target.value })}>
          <option value="">All workspace knowledge</option>
          {knowledgeBases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
        </select>
      </Field>
      <Field label="Query source">
        <select className={selectCls} value={queryMode} onChange={(e) => update({ queryMode: e.target.value })}>
          <option value="static">Static query</option>
          <option value="dynamic">From previous node output</option>
        </select>
      </Field>
      {queryMode === 'static' ? (
        <Field label="Query">
          <textarea className={textareaCls} rows={4} value={query} onChange={(e) => update({ query: e.target.value })} placeholder="What should this workflow retrieve?" />
        </Field>
      ) : (
        <>
          <Field label="Source node ID">
            <input className={inputCls} value={asStr(data.queryNodeId)} onChange={(e) => update({ queryNodeId: e.target.value })} placeholder="node-id" />
          </Field>
          <Field label="Output path">
            <input className={inputCls} value={asStr(data.queryPath)} onChange={(e) => update({ queryPath: e.target.value })} placeholder="$.company.description" />
          </Field>
        </>
      )}
      <Field label="Retrieval mode">
        <select className={selectCls} value={asStr(data.retrievalMode) || 'contextual'} onChange={(e) => update({ retrievalMode: e.target.value })}>
          <option value="contextual">Contextual</option>
          <option value="strict">Strict</option>
          <option value="exploratory">Exploratory</option>
        </select>
      </Field>
      <Field label="Top results">
        <input className={inputCls} type="number" min={1} max={20} value={topK} onChange={(e) => update({ topK: Number(e.target.value) })} />
      </Field>
      <button
        type="button"
        disabled={!knowledgeBaseId || !query.trim() || testing || queryMode !== 'static'}
        onClick={() => void testRetrieval()}
        className="mb-3 inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Search size={12} /> {testing ? 'Testing...' : 'Test retrieval'}
      </button>
      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((result) => (
            <div key={result.id} className="rounded-md border border-line bg-surface-2 p-2">
              <div className="mb-1 text-[10px] text-text-muted">score {Math.round(result.score * 100)}%</div>
              <p className="line-clamp-3 text-[11px] leading-relaxed text-text-secondary">{result.content}</p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function WebhookForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  return (
    <>
      <Field label="URL" hint="Destination endpoint that will receive the POST.">
        <input
          type="url"
          className={inputCls}
          placeholder="https://example.com/hook"
          value={asStr(data.url)}
          onChange={(e) => update({ url: e.target.value })}
        />
      </Field>
      <Field label="HTTP method">
        <select className={selectCls} value={asStr(data.method) || 'POST'} onChange={(e) => update({ method: e.target.value })}>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
          <option value="GET">GET</option>
          <option value="DELETE">DELETE</option>
        </select>
      </Field>
    </>
  );
}

function WaitForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  return (
    <Field label="Duration (seconds)" hint="How long to wait before continuing.">
      <input
        type="number"
        className={inputCls}
        min={0}
        value={typeof data.durationSeconds === 'number' ? data.durationSeconds : (typeof data.duration === 'number' ? data.duration : '')}
        onChange={(e) => update({ durationSeconds: e.target.value === '' ? undefined : Number(e.target.value) })}
      />
    </Field>
  );
}

function VariablesForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  return (
    <>
      <Field label="Operation">
        <select className={selectCls} value={asStr(data.operation) || 'read'} onChange={(e) => update({ operation: e.target.value })}>
          <option value="read">Read</option>
          <option value="write">Write</option>
          <option value="append">Append</option>
          <option value="delete">Delete</option>
        </select>
      </Field>
      <Field label="Key">
        <input
          type="text"
          className={inputCls}
          placeholder="my.variable"
          value={asStr(data.key)}
          onChange={(e) => update({ key: e.target.value })}
        />
      </Field>
      <Field label="Value path (optional)">
        <input
          type="text"
          className={inputCls}
          placeholder="$.input.foo"
          value={asStr(data.valuePath)}
          onChange={(e) => update({ valuePath: e.target.value })}
        />
      </Field>
    </>
  );
}

function GenericForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  const entries = useMemo(() => Object.entries(data).filter(([k]) => k !== 'kind' && k !== 'isOutput'), [data]);
  if (entries.length === 0) {
    return (
      <p className="text-[12px] text-text-muted">
        This node has no form-configurable fields yet. Use the JSON view (toggle in the header) to edit raw config.
      </p>
    );
  }
  return (
    <>
      {entries.map(([key, value]) => {
        const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
        const isBool = typeof value === 'boolean';
        const isNum = typeof value === 'number';
        const isObj = value !== null && typeof value === 'object';
        return (
          <Field key={key} label={label}>
            {isBool ? (
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={value as boolean}
                  onChange={(e) => update({ [key]: e.target.checked })}
                  className="rounded border-line bg-surface-2 accent-accent"
                />
                <span className="text-[12px] text-text-primary">{(value as boolean) ? 'true' : 'false'}</span>
              </label>
            ) : isNum ? (
              <input
                type="number"
                className={inputCls}
                value={String(value)}
                onChange={(e) => update({ [key]: Number(e.target.value) })}
              />
            ) : isObj ? (
              <textarea
                rows={3}
                spellCheck={false}
                className={textareaCls + ' font-mono text-[11px]'}
                value={JSON.stringify(value, null, 2)}
                onChange={(e) => {
                  try { update({ [key]: JSON.parse(e.target.value) as unknown }); }
                  catch { /* keep parent */ }
                }}
              />
            ) : (
              <input
                type="text"
                className={inputCls}
                value={asStr(value)}
                onChange={(e) => update({ [key]: e.target.value })}
              />
            )}
          </Field>
        );
      })}
    </>
  );
}
