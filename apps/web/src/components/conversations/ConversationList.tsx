/**
 * ConversationList — V1-SPEC §3.3, §11.7 left-rail conversation list.
 */

import { Link } from 'react-router-dom';

export interface ConversationListItem {
  id: string;
  agentId: string;
  agentName?: string | null;
  agentColorHex?: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
}

export function ConversationList({
  conversations,
  activeId,
}: {
  conversations: ConversationListItem[];
  activeId?: string;
}) {
  return (
    <ul className="divide-y divide-line">
      {conversations.length === 0 && (
        <li className="p-3 text-sm text-text-muted">No conversations yet.</li>
      )}
      {conversations.map((c) => (
        <li key={c.id}>
          <Link
            to={`/conversations/${c.agentId}`}
            className={`flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-2 ${
              activeId === c.agentId ? 'bg-surface-2' : ''
            }`}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: c.agentColorHex ?? '#888' }}
            />
            <span className="flex-1 truncate">{c.agentName ?? c.agentId}</span>
            {c.unreadCount > 0 && (
              <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-canvas">
                {c.unreadCount}
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
