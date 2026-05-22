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
        'mb-2 rounded-lg border border-line/70 bg-canvas/70 px-2.5 py-2 text-[11px] leading-relaxed text-text-muted shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
        streaming && 'border-accent/25',
      )}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-semibold not-italic text-text-secondary">
          {streaming ? <Loader2 size={12} className="animate-spin text-accent" /> : <MessageSquareText size={12} />}
          Thinking
        </span>
        {!streaming && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-text-muted transition hover:bg-surface-2 hover:text-text-primary"
          >
            <ChevronDown size={11} />
            Hide
          </button>
        )}
      </div>
      <div className="whitespace-pre-wrap break-words italic">
        {trimmed}
        {streaming && <span className="ml-0.5 inline-block h-3 w-px animate-pulse bg-accent align-[-2px]" />}
      </div>
    </div>
  );
}
