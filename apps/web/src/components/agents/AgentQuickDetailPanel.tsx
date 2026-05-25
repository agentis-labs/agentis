/**
 * AgentQuickDetailPanel — the daily check-in surface (AGENTS-PAGE-REDESIGN.md §2).
 *
 * A right-anchored slide-over that opens when an operator clicks an agent card
 * in Fleet view. Shows live status, channel connections, and meaningful quick
 * stats — without navigating away from the fleet. For changing configuration,
 * the operator uses "Open agent config →" to reach the full config page.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Download, Loader2, MessageCircle, Send, X } from 'lucide-react';
import clsx from 'clsx';
import { REALTIME_EVENTS } from '@agentis/core';
import { api } from '../../lib/api';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import { useToast } from '../shared/Toast';
import { useAgentInstallSession } from '../../hooks/useBackgroundInstall';
import { dismissInstallSession, type InstallSession } from '../../lib/backgroundInstall';

export interface QuickDetailAgent {
  id: string;
  name: string;
  status?: string | null;
  role?: string | null;
  adapterType?: string | null;
  runtimeModel?: string | null;
  avatarUrl?: string | null;
  avatarGlyph?: string | null;
  colorHex?: string | null;
  currentTask?: string | null;
  currentTaskId?: string | null;
  lastActiveAt?: string | null;
  lastHeartbeatAt?: string | null;
  isPaused?: boolean | null;
  runsToday?: number | null;
  spendTodayCents?: number | null;
  pendingApprovals?: number | null;
  monthlyBudgetCents?: number | null;
  currentMonthSpendCents?: number | null;
}

interface ChannelConnection {
  id: string;
  agentId: string;
  kind: string;
  name: string;
  status: string;
  defaultChatId: string | null;
}

const CHANNEL_PROVIDERS = [
  { kind: 'telegram', label: 'Telegram' },
  { kind: 'discord', label: 'Discord' },
] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return ((parts[0]![0] ?? '') + (parts[parts.length - 1]![0] ?? '')).toUpperCase();
}

function relativeTime(iso?: string | null): string {
  if (!iso) return 'unknown';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'unknown';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function harnessLabel(adapterType?: string | null): string {
  switch (adapterType) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes_agent': return 'Hermes Agent';
    case 'claude_code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'http': return 'HTTP / Webhook';
    default: return 'No harness';
  }
}

type Readiness = 'running' | 'live' | 'idle' | 'failed' | 'setting_up';

function readinessOf(status?: string | null, currentTaskId?: string | null, isPaused?: boolean | null, lastHeartbeatAt?: string | null): Readiness {
  if (status === 'setting_up') return 'setting_up';
  if (status === 'error') return 'failed';
  if (status === 'busy' || status === 'running' || currentTaskId) return 'running';
  if (isPaused || status === 'paused') return 'idle';
  if (status === 'online') return 'live';
  if (lastHeartbeatAt && Date.now() - new Date(lastHeartbeatAt).getTime() < 120_000) return 'live';
  return 'idle';
}

function formatMoney(cents?: number | null): string {
  const dollars = (cents ?? 0) / 100;
  return dollars >= 10 ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`;
}

export function AgentQuickDetailPanel({
  open,
  agent,
  onClose,
}: {
  open: boolean;
  agent: QuickDetailAgent | null;
  onClose: () => void;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const [channels, setChannels] = useState<ChannelConnection[]>([]);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [liveLine, setLiveLine] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const agentIdRef = useRef<string | null>(null);

  // Reset transient live state whenever a different agent is selected.
  useEffect(() => {
    if (agent?.id !== agentIdRef.current) {
      agentIdRef.current = agent?.id ?? null;
      setLiveStatus(null);
      setLiveLine(null);
      setCancelling(false);
    }
  }, [agent?.id]);

  useEffect(() => {
    if (!open || !agent) return;
    let cancelled = false;
    void api<{ connections: ChannelConnection[] }>('/v1/channels')
      .then((data) => {
        if (!cancelled) setChannels((data.connections ?? []).filter((conn) => conn.agentId === agent.id));
      })
      .catch(() => {
        if (!cancelled) setChannels([]);
      });
    return () => { cancelled = true; };
  }, [open, agent]);

  useEffect(() => {
    if (!open || !agent) return;
    return rtSubscribe('agent', { agentId: agent.id });
  }, [open, agent]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useRealtime(
    [
      REALTIME_EVENTS.AGENT_STATUS_CHANGED,
      REALTIME_EVENTS.AGENT_PRESENCE_THINKING,
      REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL,
      REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE,
    ],
    (env: RealtimeEnvelope) => {
      const payload = env.payload as Record<string, unknown>;
      if (!agent || (payload.agentId && payload.agentId !== agent.id)) return;
      if (env.event === REALTIME_EVENTS.AGENT_STATUS_CHANGED && typeof payload.status === 'string') {
        setLiveStatus(payload.status);
        return;
      }
      if (env.event === REALTIME_EVENTS.AGENT_PRESENCE_THINKING) {
        setLiveLine('thinking…');
        return;
      }
      if (env.event === REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL) {
        const tool = typeof payload.tool === 'string' ? payload.tool : typeof payload.name === 'string' ? payload.name : 'tool call';
        setLiveLine(`calling ${tool}`);
        return;
      }
      if (env.event === REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE) {
        const text = typeof payload.body === 'string' ? payload.body : typeof payload.text === 'string' ? payload.text : null;
        if (text) setLiveLine(text.slice(0, 120));
      }
    },
  );

  const cancelTask = useCallback(async () => {
    if (!agent?.currentTaskId) return;
    setCancelling(true);
    try {
      await api(`/v1/agents/${agent.id}/cancel-task/${agent.currentTaskId}`, { method: 'POST' });
      toast.success('Task cancelled');
    } catch (err) {
      toast.error('Could not cancel task', String(err));
    } finally {
      setCancelling(false);
    }
  }, [agent, toast]);

  const installSession = useAgentInstallSession(agent?.id);

  if (!open || !agent) return null;

  const status = liveStatus ?? agent.status ?? 'offline';
  const installComplete = installSession?.phase === 'complete';
  const installFailed = installSession?.phase === 'error';
  const installActive = installSession?.phase === 'installing' || installSession?.phase === 'verifying';
  const staleSetup = status === 'setting_up' && !installSession;
  const isSettingUp = installActive;
  const readiness = installComplete
    ? ('live' as Readiness)
    : installFailed || staleSetup
      ? ('failed' as Readiness)
      : isSettingUp
        ? ('setting_up' as Readiness)
        : readinessOf(status, agent.currentTaskId, agent.isPaused, agent.lastHeartbeatAt);
  const dotClass =
    readiness === 'setting_up' ? 'bg-cyan-500' :
    readiness === 'running' ? 'bg-warn' :
    readiness === 'live' ? 'bg-accent' :
    readiness === 'failed' ? 'bg-danger' : 'bg-text-muted';

  const runsToday = agent.runsToday ?? 0;
  const spendCents = agent.spendTodayCents ?? agent.currentMonthSpendCents ?? 0;
  const pending = agent.pendingApprovals ?? 0;
  const hasStats = runsToday > 0 || spendCents > 0 || pending > 0 || (agent.monthlyBudgetCents ?? 0) > 0;

  return (
    <>
      <div
        className="fixed inset-0 top-12 z-30 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${agent.name} — agent details`}
        className="animate-slide-in-right fixed right-0 top-12 z-40 flex h-[calc(100vh-3rem)] w-[400px] flex-col border-l border-line bg-surface shadow-card"
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full border border-line bg-surface-2">
            {agent.avatarUrl ? (
              <img src={agent.avatarUrl} alt={agent.name} className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[15px] font-semibold text-text-primary">
                {agent.avatarGlyph || initials(agent.name)}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-heading text-text-primary">{agent.name}</h2>
              <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', dotClass, (readiness === 'running' || readiness === 'setting_up') && 'animate-pulse')} />
            </div>
            <div className="mt-0.5 truncate text-[12px] capitalize text-text-muted">
              {agent.role ?? 'agent'} · {harnessLabel(agent.adapterType)}
              {agent.runtimeModel ? ` · ${agent.runtimeModel}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex gap-2 border-b border-line px-5 py-3">
          <button
            type="button"
            onClick={() => nav(`/chat/agent/${agent.id}`)}
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          >
            <MessageCircle size={13} /> Talk
          </button>
          <button
            type="button"
            onClick={() => nav(`/agents/${agent.id}`)}
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-btn border border-line bg-surface-2 px-3 text-[13px] font-medium text-text-secondary transition-colors hover:border-line-strong hover:text-text-primary"
          >
            Open agent <ArrowRight size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <Section title="Live status">
            <div className="rounded-[14px] border border-line bg-surface-2 px-4 py-3">
              {isSettingUp ? (
                installSession ? <InstallProgressPanel session={installSession} agentId={agent.id} /> : <SetupPendingPanel />
              ) : readiness === 'running' ? (
                <div className="space-y-2">
                  <div className="text-[13px] font-medium text-text-primary">
                    {agent.currentTask?.trim() || 'Working on a task'}
                  </div>
                  <div className="flex items-center gap-2 text-[12px] text-text-secondary">
                    <Loader2 size={12} className="animate-spin text-warn" />
                    {liveLine ?? 'running…'}
                  </div>
                  {agent.currentTaskId && (
                    <button
                      type="button"
                      onClick={() => void cancelTask()}
                      disabled={cancelling}
                      className="rounded-btn border border-danger px-2.5 py-1 text-[12px] font-medium text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
                    >
                      {cancelling ? 'Cancelling…' : 'Cancel task'}
                    </button>
                  )}
                </div>
              ) : readiness === 'failed' ? (
                <div className="text-[13px] text-danger">
                  {staleSetup
                    ? 'Runtime setup is not running. Open Runtime settings to find/connect or install the harness.'
                    : 'Last run failed - needs review.'}
                </div>
              ) : (
                <div className="text-[13px] text-text-secondary">
                  Waiting for work. <span className="text-text-muted">Last: {relativeTime(agent.lastActiveAt ?? agent.lastHeartbeatAt)}</span>
                </div>
              )}
            </div>
          </Section>

          <Section title="Channels">
            <div className="space-y-2">
              {CHANNEL_PROVIDERS.map((provider) => {
                const conn = channels.find((c) => c.kind === provider.kind);
                return (
                  <div
                    key={provider.kind}
                    className="flex items-center gap-2 rounded-[14px] border border-line bg-surface-2 px-3 py-2.5"
                  >
                    <span className="text-[13px] font-medium text-text-primary">{provider.label}</span>
                    {conn ? (
                      <>
                        <span className="flex items-center gap-1 text-[12px] text-accent">
                          <span className="h-1.5 w-1.5 rounded-full bg-accent" /> connected
                        </span>
                        <span className="ml-auto truncate text-[11px] text-text-muted">{conn.name}</span>
                      </>
                    ) : (
                      <>
                        <span className="flex items-center gap-1 text-[12px] text-text-muted">
                          <span className="h-1.5 w-1.5 rounded-full bg-text-muted" /> not set
                        </span>
                        <button
                          type="button"
                          aria-label={`Connect ${provider.label} to ${agent.name}`}
                          onClick={() => nav(`/agents/${agent.id}?tab=channels`)}
                          className="ml-auto inline-flex items-center gap-1 text-[12px] text-accent transition-opacity hover:opacity-80"
                        >
                          <Send size={11} /> Connect
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>

          {hasStats && (
            <Section title="Quick stats">
              <div className="grid grid-cols-2 gap-2">
                {runsToday > 0 && <Stat label="Runs today" value={String(runsToday)} />}
                {(spendCents > 0 || (agent.monthlyBudgetCents ?? 0) > 0) && (
                  <Stat
                    label="Budget"
                    value={
                      agent.monthlyBudgetCents
                        ? `${formatMoney(spendCents)} / ${formatMoney(agent.monthlyBudgetCents)}`
                        : formatMoney(spendCents)
                    }
                  />
                )}
                {pending > 0 && <Stat label="Pending approvals" value={String(pending)} />}
              </div>
            </Section>
          )}
        </div>

        <div className="border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={() => nav(`/agents/${agent.id}`)}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-btn border border-line bg-surface-2 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:border-line-strong hover:text-text-primary"
          >
            Open agent config <ArrowRight size={13} />
          </button>
        </div>
      </aside>
    </>
  );
}

function SetupPendingPanel() {
  return (
    <div className="flex items-center gap-2 text-[13px] text-text-secondary">
      Runtime setup is not running. Open Runtime settings to find/connect or install the harness.
    </div>
  );
}

/**
 * InstallProgressPanel — live install log shown inside the quick-detail panel
 * when an agent is in the "setting up" state. Shows steps, progress bar, and
 * a scrollable log of install output.
 */
function InstallProgressPanel({ session, agentId }: { session: InstallSession; agentId: string }) {
  const logEndRef = useRef<HTMLDivElement>(null);
  const totalSteps = 4;
  const completedSteps = session.steps.filter((s) => s.status === 'done').length;
  const progress = Math.min(100, Math.round((completedSteps / totalSteps) * 100));
  const hasError = session.phase === 'error';
  const isComplete = session.phase === 'complete';

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.logs.length]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {isComplete ? (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/20 text-accent">
            <Check size={11} />
          </span>
        ) : hasError ? (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-danger/20 text-danger">!</span>
        ) : (
          <Download size={14} className="animate-pulse text-cyan-400" />
        )}
        <span className={clsx('text-[13px] font-medium', isComplete ? 'text-accent' : hasError ? 'text-danger' : 'text-text-primary')}>
          {isComplete ? 'Runtime installed — agent is live' : hasError ? 'Installation failed' : 'Installing runtime…'}
        </span>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-canvas">
          <div
            className={clsx(
              'h-full rounded-full transition-all duration-500 ease-out',
              hasError ? 'bg-danger' : isComplete ? 'bg-accent' : 'bg-cyan-500',
            )}
            style={{ width: `${isComplete ? 100 : progress}%` }}
          />
        </div>
        <span className="text-[10px] tabular-nums text-text-muted">{isComplete ? 100 : progress}%</span>
      </div>

      {/* Steps list */}
      <div className="space-y-1">
        {session.steps.map((step) => (
          <div key={step.index} className="flex items-center gap-2 text-[12px]">
            {step.status === 'done' ? (
              <Check size={10} className="shrink-0 text-accent" />
            ) : step.status === 'error' ? (
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-danger" />
            ) : (
              <Loader2 size={10} className="shrink-0 animate-spin text-cyan-400" />
            )}
            <span className={clsx(
              'truncate',
              step.status === 'done' ? 'text-text-muted' : step.status === 'error' ? 'text-danger' : 'text-text-primary',
            )}>
              {step.label}
            </span>
            {step.detail && <span className="ml-auto truncate text-[10px] text-text-muted">{step.detail}</span>}
          </div>
        ))}
      </div>

      {/* Log output */}
      {session.logs.length > 0 && (
        <div className="max-h-28 overflow-y-auto rounded-md bg-canvas p-2 font-mono text-[10px] leading-relaxed text-text-muted">
          {session.logs.slice(-30).map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}

      {/* Error message */}
      {hasError && session.error && (
        <div className="rounded-md bg-danger/5 px-2.5 py-2 text-[12px] text-danger">
          {session.error}
        </div>
      )}

      {/* Dismiss button after completion or error */}
      {(isComplete || hasError) && (
        <button
          type="button"
          onClick={() => dismissInstallSession(agentId)}
          className="inline-flex h-7 items-center rounded-btn border border-line bg-canvas px-2.5 text-[11px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">{title}</div>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] border border-line bg-surface-2 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{label}</div>
      <div className="mt-1 text-[15px] font-semibold tracking-[-0.02em] text-text-primary">{value}</div>
    </div>
  );
}
