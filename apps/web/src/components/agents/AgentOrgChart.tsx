import { useMemo } from 'react';
import { ReactFlow, Background, Controls, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../../lib/api';
import type { CommandAgent } from './AgentCard';

export interface OrgAgent extends CommandAgent {
  children?: OrgAgent[];
}

export function AgentOrgChart({ agents, onChanged }: { agents: OrgAgent[]; onChanged: () => void }) {
  const { nodes, edges } = useMemo(() => layout(agents), [agents]);
  return (
    <div className="h-full min-h-[32rem] rounded-lg border border-line bg-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        onNodeDragStop={async (_event: unknown, node: Node) => {
          const nearest = nodes
            .filter((candidate) => candidate.id !== node.id)
            .map((candidate) => ({
              id: candidate.id,
              distance: Math.hypot(candidate.position.x - node.position.x, candidate.position.y - node.position.y),
            }))
            .sort((a, b) => a.distance - b.distance)[0];
          if (!nearest || nearest.distance > 190) return;
          await api(`/v1/agents/${node.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ reportsTo: nearest.id }),
          });
          onChanged();
        }}
      >
        <Background color="var(--color-canvas-grid)" gap={28} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function layout(roots: OrgAgent[]) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let cursor = 0;

  function walk(agent: OrgAgent, depth: number, parentId: string | null) {
    const x = cursor * 260;
    const y = depth * 160;
    cursor += 1;
    nodes.push({
      id: agent.id,
      position: { x, y },
      data: {
        label: (
          <div className="w-52 rounded-lg border border-line bg-surface p-3 text-left shadow-card" style={{ borderTopColor: agent.colorHex ?? undefined, borderTopWidth: 3 }}>
            <div className="flex items-center gap-2">
              <span>{agent.avatarGlyph || '◈'}</span>
              <span className="truncate text-sm font-medium">{agent.name}</span>
            </div>
            <div className="mt-1 truncate text-xs text-text-muted">{agent.role || 'agent'}</div>
            <div className="mt-2 text-[10px] uppercase text-text-muted">{agent.status}</div>
          </div>
        ),
      },
      type: 'default',
    });
    if (parentId) edges.push({ id: `${parentId}-${agent.id}`, source: parentId, target: agent.id, animated: false });
    for (const child of agent.children ?? []) walk(child, depth + 1, agent.id);
  }

  roots.forEach((agent) => walk(agent, 0, null));
  return { nodes, edges };
}
