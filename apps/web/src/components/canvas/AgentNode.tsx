/**
 * AgentNode — V1-SPEC §3.3 spec-named agent canvas node.
 *
 * Specialised rendering for `agent_task` nodes. Carries the agent's color
 * dot in the glyph slot so the canvas reads as a constellation when the
 * AgentFocusOverlayManager animates focus shifts between agents.
 */

import clsx from 'clsx';
import { Handle, Position } from '@xyflow/react';
import { Typewriter } from '../shared/Typewriter';

export interface AgentNodeData {
  label: string;
  type: string;
  agentColorHex?: string | null;
  agentName?: string | null;
  toolPreview?: string;
}

export function AgentNode({ data }: { data: AgentNodeData }) {
  return (
    <div
      className={clsx(
        'relative flex min-w-[180px] flex-col gap-1 rounded-node border border-line bg-surface-2 px-3 py-2 shadow-card',
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-line !bg-surface"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-line !bg-surface"
      />
      <div className="flex items-center gap-2">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-full"
          style={{
            background: data.agentColorHex ? `${data.agentColorHex}33` : 'rgba(120,120,120,0.2)',
            color: data.agentColorHex ?? '#aaa',
          }}
        >
          ◎
        </span>
        <div className="leading-tight">
          <div className="text-sm text-text-primary">{data.label}</div>
          <div className="text-[10px] uppercase tracking-wide text-text-muted">
            {data.agentName ? `agent · ${data.agentName}` : data.type}
          </div>
        </div>
      </div>
      {data.toolPreview && (
        <Typewriter text={data.toolPreview} className="text-[10px] text-text-muted" />
      )}
    </div>
  );
}
