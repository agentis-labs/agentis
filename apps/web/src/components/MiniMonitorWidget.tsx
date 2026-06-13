import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Crown, RadioTower, Send, Sparkles, X } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import clsx from 'clsx';
import { api } from '../lib/api';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../lib/realtime';
import { describeRealtimeActivity } from '../lib/realtimeActivity';
import { refreshWorkspaceSnapshot, useWorkspaceData, type WorkspaceActiveRun, type WorkspaceNotification } from '../lib/workspaceData';
import { usePrimaryChatScopes } from './chat/usePrimaryChatScopes';
import { useChatPanelStore } from './chat/ChatPanelStore';
import { useToast } from './shared/Toast';

interface FeedItem {
  id: string;
  title: string;
  detail: string;
  tone: 'accent' | 'warn' | 'danger' | 'muted';
  timestamp: string;
}

const MONITOR_EVENTS = [
  REALTIME_EVENTS.RUN_CREATED,
  REALTIME_EVENTS.RUN_COMPLETED,
  REALTIME_EVENTS.RUN_FAILED,
  REALTIME_EVENTS.APPROVAL_REQUESTED,
  REALTIME_EVENTS.APPROVAL_RESOLVED,
  REALTIME_EVENTS.AGENT_WORK_STEP,
  REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL,
  REALTIME_EVENTS.AGENT_STATUS_CHANGED,
] as const;

export function MiniMonitorWidget({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { workspaceId, approvals, failedRuns, activeRuns, notifications, counts } = useWorkspaceData();
  const { orchestrator } = usePrimaryChatScopes();
  const chatState = useChatPanelStore((state) => state.state);
  const dockedWidth = useChatPanelStore((state) => state.dockedWidth);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open || !workspaceId) return undefined;
    return rtSubscribe('workspace', { workspaceId });
  }, [open, workspaceId]);

  useEffect(() => {
    if (!open) return;
    setFeed(buildSeedFeed(notifications, activeRuns));
  }, [activeRuns, notifications, open]);

  useRealtime([...MONITOR_EVENTS], (env) => {
    if (!open) return;
    const next = describeMonitorEvent(env);
    if (!next) return;
    setFeed((current) => [next, ...current].slice(0, 8));
  });

  const topApproval = approvals[0] ?? null;
  const rightOffset = chatState === 'docked' ? dockedWidth + 20 : 16;
  const activeSummary = useMemo(() => activeRuns.slice(0, 2), [activeRuns]);

  if (!open) return null;

  async function resolveApproval(decision: 'approve' | 'reject') {
    if (!topApproval) return;
    try {
      await api(`/v1/approvals/${topApproval.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      toast.success(decision === 'approve' ? 'Approval accepted' : 'Approval rejected');
      void refreshWorkspaceSnapshot();
    } catch (error) {
      toast.error('Approval action failed', error instanceof Error ? error.message : String(error));
    }
  }

  async function sendQuestion() {
    const body = draft.trim();
    if (!body) return;
    if (!orchestrator) {
      toast.warn('No orchestrator yet', 'Commission the workspace orchestrator before sending monitor prompts.');
      return;
    }
    setSending(true);
    try {
      await api('/v1/conversations/orchestrator/send', {
        method: 'POST',
        body: JSON.stringify({ body, message: body }),
      });
      const store = useChatPanelStore.getState();
      store.selectThread({ kind: 'agent', id: orchestrator.id, name: orchestrator.name });
      store.setState('docked');
      setDraft('');
      toast.success('Sent to orchestrator', body);
    } catch (error) {
      toast.error('Could not send prompt', error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      className="fixed bottom-4 z-[65] w-[320px] overflow-hidden rounded-2xl border border-line/80 bg-canvas/95 shadow-2xl backdrop-blur-xl"
      style={{ right: rightOffset }}
      aria-label="Mini monitor"
    >
      <header className="flex items-center gap-2 border-b border-line/70 px-3 py-2.5">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-accent/25 bg-accent-soft text-accent">
          <RadioTower size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-text-muted">Mini Monitor</div>
          <div className="truncate text-[12px] text-text-secondary">
            {orchestrator ? `${orchestrator.name} live` : 'Waiting for orchestrator setup'}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close mini monitor"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text-primary"
        >
          <X size={14} />
        </button>
      </header>

      <div className="grid grid-cols-3 gap-2 border-b border-line/60 px-3 py-3">
        <Metric value={counts.liveAgents} label="live" tone="accent" />
        <Metric value={activeRuns.length} label="runs" tone="muted" />
        <Metric value={approvals.length + failedRuns.length} label="attention" tone={approvals.length + failedRuns.length > 0 ? 'warn' : 'muted'} />
      </div>

      {activeSummary.length > 0 && (
        <div className="border-b border-line/60 px-3 py-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">Working now</div>
          <div className="space-y-2">
            {activeSummary.map((run) => (
              <div key={run.id} className="rounded-xl border border-line bg-surface/80 px-3 py-2">
                <div className="truncate text-[12px] font-medium text-text-primary">{run.workflowName}</div>
                <div className="mt-1 truncate text-[11px] text-text-secondary">{run.currentStep ?? run.status}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {topApproval && (
        <div className="border-b border-line/60 px-3 py-3">
          <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-warn">
            <AlertTriangle size={12} />
            Needs operator
          </div>
          <div className="rounded-xl border border-warn/30 bg-warn-soft px-3 py-2.5">
            <div className="text-[12px] font-medium text-text-primary">{topApproval.agentName ?? 'Approval request'}</div>
            <div className="mt-1 text-[11px] text-text-secondary">{topApproval.summary ?? topApproval.workflowName ?? 'A run is waiting for a human decision.'}</div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void resolveApproval('approve')}
                className="inline-flex h-7 items-center gap-1 rounded-btn bg-accent px-2.5 text-[11px] font-medium text-canvas hover:bg-accent-hover"
              >
                <Check size={11} />
                Approve
              </button>
              <button
                type="button"
                onClick={() => void resolveApproval('reject')}
                className="inline-flex h-7 items-center rounded-btn border border-line bg-surface-2 px-2.5 text-[11px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="border-b border-line/60 px-3 py-3">
        <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">
          <Sparkles size={12} />
          Live feed
        </div>
        <div className="space-y-2">
          {feed.length === 0 ? (
            <div className="rounded-xl border border-line bg-surface/60 px-3 py-3 text-[11px] text-text-muted">
              Waiting for realtime activity.
            </div>
          ) : feed.map((item) => (
            <div key={item.id} className="rounded-xl border border-line bg-surface/60 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className={clsx(
                  'h-1.5 w-1.5 rounded-full',
                  item.tone === 'accent' && 'bg-accent',
                  item.tone === 'warn' && 'bg-warn',
                  item.tone === 'danger' && 'bg-danger',
                  item.tone === 'muted' && 'bg-text-muted/60',
                )} />
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text-primary">{item.title}</span>
                <span className="text-[10px] text-text-muted">{relativeTime(item.timestamp)}</span>
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-text-secondary">{item.detail}</div>
            </div>
          ))}
        </div>
      </div>

      <form
        className="flex items-center gap-2 px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void sendQuestion();
        }}
      >
        <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-2 text-text-muted">
          <Crown size={13} />
        </div>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={orchestrator ? 'Ask the orchestrator...' : 'Commission the orchestrator first'}
          disabled={!orchestrator || sending}
          className="h-9 min-w-0 flex-1 rounded-btn border border-line bg-surface-2 px-3 text-[12px] text-text-primary outline-none placeholder:text-text-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!orchestrator || sending || !draft.trim()}
          aria-label="Send monitor prompt"
          className="inline-flex h-9 w-9 items-center justify-center rounded-btn bg-accent text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send size={13} />
        </button>
      </form>
    </section>
  );
}

function Metric({ value, label, tone }: { value: number; label: string; tone: 'accent' | 'warn' | 'muted' }) {
  return (
    <div className="rounded-xl border border-line bg-surface/70 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[0.16em] text-text-muted">{label}</div>
      <div className={clsx(
        'mt-1 text-lg font-semibold',
        tone === 'accent' && 'text-accent',
        tone === 'warn' && 'text-warn',
        tone === 'muted' && 'text-text-primary',
      )}>{value}</div>
    </div>
  );
}

function buildSeedFeed(notifications: WorkspaceNotification[], activeRuns: WorkspaceActiveRun[]): FeedItem[] {
  const next: FeedItem[] = [];
  for (const item of notifications.slice(0, 3)) {
    next.push({
      id: item.id,
      title: item.title,
      detail: item.context,
      tone: item.type === 'approval' ? 'warn' : item.type === 'failure' ? 'danger' : 'muted',
      timestamp: item.timestamp,
    });
  }
  for (const run of activeRuns.slice(0, 3)) {
    next.push({
      id: `run-${run.id}`,
      title: run.workflowName,
      detail: run.currentStep ?? run.status,
      tone: 'accent',
      timestamp: run.startedAt,
    });
  }
  return next.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 6);
}

function describeMonitorEvent(env: RealtimeEnvelope): FeedItem | null {
  const activity = describeRealtimeActivity(env);
  if (!activity) return null;
  return {
    id: `feed-${activity.id}`,
    title: activity.title,
    detail: activity.detail,
    tone: activity.tone === 'success' ? 'accent' : activity.tone,
    timestamp: activity.at,
  };
}

function relativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return 'now';
  const diff = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

