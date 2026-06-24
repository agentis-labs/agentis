import { useEffect, useMemo, useState } from 'react';
import { History } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Skeleton } from '../shared/Skeleton';
import { EmptyState } from '../shared/EmptyState';
import { EpisodeRow } from './EpisodeRow';
import type { EpisodeRowData } from './types';

const FILTERS = ['all', 'decision', 'failure', 'recovery', 'correction', 'pattern', 'distilled_lesson'] as const;

export function EpisodesTab({ scopeId }: { scopeId?: string }) {
  const toast = useToast();
  const [episodes, setEpisodes] = useState<EpisodeRowData[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const path = scopeId ? `/v1/memory/episodes?limit=80&scopeId=${encodeURIComponent(scopeId)}` : '/v1/memory/episodes?limit=80';
    void api<{ episodes: EpisodeRowData[] }>(path)
      .then((data) => { if (!cancelled) setEpisodes(data.episodes ?? []); })
      .catch((err) => { if (!cancelled) { toast.error('Failed to load episodes', apiErrorMessage(err)); setEpisodes([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scopeId, toast]);

  const filtered = useMemo(() => episodes.filter((episode) => filter === 'all' || episode.type === filter), [episodes, filter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] text-text-muted">
          {scopeId ? 'Lessons promoted from this workflow’s runs.' : 'Lessons promoted automatically from workflow runs.'}
        </p>
        <div className="ml-auto flex flex-wrap gap-1">
          {FILTERS.map((item) => (
            <button key={item} type="button" onClick={() => setFilter(item)} className={filter === item ? activeFilter : idleFilter}>
              {item.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </div>
      {loading ? <Skeleton height={220} /> : filtered.length === 0 ? (
        <EmptyState
          icon={<History size={48} />}
          title="No promoted memories yet"
          body={scopeId
            ? 'Episodes appear here as this workflow completes and Agentis distills useful decisions, recoveries, and patterns.'
            : 'Episodes appear here as workflows complete and Agentis distills useful decisions, recoveries, and patterns.'}
        />
      ) : (
        <div className="space-y-2">{filtered.map((episode) => <EpisodeRow key={episode.id} episode={episode} />)}</div>
      )}
    </div>
  );
}

const activeFilter = 'inline-flex h-7 items-center rounded-pill border border-accent-muted bg-accent-soft px-2.5 text-[11px] font-medium capitalize text-accent';
const idleFilter = 'inline-flex h-7 items-center rounded-pill border border-line bg-surface-2 px-2.5 text-[11px] font-medium capitalize text-text-muted hover:text-text-primary';
