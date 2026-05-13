/**
 * NotificationBell — header notification surface (AGENTIS-UX-V2 §2.4).
 *
 * Phase 2: full popover with three buckets - pending approvals, failed
 * runs, and room mentions. Live updates via realtime approvals, runs, and
 * room message events.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, AlertTriangle, CheckCircle2, MessageSquare, X } from 'lucide-react';
import clsx from 'clsx';
import { REALTIME_EVENTS } from '@agentis/core';
import { api } from '../../lib/api';
import { useRealtime } from '../../lib/realtime';

interface ApprovalRow {
  id: string;
  status: string;
  title?: string;
  summary?: string;
  createdAt?: string;
  source?: string;
}

interface RunRow {
  id: string;
  status: string;
  workflowId: string;
  workflowName?: string;
  failureReason?: string | null;
  finishedAt?: string | null;
}

interface MentionRow {
  id: string;
  roomId: string;
  roomName?: string;
  authorType: string;
  authorId?: string | null;
  contentType: string;
  content: Record<string, unknown> | string | null;
  createdAt: string;
}

export function NotificationBell() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [failedRuns, setFailedRuns] = useState<RunRow[]>([]);
  const [mentions, setMentions] = useState<MentionRow[]>([]);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  async function refresh() {
    await Promise.all([
      api<{ approvals: ApprovalRow[] }>('/v1/approvals?status=pending')
        .then((r) => setApprovals(r.approvals ?? []))
        .catch(() => undefined),
      api<{ runs: RunRow[] }>('/v1/runs?status=failed&limit=10')
        .then((r) => setFailedRuns(r.runs ?? []))
        .catch(() => undefined),
      api<{ mentions: MentionRow[] }>('/v1/rooms/mentions?limit=10')
        .then((r) => setMentions(r.mentions ?? []))
        .catch(() => undefined),
    ]);
  }

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('agentis:open-notifications', onOpen);
    return () => window.removeEventListener('agentis:open-notifications', onOpen);
  }, []);

  useRealtime(
    [
      REALTIME_EVENTS.APPROVAL_REQUESTED,
      REALTIME_EVENTS.APPROVAL_RESOLVED,
      REALTIME_EVENTS.RUN_FAILED,
      REALTIME_EVENTS.ROOM_MESSAGE_SENT,
      REALTIME_EVENTS.ROOM_MESSAGE_RECEIVED,
    ],
    () => void refresh(),
  );

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const total = approvals.length + failedRuns.length + mentions.length;
  const hasAny = total > 0;

  async function dismissApproval(id: string) {
    try {
      await api(`/v1/approvals/${id}/dismiss`, { method: 'POST' });
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch {
      /* best-effort */
    }
  }

  async function snoozeApproval(id: string, hours = 4) {
    const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    try {
      await api(`/v1/approvals/${id}/snooze`, {
        method: 'POST',
        body: JSON.stringify({ until }),
      });
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch {
      /* best-effort */
    }
  }

  async function resolveApproval(id: string, decision: 'approve' | 'reject') {
    try {
      await api(`/v1/approvals/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch {
      /* best-effort */
    }
  }

  const renderedApprovals = useMemo(() => approvals.slice(0, 5), [approvals]);
  const renderedRuns = useMemo(() => failedRuns.slice(0, 5), [failedRuns]);
  const renderedMentions = useMemo(() => mentions.slice(0, 5), [mentions]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={hasAny ? `${total} notification${total > 1 ? 's' : ''}` : 'No notifications'}
        aria-label="Notifications"
        aria-expanded={open}
        className={clsx(
          'relative inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface-2 text-text-muted transition hover:border-accent/40 hover:text-accent',
          hasAny && 'text-accent',
        )}
      >
        <Bell size={14} />
        {hasAny && (
          <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-medium text-canvas">
            {total > 99 ? '99+' : total}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-9 z-50 w-[360px] rounded-lg border border-line bg-surface-1 shadow-2xl"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-xs font-medium text-text">Notifications</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-text-muted hover:text-text"
              aria-label="Close"
            >
              <X size={12} />
            </button>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            <Section
              title="Approvals"
              icon={<CheckCircle2 size={12} className="text-accent" />}
              empty="No pending approvals"
              items={renderedApprovals}
              renderItem={(a) => (
                <div className="flex flex-col gap-1 border-b border-line/40 px-3 py-2 last:border-0">
                  <div className="text-left text-xs font-medium text-text">
                    {a.title ?? a.summary ?? a.id}
                  </div>
                  {a.summary && a.title !== a.summary && (
                    <span className="text-[11px] text-text-muted">{a.summary}</span>
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => void resolveApproval(a.id, 'approve')}
                      className="rounded-md bg-accent px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-canvas"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void resolveApproval(a.id, 'reject')}
                      className="rounded-md border border-line px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-text-muted hover:text-danger"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => void snoozeApproval(a.id, 4)}
                      className="text-[10px] uppercase tracking-wide text-text-muted hover:text-accent"
                    >
                      Snooze 4h
                    </button>
                    <button
                      type="button"
                      onClick={() => void dismissApproval(a.id)}
                      className="text-[10px] uppercase tracking-wide text-text-muted hover:text-accent"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            />
            <Section
              title="Failed runs"
              icon={<AlertTriangle size={12} className="text-status-error" />}
              empty="No failed runs"
              items={renderedRuns}
              renderItem={(r) => (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    nav(`/runs/${r.id}`);
                  }}
                  className="flex w-full flex-col gap-0.5 border-b border-line/40 px-3 py-2 text-left last:border-0 hover:bg-surface-2"
                >
                  <span className="text-xs font-medium text-text">
                    {r.workflowName ?? r.workflowId}
                  </span>
                  <span className="text-[11px] text-text-muted">
                    {r.failureReason ?? 'Run failed'}
                  </span>
                </button>
              )}
            />
            <Section
              title="Mentions"
              icon={<MessageSquare size={12} className="text-accent" />}
              empty="No mentions yet"
              items={renderedMentions}
              renderItem={(mention) => (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    window.dispatchEvent(
                      new CustomEvent('agentis:chat-panel-open', { detail: { roomId: mention.roomId } }),
                    );
                  }}
                  className="flex w-full flex-col gap-0.5 border-b border-line/40 px-3 py-2 text-left last:border-0 hover:bg-surface-2"
                >
                  <span className="text-xs font-medium text-text">
                    {mention.roomName ?? 'Room mention'}
                  </span>
                  <span className="line-clamp-2 text-[11px] text-text-muted">
                    {mentionSummary(mention)}
                  </span>
                </button>
              )}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface SectionProps<T> {
  title: string;
  icon: ReactNode;
  empty: string;
  items: T[];
  renderItem: (item: T) => ReactNode;
}

function Section<T>({ title, icon, empty, items, renderItem }: SectionProps<T>) {
  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        {icon}
        {title}
        <span className="ml-auto text-[10px] text-text-muted/60">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="px-3 pb-3 text-[11px] text-text-muted/70">{empty}</div>
      ) : (
        items.map((item, i) => <div key={i}>{renderItem(item)}</div>)
      )}
    </div>
  );
}

function mentionSummary(mention: MentionRow): string {
  const content = normalizeMentionContent(mention.content);
  const text = String(content.text ?? content.body ?? content.summary ?? content.title ?? '').trim();
  const author = mention.authorType === 'agent' ? 'Agent' : mention.authorType === 'system' ? 'System' : 'Operator';
  return text ? `${author}: ${text}` : `${author} mentioned you`;
}

function normalizeMentionContent(content: MentionRow['content']): Record<string, unknown> {
  if (!content) return {};
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return parsed && typeof parsed === 'object' ? parsed : { text: content };
    } catch {
      return { text: content };
    }
  }
  return content;
}
