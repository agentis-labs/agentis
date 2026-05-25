/**
 * WorkflowBuilderPage — the Builder Session (ORCHESTRATOR-CREATION-10X §9).
 *
 * The paradigm shift: creation is a session, not a tool call. Split-pane —
 * builder chat (left: describe → Phase Cards → specialist roster) + a live
 * canvas (right) that animates nodes in as the workflow is built.
 *
 *   Step 1  describe the workflow
 *   Step 2  Plan → editable Phase Cards with a live cost meter
 *   Step 3  Approve & build → the graph streams onto the live canvas
 *   Step 4  Open the full canvas to wire integrations / run
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Sparkles, Maximize2 } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, apiErrorMessage, workspace as workspaceStore } from '../lib/api';
import { rtSubscribe, useRealtime } from '../lib/realtime';
import { PhaseCards, type WorkflowPlanView } from '../components/workflows/PhaseCards';
import { CanvasEmbed } from '../components/ChatPanel/CanvasEmbed';
import { Button } from '../components/shared/Button';
import { useToast } from '../components/shared/Toast';

interface AgentRow { id: string; name: string; role?: string | null; status?: string }
interface CastMember { role: string; status: 'online' | 'offline' | 'unknown'; fallback?: string }

interface BuildResult {
  workflowId: string;
  runId: string;
  title: string;
  nodeCount: number;
  archetype: string;
  warnings?: Array<{ message: string }>;
}

const ROLE_GLYPH: Record<string, string> = {
  planner: '◆', researcher: '◎', coder: '⌨', reviewer: '⚖', analyst: '▤',
  writer: '✎', monitor: '◉', architect: '⌗', debugger: '☣', deployer: '⬢',
};

export function WorkflowBuilderPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [description, setDescription] = useState('');
  const [plan, setPlan] = useState<WorkflowPlanView | null>(null);
  const [planning, setPlanning] = useState(false);
  const [building, setBuilding] = useState(false);
  const [built, setBuilt] = useState<BuildResult | null>(null);
  const [specialists, setSpecialists] = useState<AgentRow[]>([]);
  const [castTeam, setCastTeam] = useState<CastMember[]>([]);
  const seenRoom = useRef(false);

  // §3 — the cast team announced before the graph streams.
  useRealtime([REALTIME_EVENTS.WORKFLOW_TEAM_ROSTER], (env) => {
    const roster = (env.payload as { roster?: CastMember[] }).roster;
    if (Array.isArray(roster)) setCastTeam(roster);
  });

  // Subscribe to the workspace realtime room so the live canvas receives the
  // streamed CANVAS_NODE_PLACED / EDGE_CONNECTED / BUILD_COMPLETE events.
  useEffect(() => {
    const wsId = workspaceStore.get();
    if (!wsId || seenRoom.current) return;
    seenRoom.current = true;
    const off = rtSubscribe('workspace', { workspaceId: wsId });
    return () => { off?.(); seenRoom.current = false; };
  }, []);

  useEffect(() => {
    void api<{ agents: AgentRow[] }>('/v1/agents')
      .then((d) => setSpecialists((d.agents ?? []).filter((a) => a.role)))
      .catch(() => {});
  }, []);

  async function runPlan() {
    if (!description.trim()) return;
    setPlanning(true);
    setPlan(null);
    try {
      const res = await api<{ plan: WorkflowPlanView }>('/v1/workflows/plan', {
        method: 'POST', body: JSON.stringify({ description: description.trim() }),
      });
      setPlan(res.plan);
    } catch (err) {
      toast.error('Planning failed', apiErrorMessage(err));
    } finally {
      setPlanning(false);
    }
  }

  async function runBuild() {
    if (!description.trim()) return;
    setBuilding(true);
    setBuilt(null);
    try {
      const res = await api<BuildResult>('/v1/workflows/build', {
        method: 'POST',
        // When the operator planned + edited, the (edited) plan drives a
        // deterministic build; otherwise the description is synthesized.
        body: JSON.stringify({ description: description.trim(), stream: true, plan: plan ?? undefined }),
      });
      setBuilt(res);
      toast.success('Workflow built', `${res.title} · ${res.nodeCount} nodes`);
    } catch (err) {
      toast.error('Build failed', apiErrorMessage(err));
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Link to="/workflows" className="rounded p-1 text-text-muted hover:text-text-primary" aria-label="Back">
          <ArrowLeft size={16} />
        </Link>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Builder Session</div>
          <div className="text-subheading text-text-primary">Build with AI</div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left — builder chat */}
        <div className="flex w-[420px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-line p-4">
          <label className="text-[11px] font-medium text-text-secondary">Describe the workflow</label>
          <textarea
            rows={4}
            className="w-full rounded-input border border-line bg-surface-2 px-2.5 py-2 text-[12px] text-text-primary"
            placeholder="e.g. Every morning, fetch the top tech blogs, rank the AI stories, draft a digest, and email it to the team."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" iconLeft={<Sparkles size={12} />} onClick={() => void runPlan()} disabled={planning || !description.trim()}>
              {planning ? 'Planning…' : 'Plan phases'}
            </Button>
            <Button variant="primary" size="sm" iconLeft={<Sparkles size={12} />} onClick={() => void runBuild()} disabled={building || !description.trim()}>
              {building ? 'Building…' : 'Build it'}
            </Button>
          </div>

          {plan && (
            <PhaseCards
              plan={plan}
              editable
              onChange={(phases) => setPlan({ ...plan, phases })}
              onApproveAll={() => void runBuild()}
              onRedesign={() => { setPlan(null); }}
            />
          )}

          {castTeam.length > 0 && (
            <div className="rounded-md border border-line bg-surface-2 p-2.5">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">Cast for this build</div>
              <div className="flex flex-col gap-1">
                {castTeam.map((m) => (
                  <div key={m.role} className="flex items-center gap-2 text-[11px]">
                    <span>{ROLE_GLYPH[m.role] ?? '•'}</span>
                    <span className="text-text-primary">{m.role}</span>
                    <span className={`ml-auto inline-block h-1.5 w-1.5 rounded-full ${m.status === 'online' ? 'bg-emerald-400' : 'bg-warn'}`} />
                    {m.status !== 'online' && (
                      <span className="text-warn">{m.fallback ? `→ ${m.fallback} fallback` : 'offline'}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Specialist roster */}
          <div className="mt-2">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">Specialist roster</div>
            {specialists.length === 0 ? (
              <p className="text-[11px] text-text-muted">No specialist agents yet — they seed on first use.</p>
            ) : (
              <div className="flex flex-col gap-1">
                {specialists.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 rounded border border-line bg-surface-2 px-2 py-1 text-[11px]">
                    <span className="text-text-secondary">{ROLE_GLYPH[a.role ?? ''] ?? '•'}</span>
                    <span className="truncate text-text-primary">{a.name}</span>
                    <span className={`ml-auto inline-block h-1.5 w-1.5 rounded-full ${a.status === 'online' ? 'bg-emerald-400' : 'bg-text-muted'}`} />
                    <span className="text-text-muted">{a.role}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {built && (
            <div className="mt-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-2.5 text-[11px]">
              <div className="font-medium text-text-primary">Built “{built.title}” · {built.nodeCount} nodes · {built.archetype}</div>
              {built.warnings && built.warnings.length > 0 && (
                <p className="mt-1 text-warn">{built.warnings.length} item(s) need attention.</p>
              )}
              <button type="button" onClick={() => nav(`/workflows/${built.workflowId}`)} className="mt-2 inline-flex items-center gap-1 text-accent hover:underline">
                <Maximize2 size={11} /> Open full canvas
              </button>
            </div>
          )}
        </div>

        {/* Right — live canvas */}
        <div className="flex min-w-0 flex-1 flex-col bg-canvas p-4">
          {built ? (
            <CanvasEmbed runId={built.runId} workflowId={built.workflowId} />
          ) : (
            <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
              {building ? 'Building your workflow…' : 'Plan and build to see your workflow appear here.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
