/**
 * ConversationThread — V1-SPEC §3.3, §11.7 scrollable thread view.
 */

import { useEffect, useRef } from 'react';
import {
  ConversationMessageRow,
  type ConversationMessage,
} from './ConversationMessageRow';

export function ConversationThread({ messages }: { messages: ConversationMessage[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto p-4">
      {messages.length === 0 && (
        <div className="text-sm text-text-muted">No messages yet.</div>
      )}
      {messages.map((m) => (
        <ConversationMessageRow key={m.id} message={m} />
      ))}
    </div>
  );
}
