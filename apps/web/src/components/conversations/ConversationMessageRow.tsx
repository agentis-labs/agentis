/**
 * ConversationMessageRow — V1-SPEC §3.3, §11.7 single message row.
 */

export interface ConversationMessage {
  id: string;
  authorType: 'operator' | 'agent' | 'system';
  body: string;
  createdAt: string;
  deliveryStatus?: string;
}

export function ConversationMessageRow({ message }: { message: ConversationMessage }) {
  const align = message.authorType === 'operator' ? 'items-end' : 'items-start';
  const tone =
    message.authorType === 'operator'
      ? 'bg-accent/15 border-accent/40'
      : message.authorType === 'system'
        ? 'bg-surface-2 border-line'
        : 'bg-surface-2 border-line';
  return (
    <div className={`mb-2 flex flex-col ${align}`}>
      <div className={`max-w-[75%] rounded-md border px-3 py-2 text-sm ${tone}`}>
        <div className="whitespace-pre-wrap">{message.body}</div>
      </div>
      <div className="mt-0.5 text-[10px] text-text-muted">
        {message.authorType} · {new Date(message.createdAt).toLocaleTimeString()}
        {message.deliveryStatus ? ` · ${message.deliveryStatus}` : ''}
      </div>
    </div>
  );
}
