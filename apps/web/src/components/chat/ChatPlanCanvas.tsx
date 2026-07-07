import { useEffect, useMemo, useState } from 'react';
import { FileText, GitBranch, LocateFixed, Network, PanelRightClose } from 'lucide-react';
import { Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { CanvasEngine } from '../canvas/CanvasEngine';
import { ChatMarkdown } from './ChatMarkdown';

export type ArchitectureCanvasKind = 'workflow' | 'extension' | 'app' | 'system';

export interface ArchitectureCanvasNode {
  id: string;
  title: string;
  role: string;
  kind?: string;
  summary?: string;
  group?: string;
}

export interface ArchitectureCanvasEdge {
  source: string;
  target: string;
  label?: string;
}

export interface ArchitectureCanvasGroup {
  id: string;
  title: string;
}

export interface ArchitectureCanvasPayload {
  kind: ArchitectureCanvasKind;
  nodes: ArchitectureCanvasNode[];
  edges: ArchitectureCanvasEdge[];
  groups?: ArchitectureCanvasGroup[];
}

export interface ParsedAgentPlan {
  before: string;
  planText: string;
  after: string;
  architecture: ArchitectureCanvasPayload | null;
}

type ArchitectureNodeData = ArchitectureCanvasNode & Record<string, unknown> & {
  index: number;
};

const PROPOSED_PLAN_RE = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;
const ARCHITECTURE_CANVAS_RE = /<architecture_canvas>\s*([\s\S]*?)\s*<\/architecture_canvas>/i;
const ARCHITECTURE_KINDS = new Set<ArchitectureCanvasKind>(['workflow', 'extension', 'app', 'system']);

export function extractAgentPlan(text: string): ParsedAgentPlan | null {
  const planMatch = text.match(PROPOSED_PLAN_RE);
  if (!planMatch || planMatch.index === undefined) return null;
  const planText = (planMatch[1] ?? '').trim();
  if (!planText) return null;

  const architectureMatch = text.match(ARCHITECTURE_CANVAS_RE);
  const architecture = parseArchitectureCanvas(architectureMatch?.[1] ?? null);
  const before = text.slice(0, planMatch.index).replace(ARCHITECTURE_CANVAS_RE, '').trim();
  const after = text.slice(planMatch.index + planMatch[0].length).replace(ARCHITECTURE_CANVAS_RE, '').trim();

  return {
    before,
    planText,
    after,
    architecture,
  };
}

function parseArchitectureCanvas(raw: string | null): ArchitectureCanvasPayload | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!ARCHITECTURE_KINDS.has(record.kind as ArchitectureCanvasKind)) return null;
    const nodes = normalizeNodes(record.nodes);
    if (nodes.length === 0) return null;
    const nodeIds = new Set(nodes.map((node) => node.id));
    return {
      kind: record.kind as ArchitectureCanvasKind,
      nodes,
      edges: normalizeEdges(record.edges, nodeIds),
      groups: normalizeGroups(record.groups),
    };
  } catch {
    return null;
  }
}

function normalizeNodes(value: unknown): ArchitectureCanvasNode[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const nodes: ArchitectureCanvasNode[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = stringValue(record.id);
    const title = stringValue(record.title);
    const role = stringValue(record.role);
    if (!id || !title || !role || seen.has(id)) continue;
    seen.add(id);
    nodes.push({
      id,
      title,
      role,
      ...(stringValue(record.kind) ? { kind: stringValue(record.kind) } : {}),
      ...(stringValue(record.summary) ? { summary: stringValue(record.summary) } : {}),
      ...(stringValue(record.group) ? { group: stringValue(record.group) } : {}),
    });
  }
  return nodes.slice(0, 18);
}

function normalizeEdges(value: unknown, nodeIds: Set<string>): ArchitectureCanvasEdge[] {
  if (!Array.isArray(value)) return [];
  const edges: ArchitectureCanvasEdge[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const source = stringValue(record.source);
    const target = stringValue(record.target);
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) continue;
    edges.push({
      source,
      target,
      ...(stringValue(record.label) ? { label: stringValue(record.label) } : {}),
    });
  }
  return edges.slice(0, 32);
}

function normalizeGroups(value: unknown): ArchitectureCanvasGroup[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groups = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const id = stringValue(record.id);
    const title = stringValue(record.title);
    return id && title ? [{ id, title }] : [];
  });
  return groups.length > 0 ? groups.slice(0, 8) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

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
