import { useEffect, useMemo, useState } from 'react';
import { Database, Gauge, GraduationCap, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { EmptyState } from '../shared/EmptyState';
import { DataImportPanel } from '../apps/DataImportPanel';
import { MemoryEntryRow } from '../knowledge/MemoryEntryRow';
import { MemoryWriteForm } from '../knowledge/MemoryWriteForm';
import type { MemoryEntryRowData, MemoryKind } from '../knowledge/types';

interface DatasetSpecRow {
  key: string;
  label: string;
  description: string;
  acceptedFormats: string[];
  targetStore: 'knowledge' | 'memory' | 'evaluator_examples' | 'baseline_inputs';
  requiredFields?: string[];
}

interface RawIngestionJob {
  id: string;
  datasetKey: string;
  status: string;
  totalItems: number;
  processedItems: number;
  storedItems?: number;
  errors?: Array<{ message?: string }>;
  impact?: { newKnowledgeClusters?: number };
  createdAt?: string;
}

interface PanelIngestionJob {
  id: string;
  datasetKey: string;
  status: string;
  totalItems: number;
  processedItems: number;
  chunkCount: number;
  embeddingCount: number;
  errorItems: number;
  currentPhase?: string;
  progressMessage?: string | null;
  errorMessage?: string | null;
}

interface EvaluatorExample {
  id: string;
  evaluatorKey: string;
  verdict: 'pass' | 'fail';
  input: unknown;
  expected: unknown;
  reason?: string;
  createdAt: string;
}

interface IntelligenceResponse {
  summary?: {
    importedDatasetCount?: number;
    knowledgeClusterCount?: number;
    promotedMemoryCount?: number;
    evaluatorExampleCount?: number;
    baselineConfidence?: number | null;
  };
}

export function BrainManageView({ slug }: { slug: string }) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [intelligence, setIntelligence] = useState<IntelligenceResponse | null>(null);
  const [datasets, setDatasets] = useState<Array<DatasetSpecRow & { status?: string; latestJob?: PanelIngestionJob | null }>>([]);
  const [latestJobs, setLatestJobs] = useState<Map<string, PanelIngestionJob>>(new Map());
  const [memory, setMemory] = useState<MemoryEntryRowData[]>([]);
  const [examples, setExamples] = useState<EvaluatorExample[]>([]);

  async function refresh() {
    setLoading(true);
    try {
      const [intel, datasetData, memoryData, exampleData] = await Promise.all([
        api<IntelligenceResponse>(`/v1/apps/${slug}/intelligence`),
        api<{ datasets: Array<{ spec: DatasetSpecRow; recentJobs: RawIngestionJob[] }> }>(`/v1/apps/${slug}/datasets`),
        api<{ episodes: MemoryEntryRowData[] }>(`/v1/apps/${slug}/memory?limit=100`),
        api<{ examples: EvaluatorExample[] }>(`/v1/apps/${slug}/evaluator-examples?limit=100`),
      ]);
      setIntelligence(intel);
      const nextJobs = new Map<string, PanelIngestionJob>();
      const nextDatasets = (datasetData.datasets ?? []).map(({ spec, recentJobs }) => {
        const latest = recentJobs?.[0] ? toPanelJob(recentJobs[0]) : null;
        if (latest) nextJobs.set(spec.key, latest);
        return {
          ...spec,
          status: latest?.status === 'completed' ? 'imported' : latest?.status,
          latestJob: latest,
        };
      });
      setDatasets(nextDatasets);
      setLatestJobs(nextJobs);
      setMemory(memoryData.episodes ?? []);
      setExamples(exampleData.examples ?? []);
    } catch (err) {
      toast.error('Failed to load Brain manager', String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [slug]);

  const stats = useMemo(() => [
    { label: 'Imported datasets', value: intelligence?.summary?.importedDatasetCount ?? 0 },
    { label: 'Knowledge clusters', value: intelligence?.summary?.knowledgeClusterCount ?? 0 },
    { label: 'Memory entries', value: memory.length },
    { label: 'Evaluator examples', value: examples.length },
  ], [examples.length, intelligence, memory.length]);

  async function saveMemory(entry: { kind: MemoryKind; title: string; content: string }) {
    await api(`/v1/apps/${slug}/memory`, { method: 'POST', body: JSON.stringify(entry) });
    toast.success('App memory saved', entry.title);
    await refresh();
  }

  async function archiveMemory(id: string) {
    await api(`/v1/apps/${slug}/memory/${id}`, { method: 'DELETE' });
    toast.success('App memory removed');
    await refresh();
  }

  if (loading && !intelligence) return <div className="p-6"><Skeleton height={520} /></div>;

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

        <Section title="Data Sources" subtitle="Import your business data so this app can use it." icon={<Database size={16} />} onRefresh={() => void refresh()}>
          <DataImportPanel appSlug={slug} datasets={datasets} latestJobs={latestJobs} onRefresh={refresh} />
        </Section>

        <Section title="Memory" subtitle="Facts, rules, and preferences this app always remembers." icon={<Gauge size={16} />}>
          <div className="space-y-3">
            <MemoryWriteForm submitLabel="Save to app memory" onSubmit={saveMemory} />
            {memory.length === 0 ? (
              <EmptyState title="No memory entries" body="Add facts, rules, and preferences that this app should always know." />
            ) : (
              <div className="space-y-2">{memory.map((entry) => <MemoryEntryRow key={entry.id} entry={entry} onArchive={(id) => void archiveMemory(id)} />)}</div>
            )}
          </div>
        </Section>

        <Section title="Evaluator Examples" subtitle="Examples that define what good and bad outputs look like." icon={<GraduationCap size={16} />}>
          <EvaluatorExampleForm slug={slug} onSaved={refresh} />
          {examples.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-card border border-line bg-surface">
              {examples.slice(0, 20).map((example) => (
                <div key={example.id} className="border-b border-line/60 px-4 py-3 last:border-b-0">
                  <div className="flex items-center gap-2 text-[11px] text-text-muted">
                    <span className="font-mono">{example.evaluatorKey}</span>
                    <span className={example.verdict === 'pass' ? 'text-accent' : 'text-danger'}>{example.verdict}</span>
                    <span className="ml-auto">{new Date(example.createdAt).toLocaleDateString()}</span>
                  </div>
                  {example.reason && <div className="mt-1 text-[12px] text-text-secondary">{example.reason}</div>}
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

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

function EvaluatorExampleForm({ slug, onSaved }: { slug: string; onSaved: () => Promise<void> }) {
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
      await api(`/v1/apps/${slug}/evaluator-examples`, {
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

function toPanelJob(job: RawIngestionJob): PanelIngestionJob {
  const stored = job.storedItems ?? job.processedItems ?? 0;
  return {
    id: job.id,
    datasetKey: job.datasetKey,
    status: job.status,
    totalItems: job.totalItems,
    processedItems: job.processedItems,
    chunkCount: job.impact?.newKnowledgeClusters ?? stored,
    embeddingCount: stored,
    errorItems: job.errors?.length ?? 0,
    currentPhase: job.status,
    progressMessage: job.status === 'completed' ? `Stored ${stored} items` : job.status,
    errorMessage: job.errors?.[0]?.message ?? null,
  };
}