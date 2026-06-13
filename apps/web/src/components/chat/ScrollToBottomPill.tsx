/**
 * ScrollToBottomPill — floating glassmorphism pill that appears when the user
 * scrolls up in a chat thread. Shows an arrow-down icon and optional unread
 * count, then scrolls to the latest message on click.
 */

import { ArrowDown } from 'lucide-react';
import clsx from 'clsx';

interface ScrollToBottomPillProps {
  visible: boolean;
  unreadCount?: number;
  onClick: () => void;
}

export function ScrollToBottomPill({ visible, unreadCount = 0, onClick }: ScrollToBottomPillProps) {
  return (
    <div
      className={clsx(
        'pointer-events-none absolute bottom-3 left-0 right-0 z-20 flex justify-center transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]',
        visible
          ? 'pointer-events-auto translate-y-0 opacity-100'
          : 'translate-y-4 opacity-0',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={unreadCount > 0 ? `${unreadCount} new messages — scroll to bottom` : 'Scroll to bottom'}
        className={clsx(
          'group relative inline-flex items-center gap-1.5 rounded-full',
          'border border-line/60 bg-surface/80 backdrop-blur-md',
          'px-3 py-1.5 text-[11px] font-medium text-text-secondary',
          'shadow-[0_8px_24px_rgba(0,0,0,0.3),0_0_0_1px_rgba(255,255,255,0.04)]',
          'transition-all duration-200',
          'hover:border-accent/40 hover:bg-surface/95 hover:text-text-primary hover:shadow-[0_8px_28px_rgba(0,0,0,0.4),0_0_0_1px_rgba(74,222,128,0.15)]',
          'active:scale-[0.97]',
        )}
      >
        {unreadCount > 0 && (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-canvas">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
        <ArrowDown
          size={13}
          className="text-text-muted transition-colors group-hover:text-accent"
        />
        <span className="transition-colors group-hover:text-text-primary">
          {unreadCount > 0
            ? `${unreadCount} new`
            : 'Latest'}
        </span>
      </button>
    </div>
  );
}
