import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, AlertCircle, ChevronDown, ChevronUp, X } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';

/**
 * WorkflowLintPanel — pre-run reference check (NATIVE-ADVANCEMENT Proposal 2′).
 *
 * Consumes `GET /v1/workflows/:id/lint`, which flags `{{nodes.X}}` references
 * that are dangling (X doesn't exist) or forward (X isn't upstream, so it won't
 * have produced output yet) — the bug class that otherwise resolves silently to
 * empty input at runtime. Surfaces them on the canvas BEFORE a run, so the
 * operator sees the problem instead of debugging a garbled-prompt failure.
 *
 * Re-checks (debounced) whenever `revision` changes, so it tracks live edits.
 */

type Severity = 'error' | 'warning';

interface ReferenceIssue {
  nodeId: string;
  nodeTitle: string;
  expression: string;
  severity: Severity;
  code: string;
  message: string;
}

interface LintResponse {
  issues: ReferenceIssue[];
  errorCount: number;
  warningCount: number;
}

export function WorkflowLintPanel({
  workflowId,
  revision,
  onFocusNode,
}: {
  workflowId: string;
  /** Any value that changes when the graph changes; triggers a debounced re-check. */
  revision: string;
  onFocusNode: (nodeId: string) => void;
}) {
  const [issues, setIssues] = useState<ReferenceIssue[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    let cancelled = false;
    timerRef.current = setTimeout(async () => {
      try {
        const data = await api<LintResponse>(`/v1/workflows/${workflowId}/lint`);
        if (!cancelled) {
          setIssues(data.issues);
          setDismissed(false); // a fresh edit re-surfaces the panel
        }
      } catch {
        if (!cancelled) setIssues([]);
      }
    }, 600);
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [workflowId, revision]);

  if (issues.length === 0 || dismissed) return null;

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  const tone = errorCount > 0 ? 'error' : 'warning';

  return (
    <div className="pointer-events-auto w-full max-w-[26rem] overflow-hidden rounded-card border border-line bg-surface shadow-dropdown">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {tone === 'error' ? (
          <AlertCircle size={13} className="shrink-0 text-danger" />
        ) : (
          <AlertTriangle size={13} className="shrink-0 text-amber-400" />
        )}
        <span className="flex-1 text-[12px] font-medium text-text-primary">
          {errorCount > 0 && `${errorCount} reference ${errorCount === 1 ? 'error' : 'errors'}`}
          {errorCount > 0 && warningCount > 0 && ', '}
          {warningCount > 0 && `${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'}`}
        </span>
        {expanded ? <ChevronUp size={13} className="text-text-muted" /> : <ChevronDown size={13} className="text-text-muted" />}
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); setDismissed(true); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setDismissed(true); } }}
          className="rounded p-0.5 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          aria-label="Dismiss"
        >
          <X size={12} />
        </span>
      </button>

      {expanded && (
        <div className="max-h-72 overflow-auto border-t border-line">
          {issues.map((issue, idx) => (
            <button
              key={`${issue.nodeId}-${idx}`}
              type="button"
              onClick={() => onFocusNode(issue.nodeId)}
              className="flex w-full flex-col gap-0.5 border-b border-line/60 px-3 py-2 text-left last:border-b-0 hover:bg-surface-2"
            >
              <div className="flex items-center gap-1.5">
                {issue.severity === 'error' ? (
                  <AlertCircle size={11} className="shrink-0 text-danger" />
                ) : (
                  <AlertTriangle size={11} className="shrink-0 text-amber-400" />
                )}
                <span className="truncate text-[11px] font-medium text-text-primary">{issue.nodeTitle}</span>
                <code className="ml-auto shrink-0 rounded bg-surface-2 px-1 text-[10px] text-text-muted">{issue.expression}</code>
              </div>
              <span className="text-[10px] leading-snug text-text-muted">{issue.message}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
