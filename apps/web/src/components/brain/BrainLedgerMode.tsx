/**
 * BrainLedgerMode — temporal table view of memories / evaluators / baselines.
 *
 * Spec: docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §8.3.
 *
 * Best for browsing promoted memories, reviewing evaluator changes, and
 * seeing baseline evolution. This is the practical mode — also the
 * mobile/narrow fallback (§18.2).
 */

import { useMemo, useState } from 'react';
import type { BrainNode, BrainResponse } from '@agentis/core';
import { BrainNodeCard } from './BrainNodeCard';

interface LedgerProps {
  brain: BrainResponse;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

type Bucket = 'all' | 'memory' | 'judgment' | 'knowledge' | 'gaps';

export function BrainLedgerMode({ brain, selectedId, onSelect }: LedgerProps) {
  const [bucket, setBucket] = useState<Bucket>('all');

  const items = useMemo<BrainNode[]>(() => {
    const all = [
      ...brain.layers.memory,
      ...brain.layers.judgment,
      ...brain.layers.knowledge,
    ];
    if (bucket === 'all') return all;
    return all.filter((n) => n.layer === bucket);
  }, [brain.layers, bucket]);

  return (
    <div className="flex h-full flex-col bg-bg-base">
      <div className="flex items-center gap-1 border-b border-line px-5 py-2.5">
        {(['all', 'knowledge', 'memory', 'judgment'] as const).map((b) => (
          <button
            key={b}
            onClick={() => setBucket(b)}
            className={[
              'rounded-full px-3 py-1 text-[11px] uppercase tracking-wider transition-colors',
              bucket === b ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary',
            ].join(' ')}
          >
            {b}
          </button>
        ))}
        <div className="ml-auto text-[11px] text-text-muted">{items.length} item{items.length === 1 ? '' : 's'}</div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {items.length === 0 ? (
            <div className="col-span-full rounded-card border border-dashed border-line bg-surface px-6 py-12 text-center text-[12px] text-text-muted">
              Nothing here yet. Memories accumulate as the app runs and learns.
            </div>
          ) : (
            items.map((n) => (
              <BrainNodeCard
                key={n.id}
                node={n}
                selected={n.id === selectedId}
                onClick={() => onSelect(n.id === selectedId ? null : n.id)}
              />
            ))
          )}
        </div>

        {/* Gaps surface — explicitly visualize absence (§9.2 gap). */}
        {brain.gaps.length > 0 && (
          <div className="mt-6">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Gaps</div>
            <div className="space-y-1.5">
              {brain.gaps.map((g) => (
                <div
                  key={g.id}
                  className="rounded-card border border-dashed border-line bg-surface px-3 py-2"
                >
                  <div className="text-[12px] font-medium text-text-secondary">{g.label}</div>
                  <div className="mt-0.5 text-[11px] text-text-muted">{g.reason}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
