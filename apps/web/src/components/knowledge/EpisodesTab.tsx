import { useEffect, useMemo, useState } from 'react';
import { History, Trash2 } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { Skeleton } from '../shared/Skeleton';
import { EmptyState } from '../shared/EmptyState';
import { EpisodeRow } from './EpisodeRow';
import type { EpisodeRowData } from './types';

const FILTERS = ['all', 'decision', 'failure', 'recovery', 'correction', 'pattern', 'distilled_lesson'] as const;

/**
 * `scopeId`, `workflowId`, and `agentId` are three independent memory-episode
 * filters (see EpisodicMemoryStore.list) — pass exactly one for a scoped view.
 * `scopeId` is what App-owned and directly-scoped runs are written under;
 * `workflowId`/`agentId` are separate columns recorded on every episode and let
 * a specific workflow canvas or agent panel find its own episodes even when the
 * write went to a different scope (e.g. an App id).
 */
export function EpisodesTab({ scopeId, workflowId, agentId }: { scopeId?: string; workflowId?: string; agentId?: string }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [episodes, setEpisodes] = useState<EpisodeRowData[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const isScoped = Boolean(scopeId || workflowId || agentId);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ limit: '80' });
    if (scopeId) params.set('scopeId', scopeId);
    if (workflowId) params.set('workflowId', workflowId);
    if (agentId) params.set('agentId', agentId);
    void api<{ episodes: EpisodeRowData[] }>(`/v1/memory/episodes?${params.toString()}`)
      .then((data) => { if (!cancelled) setEpisodes(data.episodes ?? []); })
      .catch((err) => { if (!cancelled) { toast.error('Failed to load episodes', apiErrorMessage(err)); setEpisodes([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scopeId, workflowId, agentId, toast]);

  const filtered = useMemo(() => episodes.filter((episode) => filter === 'all' || episode.type === filter), [episodes, filter]);
  const allSelected = filtered.length > 0 && filtered.every((e) => selected.has(e.id));

  function toggle(id: string) {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(filtered.map((e) => e.id)));
  }
  function removeLocal(id: string) {
    setEpisodes((prev) => prev.filter((e) => e.id !== id));
    setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }
  async function deleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const ok = await confirm({
      title: `Delete ${ids.length} ${ids.length === 1 ? 'episode' : 'episodes'}?`,
      body: 'This removes the promoted lesson from the Brain. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    const results = await Promise.allSettled(ids.map((id) => api(`/v1/brain/atoms/episode/${id}`, { method: 'DELETE' })));
    const deleted = new Set(ids.filter((_, i) => results[i]?.status === 'fulfilled'));
    setEpisodes((prev) => prev.filter((e) => !deleted.has(e.id)));
    setSelected(new Set());
    if (deleted.size < ids.length) toast.error('Some episodes could not be deleted');
    else toast.success(`Deleted ${deleted.size} ${deleted.size === 1 ? 'episode' : 'episodes'}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {filtered.length > 0 && (
          <label className="flex items-center gap-2 text-[12px] text-text-muted">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-3.5 w-3.5 rounded border-line bg-surface text-accent" />
            {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
          </label>
        )}
        {selected.size > 0 ? (
          <button type="button" onClick={() => void deleteSelected()} className="inline-flex items-center gap-1 rounded-btn border border-danger/30 bg-danger-soft px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/15">
            <Trash2 size={12} /> Delete selected
          </button>
        ) : (
          <p className="text-[13px] text-text-muted">
            {isScoped ? 'Lessons promoted from this scope’s runs.' : 'Lessons promoted automatically from workflow runs.'}
          </p>
        )}
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
          body={isScoped
            ? 'Episodes appear here as this scope’s runs complete and Agentis distills useful decisions, recoveries, and patterns.'
            : 'Episodes appear here as workflows complete and Agentis distills useful decisions, recoveries, and patterns.'}
        />
      ) : (
        <div className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
          {filtered.map((episode) => (
            <EpisodeRow
              key={episode.id}
              episode={episode}
              selected={selected.has(episode.id)}
              onToggleSelect={toggle}
              onUpdated={(next) => setEpisodes((prev) => prev.map((e) => (e.id === next.id ? next : e)))}
              onDeleted={removeLocal}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const activeFilter = 'inline-flex h-7 items-center rounded-pill border border-accent-muted bg-accent-soft px-2.5 text-[11px] font-medium capitalize text-accent';
const idleFilter = 'inline-flex h-7 items-center rounded-pill border border-line bg-surface-2 px-2.5 text-[11px] font-medium capitalize text-text-muted hover:text-text-primary';
