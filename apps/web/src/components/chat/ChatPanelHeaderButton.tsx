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
  const activeTask = useChatPanelStore((store) => store.activeTask);
  const open = state !== 'hidden';
  const busy = Boolean(activeTask);

  return (
    <button
      type="button"
      onClick={() => setState(open ? 'hidden' : 'docked')}
      aria-label={`${open ? 'Close' : 'Open'} chat panel${busy ? ' (agent working)' : ''}`}
      className={clsx(
        'relative inline-flex h-9 w-9 items-center justify-center rounded-btn border bg-surface-2 text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary',
        busy ? 'border-accent/60 text-accent' : 'border-line',
        open && 'bg-surface-3 text-text-primary',
      )}
      title={busy ? `${activeTask!.agentName} is working…` : 'Chat (⌘/)'}
    >
      {busy && (
        <span className="absolute inset-0 rounded-btn ring-1 ring-accent/50 motion-safe:animate-ping" aria-hidden />
      )}
      <MessageCircle size={14} className="relative" />
      {busy ? (
        <span className="absolute -right-1 -top-1 inline-flex h-2.5 w-2.5 items-center justify-center rounded-full bg-accent motion-safe:animate-pulse" aria-hidden />
      ) : unreadCount > 0 ? (
        <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-canvas">
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      ) : null}
    </button>
  );
}
