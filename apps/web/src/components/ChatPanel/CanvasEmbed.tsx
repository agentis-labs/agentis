/**
 * CanvasEmbed — read-only mini canvas for in-chat workflow narration
 * (AGENTIS-UX-V2 §6.5).
 *
 * Subscribes to CANVAS_NODE_PLACED / CANVAS_EDGE_CONNECTED /
 * CANVAS_BUILD_COMPLETE for a given runId, and renders nodes + edges as
 * they stream in. Click to open the full canvas at /workflows/:workflowId.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ReactFlow, Background, Controls, type Edge, type Node } from '@xyflow/react';
import { Maximize2 } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import { REALTIME_EVENTS } from '@agentis/core';
import { useRealtime } from '../../lib/realtime';

interface Props {
  runId: string;
  workflowId?: string;
  initialNodes?: Node[];
  initialEdges?: Edge[];
}

export function CanvasEmbed({ runId, workflowId, initialNodes = [], initialEdges = [] }: Props) {
  const nav = useNavigate();
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const [edges, setEdges] = useState<Edge[]>(initialEdges);
  const [complete, setComplete] = useState(false);
  const seenNodes = useRef(new Set<string>(initialNodes.map((n) => n.id)));
  const seenEdges = useRef(new Set<string>(initialEdges.map((e) => e.id)));

  useRealtime(
    [
      REALTIME_EVENTS.CANVAS_NODE_PLACED,
      REALTIME_EVENTS.CANVAS_EDGE_CONNECTED,
      REALTIME_EVENTS.CANVAS_BUILD_COMPLETE,
    ],
    (env) => {
      const payload = env.payload as {
        runId?: string;
        node?: Node;
        edge?: Edge;
      };
      if (payload.runId !== runId) return;
      if (env.event === REALTIME_EVENTS.CANVAS_NODE_PLACED && payload.node) {
        if (seenNodes.current.has(payload.node.id)) return;
        seenNodes.current.add(payload.node.id);
        setNodes((prev) => [...prev, payload.node!]);
      } else if (env.event === REALTIME_EVENTS.CANVAS_EDGE_CONNECTED && payload.edge) {
        if (seenEdges.current.has(payload.edge.id)) return;
        seenEdges.current.add(payload.edge.id);
        setEdges((prev) => [...prev, payload.edge!]);
      } else if (env.event === REALTIME_EVENTS.CANVAS_BUILD_COMPLETE) {
        setComplete(true);
      }
    },
  );

  useEffect(() => {
    if (initialNodes.length > 0 || initialEdges.length > 0) return;
  }, [initialNodes, initialEdges]);

  const empty = nodes.length === 0;

  const fit = useMemo(() => ({ padding: 0.2 }), []);

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-line bg-canvas">
      <div className="flex items-center justify-between border-b border-line/40 px-2 py-1 text-[10px] text-text-muted">
        <span>
          Canvas · {nodes.length} node{nodes.length === 1 ? '' : 's'} ·{' '}
          {complete ? 'complete' : 'building…'}
        </span>
        {workflowId && (
          <button
            type="button"
            onClick={() => nav(`/workflows/${workflowId}`)}
            className="inline-flex items-center gap-1 hover:text-accent"
            aria-label="Open full canvas"
          >
            <Maximize2 size={10} />
            Open
          </button>
        )}
      </div>
      <div className="h-[220px] w-full">
        {empty ? (
          <div className="flex h-full items-center justify-center text-[11px] text-text-muted">
            Waiting for canvas events…
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            fitViewOptions={fit}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
