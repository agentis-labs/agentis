import { CheckCircle2, ChevronDown, ChevronUp, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import clsx from 'clsx';
import type { ToolCallPillData } from '../ChatPanel/ToolCallPill';

export function StickyProgressBanner({
  toolCalls,
  onJumpToLatest,
  activeRunId,
  onCancelRun,
}: {
  toolCalls: ToolCallPillData[];
  onJumpToLatest?: () => void;
  activeRunId?: string;
  onCancelRun?: (runId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const running = toolCalls.filter((call) => call.status === 'running').length;
  const done = toolCalls.filter((call) => call.status === 'success').length;
  const failed = toolCalls.filter((call) => call.status === 'error').length;

  if (toolCalls.length === 0 || running === 0) return null;

  return (
    <div className="sticky top-0 z-[1] mb-3 overflow-hidden rounded-xl border border-accent/25 bg-surface/95 text-[11px] shadow-[0_14px_30px_-22px_rgba(0,0,0,0.45)] backdrop-blur">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-surface-2/70 active:bg-surface-2"
      >
        <Loader2 size={13} className="animate-spin text-accent" />
        <span className="font-semibold text-text-primary">Agent is working</span>
        <span className="rounded-full bg-accent/10 px-2 py-0.5 font-medium text-accent">
          {done}/{toolCalls.length} done
        </span>
        {failed > 0 && <span className="rounded-full bg-danger/10 px-2 py-0.5 font-medium text-danger">{failed} failed</span>}
        <span className="ml-auto text-text-muted">{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
      </button>
      {open && (
        <div className="border-t border-line/60 px-3 py-2">
          <div className="space-y-1.5">
            {toolCalls.slice(0, 4).map((call) => (
              <div key={call.id} className="flex items-center gap-2">
                {call.status === 'running' ? (
                  <Loader2 size={12} className="animate-spin text-accent" />
                ) : call.status === 'error' ? (
                  <XCircle size={12} className="text-danger" />
                ) : (
                  <CheckCircle2 size={12} className="text-accent" />
                )}
                <span className={clsx('min-w-0 flex-1 truncate font-mono', call.status === 'running' ? 'text-text-primary' : 'text-text-muted')}>
                  {call.name}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {onJumpToLatest && (
              <button
                type="button"
                onClick={onJumpToLatest}
                className="rounded-btn border border-line bg-canvas px-2 py-1 text-[10px] font-semibold text-text-secondary transition hover:border-accent/40 hover:text-text-primary active:scale-[0.98]"
              >
                View latest
              </button>
            )}
            {onCancelRun && activeRunId && (
              <button
                type="button"
                onClick={() => onCancelRun(activeRunId)}
                className="rounded-btn border border-danger/20 bg-danger/10 px-2 py-1 text-[10px] font-semibold text-danger transition hover:bg-danger/20 hover:border-danger/30 active:scale-[0.98]"
              >
                Stop execution
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
