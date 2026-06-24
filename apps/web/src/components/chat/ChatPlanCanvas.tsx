import { useMemo, useState } from 'react';
import { FileText, GitBranch, LocateFixed, Network, PanelRightClose } from 'lucide-react';
import { Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { CanvasEngine } from '../canvas/CanvasEngine';
import { ChatMarkdown } from './ChatMarkdown';

export interface ParsedAgentPlan {
  before: string;
  planText: string;
  after: string;
}

interface PlanSection {
  id: string;
  title: string;
  body: string;
  bullets: string[];
}

type AgentPlanNodeData = {
  title: string;
  summary: string;
  index: number;
};

const PROPOSED_PLAN_RE = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

export function extractAgentPlan(text: string): ParsedAgentPlan | null {
  const match = text.match(PROPOSED_PLAN_RE);
  if (!match || match.index === undefined) return null;
  const planText = (match[1] ?? '').trim();
  if (!planText) return null;
  return {
    before: text.slice(0, match.index).trim(),
    planText,
    after: text.slice(match.index + match[0].length).trim(),
  };
}

function AgentPlanNode({ data, selected }: NodeProps<Node<AgentPlanNodeData>>) {
  return (
    <div
      className={clsx(
        'w-[230px] rounded-lg border border-line bg-surface/95 px-3 py-2.5 text-left shadow-[0_18px_45px_-35px_rgba(0,0,0,0.9)]',
        selected && 'ring-2 ring-accent/35',
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-2 !border-surface !bg-text-muted" />
      <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-accent">
        Step {data.index + 1}
      </div>
      <div className="text-[12px] font-semibold leading-snug text-text-primary">{data.title}</div>
      {data.summary ? (
        <p className="mt-1 line-clamp-2 text-[10.5px] leading-relaxed text-text-secondary">{data.summary}</p>
      ) : null}
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-2 !border-surface !bg-accent" />
    </div>
  );
}

const nodeTypes = { agentPlan: AgentPlanNode };

function stripMarkdown(value: string): string {
  return value
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\([^)]*\)/g, '$1')
    .trim();
}

function parseSections(planText: string): PlanSection[] {
  const lines = planText.split(/\r?\n/);
  const sections: PlanSection[] = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.+)$/) ?? line.match(/^\*\*(.+?)\*\*\s*$/);
    if (heading) {
      if (current) sections.push(sectionFrom(current, sections.length));
      current = { title: stripMarkdown(heading[2] ?? heading[1] ?? 'Plan'), lines: [] };
      continue;
    }
    if (!current && line.trim()) current = { title: stripMarkdown(line), lines: [] };
    else current?.lines.push(line);
  }
  if (current) sections.push(sectionFrom(current, sections.length));

  const useful = sections.filter((section) => section.title && (section.body || section.bullets.length > 0));
  if (useful.length > 0) return useful.slice(0, 8);

  const bullets = planText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-*]\s+|\d+\.\s+)/.test(line))
    .map((line) => stripMarkdown(line.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '')))
    .filter(Boolean);

  return (bullets.length ? bullets : [stripMarkdown(planText).slice(0, 120)]).slice(0, 8).map((title, index) => ({
    id: `section-${index}`,
    title,
    body: '',
    bullets: [],
  }));
}

function sectionFrom(current: { title: string; lines: string[] }, index: number): PlanSection {
  const bullets: string[] = [];
  const bodyLines: string[] = [];
  for (const line of current.lines) {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-*]\s+(.+)$/) ?? trimmed.match(/^\d+\.\s+(.+)$/);
    if (bullet) bullets.push(stripMarkdown(bullet[1] ?? ''));
    else if (trimmed) bodyLines.push(trimmed);
  }
  return {
    id: `section-${index}`,
    title: current.title,
    body: stripMarkdown(bodyLines.join('\n')),
    bullets: bullets.filter(Boolean).slice(0, 4),
  };
}

export function ChatPlanCanvas({ planText }: { planText: string }) {
  const [view, setView] = useState<'canvas' | 'text'>('canvas');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sections = useMemo(() => parseSections(planText), [planText]);
  const selected = sections.find((section) => section.id === selectedId) ?? null;

  const nodes = useMemo<Node<AgentPlanNodeData>[]>(() => sections.map((section, index) => ({
    id: section.id,
    type: 'agentPlan',
    position: {
      x: (index % 3) * 280,
      y: Math.floor(index / 3) * 150,
    },
    data: {
      title: section.title,
      summary: section.bullets[0] ?? section.body,
      index,
    },
  })), [sections]);

  const edges = useMemo<Edge[]>(() => sections.slice(1).map((section, index) => ({
    id: `edge-${sections[index]!.id}-${section.id}`,
    source: sections[index]!.id,
    target: section.id,
    type: 'smoothstep',
    style: { stroke: 'var(--color-line)', strokeWidth: 1.4 },
  })), [sections]);

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-canvas/70 text-text-primary">
      <header className="flex min-h-11 items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-accent/25 bg-accent/10 text-accent">
            <GitBranch size={14} />
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-text-primary">Agent plan</div>
            <div className="truncate text-[9.5px] text-text-muted">{sections.length} mapped section{sections.length === 1 ? '' : 's'}</div>
          </div>
        </div>
        <div className="flex rounded-md border border-line bg-surface p-0.5">
          <button
            type="button"
            onClick={() => setView('canvas')}
            className={clsx('grid h-7 w-7 place-items-center rounded text-text-muted hover:text-text-primary', view === 'canvas' && 'bg-surface-3 text-accent')}
            aria-label="Show plan canvas"
          >
            <Network size={13} />
          </button>
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

      {view === 'canvas' ? (
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
          {selected && (
            <aside className="absolute bottom-3 right-3 top-12 z-20 w-[300px] overflow-y-auto rounded-lg border border-line bg-surface/95 p-3 shadow-modal backdrop-blur">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-accent">Selected section</div>
                  <h4 className="mt-1 text-[12px] font-semibold text-text-primary">{selected.title}</h4>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="-m-1 rounded p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
                  aria-label="Close section details"
                >
                  <PanelRightClose size={14} />
                </button>
              </div>
              {selected.body ? <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">{selected.body}</p> : null}
              {selected.bullets.length > 0 ? (
                <ul className="mt-2 space-y-1 text-[10.5px] leading-relaxed text-text-secondary">
                  {selected.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
                </ul>
              ) : null}
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
