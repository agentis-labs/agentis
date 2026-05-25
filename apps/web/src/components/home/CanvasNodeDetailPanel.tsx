import { AlertTriangle, ArrowRight, Bot, Check, ExternalLink, MessageCircle, X } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import type { CanvasNode } from './homeCanvasTypes';

export function CanvasNodeDetailPanel({
  node,
  onClose,
  onNavigate,
  onOpenChat,
  onRefresh,
}: {
  node: CanvasNode | null;
  onClose: () => void;
  onNavigate: (route: string) => void;
  onOpenChat: (node: CanvasNode) => void;
  onRefresh: () => void;
}) {
  if (!node) return null;
  const hasRoute = Boolean(node.route);
  const canChat = Boolean(node.agent);
  const state = node.operationalState ?? (node.warn ? 'attention' : node.active ? 'active' : 'idle');

  async function resolveApproval(decision: 'approve' | 'reject') {
    if (!node?.approval?.id) return;
    await api(`/v1/approvals/${node.approval.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }).catch(() => undefined);
    onRefresh();
  }

  return (
    <div data-canvas-control className="pointer-events-none absolute inset-y-0 right-0 z-50 flex w-full max-w-[420px] items-stretch p-4">
      <aside className="pointer-events-auto flex min-h-0 w-full flex-col rounded-2xl border border-line bg-surface/96 shadow-2xl backdrop-blur-xl">
        <header className="flex items-start gap-3 border-b border-line px-4 py-4">
          <div
            className={clsx(
              'flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-card border',
              state === 'error'
                ? 'border-danger/45 bg-danger/10 text-danger'
                : state === 'attention'
                  ? 'border-warn/40 bg-warn-soft text-warn'
                  : state === 'active'
                    ? 'border-white/40 bg-white/10 text-text-primary'
                    : 'border-line bg-surface-2 text-text-secondary',
            )}
            style={{ color: node.accent ?? undefined }}
          >
            {node.imageUrl ? <img src={node.imageUrl} alt="" className="h-full w-full object-cover" /> : node.icon ?? <Bot size={18} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase text-text-muted">
              <span>{node.kind}</span>
              {state === 'active' && <span className="rounded-pill bg-white/10 px-1.5 py-0.5 text-text-primary">executing</span>}
              {state === 'attention' && <span className="rounded-pill bg-warn-soft px-1.5 py-0.5 text-warn">attention</span>}
              {state === 'error' && <span className="rounded-pill bg-danger-soft px-1.5 py-0.5 text-danger">error</span>}
            </div>
            <h2 className="mt-1 truncate text-heading text-text-primary">{node.title}</h2>
            <p className="mt-1 text-[12px] text-text-secondary">{node.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail panel"
            title="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-btn text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {node.agent && <AgentLiveState node={node} />}

          {node.tooltipLines.length > 0 && (
            <section className="space-y-2">
              {node.tooltipLines.map((line) => (
                <div key={line} className="rounded-card border border-line bg-canvas/35 px-3 py-2 text-[12px] text-text-secondary">
                  {line}
                </div>
              ))}
            </section>
          )}

          {node.kind === 'approval' && (
            <section className="mt-4 rounded-card border border-warn/25 bg-warn-soft px-3 py-3">
              <div className="flex gap-2 text-[12px] text-text-secondary">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
                <span>{node.approval?.summary ?? 'This run is waiting for an operator decision.'}</span>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void resolveApproval('approve')}
                  className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-text-primary px-2.5 text-[12px] font-medium text-canvas hover:bg-white active:scale-[0.98]"
                >
                  <Check size={13} />
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => void resolveApproval('reject')}
                  className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                >
                  Reject
                </button>
              </div>
            </section>
          )}

          {node.ghost && (
            <section className="mt-4 rounded-card border border-dashed border-line bg-canvas/35 px-3 py-3 text-[12px] text-text-secondary">
              This slot is reserved for the next layer of the command tree.
            </section>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          {canChat && (
            <button
              type="button"
              onClick={() => onOpenChat(node)}
              className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-text-primary px-3 text-[12px] font-medium text-canvas hover:bg-white active:scale-[0.98]"
            >
              <MessageCircle size={14} />
              Give instruction
            </button>
          )}
          {hasRoute && (
            <button
              type="button"
              onClick={() => node.route && onNavigate(node.route)}
              className="inline-flex h-9 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-3 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            >
              <ExternalLink size={14} />
              Open
            </button>
          )}
          {node.ghost && (
            <button
              type="button"
              onClick={() => onNavigate('/agents')}
              className="inline-flex h-9 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-3 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            >
              <ArrowRight size={14} />
              Configure agents
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}

function AgentLiveState({ node }: { node: CanvasNode }) {
  const state = node.operationalState ?? (node.warn ? 'attention' : node.active ? 'active' : 'idle');
  const label =
    state === 'active'
      ? 'Executing'
      : state === 'error'
        ? 'Error'
        : state === 'offline'
          ? 'Offline'
          : state === 'attention'
            ? 'Waiting on operator'
            : 'Idle';
  const output = node.outputLines?.slice(-5) ?? [];

  return (
    <section className="mb-4 rounded-card border border-line bg-canvas/55 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">{label}</div>
          <div className="mt-1 text-[13px] text-text-primary">
            {node.currentTask ?? (state === 'idle' ? 'No active run. Showing last known workspace state.' : 'Awaiting live execution details.')}
          </div>
        </div>
        <span className="font-mono text-[10px] text-text-muted">{node.artifactCount ?? 0} today</span>
      </div>

      {node.currentTool && (
        <div className="mt-3 rounded-card border border-line bg-[#141414] px-3 py-2">
          <div className="font-mono text-[10px] uppercase tracking-wide text-text-muted">Current tool call</div>
          <div className="mt-1 truncate font-mono text-[12px] text-text-primary">{node.currentTool}</div>
        </div>
      )}

      {node.runtimeError && (
        <div className="mt-3 rounded-card border border-danger/30 bg-danger/5 px-3 py-2">
          <div className="font-mono text-[10px] uppercase tracking-wide text-danger">Failure detail</div>
          <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">{node.runtimeError}</div>
        </div>
      )}

      {output.length > 0 && (
        <div className="mt-3 rounded-card border border-line bg-[#141414] px-3 py-2">
          <div className="font-mono text-[10px] uppercase tracking-wide text-text-muted">Output stream</div>
          <div className="mt-2 space-y-1">
            {output.map((line, index) => (
              <div key={`${line}-${index}`} className="truncate font-mono text-[12px] text-text-secondary">
                {line}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
