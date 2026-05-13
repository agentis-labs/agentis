/**
 * WorkflowNode — V1-SPEC §3.3 spec-named canvas node.
 *
 * The visual node used by the React-Flow canvas for every workflow step
 * except agent_task (which has its own focus-overlay treatment via
 * `AgentNode`). Pure presentation; the canvas owns interactions.
 */

import clsx from 'clsx';
import { Handle, Position } from '@xyflow/react';
import { Typewriter } from '../shared/Typewriter';

export const NODE_GLYPH: Record<string, string> = {
  trigger: '◉',
  skill_task: '✦',
  agent_task: '◎',
  router: '⤳',
  merge: '⟴',
  checkpoint: '✓',
  subflow: '⊞',
  scratchpad: '◈',
  knowledge: '◇',
};

export interface WorkflowNodeData {
  label: string;
  kind: string;
  type: string;
  toolPreview?: string;
}

export function WorkflowNode({ data }: { data: WorkflowNodeData }) {
  const glyph = NODE_GLYPH[data.kind] ?? '•';
  const isTrigger = data.kind === 'trigger';
  return (
    <div
      className={clsx(
        'relative flex min-w-[160px] flex-col gap-1 rounded-node border bg-surface-2 px-3 py-2 shadow-card',
        isTrigger ? 'border-accent/60 shadow-glow' : 'border-line',
      )}
    >
      {!isTrigger && (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-2 !w-2 !border-line !bg-surface"
        />
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-line !bg-surface"
      />
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'flex h-7 w-7 items-center justify-center rounded-md text-sm',
            isTrigger ? 'bg-accent/20 text-accent' : 'bg-surface text-text-muted',
          )}
        >
          {glyph}
        </span>
        <div className="leading-tight">
          <div className="text-sm text-text-primary">{data.label}</div>
          <div className="text-[10px] uppercase tracking-wide text-text-muted">{data.type}</div>
        </div>
      </div>
      {data.toolPreview && (
        <Typewriter text={data.toolPreview} className="text-[10px] text-text-muted" />
      )}
    </div>
  );
}
