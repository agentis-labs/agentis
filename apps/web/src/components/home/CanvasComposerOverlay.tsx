import { useMemo, useRef, useState } from 'react';
import { ChevronDown, Send } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import type { WorkspaceActiveRun, WorkspaceAgent, WorkspaceApproval } from '../../lib/workspaceData';
import { usePrimaryChatScopes } from '../chat/usePrimaryChatScopes';
import { useChatPanelStore } from '../chat/ChatPanelStore';
import {
  ChatScopeBadge,
  formatChatScopeDescriptor,
  formatChatScopeName,
  formatChatScopePlaceholder,
} from '../chat/scopeIdentity';
import { useComposerContext } from '../../hooks/useComposerContext';
import type { ComposerRecentCompletion, ComposerUser } from './homeCanvasTypes';

interface Recipient {
  id: string;
  name: string;
  role: 'orchestrator' | 'manager';
  detail: string;
}

export function CanvasComposerOverlay({
  agents,
  activeRuns,
  approvals,
  recentCompletions,
  user,
  dimmed,
  onOpenAgents,
}: {
  agents: WorkspaceAgent[];
  activeRuns: WorkspaceActiveRun[];
  approvals: WorkspaceApproval[];
  recentCompletions: ComposerRecentCompletion[];
  user: ComposerUser | null;
  dimmed: boolean;
  onOpenAgents: () => void;
}) {
  const { orchestrator, scopes, workspaceName } = usePrimaryChatScopes();
  const { placeholder } = useComposerContext({
    agents,
    activeRuns,
    pendingApprovals: approvals,
    recentCompletions,
    user,
  });
  const recipients = useMemo<Recipient[]>(
    () => scopes.map((scope) => ({
      id: scope.id,
      name: formatChatScopeName(scope),
      role: scope.role,
      detail: formatChatScopeDescriptor(scope, workspaceName),
    })),
    [scopes, workspaceName],
  );
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [inlineReply, setInlineReply] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const recipient = recipients.find((item) => item.id === recipientId)
    ?? recipients[0]
    ?? null;
  const composerPlaceholder = activeRuns[0]
    ? placeholder
    : recipient
      ? formatChatScopePlaceholder(recipient.name, approvals.length > 0)
      : placeholder;

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(96, Math.max(32, el.scrollHeight))}px`;
  }

  async function send() {
    const body = draft.trim();
    if (!body) return;
    if (!recipient) {
      onOpenAgents();
      return;
    }
    setDraft('');
    setPickerOpen(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setInlineReply(`Routing this through ${recipient.name}...`);
    window.setTimeout(() => setInlineReply(null), 1800);

    const store = useChatPanelStore.getState();
    store.selectThread({ kind: 'agent', id: recipient.id, name: recipient.name });
    store.setState('docked');

    const path = recipient.id === orchestrator?.id
      ? '/v1/conversations/orchestrator/send'
      : `/v1/conversations/${recipient.id}/send`;
    void api(path, { method: 'POST', body: JSON.stringify({ body, message: body }) }).catch(() => undefined);
  }

  return (
    <div
      data-canvas-control
      className={clsx(
        'absolute left-1/2 top-5 z-40 w-[min(640px,calc(100%-32px))] -translate-x-1/2 transition-opacity duration-300',
        dimmed ? 'opacity-30' : 'opacity-100',
      )}
    >
      <div className="flex min-h-[52px] items-center gap-2 rounded-[18px] border border-line/50 bg-[rgba(10,12,16,0.86)] px-2.5 shadow-[0_18px_60px_rgba(0,0,0,0.38)] backdrop-blur-xl transition-colors duration-200 focus-within:border-line-strong focus-within:bg-[rgba(10,12,16,0.96)]">
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setPickerOpen((current) => !current)}
            disabled={recipients.length === 0}
            className="inline-flex min-h-9 items-center gap-2 rounded-[12px] px-2.5 py-1.5 text-left text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface/70 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChatScopeBadge role={recipient?.role ?? 'orchestrator'} size={12} className="h-7 w-7 rounded-[8px] border-line/80 bg-canvas/80" />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block max-w-36 truncate">{recipient?.name ?? 'Set up'}</span>
              {recipient?.detail && (
                <span className="block max-w-36 truncate text-[10px] font-normal text-text-muted">{recipient.detail}</span>
              )}
            </span>
            <ChevronDown size={12} className="text-text-muted" />
          </button>
          {pickerOpen && recipients.length > 0 && (
            <div className="absolute left-0 top-full z-50 mt-2 max-h-56 w-64 overflow-y-auto rounded-[14px] border border-line/80 bg-surface shadow-dropdown">
              {recipients.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => { setRecipientId(entry.id); setPickerOpen(false); }}
                  className={clsx(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors',
                    recipient?.id === entry.id ? 'bg-accent-soft text-accent' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                  )}
                >
                  <ChatScopeBadge role={entry.role} active={recipient?.id === entry.id} size={11} className="h-7 w-7 rounded-[8px]" />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate font-medium">{entry.name}</span>
                    <span className="block truncate text-[10px] text-text-muted">{entry.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); autosize(event.currentTarget); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={1}
          aria-label={recipient ? `Message ${recipient.name}` : 'Message chat scope'}
          placeholder={composerPlaceholder}
          className="max-h-[96px] min-h-8 flex-1 resize-none bg-transparent py-2 text-[14px] leading-6 text-text-primary outline-none placeholder:text-text-muted/70"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!draft.trim()}
          aria-label="Send"
          title="Send"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] text-text-muted transition hover:bg-accent-soft hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Send size={15} />
        </button>
      </div>
      {inlineReply && (
        <div className="mt-2 rounded-[14px] border border-line/60 bg-surface/88 px-3 py-2 text-[12px] text-text-secondary shadow-card">
          {inlineReply}
        </div>
      )}
    </div>
  );
}
