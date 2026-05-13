/**
 * BrainView — embeddable Brain UX surface.
 *
 * Spec: docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §6.3, §8, §15.
 *
 * Shape:
 *   - Top: stat rail + mode switcher (Map / Flow / Ledger) + filters.
 *   - Stage: switches between BrainStage / BrainFlowMode / BrainLedgerMode.
 *   - Right rail: BrainDetailRail (selection-aware).
 *
 * Two scopes, same component:
 *   - App scope:   pass `slug` → fetches /v1/apps/:slug/brain
 *   - Workspace:   pass slug=null → fetches /v1/brain (Global Brain)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, AlertTriangle, CircleDashed } from 'lucide-react';
import { REALTIME_EVENTS, type BrainGraph, type BrainNode, type BrainResponse } from '@agentis/core';
import { api } from '../../lib/api';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';
import { BrainStage } from './BrainStage';
import { BrainFlowMode } from './BrainFlowMode';
import { BrainLedgerMode } from './BrainLedgerMode';
import { BrainDetailRail } from './BrainDetailRail';
import { EmptyBrainStage } from './EmptyBrainStage';
import { graphToBrainNodes } from './brainGraphAdapter';

type Mode = 'map' | 'flow' | 'ledger';
type LayerFilter = 'all' | 'knowledge' | 'memory' | 'judgment';

interface BrainViewProps {
  /** When set, loads /v1/apps/:slug/brain. When null, loads /v1/brain (global). */
  slug: string | null;
  onManage?: () => void;
}

export function BrainView({ slug, onManage }: BrainViewProps) {
  const [data, setData] = useState<BrainResponse | null>(null);
  const [graph, setGraph] = useState<BrainGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>('map');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [layerFilter, setLayerFilter] = useState<LayerFilter>('all');
  const [showWarnings, setShowWarnings] = useState(true);
  const [showGaps, setShowGaps] = useState(true);
  const [livePulse, setLivePulse] = useState(0);
  const toast = useToast();

  const brainUrl = slug ? `/v1/apps/${slug}/brain` : `/v1/brain`;
  const graphUrl = slug ? `/v1/apps/${slug}/brain/graph` : `/v1/brain/graph`;

  const reloadGraph = useCallback(() => {
    void api<{ graph: BrainGraph }>(graphUrl)
      .then((response) => setGraph(response.graph))
      .catch(() => {});
  }, [graphUrl]);

  useEffect(() => {
    setLoading(true);
    setSelectedId(null);
    setGraph(null);
    void Promise.all([
      api<BrainResponse>(brainUrl),
      api<{ graph: BrainGraph }>(graphUrl),
    ])
      .then(([brain, graphResponse]) => {
        setData(brain);
        setGraph(graphResponse.graph);
      })
      .catch((e) => toast.error('Failed to load Brain', String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brainUrl, graphUrl]);

  useEffect(() => rtSubscribe('workspace', {}), []);

  useRealtime([
    REALTIME_EVENTS.BRAIN_ATOM_CREATED,
    REALTIME_EVENTS.BRAIN_ATOM_REINFORCED,
    REALTIME_EVENTS.BRAIN_LINK_CREATED,
  ], (env) => {
    const payload = env.payload as { appId?: string | null } | null;
    if (slug && graph?.meta.appId && payload?.appId && payload.appId !== graph.meta.appId) return;
    setLivePulse((value) => value + 1);
    reloadGraph();
  });

  const graphNodes = useMemo<BrainNode[]>(() => graph ? graphToBrainNodes(graph) : [], [graph]);

  const allNodes = useMemo<BrainNode[]>(() => {
    if (graphNodes.length > 1) return graphNodes;
    return data
      ? [
          ...data.layers.core,
          ...data.layers.knowledge,
          ...data.layers.memory,
          ...data.layers.judgment,
        ]
      : [];
  }, [data, graphNodes]);

  // Search-driven selection (§17.4): selecting from the search box
  // navigates+focuses the matching node rather than opening a separate table.
  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return allNodes
      .filter((n) =>
        n.label.toLowerCase().includes(q) ||
        (n.description ?? '').toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [search, allNodes]);

  const selectedNode = useMemo<BrainNode | null>(
    () => allNodes.find((n) => n.id === selectedId) ?? null,
    [allNodes, selectedId],
  );
  const isEmptyBrain = data
    ? data.layers.knowledge.length === 0 && data.layers.memory.length === 0 && data.layers.judgment.length === 0
    : false;

  if (loading) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={28} width={300} />
        <Skeleton height={500} />
      </div>
    );
  }
  if (!data) {
    return <div className="p-8 text-[14px] text-text-muted">Could not load Brain.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Stat rail + mode switcher */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-3">
        <Stat label="Knowledge" value={data.stats.knowledgeNodes} />
        <Stat label="Memory" value={data.stats.memoryNodes} />
        <Stat label="Evaluators+Baselines" value={data.stats.evaluatorNodes} />
        <Stat
          label="Baseline"
          value={
            data.stats.baselineConfidence != null
              ? `${Math.round(data.stats.baselineConfidence * 100)}%`
              : '—'
          }
        />
        {data.stats.staleSources > 0 && (
          <Stat label="Stale" value={data.stats.staleSources} tone="warn" />
        )}
        {graph && (
          <Stat label="Links" value={graph.meta.linkCount} tone={livePulse > 0 ? 'live' : undefined} />
        )}
        <div className="ml-auto flex items-center gap-2">
          <SearchBox
            value={search}
            onChange={setSearch}
            results={searchMatches}
            onSelect={(id) => { setSelectedId(id); setSearch(''); }}
          />
          <ModeSwitch mode={mode} onChange={setMode} />
        </div>
      </div>

      {/* Filters bar */}
      <div className="flex items-center gap-2 border-b border-line bg-surface px-5 py-2 text-[11px]">
        <span className="text-text-muted">Filters:</span>
        {(['all', 'knowledge', 'memory', 'judgment'] as const).map((l) => (
          <button
            key={l}
            onClick={() => setLayerFilter(l)}
            className={[
              'rounded-full px-2.5 py-0.5 uppercase tracking-wider transition-colors',
              layerFilter === l ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary',
            ].join(' ')}
          >
            {l}
          </button>
        ))}
        <span className="ml-2 h-3 w-px bg-line" />
        <button
          onClick={() => setShowWarnings((v) => !v)}
          className={[
            'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 transition-colors',
            showWarnings ? 'text-amber-300' : 'text-text-muted',
          ].join(' ')}
        >
          <AlertTriangle size={11} />
          Warnings
        </button>
        <button
          onClick={() => setShowGaps((v) => !v)}
          className={[
            'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 transition-colors',
            showGaps ? 'text-text-secondary' : 'text-text-muted',
          ].join(' ')}
        >
          <CircleDashed size={11} />
          Gaps
        </button>
        <Legend />
      </div>

      {/* Stage + detail rail */}
      <div className="flex flex-1 overflow-hidden">
        <div className="relative flex-1 overflow-hidden">
          {mode === 'map' && (
            isEmptyBrain ? (
              <EmptyBrainStage
                scope={slug ? 'app' : 'workspace'}
                actionLabel={slug ? 'Go to Manage' : 'Open Knowledge Hub'}
                onAction={onManage ?? (() => { window.location.href = '/knowledge'; })}
              />
            ) : (
              <BrainStage
                brain={data}
                graph={graph}
                selectedId={selectedId}
                onSelect={setSelectedId}
                filters={{ showWarnings, showGaps, layerFilter }}
                livePulse={livePulse}
              />
            )
          )}
          {mode === 'flow' && (
            <BrainFlowMode brain={data} selectedId={selectedId} onSelect={setSelectedId} />
          )}
          {mode === 'ledger' && (
            <BrainLedgerMode brain={data} selectedId={selectedId} onSelect={setSelectedId} />
          )}
        </div>
        <BrainDetailRail
          brain={data}
          node={selectedNode}
          appSlug={slug}
        />
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'warn' | 'live' }) {
  return (
    <div className="rounded-card border border-line bg-bg-base px-2.5 py-1.5">
      <div className={[
        'text-[14px] font-semibold leading-tight',
        tone === 'warn' ? 'text-amber-300' : tone === 'live' ? 'text-cyan-300' : 'text-text-primary',
      ].join(' ')}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
}

function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="inline-flex rounded-full border border-line bg-surface p-0.5 text-[11px]">
      {(['map', 'flow', 'ledger'] as const).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={[
            'rounded-full px-3 py-1 capitalize transition-colors',
            mode === m ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary',
          ].join(' ')}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function SearchBox({
  value, onChange, results, onSelect,
}: {
  value: string;
  onChange: (v: string) => void;
  results: BrainNode[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="relative">
      <div className="flex items-center gap-1.5 rounded-full border border-line bg-bg-base px-2.5 py-1">
        <Search size={11} className="text-text-muted" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search the brain"
          className="w-44 bg-transparent text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none"
        />
      </div>
      {value && results.length > 0 && (
        <div className="absolute right-0 top-full z-20 mt-1 w-72 overflow-hidden rounded-card border border-line bg-surface shadow-xl">
          {results.map((n) => (
            <button
              key={n.id}
              onClick={() => onSelect(n.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-surface-2"
            >
              <span className="text-[10px] uppercase tracking-wider text-text-muted">{n.type.replace(/_/g, ' ')}</span>
              <span className="truncate text-text-primary">{n.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Legend() {
  // Compact legend — surfaces edge color semantics so the operator can read
  // intelligence flow correctly. Hidden behind hover to avoid chrome bloat.
  return (
    <div className="ml-auto inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted">
      <Swatch color="#22d3ee" /> feeds
      <Swatch color="#a3e635" /> evaluates
      <Swatch color="#a78bfa" /> derived
      <Swatch color="#7c83ff" /> used
      <Swatch color="#f59e0b" /> measures
    </div>
  );
}
function Swatch({ color }: { color: string }) {
  return <span className="inline-block h-1 w-3 rounded-full" style={{ background: color }} />;
}
