import { useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Database, Trash2, Upload, UploadCloud } from 'lucide-react';
import { ambient, api, tokens, workspace } from '../../lib/api';
import { useToast } from '../shared/Toast';

interface DatasetRow {
  key: string;
  label: string;
  description: string;
  acceptedFormats: string[];
  targetStore: 'knowledge' | 'memory' | 'evaluator_examples' | 'baseline_inputs';
  requiredFields?: string[];
  status?: string;
  processedItems?: number;
  chunkCount?: number;
  latestJob?: IngestionJob | null;
}

interface IngestionJob {
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

interface PreviewResult {
  recordCount: number;
  columns: string[];
  previewRows: Array<{ title: string; fields: Record<string, unknown> }>;
  warnings: string[];
  sourceHash: string;
  byteSize: number;
}

interface ProgressSnapshot {
  jobId: string | null;
  status: string;
  processedItems: number;
  totalItems: number;
  currentPhase: string;
  progressMessage?: string | null;
  errorMessage?: string | null;
  percentComplete: number;
  errorCount: number;
  chunkCount?: number;
  embeddingCount?: number;
}

export function DataImportPanel({
  appSlug,
  datasets,
  latestJobs,
  onRefresh,
}: {
  appSlug: string;
  datasets: DatasetRow[];
  latestJobs: Map<string, IngestionJob>;
  onRefresh: () => Promise<void>;
}) {
  if (datasets.length === 0) {
    return <div className="rounded-md border border-line bg-surface px-3 py-10 text-center text-xs text-text-muted">No dataset sources declared.</div>;
  }
  return (
    <div className="grid gap-3">
      {datasets.map((dataset) => (
        <DatasetImportRow
          key={dataset.key}
          appSlug={appSlug}
          dataset={dataset}
          latestJob={latestJobs.get(dataset.key) ?? dataset.latestJob ?? null}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  );
}

function DatasetImportRow({
  appSlug,
  dataset,
  latestJob,
  onRefresh,
}: {
  appSlug: string;
  dataset: DatasetRow;
  latestJob: IngestionJob | null;
  onRefresh: () => Promise<void>;
}) {
  const toast = useToast();
  const [format, setFormat] = useState(dataset.acceptedFormats[0] ?? 'text');
  const [file, setFile] = useState<File | null>(null);
  const [content, setContent] = useState<string>('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);
  const [impact, setImpact] = useState<{ records: number; chunks: number; embeddings: number } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);

  async function previewFile(nextFile: File | null) {
    if (!nextFile) return;
    setBusy(true);
    try {
      const text = await nextFile.text();
      setFile(nextFile);
      setContent(text);
      setImpact(null);
      const res = await api<{ preview: PreviewResult }>(`/v1/apps/${appSlug}/data/${dataset.key}/preview`, {
        method: 'POST',
        body: JSON.stringify({ sourceFormat: format, name: nextFile.name, mimeType: nextFile.type || undefined, content: text }),
      });
      setPreview(res.preview);
    } catch (err) {
      toast.error('Preview failed', messageFrom(err));
    } finally {
      setBusy(false);
    }
  }

  async function ingest() {
    if (!file) return;
    setBusy(true);
    try {
      const res = await api<{ job?: IngestionJob }>(`/v1/apps/${appSlug}/data/${dataset.key}/ingest`, {
        method: 'POST',
        body: JSON.stringify({ sourceFormat: format, name: file.name, mimeType: file.type || undefined, content }),
      });
      if (res.job) {
        setProgress(progressFromJob(res.job));
        setImpact({ records: res.job.processedItems, chunks: res.job.chunkCount, embeddings: res.job.embeddingCount });
      }
      void streamProgress();
      toast.success('Data imported', dataset.label);
      setFile(null);
      setContent('');
      setPreview(null);
      await onRefresh();
    } catch (err) {
      toast.error('Import failed', messageFrom(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/v1/apps/${appSlug}/data/${dataset.key}`, { method: 'DELETE' });
      toast.success('Data removed', dataset.label);
      await onRefresh();
    } catch (err) {
      toast.error('Remove failed', messageFrom(err));
    } finally {
      setBusy(false);
    }
  }

  async function streamProgress() {
    try {
      const headers = new Headers();
      const access = tokens.access();
      if (access) headers.set('authorization', `Bearer ${access}`);
      const ws = workspace.get();
      if (ws) headers.set('x-agentis-workspace', ws);
      const amb = ambient.get();
      if (amb) headers.set('x-agentis-ambient', amb);
      const res = await fetch(`/v1/apps/${appSlug}/data/${dataset.key}/progress`, { headers });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const event of events) {
          const data = event.split('\n').find((line) => line.startsWith('data: '));
          if (!data) continue;
          const snapshot = JSON.parse(data.slice(6)) as ProgressSnapshot;
          setProgress(snapshot);
          if (snapshot.status === 'completed') {
            setImpact({ records: snapshot.processedItems, chunks: snapshot.chunkCount ?? 0, embeddings: snapshot.embeddingCount ?? 0 });
          }
        }
      }
    } catch {
      /* progress stream is best-effort; the job row remains authoritative */
    }
  }

  const failed = latestJob?.status === 'failed';
  const imported = dataset.status === 'imported' && !failed;
  const shownProgress = progress ?? (latestJob ? progressFromJob(latestJob) : null);
  return (
    <article
      className={clsx('rounded-md border bg-surface p-4 shadow-card transition', dragActive ? 'border-accent/60' : 'border-line')}
      onDragOver={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        void previewFile(event.dataTransfer.files?.[0] ?? null);
      }}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md border border-line bg-surface-2 text-accent">
          <Database size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-medium text-text-primary">{dataset.label}</div>
            <Status failed={failed} imported={imported} label={failed ? 'failed' : imported ? 'imported' : 'not imported'} />
          </div>
          <div className="mt-1 max-w-3xl text-[11px] leading-5 text-text-muted">{dataset.description}</div>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-text-muted">
            <span className="rounded-full border border-line bg-canvas px-2 py-0.5">{dataset.targetStore}</span>
            {dataset.requiredFields?.map((field) => (
              <span key={field} className="rounded-full border border-line bg-canvas px-2 py-0.5">{field}</span>
            ))}
            {latestJob?.currentPhase && <span className="rounded-full border border-line bg-canvas px-2 py-0.5">{latestJob.currentPhase}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <select
            value={format}
            onChange={(event) => setFormat(event.target.value)}
            className="h-8 max-w-32 rounded-md border border-line bg-canvas px-2 text-[11px] text-text-primary outline-none"
            title="Source format"
          >
            {(dataset.acceptedFormats.length ? dataset.acceptedFormats : ['text']).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <label className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-line bg-canvas px-2.5 text-xs text-text-primary transition hover:border-accent/40">
            <UploadCloud size={13} />
            Preview
            <input type="file" className="hidden" disabled={busy} onChange={(event) => void previewFile(event.target.files?.[0] ?? null)} />
          </label>
          <button
            type="button"
            onClick={() => void ingest()}
            disabled={busy || !preview}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2.5 text-xs text-accent transition hover:border-accent/60 disabled:opacity-50"
          >
            <Upload size={13} />
            Import
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy || (!latestJob && dataset.status !== 'imported')}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-line bg-canvas px-2.5 text-xs text-text-muted transition hover:border-danger/40 hover:text-danger disabled:opacity-40"
            title="Clear source"
            aria-label="Clear source"
          >
            <Trash2 size={13} />
            Clear
          </button>
        </div>
      </div>
      {shownProgress && shownProgress.status !== 'not_started' && (
        <div className="mt-3 rounded-md border border-line bg-canvas p-2">
          <div className="flex items-center justify-between gap-2 text-[11px] text-text-muted">
            <span>{shownProgress.progressMessage ?? shownProgress.currentPhase}</span>
            <span>{shownProgress.percentComplete}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.min(100, shownProgress.percentComplete)}%` }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[10px] uppercase text-text-muted">
            <span>{shownProgress.processedItems}/{shownProgress.totalItems} records</span>
            <span>{shownProgress.chunkCount ?? 0} chunks</span>
            <span>{shownProgress.embeddingCount ?? 0} embeddings</span>
            {shownProgress.errorCount > 0 && <span className="text-danger">{shownProgress.errorCount} errors</span>}
          </div>
          {shownProgress.errorCount > 0 && shownProgress.errorMessage && (
            <div className="mt-2 text-[11px] text-danger">{shownProgress.errorMessage}</div>
          )}
        </div>
      )}
      {dragActive && (
        <div className="mt-3 rounded-md border border-dashed border-accent/50 bg-accent/10 px-3 py-2 text-[11px] text-accent">
          Drop file to preview
        </div>
      )}
      {preview && (
        <div className="mt-3 rounded-md border border-line bg-canvas p-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
            <span>{preview.recordCount} records</span>
            <span>{preview.columns.length} columns</span>
            <span>{Math.round(preview.byteSize / 1024)} KB</span>
          </div>
          {preview.warnings.length > 0 && (
            <div className="mt-2 flex items-center gap-1 text-[11px] text-amber-200">
              <AlertTriangle size={12} />
              {preview.warnings.join(' ')}
            </div>
          )}
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {preview.previewRows.slice(0, 3).map((row) => (
              <div key={row.title} className="min-w-0 rounded-md border border-line bg-surface px-2 py-2 text-[11px]">
                <div className="truncate font-medium text-text-primary">{row.title}</div>
                <div className="mt-1 truncate text-text-muted">{Object.entries(row.fields).slice(0, 3).map(([key, value]) => `${key}: ${String(value)}`).join(' / ')}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {impact && (
        <div className="mt-3 grid gap-2 rounded-md border border-accent/30 bg-accent/10 p-3 text-[11px] text-accent sm:grid-cols-3">
          <div><span className="block text-[10px] uppercase opacity-75">Records</span>{impact.records}</div>
          <div><span className="block text-[10px] uppercase opacity-75">Chunks</span>{impact.chunks}</div>
          <div><span className="block text-[10px] uppercase opacity-75">Embeddings</span>{impact.embeddings}</div>
        </div>
      )}
    </article>
  );
}

function progressFromJob(job: IngestionJob): ProgressSnapshot {
  return {
    jobId: job.id,
    status: job.status,
    processedItems: job.processedItems,
    totalItems: job.totalItems,
    currentPhase: job.currentPhase ?? job.status,
    progressMessage: job.progressMessage,
    errorMessage: job.errorMessage,
    percentComplete: job.totalItems > 0 ? Math.round((job.processedItems / job.totalItems) * 100) : 0,
    errorCount: job.errorItems,
    chunkCount: job.chunkCount,
    embeddingCount: job.embeddingCount,
  };
}

function Status({ failed, imported, label }: { failed: boolean; imported: boolean; label: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase', failed ? 'border-danger/30 bg-danger/10 text-danger' : imported ? 'border-accent/30 bg-accent/10 text-accent' : 'border-line bg-surface-2 text-text-muted')}>
      {failed ? <AlertTriangle size={11} /> : imported ? <CheckCircle2 size={11} /> : <Database size={11} />}
      {label}
    </span>
  );
}

function messageFrom(err: unknown) {
  return err && typeof err === 'object' && 'message' in err
    ? String((err as { message?: unknown }).message)
    : 'Something went wrong.';
}
