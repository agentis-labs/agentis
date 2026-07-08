

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Database, Download, Trash2, Bot, ArrowRight, Cpu, RefreshCw } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, apiErrorMessage } from '../../lib/api';
import { useRealtime } from '../../lib/realtime';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { useAgentisStore } from '../../store/agentisStore';

interface Storage { engine: string; location: string; path: string | null; sizeBytes: number; ownedBy: string }
interface Counts { memories: number; knowledge: number; notes: number; agents: number }
interface Provenance { source: string; label: string; count: number }
interface RecentMemory { id: string; title: string; type: string; source: string; sourceLabel: string; agentId: string | null; createdAt: string }
interface OwnedAgent { id: string; name: string; adapterType: string; runtimeModel: string | null; avatarGlyph: string | null; colorHex: string | null; memories: number }
interface Overview { storage: Storage; counts: Counts; provenance: Provenance[]; recent: RecentMemory[]; agents: OwnedAgent[] }

function formatBytes(bytes: number): string {
  if (!bytes) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return 'a minute ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function runtimeLabel(adapterType: string): string {
  const map: Record<string, string> = {
    claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor', hermes: 'Hermes',
    antigravity: 'Antigravity', openclaw: 'OpenClaw', http: 'HTTP',
  };
  return map[adapterType] ?? adapterType.replace(/_/g, ' ');
}

export function DataOwnershipPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  const closeSettings = useAgentisStore((s) => s.closeSettings);

  const load = useCallback(() => {
    api<Overview>('/v1/sovereignty/overview')
      .then((res) => { setData(res); setError(null); })
      .catch((e) => setError(apiErrorMessage(e)));
  }, []);

  useEffect(() => { load(); }, [load]);
  // The Brain is cared for continuously as you work — reflect that live.
  useRealtime(
    [REALTIME_EVENTS.AGENT_CREATED, REALTIME_EVENTS.AGENT_UPDATED, REALTIME_EVENTS.AGENT_STATUS_CHANGED, REALTIME_EVENTS.HARNESS_IMPORT_UPDATES],
    load,
  );

  async function exportAll() {
    setExporting(true);
    try {
      const doc = await api('/v1/sovereignty/export');
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `agentis-your-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Your data was downloaded', 'An open, re-importable copy — it never left your machine.');
    } catch (e) {
      toast.error('Export failed', apiErrorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  async function forget(item: RecentMemory) {
    const ok = await confirm({
      title: `Forget “${item.title}??`,
      body: 'This permanently deletes it from your Brain and excludes it from all future recall. It cannot be undone.',
      confirmLabel: 'Forget it',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/v1/sovereignty/memory/${item.id}`, { method: 'DELETE' });
      setData((prev) => prev && {
        ...prev,
        recent: prev.recent.filter((r) => r.id !== item.id),
        counts: { ...prev.counts, memories: Math.max(0, prev.counts.memories - 1) },
      });
      toast.success('Forgotten', 'It is gone from your Brain.');
    } catch (e) {
      toast.error('Could not forget', apiErrorMessage(e));
    }
  }

  if (error && !data) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-[13px] text-danger">{error}</p>
        <button onClick={load} className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-3 text-[12px] text-text-secondary hover:text-text-primary">
          <RefreshCw size={12} /> Retry
        </button>
      </div>
    );
  }

  const maxProvenance = data ? Math.max(1, ...data.provenance.map((p) => p.count)) : 1;

  return (
    <div className="space-y-6">
      <p className="-mt-3 text-[13px] text-text-secondary">
        Everything Agentis remembers for you — owned by you, kept on your machine, yours to take or erase.
      </p>

      {/* Ownership hero — the emotional core */}
      <section className="rounded-card border border-line bg-surface-2 p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
              <ShieldCheck size={20} />
            </div>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold text-text-primary">Stored on your machine</div>
              <p className="mt-1 max-w-md text-[13px] leading-relaxed text-text-secondary">
                Agentis is open source and local-first. Your knowledge lives in a single database file that
                you own — nothing in it is sent anywhere unless you send it.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-muted">
                <Database size={12} className="shrink-0" />
                <span className="truncate font-mono">{data?.storage.path ?? '…'}</span>
                {data && (
                  <>
                    <span className="opacity-40">·</span>
                    <span className="tabular-nums">{formatBytes(data.storage.sizeBytes)}</span>
                    <span className="opacity-40">·</span>
                    <span>SQLite, local</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-col items-stretch gap-1.5">
            <button
              type="button"
              onClick={exportAll}
              disabled={exporting || !data}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-btn bg-accent px-3.5 text-[13px] font-semibold text-canvas transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              <Download size={14} />
              {exporting ? 'Preparing…' : 'Download everything'}
            </button>
            <span className="text-center text-[11px] text-text-muted">Open format · re-importable</span>
          </div>
        </div>
      </section>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile value={data?.counts.memories} label="Memories" />
        <StatTile value={data?.counts.knowledge} label="Knowledge" />
        <StatTile value={data?.counts.notes} label="Notes" />
        <StatTile value={data?.counts.agents} label="Agents" />
      </div>

      {/* Where it comes from */}
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Where it comes from</h3>
        <div className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-4">
          {(data?.provenance ?? []).map((p) => (
            <div key={p.source}>
              <div className="mb-1 flex items-center justify-between text-[12px]">
                <span className="text-text-secondary">{p.label}</span>
                <span className="tabular-nums text-text-muted">{p.count}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-accent/70" style={{ width: `${Math.max(4, (p.count / maxProvenance) * 100)}%` }} />
              </div>
            </div>
          ))}
          {data && data.provenance.length === 0 && (
            <p className="py-4 text-center text-[12px] text-text-muted">No memory sources yet.</p>
          )}
          {!data && <div className="h-24 animate-pulse rounded-md bg-surface-2" />}
        </div>
      </section>

      {/* Continuously remembered */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
            Continuously remembered
          </h3>
          <span className="text-[11px] normal-case text-text-muted">Captured as you work</span>
        </div>
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          {(data?.recent ?? []).map((item) => (
            <li key={item.id} className="group flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-text-primary">{item.title}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-muted">
                  <span className="rounded-full bg-surface-2 px-1.5 py-0.5">{item.sourceLabel}</span>
                  <span>{relativeTime(item.createdAt)}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => forget(item)}
                title="Forget this memory"
                aria-label={`Forget ${item.title}`}
                className="shrink-0 rounded-btn p-1.5 text-text-muted opacity-0 transition-all hover:bg-danger-soft hover:text-danger focus:opacity-100 group-hover:opacity-100"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
          {data && data.recent.length === 0 && (
            <li className="px-4 py-6 text-center text-[12px] text-text-muted">
              Nothing remembered yet. As you work with your agents, durable knowledge lands here automatically.
            </li>
          )}
          {!data && [0, 1, 2].map((i) => (
            <li key={i} className="px-4 py-2.5">
              <div className="h-3 w-2/3 animate-pulse rounded bg-surface-2" />
              <div className="mt-1.5 h-2.5 w-1/3 animate-pulse rounded bg-surface-2" />
            </li>
          ))}
        </ul>
      </section>

      {/* Own your agents */}
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Your agents are yours</h3>
        <p className="mt-1.5 text-[13px] text-text-secondary">
          An agent’s brain and full state belong to you. Change the runtime underneath — keep the brain.
        </p>
        {data && data.agents.length > 0 ? (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => { closeSettings(); nav(`/agents/${agent.id}`); }}
                className="group flex flex-col gap-3 rounded-card border border-line bg-surface p-4 text-left transition-colors hover:border-line-strong"
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-canvas"
                    style={{ backgroundColor: agent.colorHex ?? 'var(--color-accent, #6366f1)' }}
                  >
                    {agent.avatarGlyph ?? agent.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">{agent.name}</span>
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
                  <Cpu size={12} className="shrink-0" />
                  <span className="truncate">
                    {runtimeLabel(agent.adapterType)}{agent.runtimeModel ? ` · ${agent.runtimeModel}` : ''}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-line pt-2.5 text-[11px]">
                  <span className="text-text-secondary">
                    <span className="tabular-nums font-medium text-text-primary">{agent.memories}</span> {agent.memories === 1 ? 'memory' : 'memories'} · portable
                  </span>
                  <ArrowRight size={12} className="text-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-text-primary" />
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-3 rounded-card border border-dashed border-line bg-surface px-4 py-8 text-center">
            <Bot size={20} className="mx-auto text-text-muted" />
            <p className="mt-2 text-[13px] text-text-secondary">No agents yet.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function StatTile({ value, label }: { value?: number; label: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <div className="text-[24px] font-semibold tabular-nums text-text-primary">
        {value === undefined ? <span className="text-text-muted">—</span> : value.toLocaleString()}
      </div>
      <div className="mt-0.5 text-[12px] text-text-muted">{label}</div>
    </div>
  );
}


