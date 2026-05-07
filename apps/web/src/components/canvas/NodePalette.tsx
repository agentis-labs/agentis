import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../lib/api';

export interface PaletteNodeType {
  type: string;
  label: string;
  glyph: string;
  description: string;
}

export const PALETTE_NODES: PaletteNodeType[] = [
  { type: 'trigger',    label: 'Trigger',      glyph: '⚡', description: 'Manual, schedule, webhook' },
  { type: 'agent_task', label: 'Agent task',   glyph: '◈', description: 'Delegate to a routed agent' },
  { type: 'skill',      label: 'Skill',        glyph: '✦', description: 'Run a typed deterministic skill' },
  { type: 'approval',   label: 'Approval',     glyph: '✓', description: 'Pause for human gate' },
  { type: 'branch',     label: 'Branch',       glyph: '⎇', description: 'Conditional fork' },
  { type: 'subflow',    label: 'Subflow',      glyph: '▦', description: 'Embed another workflow' },
  { type: 'webhook',    label: 'Webhook',      glyph: '↗', description: 'POST to external URL' },
  { type: 'wait',       label: 'Wait / Timer', glyph: '⏲', description: 'Delay or schedule resume' },
];

interface ReusableWorkflow {
  id: string;
  title: string;
}

export function NodePalette({
  onPick,
  className,
}: {
  onPick?: (type: string, data?: Record<string, unknown>) => void;
  className?: string;
}) {
  const [reusable, setReusable] = useState<ReusableWorkflow[]>([]);

  useEffect(() => {
    void api<{ workflows: ReusableWorkflow[] }>('/v1/workflows?isReusable=true')
      .then((d) => setReusable(d.workflows ?? []))
      .catch(() => {});
  }, []);

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

      {reusable.length > 0 && (
        <>
          <div className="my-1 border-t border-line/60" />
          <h3 className="px-1 pb-1 text-[10px] uppercase tracking-wider text-text-muted">Reusable</h3>
          {reusable.map((wf) => (
            <button
              key={wf.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  'application/x-agentis-node',
                  JSON.stringify({ type: 'subflow', workflowId: wf.id, label: wf.title }),
                );
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => onPick?.('subflow', { workflowId: wf.id, label: wf.title })}
              className="flex items-start gap-2 rounded-md border border-transparent bg-surface-2 px-2 py-1.5 text-left hover:border-accent/40"
              title={`Subflow: ${wf.title}`}
            >
              <span className="text-base leading-none">▦</span>
              <span className="flex flex-col">
                <span className="font-medium text-text-primary">{wf.title}</span>
                <span className="text-[10px] text-text-muted">Subflow</span>
              </span>
            </button>
          ))}
        </>
      )}
    </aside>
  );
}
