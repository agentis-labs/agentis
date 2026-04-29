import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import clsx from 'clsx';
import { api } from '../lib/api';
import { NodePalette } from '../components/canvas/NodePalette';
import { ContextInspector, type InspectorSelection } from '../components/canvas/ContextInspector';
import { RunDrawer } from '../components/canvas/RunDrawer';
import { AgentFocusOverlayManager } from '../components/canvas/AgentFocusOverlayManager';
import { Typewriter } from '../components/shared/Typewriter';

interface WorkflowDetail {
  id: string;
  title: string;
  summary: string | null;
  graph: {
    version: 1;
    nodes: Array<{
      id: string;
      type: string;
      title: string;
      position: { x: number; y: number };
      config: { kind: string; [k: string]: unknown };
    }>;
    edges: Array<{ id: string; source: string; target: string }>;
    viewport: { x: number; y: number; zoom: number };
  };
}

interface SkillRow {
  id: string;
  slug: string;
  name: string;
  runtime: string;
}

const NODE_GLYPH: Record<string, string> = {
  trigger: '◉',
  skill_task: '✦',
  agent_task: '◎',
  router: '⤳',
  merge: '⟴',
  checkpoint: '✓',
  subflow: '⊞',
  scratchpad: '◈',
};

export function WorkflowCanvasPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [wf, setWf] = useState<WorkflowDetail | null>(null);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selection, setSelection] = useState<InspectorSelection>({ kind: null });
  const overlayHostRef = useRef<HTMLDivElement | null>(null);
  const overlayManagerRef = useRef<AgentFocusOverlayManager | null>(null);

  useEffect(() => {
    if (!overlayHostRef.current) return;
    const mgr = new AgentFocusOverlayManager();
    mgr.attach(overlayHostRef.current);
    overlayManagerRef.current = mgr;
    return () => mgr.detach();
  }, []);

  useEffect(() => {
    if (!id) return;
    void api<{ workflow: WorkflowDetail }>(`/v1/workflows/${id}`).then((d) => setWf(d.workflow));
    void api<{ skills: SkillRow[] }>('/v1/skills').then((d) => setSkills(d.skills));
  }, [id]);

  // Auto-rebind any "BIND_AT_RUNTIME" skill_task to the echo skill if available,
  // because the seed workflow doesn't know skill IDs at template time.
  useEffect(() => {
    if (!wf) return;
    const echo = skills.find((s) => s.slug === 'echo');
    if (!echo) return;
    let changed = false;
    const nextNodes = wf.graph.nodes.map((n) => {
      if (n.config.kind === 'skill_task' && n.config.skillId === 'BIND_AT_RUNTIME') {
        changed = true;
        return { ...n, config: { ...n.config, skillId: echo.id } };
      }
      return n;
    });
    if (changed) {
      setWf({ ...wf, graph: { ...wf.graph, nodes: nextNodes } });
      void api(`/v1/workflows/${wf.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ graph: { ...wf.graph, nodes: nextNodes } }),
      }).catch(() => {});
    }
  }, [wf, skills]);

  const flowNodes = useMemo<Node[]>(() => {
    if (!wf) return [];
    return wf.graph.nodes.map((n) => ({
      id: n.id,
      type: 'agentis',
      position: n.position,
      data: { label: n.title, kind: n.config.kind, type: n.type },
    }));
  }, [wf]);

  const flowEdges = useMemo<Edge[]>(() => {
    if (!wf) return [];
    return wf.graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: false,
    }));
  }, [wf]);

  async function run() {
    if (!wf) return;
    setRunning(true);
    try {
      const res = await api<{ runId: string }>(`/v1/workflows/${wf.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ inputs: { hello: 'world' } }),
      });
      setActiveRunId(res.runId);
      setDrawerOpen(true);
      nav(`/runs/${res.runId}`);
    } finally {
      setRunning(false);
    }
  }

  if (!wf) return <div className="p-6 text-sm text-text-muted">Loading…</div>;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <button onClick={() => nav('/workflows')} className="text-xs text-text-muted hover:text-text-primary">
          ← Workflows
        </button>
        <span className="text-sm">{wf.title}</span>
        <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-accent">
          live
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={run}
            disabled={running}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-60"
          >
            {running ? 'Starting…' : 'Run'}
          </button>
          <button
            disabled
            title="Publishing to the skill registry lands later"
            className="rounded-lg bg-accent/90 px-3 py-1.5 text-xs font-medium text-canvas opacity-60"
          >
            Publish
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <NodePalette />
        <div ref={overlayHostRef} className="relative min-h-0 flex-1">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            fitView
            nodeTypes={{ agentis: AgentisNode }}
            onNodeClick={(_, n) =>
              setSelection({
                kind: 'node',
                nodeId: n.id,
                nodeType: (n.data as { type?: string }).type,
                data: n.data as Record<string, unknown>,
              })
            }
            onPaneClick={() => setSelection({ kind: null })}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} color="#1c2028" />
            <Controls position="bottom-right" />
          </ReactFlow>
          <RunDrawer runId={activeRunId} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
        </div>
        <ContextInspector selection={selection} onClose={() => setSelection({ kind: null })} />
      </div>
    </div>
  );
}

function AgentisNode({ data }: { data: { label: string; kind: string; type: string; toolPreview?: string } }) {
  const glyph = NODE_GLYPH[data.kind] ?? '•';
  const isTrigger = data.kind === 'trigger';
  return (
    <div
      className={clsx(
        'flex min-w-[160px] flex-col gap-1 rounded-node border bg-surface-2 px-3 py-2 shadow-card',
        isTrigger ? 'border-accent/60 shadow-glow' : 'border-line',
      )}
    >
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
