/**
 * AgentLiveFeed — the canvas "LIVE" panel.
 *
 * One collapsible section per active/recent agent, ordered orchestrator →
 * managers → workers to mirror the canvas hierarchy. Each section streams
 * what its agent is doing right now and resolves approvals inline, so the
 * operator never has to leave the canvas.
 *
 * Replaces the old event-centric `ActivityRail`.
 */

import { useMemo, useState } from 'react';
import { Check, ChevronDown, Radio, X } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import type { WorkspaceActiveRun, WorkspaceAgent, WorkspaceApproval } from '../../lib/workspaceData';
import {
  useAgentLiveFeed,
  type AgentFeedSection,
  type AgentFeedStatus,
  type FeedLine,
} from './useAgentLiveFeed';

interface AgentLiveFeedProps {
  agents: WorkspaceAgent[];
  activeRuns: WorkspaceActiveRun[];
  approvals: WorkspaceApproval[];
  onRefresh: () => void;
  onSelectNode?: (nodeId: string) => void;
}

const STALE_MS = 2 * 60_000;

export function AgentLiveFeed({ agents, activeRuns, approvals, onRefresh, onSelectNode }: AgentLiveFeedProps) {
  const sections = useAgentLiveFeed(agents, activeRuns, approvals);
  const [collapsed, setCollapsed] = useState(false);
  const [resolving, setResolving] = useState<Record<string, boolean>>({});

  const visible = useMemo(() => sections.filter((s) => !resolving[s.approval?.id ?? '']), [sections, resolving]);

  if (visible.length === 0) return null;

  const workingCount = visible.filter((s) => s.status === 'working').length;
  const waitingCount = visible.filter((s) => s.status === 'waiting').length;

  async function resolveApproval(approvalId: string, decision: 'approve' | 'reject') {
    setResolving((current) => ({ ...current, [approvalId]: true }));
    try {
      await api(`/v1/approvals/${approvalId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
    } catch {
      setResolving((current) => {
        const next = { ...current };
        delete next[approvalId];
        return next;
      });
      return;
    }
    onRefresh();
  }

  return (
    <div
      data-canvas-control
      className="absolute left-4 top-20 z-40 hidden w-80 overflow-hidden rounded-2xl border border-line/60 bg-surface/75 shadow-card backdrop-blur-md lg:block"
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2"
      >
        <Radio size={12} className="shrink-0 text-accent" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Live</span>
        <span className="flex-1 truncate text-[10px] text-text-muted">
          {summaryLabel(workingCount, waitingCount, visible.length)}
        </span>
        <ChevronDown
          size={14}
          className={clsx('shrink-0 text-text-muted transition-transform', collapsed && '-rotate-90')}
        />
      </button>
      {!collapsed && (
        <div className="max-h-[calc(100vh-10rem)] divide-y divide-line/50 overflow-y-auto">
          {visible.map((section) => (
            <FeedSectionRow
              key={section.key}
              section={section}
              onResolve={resolveApproval}
              onSelectNode={onSelectNode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FeedSectionRow({
  section,
  onResolve,
  onSelectNode,
}: {
  section: AgentFeedSection;
  onResolve: (approvalId: string, decision: 'approve' | 'reject') => void;
  onSelectNode?: (nodeId: string) => void;
}) {
  const visibleLines = section.lines.slice(-3);
  const selectable = Boolean(section.agentId && onSelectNode);

  return (
    <div className="px-3 py-2.5">
      <div
        role={selectable ? 'button' : undefined}
        tabIndex={selectable ? 0 : undefined}
        onClick={selectable ? () => onSelectNode!(`agent-${section.agentId}`) : undefined}
        onKeyDown={
          selectable
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelectNode!(`agent-${section.agentId}`);
              }
            : undefined
        }
        className={clsx('flex items-center gap-2', selectable && 'cursor-pointer')}
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-card text-[11px] font-semibold text-white"
          style={{ backgroundColor: section.colorHex ?? 'var(--color-accent, #6366f1)' }}
        >
          {avatarText(section)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold text-text-primary">{section.name}</span>
          {section.headline && (
            <span className="block truncate text-[10px] text-text-muted">{section.headline}</span>
          )}
        </span>
        <StatusBadge status={section.status} lastActivityAt={section.lastActivityAt} />
      </div>

      {visibleLines.length > 0 && (
        <div className="mt-1.5 space-y-0.5 pl-8">
          {visibleLines.map((line) => (
            <FeedLineRow key={line.id} line={line} />
          ))}
        </div>
      )}

      {section.progress && section.progress.total > 0 && (
        <div className="mt-1.5 flex items-center gap-2 pl-8">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${progressPct(section.progress)}%` }}
            />
          </div>
          <span className="shrink-0 text-[9px] tabular-nums text-text-muted">
            {section.progress.done}/{section.progress.total}
          </span>
        </div>
      )}

      {section.approval && (
        <div className="mt-2 pl-8">
          <div className="rounded-card border border-warn/30 bg-warn/5 p-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-warn">Approval needed</div>
            <div className="mt-0.5 text-[11px] text-text-secondary">
              {section.approval.summary ?? section.approval.workflowName ?? 'Review requested before continuing.'}
            </div>
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => onResolve(section.approval!.id, 'approve')}
                className="flex flex-1 items-center justify-center gap-1 rounded-card bg-accent px-2 py-1 text-[11px] font-semibold text-white hover:opacity-90"
              >
                <Check size={12} /> Approve
              </button>
              <button
                type="button"
                onClick={() => onResolve(section.approval!.id, 'reject')}
                className="flex flex-1 items-center justify-center gap-1 rounded-card border border-line px-2 py-1 text-[11px] font-semibold text-text-secondary hover:bg-surface-2"
              >
                <X size={12} /> Reject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FeedLineRow({ line }: { line: FeedLine }) {
  const stale = Date.now() - line.at > STALE_MS;
  const prefix = line.kind === 'tool' || line.kind === 'message' ? '↳ ' : '';
  return (
    <div
      className={clsx(
        'flex gap-1.5 text-[11px] transition-opacity',
        stale ? 'opacity-40' : 'opacity-100',
        line.kind === 'fail' ? 'text-danger' : line.kind === 'done' ? 'text-text-muted' : 'text-text-secondary',
      )}
    >
      <span className="truncate">
        {prefix}
        {line.kind === 'message' ? `“${line.text}”` : line.text}
      </span>
    </div>
  );
}

function StatusBadge({ status, lastActivityAt }: { status: AgentFeedStatus; lastActivityAt: number }) {
  const label =
    status === 'working'
      ? 'working'
      : status === 'waiting'
        ? 'waiting'
        : status === 'failed'
          ? 'failed'
          : `done ${formatAgo(lastActivityAt)}`;
  return (
    <span
      className={clsx(
        'flex shrink-0 items-center gap-1 text-[10px] font-medium',
        status === 'working' && 'text-accent',
        status === 'waiting' && 'text-warn',
        status === 'failed' && 'text-danger',
        status === 'done' && 'text-text-muted',
      )}
    >
      {status === 'working' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />}
      {status === 'waiting' && <span className="h-1.5 w-1.5 rounded-full bg-warn" />}
      {label}
    </span>
  );
}

function avatarText(section: AgentFeedSection): string {
  if (section.glyph && section.glyph.trim()) return section.glyph.trim().slice(0, 2);
  return section.name.trim().slice(0, 1).toUpperCase() || '?';
}

function progressPct(progress: { done: number; total: number }): number {
  return Math.max(4, Math.min(100, Math.round((progress.done / progress.total) * 100)));
}

function summaryLabel(working: number, waiting: number, total: number): string {
  if (waiting > 0) return `${waiting} need${waiting === 1 ? 's' : ''} review`;
  if (working > 0) return `${working} agent${working === 1 ? '' : 's'} working`;
  return `${total} recent`;
}

function formatAgo(timestamp: number): string {
  const diffMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (diffMinutes < 1) return 'now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}
