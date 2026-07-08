/**
 * RunVerdictBanner — SWIFT layer 3 made visible: was the run ACCOMPLISHED
 * (world-verified) or merely completed? Renders the verdict with its evidence
 * (probe results, judge critique) and the deficiencies with their producing
 * nodes. Renders nothing when the run has no verdict (no spec on the workflow).
 */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, CircleAlert, CircleX, HelpCircle } from 'lucide-react';
import { api } from '../../lib/api';

export interface RunVerdictView {
  outcome: 'accomplished' | 'partial' | 'hollow' | 'failed_checks';
  checks: Array<{ checkId: string; claim: string; passed: boolean; evidence: string; unavailable?: boolean }>;
  deficiencies: Array<{ claim: string; detail: string; producingNodeIds: string[] }>;
  sufficiency?: { typedEmptyFills: string[]; stubSuspects: string[]; floorViolations: string[] };
  rework?: { attempts: number; nodesReworked: string[] };
}

const OUTCOME_META: Record<RunVerdictView['outcome'], { label: string; tone: string; Icon: typeof CheckCircle2 }> = {
  accomplished: { label: 'Accomplished — world-verified', tone: 'border-success/40 bg-success/10 text-success', Icon: CheckCircle2 },
  partial: { label: 'Partial — some claims could not be verified', tone: 'border-amber-400/40 bg-amber-400/10 text-amber-400', Icon: HelpCircle },
  hollow: { label: 'Hollow — completed but the output is empty/placeholder', tone: 'border-danger/40 bg-danger/10 text-danger', Icon: CircleAlert },
  failed_checks: { label: 'Not accomplished — verification failed', tone: 'border-danger/40 bg-danger/10 text-danger', Icon: CircleX },
};

export function RunVerdictBanner({ runId, refreshKey }: { runId: string; refreshKey?: string | number }) {
  const [verdict, setVerdict] = useState<RunVerdictView | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    setVerdict(null);
    api<{ run?: { verdict?: RunVerdictView } }>(`/v1/runs/${runId}`)
      .then((res) => { if (alive && res.run?.verdict) setVerdict(res.run.verdict); })
      .catch(() => {});
    return () => { alive = false; };
  }, [runId, refreshKey]);

  if (!verdict) return null;
  const meta = OUTCOME_META[verdict.outcome];
  const passed = verdict.checks.filter((c) => c.passed).length;

  return (
    <div className={clsx('mb-2 rounded-lg border p-2', meta.tone)}>
      <button type="button" onClick={() => setExpanded((v) => !v)} className="flex w-full items-center gap-2 text-left">
        <meta.Icon size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{meta.label}</span>
        <span className="shrink-0 font-mono text-[10px] opacity-80">{passed}/{verdict.checks.length} checks</span>
        {verdict.rework && verdict.rework.attempts > 0 && (
          <span className="shrink-0 rounded-full border border-current px-1.5 text-[9px]" title={`Outcome re-work: ${verdict.rework.nodesReworked.join(', ')}`}>
            reworked ×{verdict.rework.attempts}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1 border-t border-current/20 pt-1.5">
          {verdict.checks.map((check) => (
            <div key={check.checkId} className="text-[10px] leading-4">
              <span className={clsx('font-semibold', check.passed ? 'text-success' : check.unavailable ? 'text-amber-400' : 'text-danger')}>
                {check.passed ? '✓' : check.unavailable ? '?' : '✗'}
              </span>{' '}
              <span className="font-medium text-text-primary">{check.claim}</span>
              <span className="text-text-muted"> — {check.evidence}</span>
            </div>
          ))}
          {(verdict.sufficiency?.floorViolations.length || verdict.sufficiency?.stubSuspects.length || verdict.sufficiency?.typedEmptyFills.length) ? (
            <div className="text-[10px] leading-4 text-text-muted">
              {verdict.sufficiency.floorViolations.map((v) => <div key={v}>hollow: {v}</div>)}
              {verdict.sufficiency.stubSuspects.map((v) => <div key={v}>stub: {v}</div>)}
              {verdict.sufficiency.typedEmptyFills.length > 0 && <div>empty keys: {verdict.sufficiency.typedEmptyFills.join(', ')}</div>}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
