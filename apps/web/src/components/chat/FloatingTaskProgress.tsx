

import { Loader2, X } from 'lucide-react';
import { useChatPanelStore } from './ChatPanelStore';

export function FloatingTaskProgress() {
  const state = useChatPanelStore((store) => store.state);
  const activeTask = useChatPanelStore((store) => store.activeTask);
  const setState = useChatPanelStore((store) => store.setState);
  const selectThread = useChatPanelStore((store) => store.selectThread);
  const markOpenRequested = useChatPanelStore((store) => store.markOpenRequested);
  const setActiveTask = useChatPanelStore((store) => store.setActiveTask);

  if (state !== 'hidden' || !activeTask) return null;

  const { agentName, label, done, total } = activeTask;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;

  function open() {
    selectThread({ kind: 'agent', id: activeTask!.agentId, name: activeTask!.agentName });
    setState('docked');
    markOpenRequested();
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') open();
      }}
      className="fixed bottom-4 right-4 z-[60] flex w-72 max-w-[calc(100vw-2rem)] cursor-pointer flex-col gap-1.5 rounded-card border border-accent/40 bg-surface px-3 py-2.5 text-left shadow-[0_24px_60px_-24px_rgba(0,0,0,0.75)] transition hover:border-accent/70"
      aria-label={`${agentName} is working — open chat`}
    >
      <div className="flex items-center gap-2">
        <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
        <span className="truncate text-[12px] font-semibold text-text-primary">{agentName} is working…</span>
        {total > 0 && (
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-muted">{done}/{total}</span>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setActiveTask(null);
          }}
          aria-label="Dismiss"
          className={`${total > 0 ? '' : 'ml-auto '}shrink-0 rounded p-0.5 text-text-muted transition hover:bg-surface-2 hover:text-text-primary`}
        >
          <X size={12} />
        </button>
      </div>
      <div className="truncate pl-[21px] text-[11px] text-text-muted">{label}</div>
      <div className="ml-[21px] h-1 overflow-hidden rounded-full bg-surface-3">
        <div
          className={pct === null ? 'h-full w-1/3 animate-pulse rounded-full bg-accent/70' : 'h-full rounded-full bg-accent transition-[width] duration-300'}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}



