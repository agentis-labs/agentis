/**
 * BrainFlowMode — directional intelligence-flow view.
 *
 * Spec: docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §8.2.
 *
 * Best for understanding causality: e.g. dataset → knowledge cluster →
 * evaluator pattern → approval logic → outcome.
 *
 * Implementation: a left-to-right Sankey-ish list. Columns are the four
 * strata (knowledge → core → judgment → memory). Edges are drawn between
 * column items with subtle curves. Cards stay readable; nothing in this
 * view depends on free physics layout.
 */

import { useMemo } from 'react';
import type { BrainNode, BrainResponse } from '@agentis/core';
import { BrainNodeCard } from './BrainNodeCard';

interface FlowProps {
  brain: BrainResponse;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const COL_W = 260;
const COL_GAP = 56;
const ROW_H = 92;

export function BrainFlowMode({ brain, selectedId, onSelect }: FlowProps) {
  const cols = useMemo(() => {
    const knowledge = [...brain.layers.knowledge];
    const core = [...brain.layers.core];
    const judgment = [...brain.layers.judgment];
    const memory = [...brain.layers.memory];
    return [
      { title: 'Knowledge', nodes: knowledge },
      { title: 'Core', nodes: core },
      { title: 'Judgment', nodes: judgment },
      { title: 'Memory', nodes: memory },
    ];
  }, [brain.layers]);

  // Compute (col, row) for each node so we can draw edges between them.
  const placements = useMemo(() => {
    const m = new Map<string, { col: number; row: number }>();
    cols.forEach((col, ci) => {
      col.nodes.forEach((n, ri) => m.set(n.id, { col: ci, row: ri }));
    });
    return m;
  }, [cols]);

  const totalW = cols.length * COL_W + (cols.length - 1) * COL_GAP;
  const maxRows = Math.max(1, ...cols.map((c) => c.nodes.length));
  const totalH = maxRows * ROW_H + 40;

  const neighborhood = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set<string>([selectedId]);
    for (const e of brain.edges) {
      if (e.source === selectedId) set.add(e.target);
      else if (e.target === selectedId) set.add(e.source);
    }
    return set;
  }, [selectedId, brain.edges]);

  return (
    <div className="relative overflow-auto bg-bg-base p-6" style={{ minHeight: '100%' }}>
      <div className="relative mx-auto" style={{ width: totalW, height: totalH }}>
        {/* Edges */}
        <svg
          width={totalW}
          height={totalH}
          className="pointer-events-none absolute inset-0"
        >
          {brain.edges.map((e) => {
            const a = placements.get(e.source);
            const b = placements.get(e.target);
            if (!a || !b) return null;
            const ax = a.col * (COL_W + COL_GAP) + COL_W;
            const ay = a.row * ROW_H + 36 + 30; // +30 = column header
            const bx = b.col * (COL_W + COL_GAP);
            const by = b.row * ROW_H + 36 + 30;
            const isHighlight = neighborhood ? neighborhood.has(e.source) && neighborhood.has(e.target) : false;
            const opacity = neighborhood && !isHighlight ? 0.05 : Math.max(0.2, e.weight ?? 0.5);
            return (
              <path
                key={e.id}
                d={`M ${ax} ${ay} C ${ax + 60} ${ay}, ${bx - 60} ${by}, ${bx} ${by}`}
                fill="none"
                stroke="#7c83ff"
                strokeOpacity={opacity}
                strokeWidth={1 + (e.weight ?? 0.4) * 1.5}
              />
            );
          })}
        </svg>
        {/* Columns */}
        <div className="relative grid h-full" style={{ gridTemplateColumns: `repeat(${cols.length}, ${COL_W}px)`, columnGap: COL_GAP }}>
          {cols.map((col, ci) => (
            <div key={ci}>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                {col.title}
              </div>
              <div className="space-y-2">
                {col.nodes.length === 0 ? (
                  <div className="rounded-card border border-dashed border-line bg-surface px-3 py-4 text-center text-[11px] text-text-muted">
                    No items in this layer.
                  </div>
                ) : (
                  col.nodes.map((n) => (
                    <FlowCard
                      key={n.id}
                      node={n}
                      selected={n.id === selectedId}
                      dim={Boolean(neighborhood && !neighborhood.has(n.id))}
                      onClick={() => onSelect(n.id === selectedId ? null : n.id)}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FlowCard({ node, selected, dim, onClick }: { node: BrainNode; selected: boolean; dim: boolean; onClick: () => void }) {
  return (
    <div style={{ transform: 'none', width: COL_W }}>
      <BrainNodeCard node={node} selected={selected} dim={dim} onClick={onClick} />
    </div>
  );
}
