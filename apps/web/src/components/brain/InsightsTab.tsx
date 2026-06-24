import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Archive, Gauge, RefreshCw, ShieldCheck, Sparkles, TrendingDown, TrendingUp } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, apiErrorMessage } from '../../lib/api';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';
import { WorkspaceMemoryTab } from '../knowledge/WorkspaceMemoryTab';
import { EpisodesTab } from '../knowledge/EpisodesTab';
import { DisputeResolutionPanel } from './DisputeResolutionPanel';

interface HealthSnapshot {
  healthScore: number;
  metrics: {
    atomCoverageScore: number;
    qualityTrend: 'rising' | 'flat' | 'falling';
    averageConfidenceDelta: number;
    evaluatorSignalRate: number;
    staleAtomCount: number;
    disputedAtomCount: number;
  };
  evaluatorSignalsThisWeek: number;
  compressionStatus: { lastRunAt: string | null; atomsArchived: number };
  intelligence: { degraded: boolean };
}

export function InsightsTab({ onOpenConfig, scopeId }: { onOpenConfig?: () => void; scopeId?: string }) {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const toast = useToast();
  const isScoped = Boolean(scopeId);
  const healthPath = scopeId ? `/v1/brain/health?scopeId=${encodeURIComponent(scopeId)}` : '/v1/brain/health';

  const load = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      setSnapshot(await api<HealthSnapshot>(healthPath));
    } catch (error) {
      toast.error('Failed to load Brain insights', apiErrorMessage(error));
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [healthPath, toast]);

  useEffect(() => { void load(true); }, [load]);
  useEffect(() => rtSubscribe('workspace', {}), []);
  useRealtime([
    REALTIME_EVENTS.BRAIN_ATOM_CREATED,
    REALTIME_EVENTS.BRAIN_ATOM_REINFORCED,
    REALTIME_EVENTS.BRAIN_DISPUTE_FLAGGED,
    REALTIME_EVENTS.BRAIN_DISPUTE_RESOLVED,
    REALTIME_EVENTS.BRAIN_MAINTENANCE_COMPLETED,
    REALTIME_EVENTS.BRAIN_CONFIG_DEGRADED,
    REALTIME_EVENTS.BRAIN_EMBEDDING_MIGRATION_COMPLETED,
  ], () => { void load(false); });

  const scoreTone = useMemo(() => {
    const score = snapshot?.healthScore ?? 0;
    if (score >= 75) return 'text-emerald-300';
    if (score >= 45) return 'text-amber-300';
    return 'text-rose-300';
  }, [snapshot?.healthScore]);

  async function dreamPass() {
    setRunning(true);
    try {
      const result = await api<{ peersProcessed: number }>('/v1/brain/dream-pass', {
        method: 'POST',
        body: JSON.stringify({ force: true, phase: 'both' }),
      });
      toast.success('Dream pass completed', `${result.peersProcessed} peer${result.peersProcessed === 1 ? '' : 's'} processed`);
      await load(false);
    } catch (error) {
      toast.error('Dream pass failed', apiErrorMessage(error));
    } finally {
      setRunning(false);
    }
  }

  if (loading) {
    return <div className="space-y-4 p-6"><Skeleton height={108} /><Skeleton height={220} /><Skeleton height={300} /></div>;
  }
  if (!snapshot) {
    return <div className="p-8 text-[14px] text-text-muted">Could not load Brain insights.</div>;
  }

  return (
    <main className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-7xl space-y-5">
        {snapshot.intelligence.degraded && !isScoped && (
          <section className="flex flex-wrap items-center gap-3 rounded-card border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-100">
            <AlertTriangle size={16} className="text-amber-300" />
            <span>Brain is running in keyword mode. Semantic search is disabled.</span>
            {onOpenConfig && <Button variant="secondary" size="sm" onClick={onOpenConfig} className="ml-auto border-amber-400/30 text-amber-100">Set up embedding</Button>}
          </section>
        )}

        <section className="grid gap-3 lg:grid-cols-[minmax(220px,0.9fr)_repeat(4,minmax(145px,1fr))]">
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Brain Health <ShieldCheck size={15} className={scoreTone} />
            </div>
            <div className={`mt-4 text-[46px] font-semibold leading-none ${scoreTone}`}>{snapshot.healthScore}</div>
            <p className="mt-2 text-[12px] text-text-muted">Confidence and retrieval readiness.</p>
          </div>
          <Metric icon={<Gauge size={15} />} label="Context Coverage" value={percent(snapshot.metrics.atomCoverageScore)} />
          <Metric icon={<Sparkles size={15} />} label="Evaluator Signal" value={percent(snapshot.metrics.evaluatorSignalRate)} />
          <Metric icon={trendIcon(snapshot.metrics.qualityTrend)} label="Quality" value={snapshot.metrics.qualityTrend} detail={signed(snapshot.metrics.averageConfidenceDelta)} />
          <Metric icon={<AlertTriangle size={15} />} label="Disputes" value={String(snapshot.metrics.disputedAtomCount)} detail={`${snapshot.metrics.staleAtomCount} stale atoms`} />
        </section>

        {!isScoped && snapshot.metrics.disputedAtomCount > 0 && (
          <section className="rounded-card border border-amber-400/20 bg-amber-500/[0.035] p-4">
            <DisputeResolutionPanel embedded hideWhenEmpty />
          </section>
        )}

        <InsightSection
          eyebrow="Memory"
          title={isScoped ? 'Workflow recall' : 'Shared recall'}
          description={isScoped
            ? 'Facts, rules, preferences, patterns, and lessons available to this workflow.'
            : 'Facts, rules, preferences, patterns, and lessons available to every agent.'}
        >
          <WorkspaceMemoryTab scopeId={scopeId} />
        </InsightSection>

        <InsightSection
          eyebrow="Episodes"
          title="Promoted learning"
          description={isScoped ? 'Lessons distilled from this workflow’s outcomes.' : 'Lessons distilled automatically from workflow outcomes.'}
        >
          <EpisodesTab scopeId={scopeId} />
        </InsightSection>

        {!isScoped && <section className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-4">
          <div className="mr-auto">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Maintenance</div>
            <p className="mt-1 text-[12px] text-text-secondary">
              {snapshot.compressionStatus.lastRunAt ? `Last dream pass ${formatTime(snapshot.compressionStatus.lastRunAt)}` : 'No dream pass run yet.'}
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-pill bg-surface-2 px-3 py-1.5 text-[12px] text-text-secondary">
            <Archive size={12} /> {snapshot.compressionStatus.atomsArchived} archived
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-pill bg-surface-2 px-3 py-1.5 text-[12px] text-text-secondary">
            <Sparkles size={12} /> {snapshot.evaluatorSignalsThisWeek} signals this week
          </span>
          <Button size="sm" variant="secondary" loading={running} iconLeft={<Sparkles size={13} />} onClick={() => void dreamPass()}>Dream Pass</Button>
          <Button size="sm" variant="ghost" iconLeft={<RefreshCw size={13} />} onClick={() => void load(true)}>Refresh</Button>
        </section>}
      </div>
    </main>
  );
}

function InsightSection({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <div className="mb-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{eyebrow}</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-heading text-text-primary">{title}</h2>
          <p className="text-[12px] text-text-muted">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Metric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2 text-text-muted">
        <span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <div className="mt-4 text-[25px] font-semibold capitalize text-text-primary">{value}</div>
      {detail && <div className="mt-1 text-[11px] text-text-muted">{detail}</div>}
    </div>
  );
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)} avg delta`;
}

function trendIcon(trend: HealthSnapshot['metrics']['qualityTrend']) {
  if (trend === 'rising') return <TrendingUp size={15} className="text-emerald-300" />;
  if (trend === 'falling') return <TrendingDown size={15} className="text-rose-300" />;
  return <Gauge size={15} />;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}
