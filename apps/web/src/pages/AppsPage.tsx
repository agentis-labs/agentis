/**
 * AppsPage — compact app cards grouped by space.
 *
 * Replaces the gigantic-card layout with a clean grid showing:
 * status, version, primary metric (from outputLabels[0]), single CTA.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AppWindow, ArrowRight, SearchX, Plus, Sparkles, X } from 'lucide-react';
import { api, workspace as wsStore } from '../lib/api';
import { rtSubscribe } from '../lib/realtime';
import { Button } from '../components/shared/Button';
import { SearchInput } from '../components/shared/SearchInput';
import { FilterBar } from '../components/shared/FilterBar';
import { Skeleton } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';
import { StatusBadge } from '../components/shared/StatusBadge';
import { useToast } from '../components/shared/Toast';

interface App {
  id: string;
  slug: string;
  name: string;
  version?: string;
  status?: 'active' | 'paused' | 'setup_needed' | 'error';
  spaceId?: string;
  spaceName?: string;
  primaryMetric?: { label: string; value: string | number; window?: string };
  setupBlocker?: string;
  iconGlyph?: string;
  iconColor?: string;
  description?: string;
  category?: string;
}

interface Space { id: string; name: string; }

type FilterValue = 'all' | 'active' | 'setup_needed' | 'paused' | 'error';

const FILTERS = [
  { value: 'all',           label: 'All' },
  { value: 'active',        label: 'Active' },
  { value: 'setup_needed',  label: 'Setup needed' },
  { value: 'paused',        label: 'Paused' },
  { value: 'error',         label: 'Error' },
] as const satisfies ReadonlyArray<{ value: FilterValue; label: string }>;

export function AppsPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const spaceFilter = searchParams.get('space');

  const [apps, setApps] = useState<App[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

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
          <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setCreating(true)}>
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
              primaryAction={<Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setCreating(true)}>New app</Button>}
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

      <GuidedAppCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(path) => {
          setCreating(false);
          toast.success('App created');
          nav(path);
        }}
      />
    </div>
  );
}

function AppCard({ a, onOpen }: { a: App; onOpen: () => void }) {
  const setupNeeded = a.status === 'setup_needed';
  return (
    <div
      onClick={onOpen}
      className="cursor-pointer rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2"
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card text-[16px] font-bold"
          style={{
            backgroundColor: a.iconColor ?? 'var(--tw-color-surface-2, #15171c)',
            color: 'var(--tw-color-text-primary, #e8eaee)',
          }}
        >
          {a.iconGlyph ?? '◈'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-subheading text-text-primary">{a.name}</span>
            <StatusBadge status={a.status ?? 'idle'} size="sm" />
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

type GuidedAppKind = 'automation' | 'assistant' | 'research' | 'support' | 'sales' | 'operations' | 'custom';

const APP_KIND_OPTIONS: Array<{ value: GuidedAppKind; label: string; description: string }> = [
  { value: 'automation', label: 'Automation', description: 'Runs a repeatable workflow' },
  { value: 'assistant', label: 'Assistant', description: 'Helps an operator decide or draft' },
  { value: 'research', label: 'Research', description: 'Reads, compares, and summarizes' },
  { value: 'support', label: 'Support', description: 'Handles tickets or requests' },
  { value: 'sales', label: 'Sales', description: 'Qualifies leads or moves deals' },
  { value: 'operations', label: 'Operations', description: 'Coordinates internal work' },
  { value: 'custom', label: 'Custom', description: 'Something more specific' },
];

function GuidedAppCreateDialog({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (path: string) => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [goal, setGoal] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [coverImage, setCoverImage] = useState('');
  const [appKind, setAppKind] = useState<GuidedAppKind>('automation');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setGoal('');
    setName('');
    setDescription('');
    setCoverImage('');
    setAppKind('automation');
    setBusy(false);
  }, [open]);

  if (!open) return null;

  const canContinue = goal.trim().length > 0 && name.trim().length > 0 && description.trim().length > 0;

  async function createApp() {
    if (!canContinue || busy) return;
    setBusy(true);
    try {
      const created = await api<{ app: { slug: string; path?: string } }>('/v1/apps', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          goal: goal.trim(),
          appKind,
          coverImage: coverImage.trim() || undefined,
        }),
      });
      onCreated(created.app.path ?? `/apps/${created.app.slug}?layer=canvas&new=1`);
    } catch (e) {
      toast.error('Could not create app', String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="animate-scale-in w-full max-w-2xl overflow-hidden rounded-modal border border-line bg-surface shadow-modal">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-heading text-text-primary">New app</h2>
            <div className="mt-0.5 text-[12px] text-text-muted">Step {step} of 2</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>

        {step === 1 ? (
          <div className="space-y-4 px-5 py-5">
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-text-secondary">What does it do?</span>
              <textarea
                autoFocus
                rows={4}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="Example: qualify inbound leads, enrich them from CRM data, and prepare a handoff summary."
                className="w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-[12px] font-medium text-text-secondary">Name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Lead qualification app"
                  className="h-9 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[12px] font-medium text-text-secondary">Cover image URL</span>
                <input
                  type="url"
                  value={coverImage}
                  onChange={(e) => setCoverImage(e.target.value)}
                  placeholder="Optional"
                  className="h-9 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                />
              </label>
            </div>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-text-secondary">One-line description</span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={140}
                placeholder="Qualifies inbound leads and prepares sales handoffs."
                className="h-9 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </label>
          </div>
        ) : (
          <div className="px-5 py-5">
            <div className="mb-3 text-[12px] font-medium text-text-secondary">What kind of app is it?</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {APP_KIND_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setAppKind(option.value)}
                  className={`rounded-card border px-3 py-3 text-left transition-colors ${appKind === option.value ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2 hover:border-line-strong'}`}
                >
                  <span className="flex items-center gap-2 text-[13px] font-semibold text-text-primary">
                    <Sparkles size={13} className={appKind === option.value ? 'text-accent' : 'text-text-muted'} />
                    {option.label}
                  </span>
                  <span className="mt-1 block text-[11px] text-text-muted">{option.description}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <footer className="flex items-center justify-between border-t border-line bg-surface-2 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={step === 1 ? onClose : () => setStep(1)}>
            {step === 1 ? 'Cancel' : 'Back'}
          </Button>
          {step === 1 ? (
            <Button variant="primary" size="sm" onClick={() => setStep(2)} disabled={!canContinue}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => void createApp()} disabled={!canContinue || busy}>
              {busy ? 'Creating...' : 'Create app'}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
