/**
 * AppsPage — compact app cards grouped by space.
 *
 * Replaces the gigantic-card layout with a clean grid showing:
 * status, version, primary metric (from outputLabels[0]), single CTA.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AppWindow, ArrowRight, SearchX, Plus } from 'lucide-react';
import { api, workspace as wsStore } from '../lib/api';
import { rtSubscribe } from '../lib/realtime';
import { Button } from '../components/shared/Button';
import { SearchInput } from '../components/shared/SearchInput';
import { FilterBar } from '../components/shared/FilterBar';
import { Skeleton } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';
import { StatusBadge } from '../components/shared/StatusBadge';

interface App {
  id: string;
  slug: string;
  name: string;
  version?: string;
  status?: 'active' | 'paused' | 'setup_needed' | 'error';
  deployStatus?: 'running' | 'stopped' | 'error' | 'deploying' | string;
  spaceId?: string;
  spaceName?: string;
  primaryMetric?: { label: string; value: string | number; window?: string };
  setupBlocker?: string;
  iconGlyph?: string;
  iconColor?: string;
  iconUrl?: string | null;
  coverImage?: string | null;
  description?: string;
  category?: string;
}

interface Space { id: string; name: string; }

type FilterValue = 'all' | 'active' | 'setup_needed' | 'paused' | 'error';

const FILTERS = [
  { value: 'all',           label: 'All' },
  { value: 'active',        label: 'Enabled' },
  { value: 'setup_needed',  label: 'Setup needed' },
  { value: 'paused',        label: 'Paused' },
  { value: 'error',         label: 'Error' },
] as const satisfies ReadonlyArray<{ value: FilterValue; label: string }>;

export function AppsPage() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const spaceFilter = searchParams.get('space');

  const [apps, setApps] = useState<App[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [search, setSearch] = useState('');

  function startAppCreation() {
    nav('/apps/new');
  }

  async function refresh() {
    setLoading(true);
    try {
      const [aRes, sRes] = await Promise.allSettled([
        api<{ apps: App[] }>('/v1/apps'),
        api<{ spaces: Space[] }>('/v1/spaces'),
      ]);
      if (aRes.status === 'fulfilled') setApps(aRes.value.apps ?? []);
      if (sRes.status === 'fulfilled') setSpaces(sRes.value.spaces ?? []);
    } finally { setLoading(false); }
  }

  useEffect(() => {
    const ws = wsStore.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    return apps.filter((a) => {
      if (spaceFilter && a.spaceId !== spaceFilter) return false;
      if (filter !== 'all' && a.status !== filter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return a.name.toLowerCase().includes(q);
      }
      return true;
    });
  }, [apps, filter, search, spaceFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, App[]>();
    for (const a of filtered) {
      const k = a.spaceId ?? '__ungrouped__';
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(a);
    }
    return map;
  }, [filtered]);

  const total = apps.length;

  if (loading && total === 0) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton width={120} height={28} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton height={120} /><Skeleton height={120} /><Skeleton height={120} />
        </div>
      </div>
    );
  }

  const activeSpaceName = spaceFilter ? spaces.find((s) => s.id === spaceFilter)?.name : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        <div>
          <h1 className="text-display text-text-primary">{activeSpaceName ? `${activeSpaceName} apps` : 'Apps'}</h1>
          <div className="mt-0.5 text-[12px] text-text-muted">Your deployed AI applications</div>
        </div>
        <div className="ml-auto">
          <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={startAppCreation}>
            New app
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-3">
        <FilterBar options={FILTERS} value={filter} onChange={setFilter} />
        <div className="ml-auto w-full sm:w-72">
          <SearchInput value={search} onChange={setSearch} placeholder="Search apps…" bindSlashShortcut />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {filtered.length === 0 ? (
          total === 0 ? (
            <EmptyState
              icon={<AppWindow size={48} />}
              title="No apps yet"
              body="Create the first app for this workspace."
              primaryAction={<Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={startAppCreation}>New app</Button>}
              variant="page"
            />
          ) : (
            <EmptyState
              icon={<SearchX size={48} />}
              title="No matching apps"
              body="Try adjusting your search or filters."
              primaryAction={<Button variant="secondary" size="sm" onClick={() => { setSearch(''); setFilter('all'); }}>Clear filters</Button>}
              variant="page"
            />
          )
        ) : (
          spaceFilter ? (
            // Single-space view: just a grid
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((a) => <AppCard key={a.id} a={a} onOpen={() => nav(`/apps/${a.slug}`)} />)}
            </div>
          ) : (
            Array.from(grouped.entries()).map(([spaceKey, list]) => {
              const space = spaces.find((s) => s.id === spaceKey);
              const groupLabel = space?.name ?? (spaceKey === '__ungrouped__' ? 'Ungrouped' : 'Other');
              return (
                <div key={spaceKey} className="mb-8 last:mb-0">
                  <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    {groupLabel} <span className="ml-1 font-normal normal-case tracking-normal">· {list.length}</span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {list.map((a) => <AppCard key={a.id} a={a} onOpen={() => nav(`/apps/${a.slug}`)} />)}
                  </div>
                </div>
              );
            })
          )
        )}
      </div>

    </div>
  );
}

function AppCard({ a, onOpen }: { a: App; onOpen: () => void }) {
  const setupNeeded = a.status === 'setup_needed';
  const displayStatus = appDisplayStatus(a);
  return (
    <div
      onClick={onOpen}
      className="cursor-pointer rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2"
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-card text-[16px] font-bold"
          style={{
            backgroundColor: a.iconColor ?? 'var(--tw-color-surface-2, #15171c)',
            color: 'var(--tw-color-text-primary, #e8eaee)',
          }}
        >
          {a.iconUrl ? <img src={a.iconUrl} alt="" className="h-full w-full object-cover" /> : (a.iconGlyph ?? '◈')}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-subheading text-text-primary">{a.name}</span>
            <StatusBadge status={displayStatus.status} label={displayStatus.label} size="sm" />
          </div>
          {a.description ? (
            <p className="mt-0.5 line-clamp-2 text-[12px] text-text-secondary">{a.description}</p>
          ) : (
            <div className="mt-0.5 text-[11px] text-text-muted italic">Add a description →</div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
            {a.version && <span>v{a.version}</span>}
            {a.category && <span>{a.category}</span>}
          </div>
        </div>
      </div>
      <div className="mt-3 border-t border-line/60 pt-3">
        {setupNeeded ? (
          <>
            <div className="text-[12px] text-warn">{a.setupBlocker ?? 'Setup needed to start using this app'}</div>
            <Button variant="primary" size="sm" className="mt-2 w-full">Continue setup</Button>
          </>
        ) : (
          <>
            {a.primaryMetric ? (
              <div>
                <div className="text-display text-text-primary">{a.primaryMetric.value}</div>
                <div className="text-[11px] text-text-muted">
                  {a.primaryMetric.label}{a.primaryMetric.window ? ` · ${a.primaryMetric.window}` : ''}
                </div>
              </div>
            ) : (
              <div className="text-[12px] text-text-muted">No metrics yet</div>
            )}
            <Button variant="secondary" size="sm" iconRight={<ArrowRight size={12} />} className="mt-2 w-full">Open</Button>
          </>
        )}
      </div>
    </div>
  );
}

function appDisplayStatus(app: App): { status: string; label: string } {
  if (app.status === 'setup_needed') return { status: 'setup_needed', label: 'Setup needed' };
  if (app.status === 'paused') return { status: 'paused', label: 'Paused' };
  if (app.status === 'error' || app.deployStatus === 'error') return { status: 'error', label: 'Error' };
  if (app.deployStatus === 'running') return { status: 'live', label: 'Live' };
  return { status: 'stopped', label: 'Stopped' };
}
