import { useEffect, useState } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { DataImportPanel } from './DataImportPanel';

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

export function AppDataSourcesSection({
  appId,
  onImported,
}: {
  appId: string;
  onImported?: () => Promise<void>;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [datasets, setDatasets] = useState<Array<DatasetSpecRow & { status?: string; latestJob?: PanelIngestionJob | null }>>([]);
  const [latestJobs, setLatestJobs] = useState<Map<string, PanelIngestionJob>>(new Map());

  async function refresh() {
    setLoading(true);
    try {
      const datasetData = await api<{ datasets: Array<{ spec: DatasetSpecRow; recentJobs: RawIngestionJob[] }> }>(`/v1/apps/${appId}/datasets`);
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
    } catch (err) {
      toast.error('Failed to load data sources', apiErrorMessage(err));
      setDatasets([]);
      setLatestJobs(new Map());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [appId]);

  async function handleRefresh() {
    await refresh();
    await onImported?.();
  }

  if (loading) {
    return (
      <div className="px-5 pt-5">
        <Skeleton height={220} />
      </div>
    );
  }

  if (datasets.length === 0) return null;

  return (
    <section className="border-b border-line px-5 py-5">
      <div className="rounded-card border border-line bg-surface p-4">
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-card border border-line bg-surface-2 text-accent">
            <Database size={16} />
          </span>
          <div>
            <h2 className="text-heading text-text-primary">Imports</h2>
            <p className="mt-1 text-[12px] text-text-muted">Structured files that populate this app's Data layer and operational tables.</p>
          </div>
          <Button variant="ghost" size="sm" className="ml-auto" iconLeft={<RefreshCw size={12} />} onClick={() => void handleRefresh()}>
            Refresh
          </Button>
        </div>
        <DataImportPanel appSlug={appId} datasets={datasets} latestJobs={latestJobs} onRefresh={handleRefresh} />
      </div>
    </section>
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