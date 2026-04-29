/**
 * Node palette — V1-SPEC §13.5.
 *
 * Left-rail draggable source for the eight canonical node types from
 * V1-SPEC §6.1. Drag onto the canvas to add a node of that type.
 *
 * Spec-required types: Trigger, Agent Task, Skill, Approval, Branch,
 * Subflow, Webhook, Wait/Timer.
 */

import clsx from 'clsx';

export interface PaletteNodeType {
  type: string;
  label: string;
  glyph: string;
  description: string;
}

export const PALETTE_NODES: PaletteNodeType[] = [
  { type: 'trigger', label: 'Trigger', glyph: '⚡', description: 'Manual, schedule, webhook' },
  { type: 'agent_task', label: 'Agent task', glyph: '◈', description: 'Delegate to a routed agent' },
  { type: 'skill', label: 'Skill', glyph: '✦', description: 'Run a typed deterministic skill' },
  { type: 'approval', label: 'Approval', glyph: '✓', description: 'Pause for human gate' },
  { type: 'branch', label: 'Branch', glyph: '⎇', description: 'Conditional fork' },
  { type: 'subflow', label: 'Subflow', glyph: '▦', description: 'Embed another workflow' },
  { type: 'webhook', label: 'Webhook', glyph: '↗', description: 'POST to external URL' },
  { type: 'wait', label: 'Wait / Timer', glyph: '⏲', description: 'Delay or schedule resume' },
];

export function NodePalette({
  onPick,
  className,
}: {
  onPick?: (type: string) => void;
  className?: string;
}) {
  return (
    <aside
      className={clsx(
        'flex w-44 shrink-0 flex-col gap-1 border-r border-line bg-surface p-2 text-xs',
        className,
      )}
    >
      <h3 className="px-1 pb-1 text-[10px] uppercase tracking-wider text-text-muted">Palette</h3>
      {PALETTE_NODES.map((n) => (
        <button
          key={n.type}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-agentis-node', n.type);
            e.dataTransfer.effectAllowed = 'copy';
          }}
          onClick={() => onPick?.(n.type)}
          className="flex items-start gap-2 rounded-md border border-transparent bg-surface-2 px-2 py-1.5 text-left hover:border-accent/40"
          title={n.description}
        >
          <span className="text-base leading-none">{n.glyph}</span>
          <span className="flex flex-col">
            <span className="font-medium text-text-primary">{n.label}</span>
            <span className="text-[10px] text-text-muted">{n.description}</span>
          </span>
        </button>
      ))}
    </aside>
  );
}
