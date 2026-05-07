/**
 * HomePage — operator landing page.
 *
 * Layout (per UIUX-REPLAN §7.1):
 *   1. Honest greeting reflecting actual workspace state
 *   2. Perplexity-style chat input (recipient pill + clean text input + send)
 *   3. Suggestion chips computed from live state
 *   4. Gradient fade transition into:
 *      - Needs Attention (approvals, failed runs)
 *      - Live Right Now (active runs)
 *      - Recently Built (artifacts grid)
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Send, ChevronDown, Bot, AlertTriangle, XCircle, Check, X, Eye,
  RotateCcw, Zap, Layers, Sparkles, ArrowRight,
} from 'lucide-react';
import clsx from 'clsx';
import { api, workspace as wsStore } from '../lib/api';
import { useRealtime } from '../lib/realtime';
import { useToast } from '../components/shared/Toast';
import { Skeleton } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';
import { Button } from '../components/shared/Button';

interface Approval {
  id: string;
  agentName?: string;
  workflowName?: string;
  summary?: string;
  runId?: string;
  createdAt: string;
}

interface ActiveRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  currentStep?: string;
  totalSteps?: number;
  stepIndex?: number;
  startedAt: string;
  agents?: Array<{ id: string; name: string }>;
}

interface FailedRun {
  id: string;
  workflowName?: string;
  failedNode?: string;
  finishedAt?: string;
}

interface Artifact {
  id: string;
  title: string;
  agent?: string;
  createdAt: string;
  thumbUrl?: string;
  kind?: 'html' | 'image' | 'doc' | 'code' | 'data';
}

interface Agent { id: string; name: string; status?: string; }

const PLACEHOLDERS = [
  'Ask thomas to write the weekly newsletter…',
  'Run the Content Pipeline workflow again…',
  'What happened with the lead enrichment last night?',
  'Schedule the digest workflow for every Friday at 9am…',
  'Build a workflow that posts to LinkedIn every Monday…',
];

function relativeTime(iso: string): string {
  try {
    const diff = Math.max(0, Date.now() - new Date(iso).getTime());
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  } catch { return ''; }
}

function timeOfDay(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Good evening';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function HomePage() {
  const nav = useNavigate();
  const toast = useToast();

  const [me, setMe] = useState<{ name: string } | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([]);
  const [failedRuns, setFailedRuns] = useState<FailedRun[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);

  // Composer state
  const [recipient, setRecipient] = useState<{ id: string; name: string } | null>(null);
  const [recipientOpen, setRecipientOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  async function refresh() {
    if (!wsStore.get()) return;
    try {
      const [meRes, agentsRes, apsRes, runsRunningRes, runsFailedRes, artsRes] = await Promise.allSettled([
        api<{ user: { name: string } }>('/v1/auth/me'),
        api<{ agents: Agent[] }>('/v1/agents'),
        api<{ approvals: Approval[] }>('/v1/approvals?status=pending'),
        api<{ runs: ActiveRun[] }>('/v1/runs?status=running&limit=5'),
        api<{ runs: FailedRun[] }>('/v1/runs?status=failed&limit=3'),
        api<{ artifacts: Artifact[] }>('/v1/artifacts?limit=6'),
      ]);
      if (meRes.status === 'fulfilled') setMe(meRes.value.user ?? null);
      if (agentsRes.status === 'fulfilled') setAgents(agentsRes.value.agents ?? []);
      if (apsRes.status === 'fulfilled') setApprovals(apsRes.value.approvals ?? []);
      if (runsRunningRes.status === 'fulfilled') setActiveRuns(runsRunningRes.value.runs ?? []);
      if (runsFailedRes.status === 'fulfilled') setFailedRuns(runsFailedRes.value.runs ?? []);
      if (artsRes.status === 'fulfilled') setArtifacts(artsRes.value.artifacts ?? []);
    } catch { /* ignore */ }
    setLoading(false);
  }

  useEffect(() => { void refresh(); }, []);
  useRealtime(['approval.requested', 'approval.resolved', 'run.created', 'run.running', 'run.completed', 'run.failed'], () => {
    void refresh();
  });

  // Cycle placeholder
  useEffect(() => {
    const t = window.setInterval(() => setPlaceholderIdx((i) => (i + 1) % PLACEHOLDERS.length), 4500);
    return () => window.clearInterval(t);
  }, []);

  // Default recipient = first agent
  useEffect(() => {
    if (!recipient && agents[0]) {
      setRecipient({ id: agents[0].id, name: agents[0].name });
    }
  }, [agents, recipient]);

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = Math.min(160, Math.max(48, el.scrollHeight)) + 'px';
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || !recipient || sending) return;
    setSending(true);
    try {
      await api(`/v1/conversations/${recipient.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      toast.success('Sent', `To ${recipient.name}`);
      setDraft('');
      if (taRef.current) taRef.current.style.height = 'auto';
      // Optionally navigate to chat thread
      nav(`/chat/agent/${recipient.id}`);
    } catch (e) {
      toast.error('Failed to send', String(e));
    } finally {
      setSending(false);
    }
  }

  async function handleApprove(a: Approval) {
    try {
      await api(`/v1/approvals/${a.id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) });
      toast.success('Approved');
      void refresh();
    } catch (e) { toast.error('Failed to approve', String(e)); }
  }
  async function handleReject(a: Approval) {
    try {
      await api(`/v1/approvals/${a.id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'rejected' }) });
      toast.success('Rejected');
      void refresh();
    } catch (e) { toast.error('Failed to reject', String(e)); }
  }
  async function handleRetry(r: FailedRun) {
    try { await api(`/v1/runs/${r.id}/retry`, { method: 'POST' }); toast.success('Retry started'); void refresh(); }
    catch (e) { toast.error('Retry failed', String(e)); }
  }

  // Honest greeting
  const greeting = useMemo(() => {
    const tod = timeOfDay();
    const name = me?.name?.split(/\s+/)[0] ?? 'operator';
    let summary = 'Your fleet is ready.';
    const working = activeRuns.length;
    const need = approvals.length + failedRuns.length;
    if (need > 0 && working > 0) {
      summary = `${working} ${working === 1 ? 'run is' : 'runs are'} working. ${need} ${need === 1 ? 'thing needs' : 'things need'} your attention.`;
    } else if (need > 0) {
      summary = `${need} ${need === 1 ? 'thing needs' : 'things need'} your attention.`;
    } else if (working > 0) {
      summary = `${working} ${working === 1 ? 'agent is' : 'agents are'} working.`;
    } else if (artifacts.length > 0) {
      summary = `${artifacts.length} ${artifacts.length === 1 ? 'thing built' : 'things built'} recently. Everything looks calm.`;
    } else {
      summary = 'Your workspace is quiet. Ready when you are.';
    }
    return { greeting: `${tod}, ${name}.`, summary };
  }, [me?.name, activeRuns.length, approvals.length, failedRuns.length, artifacts.length]);

  // Suggestion chips
  const chips = useMemo(() => {
    const out: Array<{ label: string; onClick: () => void }> = [];
    if (approvals[0]) {
      out.push({
        label: `Review ${approvals[0].agentName ?? 'agent'}'s request`,
        onClick: () => document.getElementById('home-needs-attention')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      });
    }
    const firstRun = activeRuns[0];
    if (firstRun) {
      out.push({
        label: `Ask for a status update`,
        onClick: () => setDraft(`Give me a status update on ${firstRun.workflowName}.`),
      });
    }
    const firstArtifact = artifacts[0];
    if (firstArtifact) {
      out.push({
        label: `Improve "${firstArtifact.title}"`,
        onClick: () => setDraft(`Improve this: ${firstArtifact.title}`),
      });
    }
    if (out.length === 0) {
      if (agents.length === 0) {
        out.push({ label: 'Set up an agent', onClick: () => nav('/agents') });
      } else {
        out.push({ label: 'Create a workflow', onClick: () => nav('/workflows') });
      }
    }
    return out.slice(0, 4);
  }, [approvals, activeRuns, artifacts, agents.length, nav]);

  return (
    <div className="relative">
      {/* Hero / chat-first section */}
      <section className="px-6 pt-12 pb-20 md:px-12 md:pt-20">
        <div className="mx-auto max-w-3xl">
          <div className="text-center">
            <h1 className="text-display text-text-primary">{greeting.greeting}</h1>
            <p className="mt-2 text-[15px] text-text-secondary">{greeting.summary}</p>
          </div>

          {/* Composer */}
          <div className="mt-10 rounded-card border border-line bg-surface shadow-card">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              {/* Recipient pill */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setRecipientOpen((v) => !v)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-pill border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-primary hover:bg-surface-3"
                >
                  <Bot size={11} className="text-accent" />
                  {recipient?.name ?? 'Recipient'}
                  <ChevronDown size={11} className="text-text-muted" />
                </button>
                {recipientOpen && (
                  <div className="absolute z-10 mt-1.5 max-h-60 w-56 overflow-y-auto rounded-card border border-line bg-surface shadow-dropdown">
                    {agents.length === 0 ? (
                      <div className="p-3 text-[12px] text-text-muted">No agents available.</div>
                    ) : (
                      agents.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => { setRecipient({ id: a.id, name: a.name }); setRecipientOpen(false); }}
                          className={clsx(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors',
                            recipient?.id === a.id
                              ? 'bg-accent-soft text-accent'
                              : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                          )}
                        >
                          <Bot size={12} />
                          {a.name}
                          <span className="ml-auto text-[10px] text-text-muted">{a.status ?? ''}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <span className="text-[11px] text-text-muted">RECIPIENT</span>
            </div>

            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); autosize(e.target); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              rows={3}
              placeholder={PLACEHOLDERS[placeholderIdx]}
              className="block min-h-[88px] w-full resize-none bg-transparent px-4 py-3 text-[15px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none"
              style={{ maxHeight: 160 }}
            />

            <div className="flex items-center justify-between border-t border-line px-3 py-2">
              <span className="text-[11px] text-text-muted">
                Enter to send · Shift+Enter for newline
              </span>
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!draft.trim() || !recipient || sending}
                className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send size={12} /> Send
              </button>
            </div>
          </div>

          {/* Suggestion chips */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {chips.map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={c.onClick}
                className="inline-flex h-8 items-center rounded-pill border border-line bg-surface-2 px-3 text-[12px] font-medium text-text-secondary transition-colors hover:border-line-strong hover:bg-surface-3 hover:text-text-primary"
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="mt-12 text-center text-[11px] uppercase tracking-wider text-text-muted">
            ↓ Your active platform ↓
          </div>
        </div>

        {/* Smooth gradient fade into content */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -mt-16 h-24 section-fade-gradient" />
      </section>

      {/* Below-fold ops content */}
      <section className="px-6 pb-12 md:px-12">
        <div className="mx-auto max-w-5xl space-y-10">

          {/* Needs Attention */}
          {(approvals.length > 0 || failedRuns.length > 0) && (
            <div id="home-needs-attention">
              <SectionHeader label="Needs attention" count={approvals.length + failedRuns.length} />
              <div className="space-y-2">
                {approvals.map((a) => (
                  <div key={a.id} className="flex items-start gap-3 rounded-card border border-warn/20 bg-warn-soft p-4">
                    <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warn" />
                    <div className="min-w-0 flex-1">
                      <div className="text-subheading text-text-primary">Approval needed</div>
                      <div className="mt-0.5 text-[13px] text-text-secondary">
                        {a.summary || `${a.workflowName ?? 'Workflow'} · ${a.agentName ?? 'agent'}`}
                      </div>
                      <div className="mt-1 text-[11px] text-text-muted">{relativeTime(a.createdAt)}</div>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <Button
                        variant="primary" size="sm"
                        onClick={() => void handleApprove(a)}
                        iconLeft={<Check size={12} />}
                      >Approve</Button>
                      <Button
                        variant="secondary" size="sm"
                        onClick={() => void handleReject(a)}
                        iconLeft={<X size={12} />}
                      >Reject</Button>
                    </div>
                  </div>
                ))}
                {failedRuns.map((r) => (
                  <div key={r.id} className="flex items-start gap-3 rounded-card border border-danger/20 bg-danger-soft p-4">
                    <XCircle size={18} className="mt-0.5 shrink-0 text-danger" />
                    <div className="min-w-0 flex-1">
                      <div className="text-subheading text-text-primary">Workflow failed</div>
                      <div className="mt-0.5 text-[13px] text-text-secondary">
                        {r.workflowName ?? 'Workflow'}{r.failedNode ? ` · failed at ${r.failedNode}` : ''}
                      </div>
                      <div className="mt-1 text-[11px] text-text-muted">{relativeTime(r.finishedAt ?? new Date().toISOString())}</div>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <Button variant="secondary" size="sm" onClick={() => nav(`/runs/${r.id}`)} iconLeft={<Eye size={12} />}>View run</Button>
                      <Button variant="secondary" size="sm" onClick={() => void handleRetry(r)} iconLeft={<RotateCcw size={12} />}>Retry</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Live Right Now */}
          <div>
            <SectionHeader label="Live right now" count={activeRuns.length} />
            {loading && activeRuns.length === 0 ? (
              <div className="space-y-2">
                <Skeleton height={88} />
                <Skeleton height={88} />
              </div>
            ) : activeRuns.length === 0 ? (
              <EmptyState
                icon={<Zap size={48} />}
                title="No active runs"
                body="Your agents are idle. Start a workflow or ask an agent to do something."
                primaryAction={<Button variant="primary" size="sm" onClick={() => nav('/workflows')}>Create workflow</Button>}
              />
            ) : (
              <div className="space-y-2">
                {activeRuns.map((r) => (
                  <div key={r.id} className="rounded-card border border-line bg-surface p-4 transition-colors hover:bg-surface-2">
                    <div className="flex items-center gap-3">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-pill bg-accent-soft">
                        <span className="h-2 w-2 animate-pulse-dot rounded-full bg-accent" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-subheading text-text-primary">{r.workflowName}</span>
                          {r.stepIndex != null && r.totalSteps != null && (
                            <span className="text-[11px] text-text-muted">step {r.stepIndex}/{r.totalSteps}</span>
                          )}
                          <span className="text-[11px] text-text-muted">· {relativeTime(r.startedAt)}</span>
                        </div>
                        {r.currentStep && (
                          <div className="mt-0.5 text-[12px] text-text-muted">{r.currentStep}</div>
                        )}
                        {r.stepIndex != null && r.totalSteps != null && (
                          <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2">
                            <div
                              className="h-full bg-accent transition-all duration-300"
                              style={{ width: `${Math.min(100, (r.stepIndex / r.totalSteps) * 100)}%` }}
                            />
                          </div>
                        )}
                      </div>
                      <Button variant="ghost" size="sm" iconRight={<ArrowRight size={12} />} onClick={() => nav(`/runs/${r.id}`)}>View</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recently Built */}
          <div>
            <SectionHeader label="Recently built" />
            {loading && artifacts.length === 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
                <Skeleton height={140} />
                <Skeleton height={140} />
                <Skeleton height={140} />
              </div>
            ) : artifacts.length === 0 ? (
              <EmptyState
                icon={<Layers size={48} />}
                title="Nothing built yet"
                body="Your agents haven't built anything yet. Try asking one to create something."
                primaryAction={<Button variant="primary" size="sm" iconLeft={<Sparkles size={12} />} onClick={() => taRef.current?.focus()}>Ask an agent</Button>}
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
                {artifacts.slice(0, 6).map((a) => (
                  <div
                    key={a.id}
                    className="cursor-pointer overflow-hidden rounded-card border border-line bg-surface transition-colors hover:bg-surface-2"
                    onClick={() => toast.info('Open artifact', a.title)}
                  >
                    <div className="aspect-video bg-surface-2">
                      {a.thumbUrl ? (
                        <img src={a.thumbUrl} alt={a.title} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-text-muted">
                          <Layers size={28} />
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <div className="truncate text-subheading text-text-primary">{a.title}</div>
                      <div className="mt-0.5 text-[11px] text-text-muted">
                        {a.agent ?? 'system'} · {relativeTime(a.createdAt)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </section>
    </div>
  );
}

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="mb-3 flex items-end justify-between">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</h2>
      {count != null && count > 0 && (
        <span className="text-[11px] text-text-muted">{count}</span>
      )}
    </div>
  );
}
