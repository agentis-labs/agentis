/**
 * AppGraphStage — ReactFlow stage for the AppGraph editor.
 *
 * Spec: docs/app-canvas/APP-CANVAS-ARCHITECTURE.md §8.1, §15.2.
 *
 * Reuses the same ReactFlow runtime as the workflow canvas (engine reuse,
 * §8.1) but maps an AppGraph onto its model instead of a WorkflowGraph.
 * Custom node renderer lives in AppGraphNode.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';
import type {
  AppGraph,
  AppGraphEdge,
  AppGraphNode,
  AppGraphNodeType,
  AppGraphReferenceScope,
} from '@agentis/core';
import { CanvasEngine, type CanvasEngineInstance } from '../canvas/CanvasEngine';
import { AppGraphNode as AppGraphNodeView, type AppGraphNodeData } from './AppGraphNode';

const nodeTypes = { appNode: AppGraphNodeView };

interface StageProps {
  graph: AppGraph;
  onChange: (next: AppGraph) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDropNodeType: (type: AppGraphNodeType, position: { x: number; y: number }) => void;
  onDropCollection?: (collection: NonNullable<AppGraphReferenceScope['collections']>[number], position: { x: number; y: number }) => void;
  showMinimap?: boolean;
}

export function AppGraphStage({
  graph, onChange, selectedId, onSelect, onDropNodeType, onDropCollection, showMinimap,
}: StageProps) {
  const rfRef = useRef<CanvasEngineInstance | null>(null);

  const nodes = useMemo<Node<AppGraphNodeData>[]>(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: 'appNode',
        position: n.position,
        data: { title: n.title, type: n.type },
        selected: n.id === selectedId,
      })),
    [graph.nodes, selectedId],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label ?? humanEdge(e.type),
        labelStyle: { fontSize: 10, fill: '#8a8c9a' },
        style: { stroke: edgeColor(e.type), strokeWidth: 1.4 },
        animated: e.type === 'activates',
      })),
    [graph.edges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const updated = applyNodeChanges(changes, nodes);
      const map = new Map(updated.map((u) => [u.id, u.position]));
      const next: AppGraph = {
        ...graph,
        nodes: graph.nodes
          .filter((n) => map.has(n.id))
          .map((n) => ({ ...n, position: map.get(n.id) ?? n.position })),
      };
      onChange(next);
    },
    [graph, nodes, onChange],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const updated = applyEdgeChanges(changes, edges);
      const keep = new Set(updated.map((e) => e.id));
      onChange({ ...graph, edges: graph.edges.filter((e) => keep.has(e.id)) });
    },
    [graph, edges, onChange],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      const id = `e_${Math.random().toString(36).slice(2, 10)}`;
      const next: AppGraphEdge = {
        id,
        source: conn.source,
        target: conn.target,
        type: 'feeds',
      };
      onChange({ ...graph, edges: [...graph.edges, next] });
    },
    [graph, onChange],
  );

  useEffect(() => {
    // No-op — kept as a hook so future viewport sync can plug in.
  }, [graph.viewport]);

  return (
    <CanvasEngine
      onReady={(inst) => { rfRef.current = inst; }}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      defaultViewport={graph.viewport}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={(_e, n) => onSelect(n.id)}
      onPaneClick={() => onSelect(null)}
      onMoveEnd={(_e, vp) => onChange({ ...graph, viewport: vp })}
      dropEffect="move"
      onDropCanvas={(e, position) => {
        const collectionRaw = e.dataTransfer.getData('application/x-agentis-app-collection');
        if (collectionRaw && onDropCollection) {
          try {
            const collection = JSON.parse(collectionRaw) as NonNullable<AppGraphReferenceScope['collections']>[number];
            if (collection.name && Array.isArray(collection.workflows)) {
              onDropCollection(collection, position);
              return;
            }
          } catch { /* fall through to single-node drop */ }
        }
        const type = e.dataTransfer.getData('application/x-agentis-app-node') as AppGraphNodeType;
        if (!type || !rfRef.current) return;
        onDropNodeType(type, position);
      }}
      fitView={graph.nodes.length > 0 && (graph.viewport.zoom === 1 && graph.viewport.x === 0 && graph.viewport.y === 0)}
      showMinimap={showMinimap}
      minimapNodeColor="#7c83ff"
      backgroundGap={24}
      backgroundColor="#23252d"
    />
  );
}

function edgeColor(type: AppGraphEdge['type']): string {
  switch (type) {
    case 'activates': return '#7c83ff';
    case 'feeds': return '#34d399';
    case 'reads_from': return '#22d3ee';
    case 'writes_to': return '#f59e0b';
    case 'approves': return '#f43f5e';
    case 'publishes_to': return '#84cc16';
    case 'observes': return '#a78bfa';
    case 'depends_on': return '#94a3b8';
    default: return '#94a3b8';
  }
}

function humanEdge(t: AppGraphEdge['type']): string {
  return t.replace(/_/g, ' ');
}

/** Helper used by the page to seed a new node position safely. */
export function defaultPositionFor(graph: AppGraph): { x: number; y: number } {
  const offset = graph.nodes.length * 30;
  return { x: 220 + offset, y: 180 + offset };
}

/** Build a default config for a freshly-dropped node type. */
export function defaultConfigFor(type: AppGraphNodeType): AppGraphNode['config'] {
  switch (type) {
    case 'app_core':            return { kind: 'app_core' };
    case 'entry_workflow':      return { kind: 'entry_workflow', workflowId: '' };
    case 'workflow_module':     return { kind: 'workflow_module', workflowId: '' };
    case 'agent_group':         return { kind: 'agent_group', groupKey: 'agents' };
    case 'knowledge_source':    return { kind: 'knowledge_source', datasetKey: '' };
    case 'memory_surface':      return { kind: 'memory_surface', scope: 'all' };
    case 'integration_surface': return { kind: 'integration_surface', service: '' };
    case 'approval_surface':    return { kind: 'approval_surface' };
    case 'output_surface':      return { kind: 'output_surface' };
    case 'scheduler':           return { kind: 'scheduler', schedule: '' };
    case 'channel_surface':     return { kind: 'channel_surface', channel: '', direction: 'outbound' };
    case 'brain_surface':       return { kind: 'brain_surface' };
  }
}
