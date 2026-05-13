/**
 * BrainStage — the layered Map view of the intelligence topology.
 *
 * Spec: docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §6.3, §7, §10.
 *
 * Implementation choice (§10.4): SVG, not WebGL — at the data scale of a
 * single app's intelligence (≤50 nodes typical), SVG gives crisper hover and
 * keyboard handling and reduced-motion support comes for free. Lines are
 * straight Bézier arcs from each node's polar position to its target;
 * unrelated nodes/edges dim on selection (§10.1, §17.2).
 *
 * Layout: server-side `polarHint()` puts knowledge at radius 220, memory at
 * 360, judgment at 480 with offset thetas to avoid ring collision. The core
 * sits at (0, 0). The viewport is centered around (0, 0) with pan + zoom.
 */

import { useMemo, useRef, useState } from 'react';
import type { BrainEdge, BrainGraph, BrainNode, BrainResponse } from '@agentis/core';
import { BrainNodeCard } from './BrainNodeCard';
import { graphToBrainEdges, graphToBrainNodes } from './brainGraphAdapter';

interface StageProps {
  brain: BrainResponse;
  graph?: BrainGraph | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  filters: {
    showWarnings: boolean;
    showGaps: boolean;
    layerFilter: 'all' | 'knowledge' | 'memory' | 'judgment';
  };
  livePulse?: number;
}

const STAGE_W = 1200;
const STAGE_H = 700;

export function BrainStage({ brain, graph, selectedId, onSelect, filters, livePulse = 0 }: StageProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const allNodes = useMemo<BrainNode[]>(
    () => graph && graph.nodes.length > 1
      ? graphToBrainNodes(graph)
      : [
          ...brain.layers.core,
          ...brain.layers.knowledge,
          ...brain.layers.memory,
          ...brain.layers.judgment,
        ],
    [brain.layers, graph],
  );

  const allEdges = useMemo<BrainEdge[]>(
    () => graph && graph.links.length > 0 ? graphToBrainEdges(graph) : brain.edges,
    [brain.edges, graph],
  );

  // Edge routing: for each edge, look up the source/target nodes and draw a
  // soft cubic curve between them. Edges with no resolvable endpoint are
  // dropped silently.
  const positions = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of allNodes) m.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
    return m;
  }, [allNodes]);

  // Resolve "neighbors of selected" so we can dim everything else (§10.1,
  // §17.1).
  const neighborhood = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set<string>([selectedId]);
    for (const e of allEdges) {
      if (e.source === selectedId) set.add(e.target);
      else if (e.target === selectedId) set.add(e.source);
    }
    return set;
  }, [selectedId, allEdges]);

  const dim = (id: string): boolean => {
    if (!neighborhood) return false;
    return !neighborhood.has(id);
  };

  // Apply user filters (§17.3). Returns the visible-node set so we can also
  // drop edges where one endpoint is filtered out.
  const visibleNodeIds = useMemo(() => {
    const out = new Set<string>();
    for (const n of allNodes) {
      if (n.layer === 'core') { out.add(n.id); continue; }
      if (filters.layerFilter !== 'all' && n.layer !== filters.layerFilter) continue;
      if (n.type === 'warning' && !filters.showWarnings) continue;
      if (n.type === 'gap' && !filters.showGaps) continue;
      out.add(n.id);
    }
    return out;
  }, [allNodes, filters]);

  const visibleEdges = useMemo(
    () =>
      allEdges.filter(
        (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target),
      ),
    [allEdges, visibleNodeIds],
  );

  const visibleNodes = allNodes.filter((n) => visibleNodeIds.has(n.id));

  function handleWheel(e: React.WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const next = Math.max(0.4, Math.min(2.5, zoom + (e.deltaY < 0 ? 0.1 : -0.1)));
    setZoom(next);
  }
  function handleMouseDown(e: React.MouseEvent) {
    if (e.target !== e.currentTarget) return;
    dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  }
  function handleMouseMove(e: React.MouseEvent) {
    if (!dragRef.current) return;
    setPan({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y });
  }
  function handleMouseUp() {
    dragRef.current = null;
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-bg-base"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
    >
      {/* Atmospheric backdrop — radial gradient (§3.1 cerebral observatory). */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(124,131,255,0.12),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(34,211,238,0.06),transparent_45%)]" />
      {graph && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-cyan-200">
          <span className={['mr-1 inline-block h-1.5 w-1.5 rounded-full bg-cyan-300', livePulse > 0 ? 'animate-pulse' : ''].join(' ')} />
          {graph.meta.atomCount} atoms · {graph.meta.linkCount} links
        </div>
      )}

      <svg
        width={STAGE_W} height={STAGE_H}
        viewBox={`${-STAGE_W / 2} ${-STAGE_H / 2} ${STAGE_W} ${STAGE_H}`}
        className="absolute left-1/2 top-1/2 select-none"
        style={{
          transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})`,
          transformOrigin: 'center',
        }}
      >
        {/* Stratum guide rings — visual anchor for the four layers. */}
        {[220, 360, 480].map((r) => (
          <circle key={r} r={r} fill="none" stroke="#23252d" strokeDasharray="2 6" strokeWidth={1} />
        ))}

        {/* Edges */}
        <g>
          {visibleEdges.map((e) => {
            const a = positions.get(e.source);
            const b = positions.get(e.target);
            if (!a || !b) return null;
            const isHighlight = neighborhood ? neighborhood.has(e.source) && neighborhood.has(e.target) : false;
            const baseOpacity = neighborhood && !isHighlight ? 0.06 : Math.max(0.18, e.weight ?? 0.5);
            return (
              <g key={e.id}>
                <path
                  d={curve(a, b)}
                  fill="none"
                  stroke={edgeStroke(e)}
                  strokeOpacity={baseOpacity}
                  strokeWidth={1 + (e.weight ?? 0.4) * 1.5}
                  strokeDasharray={edgeDash(e)}
                />
              </g>
            );
          })}
        </g>

        {/* Nodes — rendered as foreignObject so we can use rich card markup. */}
        <g>
          {visibleNodes.map((n) => {
            const pos = positions.get(n.id) ?? { x: 0, y: 0 };
            const isCore = n.type === 'core';
            const w = isCore ? 220 : Math.round(140 + 60 * (n.weight ?? 0.5));
            const h = 70;
            return (
              <foreignObject
                key={n.id}
                x={pos.x - w / 2}
                y={pos.y - h / 2}
                width={w}
                height={h}
                style={{ overflow: 'visible' }}
              >
                <BrainNodeCard
                  node={n}
                  selected={n.id === selectedId}
                  dim={dim(n.id)}
                  onClick={() => onSelect(n.id === selectedId ? null : n.id)}
                />
              </foreignObject>
            );
          })}
        </g>
      </svg>

      {/* Zoom controls — minimal chrome (§3.1 "minimal chrome"). */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1 rounded-md border border-line bg-surface p-1">
        <button
          className="h-6 w-6 text-[12px] text-text-secondary hover:text-text-primary"
          onClick={() => setZoom((z) => Math.min(2.5, z + 0.1))}
          aria-label="Zoom in"
        >+</button>
        <button
          className="h-6 w-6 text-[12px] text-text-secondary hover:text-text-primary"
          onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))}
          aria-label="Zoom out"
        >−</button>
        <button
          className="h-6 w-6 text-[10px] text-text-secondary hover:text-text-primary"
          onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
          aria-label="Reset view"
        >·</button>
      </div>
    </div>
  );
}

function curve(a: { x: number; y: number }, b: { x: number; y: number }): string {
  // Soft cubic bezier — bend toward the origin so edges don't overlap nodes.
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const cx = mx * 0.55;
  const cy = my * 0.55;
  return `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`;
}

function edgeStroke(e: BrainEdge): string {
  switch (e.kind) {
    case 'feeds':        return '#22d3ee';
    case 'evaluates':    return '#a3e635';
    case 'derived_from': return '#a78bfa';
    case 'supports':     return '#22c55e';
    case 'contradicts':  return '#fb7185';
    case 'refines':      return '#94a3b8';
    case 'co_observed':  return '#38bdf8';
    case 'used_in':      return '#7c83ff';
    case 'supersedes':   return '#fb923c';
    case 'measures':     return '#f59e0b';
    default:             return '#94a3b8';
  }
}

function edgeDash(e: BrainEdge): string | undefined {
  switch (e.kind) {
    case 'contradicts': return '6 5';
    case 'refines': return '2 5';
    case 'co_observed': return '1 6';
    default: return undefined;
  }
}
