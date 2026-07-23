import { useCallback, useEffect, useState } from 'react';
import { Target, TrendingUp, Loader2, RefreshCcw } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../shared/Button';

/** Shape of GET /v1/apps/:id/goal — the Goal dashboard (Evolution Loop). */
interface Strategy {
  key: string;
  hypothesis: string;
  variant: string | null;
  status: 'active' | 'proven' | 'retired';
  wins: number;
  trials: number;
  winRate: number;
  confidence: number;
}
interface Decision {
  experimentKey: string;
  status: 'insufficient_data' | 'no_clear_winner' | 'winner';
  winnerKey?: string;
  retireKeys?: string[];
  spawnFromKey?: string;
  rationale: string;
}
interface GoalDashboard {
  appId: string;
  goal: { statement: string; northStar?: { metric: string; direction: string; target?: number } | null } | null;
  strategies: Strategy[];
  decisions: Decision[];
  experiments: Array<{ key: string; status: string }>;
  baselines: Array<{ workflowId: string; window: string; successRate: number; sampleSize: number }>;
}

const STATUS_TONE: Record<string, string> = {
  proven: 'text-success',
  active: 'text-text-secondary',
  retired: 'text-text-muted',
  winner: 'text-success',
  no_clear_winner: 'text-warn',
  insufficient_data: 'text-text-muted',
};

export function AppGoalPanel({ appId }: { appId: string }) {
  const [data, setData] = useState<GoalDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ data: GoalDashboard }>(`/v1/apps/${appId}/goal`);
      setData(res.data);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => { void load(); }, [load]);

  if (loading && !data) {
    return <div className="flex items-center gap-2 p-4 text-[12px] text-text-muted"><Loader2 size={13} className="animate-spin" /> Loading Goal…</div>;
  }
  if (error) return <div className="p-4 text-[12px] text-danger">{error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-4 p-1">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-text-primary"><Target size={14} className="text-accent" /> Goal &amp; Evolution</h3>
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}><RefreshCcw size={12} /> Refresh</Button>
      </div>

      {/* Goal */}
      <div className="rounded-card border border-line bg-surface-2/40 p-3">
        {data.goal ? (
          <>
            <div className="text-[13px] text-text-primary">{data.goal.statement}</div>
            {data.goal.northStar && (
              <div className="mt-1 flex items-center gap-1 text-[11px] text-text-muted">
                <TrendingUp size={11} /> North-star: {data.goal.northStar.direction} <span className="font-medium text-text-secondary">{data.goal.northStar.metric}</span>
                {data.goal.northStar.target != null ? ` → ${data.goal.northStar.target}` : ''}
              </div>
            )}
          </>
        ) : (
          <div className="text-[12px] text-text-muted">No Goal set yet. Set one with the <code>agentis.app.goal</code> tool — it steers strategy evolution and is recalled into every run.</div>
        )}
      </div>

      {/* Strategy standings */}
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wide text-text-muted">Competing strategies</div>
        {data.strategies.length === 0 ? (
          <div className="text-[12px] text-text-muted">No strategies yet. Propose competing approaches with <code>agentis.strategy.propose</code>.</div>
        ) : (
          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-surface-2 text-text-muted">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">Strategy</th>
                  <th className="px-2.5 py-1.5 font-medium">Win rate</th>
                  <th className="px-2.5 py-1.5 font-medium">Trials</th>
                  <th className="px-2.5 py-1.5 font-medium">Confidence</th>
                  <th className="px-2.5 py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.strategies.map((s) => (
                  <tr key={s.key} className="border-t border-line">
                    <td className="px-2.5 py-1.5">
                      <div className="font-medium text-text-primary">{s.key}{s.variant ? ` · ${s.variant}` : ''}</div>
                      <div className="text-[11px] text-text-muted">{s.hypothesis}</div>
                    </td>
                    <td className="px-2.5 py-1.5 tabular-nums">{(s.winRate * 100).toFixed(0)}%</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{s.trials}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{(s.confidence * 100).toFixed(0)}%</td>
                    <td className={`px-2.5 py-1.5 ${STATUS_TONE[s.status] ?? ''}`}>{s.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Evolution decisions */}
      {data.decisions.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] uppercase tracking-wide text-text-muted">Evolution status</div>
          <div className="space-y-1.5">
            {data.decisions.map((d) => (
              <div key={d.experimentKey} className="rounded-card border border-line bg-surface-2/30 px-3 py-2 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-text-primary">{d.experimentKey}</span>
                  <span className={STATUS_TONE[d.status] ?? 'text-text-muted'}>{d.status.replace(/_/g, ' ')}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-text-muted">{d.rationale}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
