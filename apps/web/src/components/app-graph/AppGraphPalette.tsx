/**
 * AppGraphPalette — drag source for AppGraph nodes.
 *
 * Spec: docs/app-canvas/APP-CANVAS-ARCHITECTURE.md §15.2.
 *
 * Distinct from the workflow palette. The taxonomy (12 types) is system-level,
 * not execution-level — see §7.3.
 */

import {
  Sparkles, Workflow, Layers, Users, BookOpen, Brain, Cable, ShieldCheck,
  Target, Clock, Megaphone, Cpu, FolderTree,
} from 'lucide-react';
import type { AppGraphNodeType, AppGraphReferenceScope } from '@agentis/core';

interface PaletteEntry {
  type: AppGraphNodeType;
  label: string;
  hint: string;
  icon: typeof Sparkles;
  zone?: 'inputs' | 'core' | 'outputs';
}

const PALETTE: PaletteEntry[] = [
  { type: 'app_core',            label: 'App core',           hint: 'Anchors this app',                   icon: Sparkles, zone: 'core' },
  { type: 'entry_workflow',      label: 'Trigger',            hint: 'What starts this app',               icon: Workflow, zone: 'core' },
  { type: 'workflow_module',     label: 'Workflow',           hint: 'A connected workflow',               icon: Layers,   zone: 'core' },
  { type: 'agent_group',         label: 'Team',               hint: 'The agents doing the work',          icon: Users,    zone: 'core' },
  { type: 'knowledge_source',    label: 'Knowledge',          hint: 'Information this app reads from',    icon: BookOpen, zone: 'inputs' },
  { type: 'memory_surface',      label: 'Memory',             hint: 'What this app remembers',            icon: Brain,    zone: 'core' },
  { type: 'integration_surface', label: 'Connection',         hint: 'An external account or tool',        icon: Cable,    zone: 'inputs' },
  { type: 'approval_surface',    label: 'Checkpoint',         hint: 'Pause here for human review',        icon: ShieldCheck, zone: 'core' },
  { type: 'output_surface',      label: 'Output',             hint: 'Something this app produces',        icon: Target,   zone: 'outputs' },
  { type: 'scheduler',           label: 'Schedule',           hint: 'Runs on a recurring schedule',       icon: Clock,    zone: 'inputs' },
  { type: 'channel_surface',     label: 'Channel',            hint: 'Inbound or outbound communication',  icon: Megaphone,zone: 'outputs' },
  { type: 'brain_surface',       label: 'Brain',              hint: 'Deep knowledge for this app',        icon: Cpu,      zone: 'core' },
];

interface PaletteProps {
  onDragStart: (type: AppGraphNodeType, e: React.DragEvent) => void;
  collections?: NonNullable<AppGraphReferenceScope['collections']>;
}

export function AppGraphPalette({ onDragStart, collections = [] }: PaletteProps) {
  return (
    <div className="flex h-full w-60 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          App modules
        </div>
        <div className="mt-1 text-[11px] text-text-muted">
          Drag onto the canvas
        </div>
      </div>
      <div className="space-y-3 p-3">
        {(['inputs', 'core', 'outputs'] as const).map((zone) => (
          <div key={zone}>
            <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              {zone}
            </div>
            <div className="space-y-1">
              {PALETTE.filter((p) => p.zone === zone).map((entry) => (
                <button
                  key={entry.type}
                  type="button"
                  draggable
                  onDragStart={(e) => onDragStart(entry.type, e)}
                  className="flex w-full cursor-grab items-center gap-2 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-left transition-colors hover:bg-surface active:cursor-grabbing"
                >
                  <entry.icon size={14} className="shrink-0 text-text-secondary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-text-primary">
                      {entry.label}
                    </div>
                    <div className="truncate text-[10px] text-text-muted">{entry.hint}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
        {collections.length > 0 && (
          <div>
            <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              collections
            </div>
            <div className="space-y-1">
              {collections.map((collection) => (
                <button
                  key={collection.name}
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-agentis-app-collection', JSON.stringify(collection));
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  className="flex w-full cursor-grab items-center gap-2 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-left transition-colors hover:bg-surface active:cursor-grabbing"
                >
                  <FolderTree size={14} className="shrink-0 text-text-secondary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-text-primary">
                      {collection.name}
                    </div>
                    <div className="truncate text-[10px] text-text-muted">
                      {collection.workflows.length} workflow{collection.workflows.length === 1 ? '' : 's'}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
