/**
 * AppGraphNode — visual node renderer for the system-composition graph.
 *
 * Spec: docs/app-canvas/APP-CANVAS-ARCHITECTURE.md §10.4 (color semantics).
 *
 * Each node carries a strong, semantic color that maps to its role in the
 * app system, so the operator can read the architecture at a glance.
 */

import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { AppGraphNodeType } from '@agentis/core';
import {
  Cpu, Workflow, Layers, Users, BookOpen, Brain, Cable, ShieldCheck,
  Target, Clock, Megaphone, Sparkles,
} from 'lucide-react';

export interface AppGraphNodeData extends Record<string, unknown> {
  title: string;
  type: AppGraphNodeType;
  subtitle?: string;
  guidance?: string;
  guidanceAction?: string;
  /** Visual highlight (e.g. selected, in active run). */
  active?: boolean;
  /** Live status of the workflow this node represents (§Layer 2). */
  runStatus?: 'running' | 'completed' | 'failed' | 'idle';
  /** Relative last-run label, e.g. "2m ago". */
  lastRunLabel?: string;
  /** Dim the node when it falls outside the focused domain. */
  dimmed?: boolean;
}

const STATUS_DOT: Record<NonNullable<AppGraphNodeData['runStatus']>, string> = {
  running: 'bg-cyan-400 animate-pulse',
  completed: 'bg-emerald-400',
  failed: 'bg-rose-400',
  idle: 'bg-slate-500',
};

const ICONS: Record<AppGraphNodeType, typeof Cpu> = {
  app_core: Sparkles,
  entry_workflow: Workflow,
  workflow_module: Layers,
  agent_group: Users,
  knowledge_source: BookOpen,
  memory_surface: Brain,
  integration_surface: Cable,
  approval_surface: ShieldCheck,
  output_surface: Target,
  scheduler: Clock,
  channel_surface: Megaphone,
  brain_surface: Cpu,
};

/**
 * Color tokens per node type — match the §10.4 semantic palette. Stored as
 * tailwind classes so they participate in dark-mode and theming.
 */
const COLORS: Record<AppGraphNodeType, { bg: string; ring: string; icon: string; tag: string }> = {
  app_core:           { bg: 'bg-indigo-500/15', ring: 'ring-indigo-400/40', icon: 'text-indigo-300',  tag: 'Core' },
  entry_workflow:     { bg: 'bg-cyan-500/15',   ring: 'ring-cyan-400/40',   icon: 'text-cyan-300',    tag: 'Trigger' },
  workflow_module:    { bg: 'bg-cyan-500/10',   ring: 'ring-cyan-400/25',   icon: 'text-cyan-300',    tag: 'Workflow' },
  agent_group:        { bg: 'bg-amber-500/15',  ring: 'ring-amber-400/40',  icon: 'text-amber-300',   tag: 'Team' },
  knowledge_source:   { bg: 'bg-teal-500/15',   ring: 'ring-teal-400/40',   icon: 'text-teal-300',    tag: 'Knowledge' },
  memory_surface:     { bg: 'bg-fuchsia-500/15',ring: 'ring-fuchsia-400/40',icon: 'text-fuchsia-300', tag: 'Memory' },
  integration_surface:{ bg: 'bg-slate-500/15',  ring: 'ring-slate-400/40',  icon: 'text-slate-300',   tag: 'Connection' },
  approval_surface:   { bg: 'bg-rose-500/15',   ring: 'ring-rose-400/40',   icon: 'text-rose-300',    tag: 'Checkpoint' },
  output_surface:     { bg: 'bg-lime-500/15',   ring: 'ring-lime-400/40',   icon: 'text-lime-300',    tag: 'Output' },
  scheduler:          { bg: 'bg-blue-500/15',   ring: 'ring-blue-400/40',   icon: 'text-blue-300',    tag: 'Schedule' },
  channel_surface:    { bg: 'bg-violet-500/15', ring: 'ring-violet-400/40', icon: 'text-violet-300',  tag: 'Channel' },
  brain_surface:      { bg: 'bg-fuchsia-500/15',ring: 'ring-fuchsia-400/40',icon: 'text-fuchsia-300', tag: 'Brain' },
};

interface NodeProps {
  data: AppGraphNodeData;
  selected?: boolean;
}

function AppGraphNodeImpl({ data, selected }: NodeProps) {
  const Icon = ICONS[data.type] ?? Cpu;
  const c = COLORS[data.type] ?? COLORS.app_core;
  const isCore = data.type === 'app_core';

  return (
    <div
      className={[
        'group relative rounded-card border border-line bg-surface px-3 py-2.5 ring-1 transition-all',
        c.bg,
        selected ? 'ring-2 ring-accent shadow-lg' : c.ring,
        data.active ? 'shadow-[0_0_22px_rgba(124,131,255,0.25)]' : '',
        data.dimmed ? 'opacity-40' : '',
        isCore ? 'min-w-[220px]' : 'min-w-[180px]',
      ].join(' ')}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-line !bg-surface-2"
      />
      <div className="flex items-center gap-2.5">
        <span
          className={[
            'flex h-8 w-8 items-center justify-center rounded-md bg-bg-base/50',
            c.icon,
          ].join(' ')}
        >
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {data.runStatus && (
              <span
                className={['h-2 w-2 shrink-0 rounded-full', STATUS_DOT[data.runStatus]].join(' ')}
                title={`Last run: ${data.runStatus}`}
              />
            )}
            <div className="truncate text-[13px] font-semibold text-text-primary">
              {data.title}
            </div>
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-text-muted">
            {c.tag}
            {data.subtitle ? ' · ' + data.subtitle : ''}
            {data.lastRunLabel ? ' · ' + data.lastRunLabel : ''}
          </div>
        </div>
      </div>
      {data.guidance && (
        <div className="mt-2 rounded-md border border-dashed border-amber-400/35 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-100">
          <div>{data.guidance}</div>
          {data.guidanceAction && (
            <div className="mt-1 inline-flex rounded-full border border-amber-300/35 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-100">
              + {data.guidanceAction}
            </div>
          )}
        </div>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-line !bg-surface-2"
      />
    </div>
  );
}

export const AppGraphNode = memo(AppGraphNodeImpl);
