/**
 * Header button to toggle the persistent ChatPanel.
 *
 * Shows unread badge + pending approval ring + typing shimmer
 * via realtime events.
 */

import { MessageCircle } from 'lucide-react';
import clsx from 'clsx';
import { useChatPanelStore } from './ChatPanelStore';

export function ChatPanelHeaderButton() {
  const { state, setState, unreadCount } = useChatPanelStore();
  const open = state !== 'hidden';

  return (
    <button
      type="button"
      onClick={() => setState(open ? 'hidden' : 'docked')}
      aria-label={`${open ? 'Close' : 'Open'} chat panel`}
      className={clsx(
        'relative inline-flex h-9 w-9 items-center justify-center rounded-btn border border-line bg-surface-2 text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary',
        open && 'bg-surface-3 text-text-primary',
      )}
      title="Chat (⌘/)"
    >
      <MessageCircle size={14} />
      {unreadCount > 0 && (
        <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-canvas">
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      )}
    </button>
  );
}
