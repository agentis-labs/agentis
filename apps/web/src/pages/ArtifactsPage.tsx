/**
 * AssetsPage — the workspace asset library (Assets 10x).
 *
 * Every structured output an agent, app, or workflow produces lands here:
 * screenshots, generated docs, code, data exports, HTML. Browsed on two clearly
 * separated axes — Source on the left rail (what generated it) × Type along the
 * top — with search. Reachable from the sidebar (route `/assets`, legacy alias
 * `/artifacts`). Opens artifacts in the shared ArtifactPanel.
 *
 * Note: the asset *type* set is fixed by the `artifacts.type` DB enum
 * (html | image | document | code | data) — every producer maps into one of these.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Frame, FileText, Image as ImageIcon, Code2, Database, Globe, Trash2, Search,
  Bot, LayoutGrid, Workflow as WorkflowIcon, MessagesSquare, Hand,
  FileType2, Sheet, Music, Video, Archive, type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, apiCached, peekCached } from '../lib/api';
import { useAssetUrl } from '../lib/useAssetUrl';
import { useRealtime } from '../lib/realtime';
import { ArtifactPanel } from '../components/ArtifactPanel/ArtifactPanel';
import type { Artifact, ArtifactOrigin, ArtifactType } from '../components/ArtifactPanel/types';

const TYPE_ICONS: Record<ArtifactType, LucideIcon> = {
  image: ImageIcon,
  document: FileText,
  pdf: FileType2,
  spreadsheet: Sheet,
  data: Database,
  code: Code2,
  html: Globe,
  audio: Music,
  video: Video,
  archive: Archive,
};

// Order types by how commonly they're produced, not alphabetically.
const TYPE_ORDER: ArtifactType[] = ['image', 'document', 'pdf', 'spreadsheet', 'data', 'code', 'html', 'audio', 'video', 'archive'];

const TYPE_LABELS: Record<ArtifactType, string> = {
  image: 'Images',
  document: 'Docs',
  pdf: 'PDF',
  spreadsheet: 'Sheets',
  data: 'Data',
  code: 'Code',
  html: 'HTML',
  audio: 'Audio',
  video: 'Video',
  archive: 'Archives',
};

const TYPE_FILTERS: Array<{ id: 'all' | ArtifactType; label: string; icon: LucideIcon }> = [
  { id: 'all', label: 'All', icon: Frame },
  ...TYPE_ORDER.map((id) => ({ id, label: TYPE_LABELS[id], icon: TYPE_ICONS[id] })),
];

const ORIGIN_META: Record<ArtifactOrigin, { label: string; plural: string; icon: LucideIcon }> = {
  agent: { label: 'Agent', plural: 'Agents', icon: Bot },
  app: { label: 'App', plural: 'Apps', icon: LayoutGrid },
  workflow: { label: 'Workflow', plural: 'Workflows', icon: WorkflowIcon },
  channel: { label: 'Channel', plural: 'Channels', icon: MessagesSquare },
  manual: { label: 'Manual', plural: 'Manual', icon: Hand },
};

// Workflows live inside Apps, so their outputs are attributed to Apps — there is
// no separate "Workflows" source. `normOrigin` folds the legacy workflow origin.
const ORIGIN_ORDER: ArtifactOrigin[] = ['agent', 'app', 'channel', 'manual'];

function normOrigin(a: Artifact): ArtifactOrigin {
  const o = (a.origin ?? 'manual') as ArtifactOrigin;
  return o === 'workflow' ? 'app' : o;
}

export function ArtifactsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const ARTIFACTS_PATH = '/v1/artifacts?limit=200';
  const [artifacts, setArtifacts] = useState<Artifact[]>(() => peekCached<{ artifacts: Artifact[] }>(ARTIFACTS_PATH)?.artifacts ?? []);
  const [typeFilter, setTypeFilter] = useState<'all' | ArtifactType>('all');
  const [originFilter, setOriginFilter] = useState<'all' | ArtifactOrigin>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [loading, setLoading] = useState(() => peekCached(ARTIFACTS_PATH) === undefined);

  async function refresh() {
    if (peekCached(ARTIFACTS_PATH) === undefined) setLoading(true);
    try {
      const res = await apiCached<{ artifacts: Artifact[] }>(ARTIFACTS_PATH);
      setArtifacts(res.artifacts ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Resolve producer ids → names so every asset can be labelled with the specific
  // agent/app that generated it (not just the origin type).
  const [sourceNames, setSourceNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    void (async () => {
      const [ag, ap] = await Promise.all([
        apiCached<{ agents: Array<{ id: string; name: string }> }>('/v1/agents').catch(() => ({ agents: [] })),
        apiCached<{ data: Array<{ id: string; name: string }> }>('/v1/apps').catch(() => ({ data: [] })),
      ]);
      const map = new Map<string, string>();
      for (const a of ag.agents ?? []) map.set(a.id, a.name);
      for (const a of ap.data ?? []) map.set(a.id, a.name);
      setSourceNames(map);
    })();
  }, []);

  const nameFor = useCallback((a: Artifact): string | null => {
    if (a.appId && sourceNames.get(a.appId)) return sourceNames.get(a.appId)!;
    if (a.agentId && sourceNames.get(a.agentId)) return sourceNames.get(a.agentId)!;
    return null;
  }, [sourceNames]);

  useEffect(() => {
    const openId = searchParams.get('open');
    if (!openId || artifacts.length === 0) return;
    const artifact = artifacts.find((item) => item.id === openId);
    if (artifact && selected?.id !== artifact.id) setSelected(artifact);
  }, [artifacts, searchParams, selected?.id]);

  useRealtime(
    [REALTIME_EVENTS.ARTIFACT_CREATED, REALTIME_EVENTS.ARTIFACT_UPDATED, REALTIME_EVENTS.ARTIFACT_DELETED],
    () => void refresh(),
  );

  // Type + search constrain the working set; Source then filters within it. Source
  // counts are computed off the type-filtered set so the rail reflects what's shown.
  const typeMatched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return artifacts.filter((a) => {
      if (typeFilter !== 'all' && a.type !== typeFilter) return false;
      if (q && !a.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [artifacts, typeFilter, query]);

  const sourceCounts = useMemo(() => {
    const counts = new Map<ArtifactOrigin, number>();
    for (const a of typeMatched) {
      const o = normOrigin(a);
      counts.set(o, (counts.get(o) ?? 0) + 1);
    }
    return counts;
  }, [typeMatched]);

  const filtered = useMemo(
    () => (originFilter === 'all' ? typeMatched : typeMatched.filter((a) => normOrigin(a) === originFilter)),
    [typeMatched, originFilter],
  );

  // When no specific source is selected, group into per-source sections so the
  // library reads as "what each producer has made".
  const groups = useMemo(() => {
    if (originFilter !== 'all') return null;
    const byOrigin = new Map<ArtifactOrigin, Artifact[]>();
    for (const a of filtered) {
      const origin = normOrigin(a);
      const bucket = byOrigin.get(origin) ?? [];
      bucket.push(a);
      byOrigin.set(origin, bucket);
    }
    return ORIGIN_ORDER.filter((o) => byOrigin.has(o)).map((o) => ({ origin: o, items: byOrigin.get(o)! }));
  }, [filtered, originFilter]);

  async function deleteArtifact(id: string) {
    if (!confirm('Delete this artifact?')) return;
    try {
      await api(`/v1/artifacts/${id}`, { method: 'DELETE' });
      setArtifacts((prev) => prev.filter((a) => a.id !== id));
      if (selected?.id === id) setSelected(null);
    } catch {
      
    }
  }

  function open(a: Artifact) {
    setSelected(a);
    setSearchParams({ open: a.id });
  }

  const sourceRail: Array<{ id: 'all' | ArtifactOrigin; label: string; icon: LucideIcon; count: number }> = [
    { id: 'all', label: 'All sources', icon: Frame, count: typeMatched.length },
    ...ORIGIN_ORDER.map((id) => ({ id, label: ORIGIN_META[id].plural, icon: ORIGIN_META[id].icon, count: sourceCounts.get(id) ?? 0 })),
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
        <div>
          <h1 className="text-base font-medium text-text">Assets</h1>
          <p className="text-[11px] text-text-muted">
            Everything your agents, apps, and workflows produce — screenshots, docs, code, and data.
          </p>
        </div>
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search assets…"
            className="w-56 rounded-md border border-line bg-surface-2 py-1.5 pl-8 pr-2 text-[12px] text-text placeholder:text-text-muted focus:border-accent/50 focus:outline-none"
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Source axis — vertical rail. */}
        <aside className="w-48 shrink-0 overflow-y-auto border-r border-line p-3">
          <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Source</div>
          <div className="flex flex-col gap-0.5">
            {sourceRail.map((s) => {
              const Icon = s.icon;
              const active = originFilter === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setOriginFilter(s.id)}
                  className={clsx(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition',
                    active ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-surface-2 hover:text-text',
                  )}
                >
                  <Icon size={13} className="shrink-0" />
                  <span className="flex-1 truncate text-left">{s.label}</span>
                  <span className={clsx('text-[10px] tabular-nums', active ? 'text-accent' : 'text-text-muted')}>{s.count}</span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Type axis — top tabs — then the grid. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-line px-6 py-2">
            {TYPE_FILTERS.map((f) => {
              const Icon = f.icon;
              const active = typeFilter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setTypeFilter(f.id)}
                  className={clsx(
                    'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition',
                    active ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-surface-2 hover:text-text',
                  )}
                >
                  <Icon size={12} />
                  {f.label}
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {loading ? (
              <div className="text-center text-[12px] text-text-muted">Loading…</div>
            ) : filtered.length === 0 ? (
              <EmptyState searching={query.trim().length > 0 || typeFilter !== 'all' || originFilter !== 'all'} />
            ) : groups ? (
              <div className="flex flex-col gap-8">
                {groups.map(({ origin, items }) => {
                  const meta = ORIGIN_META[origin];
                  const Icon = meta.icon;
                  return (
                    <section key={origin}>
                      <div className="mb-3 flex items-center gap-2">
                        <Icon size={13} className="text-accent" />
                        <h2 className="text-[12px] font-medium text-text">{meta.plural}</h2>
                        <span className="text-[11px] text-text-muted">{items.length}</span>
                      </div>
                      <CardGrid items={items} onOpen={open} onDelete={deleteArtifact} nameFor={nameFor} />
                    </section>
                  );
                })}
              </div>
            ) : (
              <CardGrid items={filtered} onOpen={open} onDelete={deleteArtifact} nameFor={nameFor} />
            )}
          </div>
        </div>
      </div>

      {selected && (
        <ArtifactPanel
          artifact={selected}
          state="fullscreen"
          onClose={() => {
            setSelected(null);
            setSearchParams({});
          }}
        />
      )}
    </div>
  );
}

function CardGrid({
  items,
  onOpen,
  onDelete,
  nameFor,
}: {
  items: Artifact[];
  onOpen: (a: Artifact) => void;
  onDelete: (id: string) => void;
  nameFor: (a: Artifact) => string | null;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
      {items.map((a) => (
        <ArtifactCard key={a.id} artifact={a} onOpen={onOpen} onDelete={onDelete} sourceName={nameFor(a)} />
      ))}
    </div>
  );
}

function ArtifactCard({
  artifact: a,
  onOpen,
  onDelete,
  sourceName,
}: {
  artifact: Artifact;
  onOpen: (a: Artifact) => void;
  onDelete: (id: string) => void;
  sourceName: string | null;
}) {
  const Icon = TYPE_ICONS[a.type] ?? Frame;
  const asset = useAssetUrl(a.type === 'image' ? a : null, { thumbnail: true });
  const preview = a.thumbnailUrl ?? (a.type === 'image' ? asset.url : null);
  return (
    <div className="group flex flex-col overflow-hidden rounded-lg border border-line bg-surface transition hover:border-accent/40 hover:shadow-lg">
      <button
        type="button"
        onClick={() => onOpen(a)}
        // Fixed-height window: tall assets show their TOP edge (object-top), with a
        // bottom fade hinting there's more to see when opened.
        className="relative block h-40 w-full overflow-hidden bg-surface-2"
        title={a.title}
      >
        {preview ? (
          <>
            <img src={preview} alt={a.title} className="absolute inset-0 h-full w-full object-cover object-top" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface/95 to-transparent" />
          </>
        ) : (
          <span className="flex h-full w-full items-center justify-center text-text-muted transition group-hover:text-accent">
            <Icon size={26} />
          </span>
        )}
      </button>
      <div className="flex items-start justify-between gap-1.5 p-2.5">
        <button type="button" onClick={() => onOpen(a)} className="min-w-0 flex-1 text-left">
          <div className="truncate text-[11px] font-medium text-text">{a.title}</div>
          <div className="mt-0.5 text-[9px] uppercase tracking-wider text-text-muted">
            {a.type} · {new Date(a.createdAt).toLocaleDateString()}
          </div>
          {(() => {
            const OriginIcon = ORIGIN_META[normOrigin(a)].icon;
            const label = sourceName ?? ORIGIN_META[normOrigin(a)].label;
            return (
              <div className="mt-1 flex items-center gap-1 text-[10px] text-text-muted" title={`Generated by ${label}`}>
                <OriginIcon size={10} className="shrink-0" />
                <span className="truncate">{label}</span>
              </div>
            );
          })()}
        </button>
        <button
          type="button"
          onClick={() => onDelete(a.id)}
          className="shrink-0 text-text-muted opacity-0 transition group-hover:opacity-100 hover:text-status-error"
          aria-label="Delete asset"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}

function EmptyState({ searching }: { searching: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface-2 text-accent">
        <Frame size={20} />
      </div>
      <p className="text-[12px] text-text-muted">
        {searching
          ? 'No assets match these filters.'
          : 'No assets yet. Ask an agent for a screenshot, or run a workflow that saves output.'}
      </p>
    </div>
  );
}



