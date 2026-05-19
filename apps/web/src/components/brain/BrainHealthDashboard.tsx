import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Archive, Gauge, RefreshCw, ShieldCheck, Sparkles, TrendingDown, TrendingUp } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import { api } from '../../lib/api';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';
import { BrainActivityFeed, type BrainActivityItem } from './BrainActivityFeed';

interface BrainHealthSnapshot {
  healthScore: number;
  metrics: {
    atomCoverageScore: number;
    qualityTrend: 'rising' | 'flat' | 'falling';
    averageConfidenceDelta: number;
    evaluatorSignalRate: number;
    abilityAdoptionRate: number;
    staleAtomCount: number;
    disputedAtomCount: number;
  };
  topAtoms: AtomSummary[];
  staleAtoms: AtomSummary[];
  evaluatorSignalsThisWeek: number;
  compressionStatus: { lastRunAt: string | null; atomsArchived: number; nextTriggerAt: string | null };
  intelligence: {
    embeddingProviderType: string;
    degraded: boolean;
    migration: unknown;
  };
  recentActivity: BrainActivityItem[];
}

interface AtomSummary {
  id: string;
  title: string;
  content: string;
  confidence: number;
  updatedAt: string;
}

export function BrainHealthDashboard({ slug }: { slug: string | null }) {
  const [snapshot, setSnapshot] = useState<BrainHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [dreaming, setDreaming] = useState(false);
  const toast = useToast();
  const basePath = slug ? `/v1/apps/${slug}/brain` : '/v1/brain';

  const load = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      setSnapshot(await api<BrainHealthSnapshot>(`${basePath}/health`));
    } catch (err) {
      toast.error('Failed to load Brain health', String(err));
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [basePath, toast]);

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => rtSubscribe('workspace', {}), []);
  useRealtime([
    REALTIME_EVENTS.BRAIN_ATOM_CREATED,
    REALTIME_EVENTS.BRAIN_ATOM_REINFORCED,
    REALTIME_EVENTS.BRAIN_CONTEXT_INJECTED,
    REALTIME_EVENTS.BRAIN_DIALECTIC_SYNTHESIZED,
    REALTIME_EVENTS.BRAIN_DISPUTE_FLAGGED,
    REALTIME_EVENTS.BRAIN_DISPUTE_RESOLVED,
    REALTIME_EVENTS.BRAIN_MAINTENANCE_COMPLETED,
    REALTIME_EVENTS.BRAIN_CONFIG_DEGRADED,
    REALTIME_EVENTS.BRAIN_EMBEDDING_MIGRATION_STARTED,
    REALTIME_EVENTS.BRAIN_EMBEDDING_MIGRATION_COMPLETED,
  ], () => {
    void load(false);
  });

  const scoreTone = useMemo(() => {
    const score = snapshot?.healthScore ?? 0;
    if (score >= 75) return 'text-emerald-300';
    if (score >= 45) return 'text-amber-300';
    return 'text-rose-300';
  }, [snapshot?.healthScore]);

  async function runDreamPass() {
    setDreaming(true);
    try {
      const result = await api<{ peersProcessed: number; factsUpserted: number; superseded: number; inductiveConclusions: number; contradictions: number }>(`${basePath}/dream-pass`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true, phase: 'both' }),
      });
      toast.success('Dream pass completed', `${result.peersProcessed} peer${result.peersProcessed === 1 ? '' : 's'} processed`);
      await load(false);
    } catch (err) {
      toast.error('Dream pass failed', String(err));
    } finally {
      setDreaming(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton height={90} />
        <Skeleton height={220} />
        <Skeleton height={280} />
      </div>
    );
  }

  if (!snapshot) {
    return <div className="p-6 text-[14px] text-text-muted">Could not load Brain health.</div>;
  }

  return (
    <main className="h-full overflow-y-auto px-5 py-5">
      <div className="mx-auto max-w-7xl space-y-5">
        {snapshot.intelligence.degraded && !slug && (
          <section className="rounded-card border border-amber-400/30 bg-amber-500/10 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-start gap-3">
                <AlertTriangle size={18} className="mt-0.5 text-amber-300" />
                <div>
                  <div className="text-[14px] font-semibold text-amber-100">Brain is running in degraded mode</div>
                  <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-amber-100/75">
                    Atom retrieval is using keyword-style hashing instead of configured semantic embeddings. Results will be lower quality until an embedding model is connected.
                  </p>
                </div>
              </div>
              <Link to="/brain/config" className="inline-flex h-9 shrink-0 items-center justify-center rounded-input bg-amber-300 px-3 text-[13px] font-semibold text-zinc-950 transition hover:bg-amber-200 active:translate-y-px">
                Set up embedding model
              </Link>
            </div>
          </section>
        )}
        <section className="grid gap-3 lg:grid-cols-[minmax(260px,0.8fr)_repeat(4,minmax(160px,1fr))]">
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Brain Health</span>
              <ShieldCheck size={16} className={scoreTone} />
            </div>
            <div className={`mt-4 text-[46px] font-semibold leading-none ${scoreTone}`}>{snapshot.healthScore}</div>
            <div className="mt-2 text-[12px] text-text-muted">Composite of context coverage, evaluator signal, ability adoption, stale load, and disputes.</div>
          </div>
          <MetricCard icon={<Gauge size={15} />} label="Context Coverage" value={percent(snapshot.metrics.atomCoverageScore)} />
          <MetricCard icon={<Sparkles size={15} />} label="Evaluator Signal" value={percent(snapshot.metrics.evaluatorSignalRate)} />
          <MetricCard icon={trendIcon(snapshot.metrics.qualityTrend)} label="Quality Trend" value={snapshot.metrics.qualityTrend} detail={signed(snapshot.metrics.averageConfidenceDelta)} />
          <MetricCard icon={<AlertTriangle size={15} />} label="Open Disputes" value={String(snapshot.metrics.disputedAtomCount)} detail={`${snapshot.metrics.staleAtomCount} stale atoms`} />
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-5">
            <div className="grid gap-5 lg:grid-cols-2">
              <AtomList title="Highest Confidence Atoms" atoms={snapshot.topAtoms} empty="No durable atoms yet." />
              <AtomList title="Stale Review Queue" atoms={snapshot.staleAtoms} empty="No stale atoms need review." stale />
            </div>
            <div className="rounded-card border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Compression</div>
                  <div className="mt-1 text-[13px] text-text-secondary">
                    {snapshot.compressionStatus.lastRunAt ? `Last maintained ${formatTime(snapshot.compressionStatus.lastRunAt)}` : 'Maintenance has not run yet.'}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-[12px] text-text-secondary">
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1">
                    <Archive size={12} /> {snapshot.compressionStatus.atomsArchived} archived
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1">
                    <RefreshCw size={12} /> {snapshot.evaluatorSignalsThisWeek} evaluator signals this week
                  </span>
                </div>
              </div>
            </div>
          </div>
          <BrainActivityFeed activity={snapshot.recentActivity} dense />
        </section>

        <div className="flex justify-end">
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" loading={dreaming} iconLeft={<Sparkles size={13} />} onClick={runDreamPass}>
              Dream Pass
            </Button>
            <Button size="sm" variant="ghost" iconLeft={<RefreshCw size={13} />} onClick={() => load(true)}>
              Refresh
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}

function MetricCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2 text-text-muted">
        <span className="text-[12px] font-semibold uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <div className="mt-4 text-[24px] font-semibold capitalize text-text-primary">{value}</div>
      {detail && <div className="mt-1 text-[12px] text-text-muted">{detail}</div>}
    </div>
  );
}

function AtomList({ title, atoms, empty, stale = false }: { title: string; atoms: AtomSummary[]; empty: string; stale?: boolean }) {
  return (
    <div className="rounded-card border border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">{title}</div>
      </div>
      {atoms.length === 0 ? (
        <div className="px-4 py-8 text-center text-[13px] text-text-muted">{empty}</div>
      ) : (
        <div className="divide-y divide-line">
          {atoms.map((atom) => (
            <article key={atom.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <h3 className="min-w-0 truncate text-[13px] font-medium text-text-primary">{atom.title}</h3>
                <span className={stale ? 'text-[11px] text-amber-300' : 'text-[11px] text-emerald-300'}>{Math.round(atom.confidence * 100)}%</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-text-muted">{atom.content}</p>
              <time className="mt-2 block text-[11px] text-text-muted" dateTime={atom.updatedAt}>{formatTime(atom.updatedAt)}</time>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)} avg delta`;
}

function trendIcon(trend: 'rising' | 'flat' | 'falling') {
  if (trend === 'rising') return <TrendingUp size={15} className="text-emerald-300" />;
  if (trend === 'falling') return <TrendingDown size={15} className="text-rose-300" />;
  return <Gauge size={15} />;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}
