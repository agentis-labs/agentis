/**
 * TerminalPane — V1-SPEC §3.3, §11.6 (operator ↔ agent terminal).
 *
 * Read-only message stream + composer for operator ↔ agent conversation.
 * The owning page wires fetching, realtime updates, and sending; this
 * component only renders.
 */

import { useEffect, useRef } from 'react';

export interface TerminalMessage {
  id: string;
  role: 'operator' | 'agent' | 'system';
  body: string;
  createdAt: string;
}

export interface TerminalPaneProps {
  messages: TerminalMessage[];
  draft: string;
  sending: boolean;
  onDraftChange: (next: string) => void;
  onSend: () => void;
}

export function TerminalPane({
  messages,
  draft,
  sending,
  onDraftChange,
  onSend,
}: TerminalPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs">
        {messages.length === 0 && (
          <div className="text-text-muted">No messages yet.</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="mb-2">
            <div className="text-text-muted">
              [{new Date(m.createdAt).toLocaleTimeString()}] {m.role}
            </div>
            <div className="whitespace-pre-wrap">{m.body}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-line bg-surface p-2">
        <input
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="Type a message and press Enter…"
          className="flex-1 rounded-md border border-line bg-canvas px-2 py-1 font-mono text-xs"
        />
        <button
          disabled={sending || !draft.trim()}
          onClick={onSend}
          className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-canvas disabled:opacity-50"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
