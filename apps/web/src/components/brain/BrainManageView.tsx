import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Gauge, GraduationCap, Pencil, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { EmptyState } from '../shared/EmptyState';
import { AppKnowledgePanel, type AppKnowledgePanelCounts } from './AppKnowledgePanel';
import { MemoryEntryRow } from '../knowledge/MemoryEntryRow';
import { MemoryWriteForm } from '../knowledge/MemoryWriteForm';
import type { MemoryEntryRowData, MemoryKind } from '../knowledge/types';

interface EvaluatorExample {
  id: string;
  evaluatorKey: string;
  verdict: 'pass' | 'fail';
  input: unknown;
  expected: unknown;
  score?: number;
  reason?: string;
  createdAt: string;
}

interface EvaluatorExamplePatch {
  evaluatorKey?: string;
  verdict?: EvaluatorExample['verdict'];
  input?: unknown;
  expected?: unknown;
  score?: number | null;
  reason?: string | null;
}

export function BrainManageView({ appId, appName }: { appId: string; appName: string }) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [memory, setMemory] = useState<MemoryEntryRowData[]>([]);
  const [examples, setExamples] = useState<EvaluatorExample[]>([]);
  const [knowledgeCounts, setKnowledgeCounts] = useState<AppKnowledgePanelCounts>({ baseCount: 0, documentCount: 0 });

  async function refresh() {
    setLoading(true);
    try {
      const [memoryData, exampleData] = await Promise.all([
        api<{ episodes: MemoryEntryRowData[] }>(`/v1/apps/${appId}/memory?limit=100`),
        api<{ examples: EvaluatorExample[] }>(`/v1/apps/${appId}/evaluator-examples?limit=100`),
      ]);
      setMemory(memoryData.episodes ?? []);
      setExamples(exampleData.examples ?? []);
    } catch (err) {
      toast.error('Failed to load Brain knowledge', String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [appId]);

  const stats = useMemo(() => [
    { label: 'Knowledge bases', value: knowledgeCounts.baseCount },
    { label: 'Documents', value: knowledgeCounts.documentCount },
    { label: 'Memory entries', value: memory.length },
    { label: 'Evaluator examples', value: examples.length },
  ], [examples.length, knowledgeCounts.baseCount, knowledgeCounts.documentCount, memory.length]);

  async function saveMemory(entry: { kind: MemoryKind; title: string; content: string }) {
    await api(`/v1/apps/${appId}/memory`, { method: 'POST', body: JSON.stringify(entry) });
    toast.success('App memory saved', entry.title);
    await refresh();
  }

  async function archiveMemory(id: string) {
    await api(`/v1/apps/${appId}/memory/${id}`, { method: 'DELETE' });
    toast.success('App memory removed');
    await refresh();
  }

  async function updateMemory(id: string, patch: { title?: string; content?: string }) {
    await api(`/v1/apps/${appId}/memory/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    toast.success('App memory updated');
    await refresh();
  }

  async function updateEvaluatorExample(id: string, patch: EvaluatorExamplePatch) {
    await api(`/v1/apps/${appId}/evaluator-examples/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    toast.success('Evaluator example updated');
    await refresh();
  }

  async function deleteEvaluatorExample(id: string) {
    await api(`/v1/apps/${appId}/evaluator-examples/${id}`, { method: 'DELETE' });
    toast.success('Evaluator example removed');
    await refresh();
  }

  if (loading) return <div className="p-6"><Skeleton height={520} /></div>;

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-card border border-line bg-surface p-4">
              <div className="text-display text-text-primary">{stat.value}</div>
              <div className="mt-1 text-[11px] uppercase tracking-wider text-text-muted">{stat.label}</div>
            </div>
          ))}
        </div>

        <Section title="Knowledge" subtitle="Documents and collections only this app should retrieve from." icon={<BookOpen size={16} />}>
          <AppKnowledgePanel appId={appId} appName={appName} onCounts={setKnowledgeCounts} />
        </Section>

        <Section title="Memory" subtitle="Facts, rules, and preferences this app always remembers." icon={<Gauge size={16} />}>
          <div className="space-y-3">
            <MemoryWriteForm submitLabel="Save to app memory" onSubmit={saveMemory} />
            {memory.length === 0 ? (
              <EmptyState title="No memory entries" body="Add facts, rules, and preferences that this app should always know." />
            ) : (
              <div className="space-y-2">
                {memory.map((entry) => (
                  <MemoryEntryRow
                    key={entry.id}
                    entry={entry}
                    onSave={(id, patch) => updateMemory(id, patch)}
                    onArchive={(id) => void archiveMemory(id)}
                  />
                ))}
              </div>
            )}
          </div>
        </Section>

        <Section title="Evaluator Examples" subtitle="Examples that define what good and bad outputs look like." icon={<GraduationCap size={16} />}>
          <EvaluatorExampleForm appId={appId} onSaved={refresh} />
          {examples.length === 0 ? (
            <div className="mt-3">
              <EmptyState title="No evaluator examples" body="Add examples that calibrate the app's pass and fail judgments." />
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {examples.map((example) => (
                <EvaluatorExampleRow
                  key={example.id}
                  example={example}
                  onSave={updateEvaluatorExample}
                  onDelete={(id) => void deleteEvaluatorExample(id)}
                />
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

export const BrainKnowledgeView = BrainManageView;

function Section({ title, subtitle, icon, children, onRefresh }: { title: string; subtitle: string; icon: React.ReactNode; children: React.ReactNode; onRefresh?: () => void }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-card border border-line bg-surface-2 text-accent">{icon}</span>
        <div>
          <h2 className="text-heading text-text-primary">{title}</h2>
          <p className="mt-1 text-[12px] text-text-muted">{subtitle}</p>
        </div>
        {onRefresh && <Button variant="ghost" size="sm" className="ml-auto" iconLeft={<RefreshCw size={12} />} onClick={onRefresh}>Refresh</Button>}
      </div>
      {children}
    </section>
  );
}

function EvaluatorExampleForm({ appId, onSaved }: { appId: string; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [evaluatorKey, setEvaluatorKey] = useState('quality');
  const [input, setInput] = useState('');
  const [expected, setExpected] = useState('');
  const [verdict, setVerdict] = useState<'pass' | 'fail'>('pass');
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!evaluatorKey.trim() || !input.trim() || !expected.trim() || saving) return;
    setSaving(true);
    try {
      await api(`/v1/apps/${appId}/evaluator-examples`, {
        method: 'POST',
        body: JSON.stringify({ evaluatorKey: evaluatorKey.trim(), input, expected, verdict }),
      });
      toast.success('Evaluator example added', evaluatorKey.trim());
      setInput('');
      setExpected('');
      await onSaved();
    } catch (err) {
      toast.error('Failed to add example', String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="rounded-card border border-line bg-surface-2 p-3">
      <div className="grid gap-3 md:grid-cols-[180px_120px_1fr_1fr_auto]">
        <input value={evaluatorKey} onChange={(event) => setEvaluatorKey(event.target.value)} placeholder="Evaluator key" className="h-9 rounded-input border border-line bg-canvas px-3 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none" />
        <select value={verdict} onChange={(event) => setVerdict(event.target.value as 'pass' | 'fail')} className="h-9 rounded-input border border-line bg-canvas px-3 text-[12px] text-text-primary focus:border-accent focus:outline-none">
          <option value="pass">Pass</option>
          <option value="fail">Fail</option>
        </select>
        <textarea value={input} onChange={(event) => setInput(event.target.value)} rows={2} placeholder="Input" className="resize-y rounded-input border border-line bg-canvas px-3 py-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none" />
        <textarea value={expected} onChange={(event) => setExpected(event.target.value)} rows={2} placeholder="Expected output" className="resize-y rounded-input border border-line bg-canvas px-3 py-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none" />
        <Button type="submit" variant="primary" size="md" loading={saving}>Add</Button>
      </div>
    </form>
  );
}

function EvaluatorExampleRow({
  example,
  onSave,
  onDelete,
}: {
  example: EvaluatorExample;
  onSave: (id: string, patch: EvaluatorExamplePatch) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftKey, setDraftKey] = useState(example.evaluatorKey);
  const [draftVerdict, setDraftVerdict] = useState<EvaluatorExample['verdict']>(example.verdict);
  const [draftInput, setDraftInput] = useState(formatEditableValue(example.input));
  const [draftExpected, setDraftExpected] = useState(formatEditableValue(example.expected));
  const [draftReason, setDraftReason] = useState(example.reason ?? '');

  useEffect(() => {
    setEditing(false);
    setDraftKey(example.evaluatorKey);
    setDraftVerdict(example.verdict);
    setDraftInput(formatEditableValue(example.input));
    setDraftExpected(formatEditableValue(example.expected));
    setDraftReason(example.reason ?? '');
  }, [example]);

  async function save() {
    if (!draftKey.trim() || !draftInput.trim() || !draftExpected.trim()) return;
    setSaving(true);
    try {
      await onSave(example.id, {
        evaluatorKey: draftKey.trim(),
        verdict: draftVerdict,
        input: parseEditableValue(draftInput),
        expected: parseEditableValue(draftExpected),
        reason: draftReason.trim() || null,
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <article className="rounded-card border border-line bg-surface p-3">
        <div className="grid gap-3 md:grid-cols-[180px_120px_1fr_1fr]">
          <input
            value={draftKey}
            onChange={(event) => setDraftKey(event.target.value)}
            className="h-9 rounded-input border border-line bg-canvas px-3 text-[12px] text-text-primary focus:border-accent focus:outline-none"
          />
          <select
            value={draftVerdict}
            onChange={(event) => setDraftVerdict(event.target.value as EvaluatorExample['verdict'])}
            className="h-9 rounded-input border border-line bg-canvas px-3 text-[12px] text-text-primary focus:border-accent focus:outline-none"
          >
            <option value="pass">Pass</option>
            <option value="fail">Fail</option>
          </select>
          <textarea
            value={draftInput}
            onChange={(event) => setDraftInput(event.target.value)}
            rows={4}
            className="resize-y rounded-input border border-line bg-canvas px-3 py-2 font-mono text-[12px] text-text-primary focus:border-accent focus:outline-none"
          />
          <textarea
            value={draftExpected}
            onChange={(event) => setDraftExpected(event.target.value)}
            rows={4}
            className="resize-y rounded-input border border-line bg-canvas px-3 py-2 font-mono text-[12px] text-text-primary focus:border-accent focus:outline-none"
          />
        </div>
        <textarea
          value={draftReason}
          onChange={(event) => setDraftReason(event.target.value)}
          rows={2}
          placeholder="Reason"
          className="mt-3 w-full resize-y rounded-input border border-line bg-canvas px-3 py-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" iconLeft={<X size={12} />} onClick={() => setEditing(false)}>Cancel</Button>
          <Button variant="secondary" size="sm" iconLeft={<Save size={12} />} loading={saving} onClick={() => void save()}>Save</Button>
        </div>
      </article>
    );
  }

  return (
    <article className="rounded-card border border-line bg-surface px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
            <span className="rounded-full border border-line bg-canvas px-2 py-0.5 font-mono">{example.evaluatorKey}</span>
            <span className={example.verdict === 'pass' ? 'text-accent' : 'text-danger'}>{example.verdict}</span>
            <span className="ml-auto">{new Date(example.createdAt).toLocaleDateString()}</span>
          </div>
          {example.reason && <div className="mt-2 text-[12px] text-text-secondary">{example.reason}</div>}
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <PreviewBlock label="Input" value={example.input} />
            <PreviewBlock label="Expected" value={example.expected} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" iconLeft={<Pencil size={12} />} onClick={() => setEditing(true)}>Edit</Button>
          <Button variant="ghost" size="sm" iconLeft={<Trash2 size={12} />} onClick={() => onDelete(example.id)}>Delete</Button>
        </div>
      </div>
    </article>
  );
}

function PreviewBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-canvas px-3 py-2">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-text-secondary">
        {formatEditableValue(value)}
      </pre>
    </div>
  );
}

function formatEditableValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function parseEditableValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
