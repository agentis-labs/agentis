/**
 * CanvasTabs — UIUX-REFACTOR §5.3.3.
 *
 * A tab strip rendered above the canvas content when more than one
 * workflow has been opened in the current session. Tabs are keyed by
 * workflow id, persisted to sessionStorage via the store, and limited
 * to 5. A tab with unsaved changes shows a dot indicator.
 *
 * The strip auto-hides when only one tab is open — the canvas page
 * still registers itself, so opening a second workflow flips the bar
 * on without page friction.
 */

import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Plus, X } from 'lucide-react';
import { useAgentisStore } from '../../store/agentisStore';

interface CanvasTabsProps {
  activeWorkflowId: string;
}

export function CanvasTabs({ activeWorkflowId }: CanvasTabsProps) {
  const tabs = useAgentisStore((s) => s.canvasTabs);
  const closeCanvasTab = useAgentisStore((s) => s.closeCanvasTab);
  const nav = useNavigate();

  if (tabs.length < 2) return null;

  return (
    <div
      className="flex items-center gap-1 overflow-x-auto border-b border-line bg-surface px-2 py-1"
      role="tablist"
      aria-label="Open workflows"
    >
      {tabs
        .slice()
        .sort((a, b) => a.openedAt - b.openedAt)
        .map((tab) => {
          const active = tab.id === activeWorkflowId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              className={clsx(
                'group inline-flex shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 py-1 text-xs transition',
                active
                  ? 'border-line bg-canvas text-text-primary'
                  : 'border-transparent text-text-muted hover:bg-surface-2 hover:text-text-primary',
              )}
            >
              <button
                type="button"
                onClick={() => nav(`/workflows/${tab.id}`)}
                className="inline-flex items-center gap-1.5"
                title={tab.title}
              >
                <span className="max-w-[140px] truncate">{tab.title}</span>
                {tab.dirty && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-accent"
                    aria-label="Unsaved changes"
                    title="Unsaved changes"
                  />
                )}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const wasActive = active;
                  closeCanvasTab(tab.id);
                  if (wasActive) {
                    const next = tabs.find((t) => t.id !== tab.id);
                    nav(next ? `/workflows/${next.id}` : '/workflows');
                  }
                }}
                className="rounded p-0.5 text-text-muted opacity-60 hover:bg-surface hover:text-text-primary hover:opacity-100"
                aria-label={`Close ${tab.title}`}
                title="Close tab"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      <button
        type="button"
        onClick={() => nav('/workflows')}
        className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted hover:bg-surface-2 hover:text-text-primary"
        title="Open another workflow"
        aria-label="Open another workflow"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}
