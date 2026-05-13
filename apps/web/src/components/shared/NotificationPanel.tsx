/**
 * NotificationPanel — opaque, well-styled dropdown anchored to the bell.
 *
 * Replaces the previous transparent list. Shows human-readable
 * summaries with inline action buttons. Approval items always first.
 */

import { useEffect, useRef, useState } from 'react';
import { Bell, Check, X, Eye, RotateCcw, AlertTriangle, XCircle, Clock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { refreshWorkspaceSnapshot, useWorkspaceData } from '../../lib/workspaceData';
import { useToast } from './Toast';

export interface AgentisNotification {
  id: string;
  type: 'approval' | 'failure' | 'completion' | 'info';
  title: string;
  context: string;
  timestamp: string;
  workflowId?: string;
  workflowName?: string;
  runId?: string;
  agentName?: string;
  approvalId?: string;
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
  const { notifications: items, loading } = useWorkspaceData();
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const toast = useToast();

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
      await api(`/v1/approvals/${n.approvalId}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approved' }),
      });
      toast.success('Approved');
      void refreshWorkspaceSnapshot();
    } catch (e) {
      toast.error('Failed to approve', String(e));
    }
  }

  async function handleReject(n: AgentisNotification) {
    if (!n.approvalId) return;
    try {
      await api(`/v1/approvals/${n.approvalId}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'rejected' }),
      });
      toast.success('Rejected');
      void refreshWorkspaceSnapshot();
    } catch (e) {
      toast.error('Failed to reject', String(e));
    }
  }

  async function handleRetry(n: AgentisNotification) {
    if (!n.runId) return;
    try {
      await api(`/v1/runs/${n.runId}/retry`, { method: 'POST' });
      toast.success('Retry started');
      void refreshWorkspaceSnapshot();
    } catch (e) {
      toast.error('Retry failed', String(e));
    }
  }

  const count = items.length;

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
          className="animate-fade-in absolute right-0 top-full z-40 mt-2 w-[380px] max-w-[calc(100vw-2rem)] rounded-card border border-line bg-surface shadow-dropdown"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-subheading text-text-primary">Notifications</span>
            <button
              type="button"
              onClick={() => { setOpen(false); nav('/history'); }}
              className="text-[12px] text-text-muted hover:text-text-primary"
            >
              View all
            </button>
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {loading && items.length === 0 && (
              <div className="px-4 py-6 text-center text-[12px] text-text-muted">Loading…</div>
            )}
            {!loading && items.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <Bell size={32} className="text-text-muted opacity-50" />
                <span className="text-subheading text-text-primary">All caught up</span>
                <span className="text-[12px] text-text-muted">Nothing needs your attention right now.</span>
              </div>
            )}

            {items.map((n) => (
              <div key={n.id} className="border-b border-line/60 px-4 py-3 last:border-b-0">
                <div className="flex items-start gap-2.5">
                  {n.type === 'approval' && <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />}
                  {n.type === 'failure' && <XCircle size={16} className="mt-0.5 shrink-0 text-danger" />}
                  {n.type === 'completion' && <Check size={16} className="mt-0.5 shrink-0 text-accent" />}
                  {n.type === 'info' && <Clock size={16} className="mt-0.5 shrink-0 text-info" />}
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
                              onClick={() => { setOpen(false); nav(`/runs/${n.runId}`); }}
                              className="inline-flex h-7 items-center gap-1 rounded-btn border border-line bg-surface-2 px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
                            >
                              <Eye size={11} /> View run
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
