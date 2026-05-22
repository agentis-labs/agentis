/**
 * ToolCallPill — UIUX §5.4 "Streaming Deltas Rendering".
 *
 * Renders a tool_call / tool_result delta in the canonical pill form:
 *
 *   ▶ {tool_name}  ●  running         ← while running (animated dot)
 *   ▶ {tool_name}  ✓  0.3ms  [expand] ← on success (clickable to inspect)
 *   ▶ {tool_name}  ✕  error           ← on failure (always expanded)
 *
 * Multiple parallel tool calls stack vertically — each pill is independent,
 * so its spinner / result animate without blocking sibling pills.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import clsx from 'clsx';

export type ToolCallStatus = 'running' | 'success' | 'error';

export interface ToolCallPillData {
  /** Stable id from the streaming protocol. */
  id: string;
  /** Tool / function name. */
  name: string;
  /** Live status. */
  status: ToolCallStatus;
  /** Optional duration in ms (rendered on success). */
  durationMs?: number | null;
  /** Tool input arguments. */
  args?: unknown;
  /** Result payload (any shape). */
  result?: unknown;
  /** Error message when status = 'error'. */
  error?: string | null;
}

export function ToolCallPill({ data }: { data: ToolCallPillData }) {
  const [expanded, setExpanded] = useState(data.status === 'error');
  const canExpand = data.result !== undefined || data.error;

  return (
    <div
      className={clsx(
        'rounded-md border bg-canvas/70 text-[11px]',
        data.status === 'error' ? 'border-danger/40' : 'border-line/60',
      )}
      data-testid="tool-call-pill"
      data-status={data.status}
    >
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => setExpanded((v) => !v)}
        className={clsx(
          'flex w-full items-center gap-2 px-2 py-1 text-left transition',
          canExpand && 'cursor-pointer hover:bg-surface-2',
          !canExpand && 'cursor-default',
        )}
        aria-expanded={expanded}
      >
        {canExpand ? (
          expanded ? <ChevronDown size={11} className="text-text-muted" /> : <ChevronRight size={11} className="text-text-muted" />
        ) : (
          <span className="w-[11px]" aria-hidden />
        )}
        <span className="text-text-muted">▶</span>
        <span className="font-mono text-text-primary">{data.name}</span>
        <span className="ml-auto inline-flex items-center gap-1.5">
          {data.status === 'running' && (
            <>
              <Loader2 size={10} className="animate-spin text-accent" />
              <span className="text-accent">running</span>
            </>
          )}
          {data.status === 'success' && (
            <>
              <span className="text-accent">✓</span>
              {data.durationMs !== undefined && data.durationMs !== null && (
                <span className="font-mono text-text-muted">{formatDuration(data.durationMs)}</span>
              )}
            </>
          )}
          {data.status === 'error' && (
            <>
              <span className="text-danger">✕</span>
              <span className="text-danger">error</span>
            </>
          )}
        </span>
      </button>
      {expanded && canExpand && (
        <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap break-all border-t border-line/60 bg-canvas px-3 py-2 font-mono text-[10px] text-text">
          {data.status === 'error'
            ? data.error ?? 'Unknown error'
            : formatResult(data.result)}
        </pre>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatResult(result: unknown): string {
  if (result === undefined || result === null) return '(no return value)';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
