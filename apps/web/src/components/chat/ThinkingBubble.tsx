import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, MessageSquareText } from 'lucide-react';
import clsx from 'clsx';

export function ThinkingBubble({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  const trimmed = text.trim();

  useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);

  if (!trimmed) return null;

  if (!streaming && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-line/70 bg-canvas/70 px-2 py-1 text-[11px] font-medium text-text-muted transition hover:border-accent/40 hover:text-text-primary active:scale-[0.98]"
      >
        <ChevronRight size={12} />
        View thinking
      </button>
    );
  }

  return (
    <div
      className={clsx(
        'mb-3 rounded-xl border border-line/50 bg-canvas/40 backdrop-blur-sm px-3 py-2 text-[11px] leading-relaxed text-text-muted shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-all duration-300',
        streaming ? 'border-accent/30 shadow-[0_0_15px_rgba(20,184,166,0.03)]' : 'border-line/45',
      )}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-line/20 pb-1">
        <span className="inline-flex items-center gap-1.5 font-mono font-semibold uppercase tracking-wider text-[9.5px] text-accent">
          {streaming ? <Loader2 size={11} className="animate-spin" /> : <MessageSquareText size={11} />}
          {streaming ? 'Thinking…' : 'Thought process'}
        </span>
        {!streaming && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="inline-flex items-center gap-1 rounded-[6px] border border-line bg-surface px-1.5 py-0.5 text-[9.5px] font-medium text-text-secondary transition hover:bg-surface-3 hover:text-text-primary"
          >
            <ChevronDown size={10} />
            Collapse
          </button>
        )}
      </div>
      <div className="whitespace-pre-wrap break-words font-mono text-[10.5px] text-text-muted/80 leading-relaxed italic">
        {trimmed}
        {streaming && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-accent align-[-1.5px] rounded-sm" />}
      </div>
    </div>
  );
}
