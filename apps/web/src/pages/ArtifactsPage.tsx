/**
 * ArtifactsPage — global library of artifacts produced by workflow runs
 * (AGENTIS-UX-V2 §5.3).
 *
 * Gallery grid with type filter tabs, opens artifacts in the ArtifactPanel.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Frame, FileText, Image as ImageIcon, Code2, Database, Globe, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { REALTIME_EVENTS } from '@agentis/core';
import { api } from '../lib/api';
import { useRealtime } from '../lib/realtime';
import { ArtifactPanel } from '../components/ArtifactPanel/ArtifactPanel';
import type { Artifact, ArtifactType } from '../components/ArtifactPanel/types';

const FILTERS: Array<{ id: 'all' | ArtifactType; label: string; icon: typeof Frame }> = [
  { id: 'all', label: 'All', icon: Frame },
  { id: 'html', label: 'HTML', icon: Globe },
  { id: 'image', label: 'Images', icon: ImageIcon },
  { id: 'document', label: 'Docs', icon: FileText },
  { id: 'code', label: 'Code', icon: Code2 },
  { id: 'data', label: 'Data', icon: Database },
];

const ICONS: Record<ArtifactType, typeof Frame> = {
  html: Globe,
  image: ImageIcon,
  document: FileText,
  code: Code2,
  data: Database,
};

export function ArtifactsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [filter, setFilter] = useState<'all' | ArtifactType>('all');
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const res = await api<{ artifacts: Artifact[] }>('/v1/artifacts?limit=200');
      setArtifacts(res.artifacts ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

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

  const filtered = useMemo(
    () => (filter === 'all' ? artifacts : artifacts.filter((a) => a.type === filter)),
    [filter, artifacts],
  );

  async function deleteArtifact(id: string) {
    if (!confirm('Delete this artifact?')) return;
    try {
      await api(`/v1/artifacts/${id}`, { method: 'DELETE' });
      setArtifacts((prev) => prev.filter((a) => a.id !== id));
      if (selected?.id === id) setSelected(null);
    } catch {
      /* best-effort */
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-line px-6 py-4">
        <div>
          <h1 className="text-base font-medium text-text">Artifacts</h1>
          <p className="text-[11px] text-text-muted">
            Structured outputs produced by your workflow runs.
          </p>
        </div>
      </header>
      <div className="flex items-center gap-1 border-b border-line px-6 py-2">
        {FILTERS.map((f) => {
          const Icon = f.icon;
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={clsx(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition',
                active
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-muted hover:bg-surface-2 hover:text-text',
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
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface-2 text-accent">
              <Frame size={20} />
            </div>
            <p className="text-[12px] text-text-muted">
              No artifacts yet. Run a workflow with a Response node to create one.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((a) => {
              const Icon = ICONS[a.type] ?? Frame;
              return (
                <div
                  key={a.id}
                  className="group flex flex-col overflow-hidden rounded-lg border border-line bg-surface-1 transition hover:border-accent/40"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(a);
                      setSearchParams({ open: a.id });
                    }}
                    className="flex aspect-video w-full items-center justify-center bg-surface-2 text-text-muted transition group-hover:text-accent"
                  >
                    {a.thumbnailUrl ? (
                      <img
                        src={a.thumbnailUrl}
                        alt={a.title}
                        className="h-full w-full object-cover"
                      />
                    ) : a.type === 'image' ? (
                      <img src={a.content} alt={a.title} className="h-full w-full object-contain" />
                    ) : (
                      <Icon size={32} />
                    )}
                  </button>
                  <div className="flex items-start justify-between gap-2 p-3">
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(a);
                        setSearchParams({ open: a.id });
                      }}
                      className="flex-1 text-left"
                    >
                      <div className="text-xs font-medium text-text">{a.title}</div>
                      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-text-muted">
                        {a.type} · {new Date(a.createdAt).toLocaleDateString()}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteArtifact(a.id)}
                      className="text-text-muted opacity-0 transition group-hover:opacity-100 hover:text-status-error"
                      aria-label="Delete artifact"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
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
