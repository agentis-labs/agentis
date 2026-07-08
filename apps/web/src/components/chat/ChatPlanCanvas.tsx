import { useEffect, useMemo, useState } from 'react';
import { FileText, GitBranch, LocateFixed, Network, PanelRightClose } from 'lucide-react';
import { Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import {
  extractAgentPlan,
  type ArchitectureCanvasKind,
  type ArchitectureCanvasNode,
  type ArchitectureCanvasPayload,
} from '@agentis/core';
import { CanvasEngine } from '../canvas/CanvasEngine';
import { ChatMarkdown } from './ChatMarkdown';

export { extractAgentPlan };
export type {
  ArchitectureCanvasKind,
  ArchitectureCanvasNode,
  ArchitectureCanvasEdge,
  ArchitectureCanvasGroup,
  ArchitectureCanvasPayload,
  ParsedAgentPlan,
} from '@agentis/core';

type ArchitectureNodeData = ArchitectureCanvasNode & Record<string, unknown> & {
  index: number;
};

function ArchitectureNode({ data, selected }: NodeProps<Node<ArchitectureNodeData>>) {
  return (
    <div
      className={clsx(
        'w-[250px] rounded-lg border border-line bg-surface/95 px-3 py-2.5 text-left shadow-[0_18px_45px_-35px_rgba(0,0,0,0.9)]',
        selected && 'ring-2 ring-accent/35',
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-2 !border-surface !bg-text-muted" />
      <div className="mb-1 flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-accent">{data.role}</span>
        {data.kind && <span className="truncate text-[9px] text-text-muted">{data.kind}</span>}
      </div>
      <div className="text-[12px] font-semibold leading-snug text-text-primary">{data.title}</div>
      {data.summary ? (
        <p className="mt-1 line-clamp-2 text-[10.5px] leading-relaxed text-text-secondary">{data.summary}</p>
      ) : null}
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-2 !border-surface !bg-accent" />
    </div>
  );
}

const nodeTypes = { architecture: ArchitectureNode };

function architectureLabel(kind: ArchitectureCanvasKind): string {
  if (kind === 'workflow') return 'Workflow architecture';
  if (kind === 'extension') return 'Extension architecture';
  if (kind === 'app') return 'App architecture';
  return 'System architecture';
}

export function ChatPlanCanvas({
  planText,
  architecture,
}: {
  planText: string;
  architecture?: ArchitectureCanvasPayload | null;
}) {
  const hasArchitecture = Boolean(architecture?.nodes.length);
  const [view, setView] = useState<'canvas' | 'text'>(() => (hasArchitecture ? 'canvas' : 'text'));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = architecture?.nodes.find((node) => node.id === selectedId) ?? null;

  useEffect(() => {
    if (!hasArchitecture) setView('text');
  }, [hasArchitecture]);

  const nodes = useMemo<Node<ArchitectureNodeData>[]>(() => (architecture?.nodes ?? []).map((node, index) => ({
    id: node.id,
    type: 'architecture',
    position: {
      x: (index % 3) * 300,
      y: Math.floor(index / 3) * 150,
    },
    data: { ...node, index },
  })), [architecture]);

  const edges = useMemo<Edge[]>(() => (architecture?.edges ?? []).map((edge, index) => ({
    id: `edge-${edge.source}-${edge.target}-${index}`,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: 'smoothstep',
    style: { stroke: 'var(--color-line)', strokeWidth: 1.4 },
  })), [architecture]);

  const title = architecture ? architectureLabel(architecture.kind) : 'Agent plan';

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-canvas/70 text-text-primary">
      <header className="flex min-h-11 items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-accent/25 bg-accent/10 text-accent">
            {hasArchitecture ? <GitBranch size={14} /> : <FileText size={14} />}
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-text-primary">{title}</div>
            <div className="truncate text-[9.5px] text-text-muted">
              {hasArchitecture ? `${architecture!.nodes.length} preview node${architecture!.nodes.length === 1 ? '' : 's'}` : 'Plan text'}
            </div>
          </div>
        </div>
        <div className="flex rounded-md border border-line bg-surface p-0.5">
          {hasArchitecture && (
            <button
              type="button"
              onClick={() => setView('canvas')}
              className={clsx('grid h-7 w-7 place-items-center rounded text-text-muted hover:text-text-primary', view === 'canvas' && 'bg-surface-3 text-accent')}
              aria-label="Show architecture canvas"
            >
              <Network size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setView('text')}
            className={clsx('grid h-7 w-7 place-items-center rounded text-text-muted hover:text-text-primary', view === 'text' && 'bg-surface-3 text-accent')}
            aria-label="Show plan text"
          >
            <FileText size={13} />
          </button>
        </div>
      </header>

      {view === 'canvas' && hasArchitecture ? (
        <div className="relative h-[340px] min-h-[300px]">
          <CanvasEngine
            className="absolute inset-0 h-full w-full"
            style={{ height: 340, width: '100%' }}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            panOnDrag
            zoomOnScroll
            zoomOnPinch
            controlsPosition="bottom-left"
            backgroundColor="transparent"
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface/90 px-2 text-[10px] text-text-muted shadow-card"
          >
            <LocateFixed size={11} />
            Fit
          </div>
          {architecture?.groups && architecture.groups.length > 0 && (
            <div className="pointer-events-none absolute left-3 top-3 flex max-w-[70%] flex-wrap gap-1.5">
              {architecture.groups.map((group) => (
                <span key={group.id} className="rounded-md border border-line bg-surface/90 px-2 py-1 text-[9.5px] font-medium text-text-muted shadow-card">
                  {group.title}
                </span>
              ))}
            </div>
          )}
          {selected && (
            <aside className="absolute bottom-3 right-3 top-12 z-20 w-[300px] overflow-y-auto rounded-lg border border-line bg-surface/95 p-3 shadow-modal backdrop-blur">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-accent">{selected.role}</div>
                  <h4 className="mt-1 text-[12px] font-semibold text-text-primary">{selected.title}</h4>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="-m-1 rounded p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
                  aria-label="Close architecture details"
                >
                  <PanelRightClose size={14} />
                </button>
              </div>
              {selected.kind ? <div className="mt-1 text-[10px] text-text-muted">{selected.kind}</div> : null}
              {selected.summary ? <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">{selected.summary}</p> : null}
            </aside>
          )}
        </div>
      ) : (
        <div className="max-h-[460px] overflow-y-auto px-3 py-3">
          <ChatMarkdown text={planText} />
        </div>
      )}
    </section>
  );
}
