/**
 * NotificationPanel — opaque, well-styled dropdown anchored to the bell.
 *
 * Replaces the previous transparent list. Shows human-readable
 * summaries with inline action buttons. Approval items always first.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Check, X, Eye, RotateCcw, AlertTriangle, XCircle, Clock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { ManagerGlyph, OrchestratorGlyph } from '../agents/AgentRoleGlyphs';
import { api, apiErrorMessage } from '../../lib/api';
import { refreshWorkspaceSnapshot, useWorkspaceData } from '../../lib/workspaceData';
import { useToast } from './Toast';
import { openRunModal } from '../../lib/runModal';

export interface AgentisNotification {
  id: string;
  type: 'approval' | 'failure' | 'completion' | 'info' | 'setup';
  title: string;
  context: string;
  timestamp: string;
  workflowId?: string;
  workflowName?: string;
  runId?: string;
  failedNodeId?: string;
  agentName?: string;
  approvalId?: string;
  actionLabel?: string;
  actionEvent?: string;
  actionPayload?: Record<string, unknown>;
}

function relativeTime(iso: string): string {
  try {
    const d = new Date(iso).getTime();
    const diff = Math.max(0, Date.now() - d);
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    return `${days}d ago`;
  } catch { return ''; }
}

export function NotificationPanel() {
  const [open, setOpen] = useState(false);
  const { workspaceId, notifications: items, loading } = useWorkspaceData();
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const toast = useToast();
  const [acknowledgedIds, setAcknowledgedIds] = useState<Set<string>>(new Set());
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const saved = readAcknowledgedNotificationIds(workspaceId);
    if (loading) {
      setAcknowledgedIds(saved);
      return;
    }
    const currentIds = new Set(items.map((item) => item.id));
    const next = new Set([...saved].filter((id) => currentIds.has(id)));
    setAcknowledgedIds(next);
    writeAcknowledgedNotificationIds(workspaceId, next);
  }, [items, workspaceId, loading]);

  useEffect(() => {
    const saved = readSeenNotificationIds(workspaceId);
    if (loading) {
      setSeenIds(saved);
      return;
    }
    const currentIds = new Set(items.map((item) => item.id));
    const next = new Set([...saved].filter((id) => currentIds.has(id)));
    setSeenIds(next);
    writeSeenNotificationIds(workspaceId, next);
  }, [items, workspaceId, loading]);

  const panelItems = useMemo(
    () => items.filter((item) => !acknowledgedIds.has(item.id)),
    [acknowledgedIds, items],
  );

  const unseenItems = useMemo(
    () => panelItems.filter((item) => !seenIds.has(item.id)),
    [panelItems, seenIds],
  );

  function acknowledgeNotifications(ids: string[]) {
    if (ids.length === 0) return;
    setAcknowledgedIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.add(id);
      writeAcknowledgedNotificationIds(workspaceId, next);
      return next;
    });
  }

  function markNotificationsSeen(ids: string[]) {
    if (ids.length === 0) return;
    setSeenIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.add(id);
      writeSeenNotificationIds(workspaceId, next);
      return next;
    });
  }

  useEffect(() => {
    if (!open) return;
    const unseen = panelItems.filter((item) => !seenIds.has(item.id)).map((item) => item.id);
    if (unseen.length > 0) markNotificationsSeen(unseen);
  }, [open, panelItems, seenIds]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function handleApprove(n: AgentisNotification) {
    if (!n.approvalId) return;
    try {
      await api(`/v1/approvals/${n.approvalId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve' }),
      });
      acknowledgeNotifications([n.id]);
      toast.success('Approved');
      void refreshWorkspaceSnapshot();
    } catch (e) {
      toast.error('Failed to approve', apiErrorMessage(e));
    }
  }

  async function handleReject(n: AgentisNotification) {
    if (!n.approvalId) return;
    try {
      await api(`/v1/approvals/${n.approvalId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'reject' }),
      });
      acknowledgeNotifications([n.id]);
      toast.success('Rejected');
      void refreshWorkspaceSnapshot();
    } catch (e) {
      toast.error('Failed to reject', apiErrorMessage(e));
    }
  }

  async function handleRetry(n: AgentisNotification) {
    if (!n.runId) return;
    try {
      await api(`/v1/runs/${n.runId}/retry`, { method: 'POST' });
      acknowledgeNotifications([n.id]);
      toast.success('Retry started');
      void refreshWorkspaceSnapshot();
    } catch (e) {
      toast.error('Retry failed', apiErrorMessage(e));
    }
  }

  const count = unseenItems.length;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${count ? ` (${count})` : ''}`}
        className={clsx(
          'relative inline-flex h-9 w-9 items-center justify-center rounded-btn border border-line bg-surface-2 text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary',
          open && 'bg-surface-3 text-text-primary',
        )}
      >
        <Bell size={14} />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          className="animate-fade-in absolute right-0 top-full z-[70] mt-2 w-[380px] max-w-[calc(100vw-2rem)] rounded-card border border-line bg-surface shadow-dropdown"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-subheading text-text-primary">Notifications</span>
            <button
              type="button"
              onClick={() => {
                acknowledgeNotifications(panelItems.map((item) => item.id));
                setOpen(false);
                nav('/history?tab=activity');
              }}
              className="text-[12px] text-text-muted hover:text-text-primary"
            >
              View all
            </button>
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {loading && panelItems.length === 0 && (
              <div className="px-4 py-6 text-center text-[12px] text-text-muted">Loading…</div>
            )}
            {!loading && panelItems.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <Bell size={32} className="text-text-muted opacity-50" />
                <span className="text-subheading text-text-primary">All caught up</span>
                <span className="text-[12px] text-text-muted">Nothing needs your attention right now.</span>
              </div>
            )}

            {panelItems.map((n) => (
              <div key={n.id} className="border-b border-line/60 px-4 py-3 last:border-b-0">
                <div className="flex items-start gap-2.5">
                  {n.type === 'approval' && <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />}
                  {n.type === 'failure' && <XCircle size={16} className="mt-0.5 shrink-0 text-danger" />}
                  {n.type === 'completion' && <Check size={16} className="mt-0.5 shrink-0 text-accent" />}
                  {n.type === 'info' && <Clock size={16} className="mt-0.5 shrink-0 text-info" />}
                  {n.type === 'setup' && n.id === 'setup-orchestrator' && <OrchestratorGlyph size={16} />}
                  {n.type === 'setup' && n.id === 'setup-managers' && <ManagerGlyph size={16} />}
                  <div className="min-w-0 flex-1">
                    <div className="text-subheading text-text-primary">{n.title}</div>
                    <div className="mt-0.5 text-[12px] text-text-secondary">{n.context}</div>
                    <div className="mt-1 text-[11px] text-text-muted">{relativeTime(n.timestamp)}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {n.type === 'approval' && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleApprove(n)}
                            className="inline-flex h-7 items-center gap-1 rounded-btn bg-accent px-2.5 text-[11px] font-medium text-canvas transition-colors hover:bg-accent-hover"
                          >
                            <Check size={11} /> Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => handleReject(n)}
                            className="inline-flex h-7 items-center gap-1 rounded-btn border border-line bg-surface-2 px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
                          >
                            <X size={11} /> Reject
                          </button>
                        </>
                      )}
                      {n.type === 'failure' && (
                        <>
                          {n.runId && (
                            <button
                              type="button"
                              onClick={() => {
                                acknowledgeNotifications([n.id]);
                                setOpen(false);
                                openRunModal({
                                  runId: n.runId,
                                  workflowId: n.workflowId,
                                  focusNodeId: n.failedNodeId,
                                  source: 'notification',
                                });
                              }}
                              className="inline-flex h-7 items-center gap-1 rounded-btn border border-line bg-surface-2 px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
                            >
                              <Eye size={11} /> Inspect
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRetry(n)}
                            className="inline-flex h-7 items-center gap-1 rounded-btn border border-line bg-surface-2 px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
                          >
                            <RotateCcw size={11} /> Retry
                          </button>
                        </>
                      )}
                      {n.type === 'setup' && n.actionEvent && (
                        <button
                          type="button"
                          onClick={() => {
                            acknowledgeNotifications([n.id]);
                            setOpen(false);
                            window.dispatchEvent(new CustomEvent(n.actionEvent!, { detail: n.actionPayload ?? {} }));
                          }}
                          className="inline-flex h-7 items-center gap-1 rounded-btn bg-accent px-2.5 text-[11px] font-semibold text-canvas transition-colors hover:bg-accent-hover"
                        >
                          {n.id === 'setup-orchestrator' && <OrchestratorGlyph size={11} />}
                          {n.id === 'setup-managers' && <ManagerGlyph size={11} />}
                          {n.actionLabel ?? 'Set up'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function notificationStorageKey(workspaceId: string | null): string | null {
  return workspaceId ? `agentis.notifications.ack.${workspaceId}` : null;
}

function seenNotificationStorageKey(workspaceId: string | null): string | null {
  return workspaceId ? `agentis.notifications.seen.${workspaceId}` : null;
}

function readAcknowledgedNotificationIds(workspaceId: string | null): Set<string> {
  const key = notificationStorageKey(workspaceId);
  if (!key) return new Set();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === 'string' && value.length > 0))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeAcknowledgedNotificationIds(workspaceId: string | null, ids: Set<string>): void {
  const key = notificationStorageKey(workspaceId);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

function readSeenNotificationIds(workspaceId: string | null): Set<string> {
  const key = seenNotificationStorageKey(workspaceId);
  if (!key) return new Set();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === 'string' && value.length > 0))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeSeenNotificationIds(workspaceId: string | null, ids: Set<string>): void {
  const key = seenNotificationStorageKey(workspaceId);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}
