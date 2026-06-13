import { useState } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { ChatMarkdown } from './ChatMarkdown';

interface ThinkingBubbleProps {
  /** The agent's reasoning / chain-of-thought text. */
  text: string;
  /** Whether the reasoning is still streaming in (no answer text yet). */
  streaming?: boolean;
}

/**
 * Collapsible disclosure for an agent's reasoning ("thinking") that precedes its
 * answer. While the reasoning is still streaming — and the answer hasn't started —
 * it auto-expands so the user sees live progress; once the answer arrives it can
 * be collapsed to keep the thread tidy. Visually muted/italic to read as
 * "behind the scenes", distinct from the actual reply.
 */
export function ThinkingBubble({ text, streaming = false }: ThinkingBubbleProps) {
  const [open, setOpen] = useState(false);
  // Auto-expand while the reasoning is actively streaming; otherwise honor the
  // user's toggle (collapsed by default).
  const expanded = open || streaming;

  return (
    <div className="mb-2 overflow-hidden rounded-card border border-dashed border-line bg-surface-1/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-text-muted transition-colors hover:text-text-primary"
      >
        <Brain className={clsx('h-3.5 w-3.5', streaming && 'animate-pulse text-accent')} aria-hidden />
        <span>{streaming ? 'Thinking…' : 'Thought process'}</span>
        <ChevronDown
          className={clsx('ml-auto h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')}
          aria-hidden
        />
      </button>
      {expanded && (
        <div className="border-t border-dashed border-line px-2.5 py-2 text-[12px] italic leading-relaxed text-text-muted">
          <ChatMarkdown text={text} />
        </div>
      )}
    </div>
  );
}
