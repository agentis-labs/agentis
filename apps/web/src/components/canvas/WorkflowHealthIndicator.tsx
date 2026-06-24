import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, CircleDashed, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';

interface HealthIssue {
  code: string;
  severity: 'error' | 'warning';
  nodeId?: string;
  nodeTitle?: string;
  message: string;
  remediation?: string;
}

interface HealthReport {
  status: 'healthy' | 'unverified' | 'blocked';
  durationMs: number;
  cacheHit: boolean;
  nodes: Record<string, { status: 'passed' | 'mocked' | 'unverified' | 'failed' }>;
  issues: HealthIssue[];
}

export function WorkflowHealthIndicator({
  workflowId,
  revision,
  onFocusNode,
}: {
  workflowId: string;
  revision: string;
  onFocusNode: (nodeId: string) => void;
}) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [checking, setChecking] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    let cancelled = false;
    setChecking(true);
    timer.current = setTimeout(async () => {
      try {
        const next = await api<HealthReport>(`/v1/workflows/${workflowId}/preflight`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (!cancelled) setReport(next);
      } catch {
        if (!cancelled) setReport(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 800);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [workflowId, revision]);

  const nodeCount = report ? Object.keys(report.nodes).length : 0;
  const errorCount = report?.issues.filter((issue) => issue.severity === 'error').length ?? 0;
  // Steps that could NOT be verified statically (external/agentic/extension
  // boundaries that were mocked) — only a real run proves them.
  const unverifiedCount = report
    ? Object.values(report.nodes).filter((node) => node.status === 'mocked' || node.status === 'unverified').length
    : 0;
  const tone = checking ? 'checking' : report?.status ?? 'checking';
  const summary = checking
    ? 'Checking workflow'
    : tone === 'healthy'
      ? `Healthy · ${nodeCount} nodes checked`
      : tone === 'blocked'
        // Blocked is a hard stop — name it as a problem, never "Ready".
        ? `Blocked · ${errorCount} ${errorCount === 1 ? 'issue' : 'issues'} to fix`
        : `Unverified · ${unverifiedCount || nodeCount} ${unverifiedCount === 1 ? 'step needs' : 'steps need'} a real run`;
  const Icon = checking ? CircleDashed : tone === 'healthy' ? ShieldCheck : tone === 'blocked' ? AlertCircle : CheckCircle2;

  return (
    <div className="pointer-events-auto w-full max-w-[28rem] overflow-hidden rounded-card border border-line bg-surface shadow-dropdown">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-9 w-full items-center gap-2 px-3 text-left active:scale-[0.99]"
        aria-expanded={expanded}
      >
        <Icon
          size={14}
          className={clsx(
            'shrink-0',
            checking && 'animate-spin text-text-muted',
            tone === 'healthy' && 'text-success',
            tone === 'unverified' && 'text-amber-400',
            tone === 'blocked' && 'text-danger',
          )}
        />
        <span className="flex-1 truncate text-[12px] font-medium text-text-primary">{summary}</span>
        {report && !checking && <span className="font-mono text-[10px] text-text-muted">{report.durationMs}ms</span>}
        {expanded ? <ChevronUp size={13} className="text-text-muted" /> : <ChevronDown size={13} className="text-text-muted" />}
      </button>

      {expanded && report && (
        <div className="max-h-72 overflow-auto border-t border-line">
          {report.issues.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-text-secondary">
              Deterministic paths passed using the workflow contract sample.
            </div>
          ) : report.issues.map((issue, index) => (
            <button
              key={`${issue.code}-${issue.nodeId ?? index}`}
              type="button"
              disabled={!issue.nodeId}
              onClick={() => issue.nodeId && onFocusNode(issue.nodeId)}
              className="block w-full border-b border-line/60 px-3 py-2 text-left last:border-0 hover:bg-surface-2 disabled:cursor-default"
            >
              <div className="flex items-center gap-2">
                <span className={clsx('text-[10px] font-semibold uppercase', issue.severity === 'error' ? 'text-danger' : 'text-amber-400')}>
                  {issue.severity}
                </span>
                {issue.nodeTitle && <span className="truncate text-[11px] font-medium text-text-primary">{issue.nodeTitle}</span>}
              </div>
              <p className="mt-0.5 text-[10px] leading-4 text-text-muted">{issue.message}</p>
              {issue.remediation && (
                <p className="mt-0.5 text-[10px] leading-4 text-text-secondary">→ {issue.remediation}</p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
