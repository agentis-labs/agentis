/**
 * ConversationInput — V1-SPEC §3.3, §11.7 message composer.
 */

export interface ConversationInputProps {
  draft: string;
  sending: boolean;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  placeholder?: string;
}

export function ConversationInput({
  draft,
  sending,
  onDraftChange,
  onSend,
  placeholder = 'Send a message…',
}: ConversationInputProps) {
  return (
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
        placeholder={placeholder}
        className="flex-1 rounded-md border border-line bg-canvas px-3 py-1.5 text-sm"
      />
      <button
        disabled={sending || !draft.trim()}
        onClick={onSend}
        className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-canvas disabled:opacity-50"
      >
        {sending ? 'Sending…' : 'Send'}
      </button>
    </div>
  );
}
