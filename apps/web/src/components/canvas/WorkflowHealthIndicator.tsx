import { useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, CircleDashed, ShieldCheck } from 'lucide-react';
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

/** PAVED-ROAD P5 — the workflow's position on the build loop (see /loop-status). */
interface LoopStatus {
  stage: 'authored' | 'dry_run_red' | 'dry_run_green' | 'suite_red' | 'suite_green'
    | 'debug_failed' | 'debug_completed_unverified' | 'debug_accomplished' | 'hardened' | 'production';
  stageLabel: string;
  evidence: {
    validatedAt: string | null;
    dryRun: { at: string; ok: boolean; issueCount: number; stale: boolean } | null;
    debugRun: { at: string; runId: string; status: string; stale: boolean; verdict?: string } | null;
    productionRun: { at: string; runId: string; status: string; stale: boolean; verdict?: string } | null;
  };
  /** SWIFT-T rolling production accomplishment (1 = world-verified). */
  outcomeHealth?: { recent: Array<0 | 1>; lastDeficientRunId?: string } | null;
  /** SWIFT "warn previously": set when the current graph was edited away from a PROVEN version. */
  divergence?: {
    source: 'blueprint' | 'hardened';
    provenHash: string;
    provenRunId?: string;
    currentHash: string;
    warning: string;
    reverify: { tool: string; why: string };
    restore: { tool: string; why: string };
  } | null;
  compass: { stage: string; summary: string; next: Array<{ tool: string; why: string }> };
}

const STAGE_TONE: Record<LoopStatus['stage'], string> = {
  authored: 'border-line text-text-muted',
  dry_run_red: 'border-danger/40 text-danger',
  dry_run_green: 'border-amber-400/40 text-amber-400',
  suite_red: 'border-danger/40 text-danger',
  suite_green: 'border-amber-400/40 text-amber-400',
  debug_failed: 'border-danger/40 text-danger',
  debug_completed_unverified: 'border-amber-400/40 text-amber-400',
  debug_accomplished: 'border-success/40 text-success',
  hardened: 'border-success/40 text-success',
  production: 'border-success/40 text-success',
};

const STAGE_SHORT: Record<LoopStatus['stage'], string> = {
  authored: 'Untested',
  dry_run_red: 'Dry-run red',
  dry_run_green: 'Dry-run ✓',
  suite_red: 'Suite red',
  suite_green: 'Suite ✓',
  debug_failed: 'Debug failed',
  debug_completed_unverified: 'Unverified',
  debug_accomplished: 'Accomplished ✓',
  hardened: 'Hardened',
  production: 'Proven',
};

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
  const [loop, setLoop] = useState<LoopStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    let cancelled = false;
    setChecking(true);
    timer.current = setTimeout(async () => {
      try {
        const [next, loopNext] = await Promise.all([
          api<HealthReport>(`/v1/workflows/${workflowId}/preflight`, {
            method: 'POST',
            body: JSON.stringify({}),
          }),
          api<LoopStatus>(`/v1/workflows/${workflowId}/loop-status`).catch(() => null),
        ]);
        if (!cancelled) {
          setReport(next);
          setLoop(loopNext);
        }
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
  // SWIFT "warn previously": a divergence from a PROVEN version dominates the
  // header — a green "Healthy" preflight must NOT mask that the operator edited a
  // proven graph, which is now UNVERIFIED until it is re-verified.
  const diverged = !checking && !!loop?.divergence;
  const HeaderIcon = diverged ? AlertTriangle : Icon;
  const headerSummary = diverged ? `Unverified · diverged from the proven ${loop!.divergence!.source}` : summary;

  return (
    <div className="pointer-events-auto w-full max-w-[28rem] overflow-hidden rounded-card border border-line bg-surface shadow-dropdown">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-9 w-full items-center gap-2 px-3 text-left active:scale-[0.99]"
        aria-expanded={expanded}
      >
        <HeaderIcon
          size={14}
          className={clsx(
            'shrink-0',
            checking && 'animate-spin text-text-muted',
            diverged && 'text-danger',
            !diverged && tone === 'healthy' && 'text-success',
            !diverged && tone === 'unverified' && 'text-amber-400',
            !diverged && tone === 'blocked' && 'text-danger',
          )}
        />
        <span className="flex-1 truncate text-[12px] font-medium text-text-primary">{headerSummary}</span>
        {diverged && (
          <span
            className="shrink-0 rounded-full border border-danger/50 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold text-danger"
            title={loop!.divergence!.warning}
          >
            ⚠ Re-verify
          </span>
        )}
        {loop && !checking && (
          <span
            className={clsx('shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium', STAGE_TONE[loop.stage])}
            title={loop.stageLabel}
          >
            {STAGE_SHORT[loop.stage]}
          </span>
        )}
        {report && !checking && <span className="font-mono text-[10px] text-text-muted">{report.durationMs}ms</span>}
        {expanded ? <ChevronUp size={13} className="text-text-muted" /> : <ChevronDown size={13} className="text-text-muted" />}
      </button>

      {expanded && report && (
        <div className="max-h-72 overflow-auto border-t border-line">
          {loop?.divergence && (
            <div className="border-b border-danger/30 bg-danger/5 px-3 py-2">
              <div className="flex items-start gap-1.5">
                <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-danger">Diverged from the proven {loop.divergence.source}</p>
                  <p className="mt-0.5 text-[10px] leading-4 text-text-secondary">{loop.divergence.warning}</p>
                  <p className="mt-1 text-[10px] leading-4 text-text-muted">
                    → Re-verify: <span className="font-mono">{loop.divergence.reverify.tool}</span> — {loop.divergence.reverify.why}
                  </p>
                  <p className="mt-0.5 text-[10px] leading-4 text-text-muted">
                    → Roll back: <span className="font-mono">{loop.divergence.restore.tool}</span> — {loop.divergence.restore.why}
                  </p>
                </div>
              </div>
            </div>
          )}
          {loop && (
            <div className="border-b border-line/60 px-3 py-2">
              <div className="text-[11px] font-medium text-text-primary">{loop.stageLabel}</div>
              {loop.compass.next[0] && (
                <p className="mt-0.5 text-[10px] leading-4 text-text-secondary">
                  → Next: <span className="font-mono">{loop.compass.next[0].tool}</span> — {loop.compass.next[0].why}
                </p>
              )}
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-text-muted">
                <span>
                  Dry-run:{' '}
                  {loop.evidence.dryRun
                    ? loop.evidence.dryRun.stale
                      ? 'stale (graph changed)'
                      : loop.evidence.dryRun.ok
                        ? 'green'
                        : `${loop.evidence.dryRun.issueCount} issue(s)`
                    : 'never'}
                </span>
                <span>
                  Debug run:{' '}
                  {loop.evidence.debugRun
                    ? loop.evidence.debugRun.stale
                      ? 'stale (graph changed)'
                      : `${loop.evidence.debugRun.status}${loop.evidence.debugRun.verdict ? ` · ${loop.evidence.debugRun.verdict.toUpperCase()}` : ' · unverified'}`
                    : 'never'}
                </span>
                {loop.outcomeHealth && loop.outcomeHealth.recent.length > 0 && (
                  <span
                    title={`Production accomplishment over the last ${loop.outcomeHealth.recent.length} run(s) — world-verified, not just completed`}
                    className={clsx(
                      'font-medium',
                      loop.outcomeHealth.recent[0] === 1 ? 'text-success' : 'text-danger',
                    )}
                  >
                    Accomplished:{' '}
                    {Math.round((loop.outcomeHealth.recent.filter((r) => r === 1).length / loop.outcomeHealth.recent.length) * 100)}%
                    {' '}({loop.outcomeHealth.recent.filter((r) => r === 1).length}/{loop.outcomeHealth.recent.length})
                  </span>
                )}
              </div>
            </div>
          )}
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
