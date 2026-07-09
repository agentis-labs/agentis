import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, Pencil, Trash2, Check, X, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { skillsApi, type SkillExample, type SkillListItem } from '../../lib/skills';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';

interface RunSummary {
  id: string;
  workflowName?: string;
  status: string;
  startedAt?: string;
  createdAt?: string;
  completedAt?: string | null;
}

interface RunOutputNode {
  id: string;
  nodeId: string;
  title: string;
  status: string;
  inputs?: unknown;
  output?: unknown;
  outputSummary?: string;
}

interface RunDetail {
  id: string;
  workflowName?: string;
  status: string;
  nodes: RunOutputNode[];
}

/**
 * Examples tab - curated input/output demonstrations (`example` atoms). They
 * ride along when their skill is loaded and grow from real wins.
 */
export function ExamplesTab({
  scopeId = null,
  scopeName,
}: {
  scopeId?: string | null;
  scopeName?: string;
}) {
  const [examples, setExamples] = useState<SkillExample[]>([]);
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [source, setSource] = useState<'run' | 'manual'>('run');
  const [form, setForm] = useState({ skillId: '', inputText: '', outputText: '' });
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const scopeOptions = scopeId ? { scopeId, includeWorkspace: false } : undefined;
      const [ex, sk] = await Promise.all([skillsApi.examples(scopeOptions), skillsApi.list(scopeOptions)]);
      setExamples(ex.examples);
      setSkills(sk.skills);
    } catch (error) {
      toast.error('Failed to load examples', apiErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [scopeId, toast]);

  useEffect(() => { void load(); }, [load]);

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const res = await api<{ runs: RunSummary[] }>('/v1/runs?status=completed&limit=30');
      const next = res.runs ?? [];
      setRuns(next);
      setSelectedRunId((current) => current || next[0]?.id || '');
    } catch (error) {
      toast.error('Failed to load run outputs', apiErrorMessage(error));
      setRuns([]);
    } finally {
      setRunsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!creating || source !== 'run' || runs.length > 0 || runsLoading) return;
    void loadRuns();
  }, [creating, loadRuns, runs.length, runsLoading, source]);

  useEffect(() => {
    if (!creating || form.skillId) return;
    setForm((f) => ({ ...f, skillId: skills[0]?.id ?? '' }));
  }, [creating, form.skillId, skills]);

  useEffect(() => {
    if (!selectedRunId || source !== 'run') {
      setRunDetail(null);
      setSelectedNodeId('');
      return;
    }
    let cancelled = false;
    api<{ run: RunDetail }>(`/v1/runs/${selectedRunId}`)
      .then((res) => {
        if (cancelled) return;
        setRunDetail(res.run);
        const firstOutput = outputNodes(res.run.nodes)[0];
        setSelectedNodeId(firstOutput?.nodeId ?? '');
        if (!firstOutput) setForm((f) => ({ ...f, inputText: '', outputText: '' }));
      })
      .catch((error) => {
        if (cancelled) return;
        setRunDetail(null);
        setSelectedNodeId('');
        toast.error('Could not read run output', apiErrorMessage(error));
      });
    return () => { cancelled = true; };
  }, [selectedRunId, source, toast]);

  const availableRunNodes = useMemo(() => outputNodes(runDetail?.nodes ?? []), [runDetail]);

  useEffect(() => {
    if (source !== 'run' || !runDetail || !selectedNodeId) return;
    const node = availableRunNodes.find((item) => item.nodeId === selectedNodeId);
    if (!node) return;
    setForm((f) => ({
      ...f,
      inputText: buildRunInput(runDetail, node),
      outputText: formatValue(node.output) || node.outputSummary || '',
    }));
  }, [availableRunNodes, runDetail, selectedNodeId, source]);

  const canSave = Boolean(form.skillId && form.inputText.trim() && form.outputText.trim());

  async function saveNew() {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await skillsApi.createExample(form.skillId, { inputText: form.inputText.trim(), outputText: form.outputText.trim() });
      setCreating(false);
      setForm({ skillId: '', inputText: '', outputText: '' });
      await load();
      toast.success('Example added');
    } catch (error) {
      toast.error('Could not add example', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-subheading text-text-primary">Examples</h2>
            <p className="mt-0.5 max-w-3xl text-[12px] leading-5 text-text-muted">
              {scopeId
                ? `Curated demonstrations for ${scopeName?.trim() || 'this agent'}'s skills. Add an output, review it, and save it into the owned skill's example set.`
                : "Curated demonstrations from real wins. Add an output, review it, and save it into the skill's example set."}
            </p>
          </div>
          <Button variant="primary" size="sm" iconLeft={<Plus size={13} />} onClick={() => setCreating((v) => !v)}>
            New example
          </Button>
        </div>

        {creating && (
          <div className="mb-4 overflow-hidden rounded-card border border-line bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-4 py-3">
              <div>
                <div className="text-[12px] font-semibold text-text-primary">Add example</div>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                  Select the source, adjust the text, then save the example.
                </p>
              </div>
              <div className="inline-flex rounded-md border border-line bg-canvas p-0.5">
                {(['run', 'manual'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setSource(mode)}
                    className={`h-7 rounded px-2.5 text-[11px] font-medium ${source === mode ? 'bg-surface-2 text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}
                  >
                    {mode === 'run' ? 'Run output' : 'Manual'}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-0 lg:grid-cols-[320px_minmax(0,1fr)]">
              <div className="space-y-3 border-b border-line/70 bg-canvas/30 p-4 lg:border-b-0 lg:border-r">
                <label className="block text-[11px] font-medium text-text-secondary">
                  Save into skill
                  <select
                    value={form.skillId}
                    onChange={(e) => setForm((f) => ({ ...f, skillId: e.target.value }))}
                    className="mt-1 h-8 w-full rounded-md border border-line bg-surface px-2 text-[12px] text-text-primary outline-none focus:border-accent"
                  >
                    {skills.length === 0 ? <option value="">No skills available</option> : null}
                    {skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>

                {skills.length === 0 && (
                  <div className="rounded-md border border-dashed border-line bg-surface/60 px-3 py-2 text-[11px] leading-4 text-text-muted">
                    Examples attach to an existing skill. Create or import a skill in the Skills tab, then add examples here.
                  </div>
                )}

                {source === 'run' && (
                  <div className="space-y-2 rounded-md border border-line bg-surface p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-text-secondary">Run output</span>
                      <button
                        type="button"
                        onClick={() => void loadRuns()}
                        className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-text-muted hover:bg-surface-2 hover:text-text-primary"
                      >
                        <RefreshCw size={11} /> Refresh
                      </button>
                    </div>
                    <select
                      value={selectedRunId}
                      onChange={(e) => setSelectedRunId(e.target.value)}
                      disabled={runsLoading || runs.length === 0}
                      className="h-8 w-full rounded-md border border-line bg-canvas px-2 text-[12px] text-text-primary outline-none focus:border-accent disabled:opacity-60"
                    >
                      {runs.length === 0 ? <option value="">{runsLoading ? 'Loading runs...' : 'No completed runs yet'}</option> : null}
                      {runs.map((run) => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}
                    </select>
                    <select
                      value={selectedNodeId}
                      onChange={(e) => setSelectedNodeId(e.target.value)}
                      disabled={!runDetail || availableRunNodes.length === 0}
                      className="h-8 w-full rounded-md border border-line bg-canvas px-2 text-[12px] text-text-primary outline-none focus:border-accent disabled:opacity-60"
                    >
                      {availableRunNodes.length === 0 ? <option value="">No output steps found</option> : null}
                      {availableRunNodes.map((node) => <option key={node.nodeId} value={node.nodeId}>{node.title}</option>)}
                    </select>
                  </div>
                )}
              </div>

              <div className="space-y-3 p-4">
                <label className="block text-[11px] font-medium text-text-secondary">
                  Task / input
                  <textarea
                    value={form.inputText}
                    onChange={(e) => setForm((f) => ({ ...f, inputText: e.target.value }))}
                    rows={4}
                    placeholder="The request or situation..."
                    className="mt-1 w-full resize-y rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent"
                  />
                </label>
                <label className="block text-[11px] font-medium text-text-secondary">
                  Example output
                  <textarea
                    value={form.outputText}
                    onChange={(e) => setForm((f) => ({ ...f, outputText: e.target.value }))}
                    rows={8}
                    placeholder="The useful result to teach agents..."
                    className="mt-1 w-full resize-y rounded-md border border-line bg-canvas px-2.5 py-1.5 font-mono text-[12px] leading-5 text-text-primary outline-none focus:border-accent"
                  />
                </label>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-line/70 px-4 py-3">
              <span className="text-[11px] text-text-muted">
                {canSave ? 'Ready to save as an example.' : 'Choose a skill and provide input plus output.'}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="inline-flex items-center gap-1 rounded-btn px-2.5 py-1 text-[11px] text-text-muted hover:bg-surface-2"
                >
                  <X size={12} /> Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void saveNew()}
                  disabled={saving || !canSave}
                  className="inline-flex items-center gap-1 rounded-btn bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
                >
                  <Check size={12} /> Add example
                </button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16 w-full rounded-card" />)}</div>
        ) : examples.length === 0 ? (
          <div className="rounded-card border border-dashed border-line px-6 py-12 text-center">
            <Sparkles size={22} className="mx-auto text-text-muted" />
            <p className="mt-3 text-[13px] text-text-secondary">No examples yet.</p>
            <p className="mx-auto mt-1 max-w-md text-[12px] leading-5 text-text-muted">
              Promote good run outputs into examples so agents have demonstrations to copy from.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2 pb-8">
            {examples.map((ex) => (
              <ExampleRow
                key={ex.id}
                example={ex}
                onUpdated={(next) => setExamples((prev) => prev.map((e) => (e.id === next.id ? next : e)))}
                onDeleted={(id) => setExamples((prev) => prev.filter((e) => e.id !== id))}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function outputNodes(nodes: RunOutputNode[]): RunOutputNode[] {
  return nodes.filter((node) => node.output != null || Boolean(node.outputSummary));
}

function buildRunInput(run: RunDetail, node: RunOutputNode): string {
  const parts = [
    `Workflow: ${run.workflowName || 'Run'}`,
    `Step: ${node.title}`,
    node.inputs != null ? `Input:\n${formatValue(node.inputs)}` : '',
  ].filter(Boolean);
  return parts.join('\n\n');
}

function formatValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function runLabel(run: RunSummary): string {
  const date = run.completedAt ?? run.startedAt ?? run.createdAt;
  const suffix = date ? ` - ${new Date(date).toLocaleString()}` : '';
  return `${run.workflowName || 'Run'}${suffix}`;
}

function ExampleRow({
  example,
  onUpdated,
  onDeleted,
}: {
  example: SkillExample;
  onUpdated: (next: SkillExample) => void;
  onDeleted: (id: string) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [titleDraft, setTitleDraft] = useState(example.title);
  const [contentDraft, setContentDraft] = useState(example.content);

  async function save() {
    const content = contentDraft.trim();
    if (!content) return;
    setSaving(true);
    try {
      await api(`/v1/brain/atoms/example/${example.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: titleDraft.trim() || undefined, content }),
      });
      onUpdated({ ...example, title: titleDraft.trim() || example.title, content });
      setEditing(false);
      toast.success('Example updated');
    } catch (err) {
      toast.error('Failed to update example', apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirm({ title: `Delete "${example.title}"?`, body: "This removes the example from the skill's demonstration set.", confirmLabel: 'Delete', tone: 'danger' });
    if (!ok) return;
    try {
      await api(`/v1/brain/atoms/example/${example.id}`, { method: 'DELETE' });
      onDeleted(example.id);
    } catch (err) {
      toast.error('Failed to delete example', apiErrorMessage(err));
    }
  }

  return (
    <li className="rounded-card border border-line bg-surface">
      <div className="flex items-start gap-2 p-4">
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="min-w-0 flex-1 text-left">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent"><Sparkles size={11} /> {example.title}</div>
          <p className={`text-[12px] leading-5 text-text-secondary ${expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>{example.content}</p>
        </button>
        <ChevronRight size={15} className={`mt-0.5 shrink-0 text-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </div>
      {expanded && (
        <div className="border-t border-line/70 px-4 py-3">
          {editing ? (
            <div className="space-y-2">
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                placeholder="Title"
                className="w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12px] font-medium text-text-primary outline-none focus:border-accent"
              />
              <textarea
                value={contentDraft}
                onChange={(e) => setContentDraft(e.target.value)}
                rows={6}
                className="w-full resize-y rounded-md border border-line bg-canvas px-2.5 py-1.5 font-mono text-[12px] leading-5 text-text-primary outline-none focus:border-accent"
              />
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex items-center gap-1 rounded-btn bg-accent px-2 py-1 text-[11px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"><Check size={12} /> Save</button>
                <button type="button" onClick={() => { setEditing(false); setTitleDraft(example.title); setContentDraft(example.content); }} className="inline-flex items-center gap-1 rounded-btn px-2 py-1 text-[11px] text-text-muted hover:bg-surface-2"><X size={12} /> Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-1">
              <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 rounded-btn px-2 py-1 text-[11px] text-text-muted hover:bg-surface-2 hover:text-text-primary"><Pencil size={12} /> Edit</button>
              <button type="button" onClick={() => void remove()} className="inline-flex items-center gap-1 rounded-btn px-2 py-1 text-[11px] text-text-muted hover:bg-danger/10 hover:text-danger"><Trash2 size={12} /> Delete</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
