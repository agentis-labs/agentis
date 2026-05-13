/**
 * ProactiveCard — UIUX-REFACTOR §9.
 *
 * Rich content blocks an agent can push into a conversation thread to
 * reduce cognitive load on the operator. The agent sends a card via
 * message metadata; this component renders title + body + optional list
 * + a row of action buttons. Each action is dispatched as an
 * `agentis:proactive-action` window event so consumers (slash dispatcher,
 * route handlers, custom plug-ins) can respond.
 */

import { ChevronRight } from 'lucide-react';

export interface ProactiveAction {
  label: string;
  /** Either a route to navigate to OR a logical action key. */
  action: string;
  params?: Record<string, unknown>;
  /** Visual prominence */
  variant?: 'primary' | 'secondary' | 'danger';
}

export interface ProactiveCardData {
  title: string;
  body?: string;
  items?: string[];
  actions?: ProactiveAction[];
  tone?: 'info' | 'warn' | 'danger' | 'success';
}

const TONE_CLASS: Record<NonNullable<ProactiveCardData['tone']>, string> = {
  info: 'border-line bg-surface-2',
  warn: 'border-warn/40 bg-warn/10',
  danger: 'border-danger/40 bg-danger/10',
  success: 'border-accent/40 bg-accent/10',
};

export function ProactiveCard({ data }: { data: ProactiveCardData }) {
  const tone = data.tone ?? 'info';
  return (
    <div className={`mt-1 rounded-lg border px-3 py-2 ${TONE_CLASS[tone]}`}>
      <div className="text-sm font-medium text-text-primary">{data.title}</div>
      {data.body && <div className="mt-0.5 text-xs text-text-muted">{data.body}</div>}
      {data.items && data.items.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-text-primary">
          {data.items.map((it, i) => (
            <li key={i} className="flex items-start gap-1">
              <ChevronRight size={11} className="mt-0.5 shrink-0 text-text-muted" />
              <span className="break-words">{it}</span>
            </li>
          ))}
        </ul>
      )}
      {data.actions && data.actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {data.actions.map((a, i) => (
            <button
              key={i}
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('agentis:proactive-action', {
                    detail: { action: a.action, params: a.params },
                  }),
                )
              }
              className={`rounded-md px-2 py-0.5 text-xs ${
                a.variant === 'primary'
                  ? 'bg-accent text-canvas'
                  : a.variant === 'danger'
                    ? 'bg-danger/20 text-danger hover:bg-danger/30'
                    : 'border border-line bg-surface text-text-primary hover:bg-surface-2'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
