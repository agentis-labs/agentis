import { useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';

/**
 * CanvasBuildComposer — describe a workflow (or a single step) in plain English
 * and let the orchestrator build it onto *this* canvas.
 *
 * It posts to the same conversation/build pipeline the chat uses, binding the
 * turn to this workflow via `viewportOverride` (resourceKind: 'workflow'). The
 * build tool then streams `CANVAS_NODE_PLACED` / `CANVAS_EDGE_CONNECTED` events
 * scoped to this workflow id, which the canvas page already renders live — so
 * nodes appear here as the agent builds, no refresh.
 *
 * Two surfaces:
 *  - `variant="empty"` — the empty-canvas hero composer ("describe the whole flow").
 *  - `variant="node"`  — "edit this step in plain English" inside the inspector.
 */

export interface CanvasBuildComposerProps {
  workflowId: string;
  workflowTitle?: string;
  variant: 'empty' | 'node';
  /** For node-edit: the step being edited, so the instruction can name it. */
  nodeId?: string;
  nodeLabel?: string;
  onSent?: () => void;
  onDismiss?: () => void;
}

export function CanvasBuildComposer({
  workflowId,
  workflowTitle,
  variant,
  nodeId,
  nodeLabel,
  onSent,
  onDismiss,
}: CanvasBuildComposerProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function send() {
    const intent = draft.trim();
    if (!intent || sending) return;
    setSending(true);
    setError(null);

    // For a node edit, name the target step so the build tool patches it in place.
    const message = variant === 'node' && nodeId
      ? `In this workflow, edit the "${nodeLabel ?? nodeId}" step (id: ${nodeId}): ${intent}`
      : intent;

    try {
      await api('/v1/conversations/orchestrator/send', {
        method: 'POST',
        body: JSON.stringify({
          body: message,
          // Bind this turn to the open workflow so the build/patch targets it and
          // its canvas events stream onto this page.
          viewportOverride: {
            surface: 'workflow-canvas',
            resourceKind: 'workflow',
            resourceId: workflowId,
            ...(workflowTitle ? { title: workflowTitle } : {}),
          },
        }),
      });
      setDraft('');
      setSent(true);
      onSent?.();
      window.setTimeout(() => setSent(false), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the orchestrator');
    } finally {
      setSending(false);
    }
  }

  if (variant === 'node') {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={draft}
            disabled={sending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Edit this step in plain English…"
            className="h-8 flex-1 rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!draft.trim() || sending}
            className="inline-flex h-8 items-center gap-1 rounded-btn bg-accent px-2 text-[11px] font-medium text-canvas hover:bg-accent-hover disabled:opacity-40"
          >
            {sending ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            Apply
          </button>
        </div>
        {sent && <p className="text-[11px] text-accent">Sent to the orchestrator — edits stream onto the canvas.</p>}
        {error && <p className="text-[11px] text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="relative pointer-events-auto w-[min(560px,calc(100%-48px))] rounded-2xl border border-line bg-surface/95 p-4 shadow-modal backdrop-blur-xl">
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss and build manually"
          title="Build manually instead"
          className="absolute right-3 top-3 inline-flex h-6 w-6 items-center justify-center rounded-full text-text-muted hover:bg-surface-2 hover:text-text-primary transition-colors"
        >
          <X size={15} />
        </button>
      )}
      <div className="mb-2 flex items-center gap-2 text-text-primary">
        <Sparkles size={16} className="text-accent" />
        <span className="text-sm font-semibold">Describe this workflow</span>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
        Tell the orchestrator what this flow should do — a trigger, the steps, the output. It builds the nodes onto this
        canvas as you watch. You can refine any step afterwards.
      </p>
      <textarea
        value={draft}
        disabled={sending}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        rows={3}
        placeholder="e.g. Every morning, pull new GitHub issues, have a specialist triage them, and post a summary to Slack."
        className="w-full resize-none rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-text-muted">{sending ? 'Building…' : '⌘/Ctrl + Enter to build'}</span>
        <button
          type="button"
          onClick={() => void send()}
          disabled={!draft.trim() || sending}
          className={clsx(
            'inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          {sending ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {sending ? 'Building…' : 'Build it'}
        </button>
      </div>
      {sent && <p className="mt-2 text-[12px] text-accent">On it — nodes will appear here as the orchestrator builds.</p>}
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
