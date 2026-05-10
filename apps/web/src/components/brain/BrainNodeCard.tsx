/**
 * BrainNodeCard — visual node renderer used inside BrainStage.
 *
 * Spec: docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §9.2 (visual treatments).
 *
 * Each of the 11 node types gets a distinct visual treatment so the operator
 * can read the intelligence topology at a glance. The card is rendered as an
 * SVG <foreignObject> so it can use full HTML/CSS for typography while sitting
 * inside the SVG stage.
 */

import {
  Sparkles, Database, Layers, Brain, Lightbulb, Gauge,
  ScrollText, FileText, GitBranch, AlertTriangle, CircleDashed,
} from 'lucide-react';
import type { BrainNode, BrainNodeType } from '@agentis/core';

const ICONS: Record<BrainNodeType, typeof Sparkles> = {
  core: Sparkles,
  dataset: Database,
  knowledge_cluster: Layers,
  memory_episode: Lightbulb,
  memory_pattern: Brain,
  evaluator: Gauge,
  baseline: ScrollText,
  artifact: FileText,
  decision: GitBranch,
  warning: AlertTriangle,
  gap: CircleDashed,
};

const COLORS: Record<BrainNodeType, { ring: string; bg: string; iconColor: string; tint: string }> = {
  core:              { ring: 'ring-indigo-300/60', bg: 'bg-indigo-500/15',  iconColor: 'text-indigo-200',  tint: 'border-indigo-400/40' },
  dataset:           { ring: 'ring-cyan-400/30',   bg: 'bg-cyan-500/10',    iconColor: 'text-cyan-200',    tint: 'border-cyan-400/30'   },
  knowledge_cluster: { ring: 'ring-teal-400/30',   bg: 'bg-teal-500/10',    iconColor: 'text-teal-200',    tint: 'border-teal-400/30'   },
  memory_episode:    { ring: 'ring-fuchsia-400/30',bg: 'bg-fuchsia-500/10', iconColor: 'text-fuchsia-200', tint: 'border-fuchsia-400/30'},
  memory_pattern:    { ring: 'ring-violet-400/40', bg: 'bg-violet-500/15',  iconColor: 'text-violet-200',  tint: 'border-violet-400/40' },
  evaluator:         { ring: 'ring-lime-400/40',   bg: 'bg-lime-500/15',    iconColor: 'text-lime-200',    tint: 'border-lime-400/40'   },
  baseline:          { ring: 'ring-amber-400/30',  bg: 'bg-amber-500/10',   iconColor: 'text-amber-200',   tint: 'border-amber-400/30'  },
  artifact:          { ring: 'ring-slate-400/30',  bg: 'bg-slate-500/10',   iconColor: 'text-slate-200',   tint: 'border-slate-400/30'  },
  decision:          { ring: 'ring-blue-400/30',   bg: 'bg-blue-500/10',    iconColor: 'text-blue-200',    tint: 'border-blue-400/30'   },
  warning:           { ring: 'ring-rose-400/40',   bg: 'bg-rose-500/15',    iconColor: 'text-rose-200',    tint: 'border-rose-400/40'   },
  gap:               { ring: 'ring-text-muted/30', bg: 'bg-surface-2',      iconColor: 'text-text-muted',  tint: 'border-dashed border-text-muted/40' },
};

interface CardProps {
  node: BrainNode;
  selected: boolean;
  dim?: boolean;
  onClick: () => void;
}

export function BrainNodeCard({ node, selected, dim, onClick }: CardProps) {
  const Icon = ICONS[node.type] ?? Sparkles;
  const c = COLORS[node.type] ?? COLORS.dataset;
  const isCore = node.type === 'core';
  const weight = node.weight ?? 0.5;
  // Cards scale with weight to give the eye a hierarchy.
  const w = isCore ? 220 : Math.round(140 + 60 * weight);

  return (
    <button
      type="button"
      onClick={onClick}
      style={{ width: w }}
      className={[
        'group flex flex-col gap-1.5 rounded-card border bg-surface px-3 py-2.5 text-left ring-1 transition-all',
        c.bg, c.tint, c.ring,
        selected ? 'shadow-[0_0_24px_rgba(124,131,255,0.35)] !ring-2 !ring-accent' : '',
        dim ? 'opacity-30 saturate-50' : 'opacity-100',
        node.status === 'warning' ? 'shadow-[0_0_18px_rgba(244,63,94,0.18)]' : '',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        <span className={['flex h-7 w-7 items-center justify-center rounded-md bg-bg-base/60', c.iconColor].join(' ')}>
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-text-primary">{node.label}</div>
          {node.description && (
            <div className="truncate text-[10px] text-text-muted">{node.description}</div>
          )}
        </div>
      </div>
      {(node.confidence != null || node.trust != null || node.freshness) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[9px] uppercase tracking-wider text-text-muted">
          {node.confidence != null && <Pill>conf {(node.confidence * 100).toFixed(0)}%</Pill>}
          {node.trust != null && <Pill>trust {(node.trust * 100).toFixed(0)}%</Pill>}
          {node.freshness && <Pill>{node.freshness}</Pill>}
        </div>
      )}
    </button>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-bg-base/60 px-1.5 py-0.5 text-[9px] tracking-wider">
      {children}
    </span>
  );
}
