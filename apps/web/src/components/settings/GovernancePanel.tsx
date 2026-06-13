/**
 * GovernancePanel — surfaces the workspace governance snapshot
 * (UNIVERSAL-HARNESS §8): fleet by runtime, today/month spend, pending
 * approvals, and audit-trail depth. Read-only; composes /v1/governance/summary.
 */

import { useEffect, useState } from 'react';
import { ShieldCheck, Cpu, DollarSign, AlertTriangle, FileClock } from 'lucide-react';
import { getGovernanceSummary, centsToUsd, type GovernanceSummary } from '../../lib/connections';
import { apiErrorMessage } from '../../lib/api';
import { Skeleton } from '../shared/Skeleton';

export function GovernancePanel() {
  const [summary, setSummary] = useState<GovernanceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getGovernanceSummary()
      .then((s) => { if (alive) { setSummary(s); setError(null); } })
      .catch((e) => { if (alive) setError(apiErrorMessage(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) return <div className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (error) return <p className="text-[13px] text-danger">{error}</p>;
  if (!summary) return null;

  const adapters = Object.entries(summary.fleet.byAdapter);

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-2">
        <ShieldCheck size={18} className="text-accent" />
        <h2 className="text-subheading text-text-primary">Governance</h2>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat icon={<Cpu size={14} />} label="Agents" value={`${summary.fleet.connected}/${summary.fleet.totalAgents}`} hint="connected / total" />
        <Stat icon={<DollarSign size={14} />} label="Today" value={centsToUsd(summary.cost.spendTodayCents)} hint={`${centsToUsd(summary.cost.monthlySpendCents)} this month`} />
        <Stat icon={<AlertTriangle size={14} />} label="Approvals" value={String(summary.approvals.pending)} hint="pending human gates" tone={summary.approvals.pending > 0 ? 'warn' : 'default'} />
        <Stat icon={<FileClock size={14} />} label="Audit" value={String(summary.audit.recentCount)} hint="recent trail entries" />
      </div>

      <section>
        <h3 className="mb-2 text-caption uppercase tracking-wide text-text-muted">Fleet by runtime</h3>
        {adapters.length === 0 ? (
          <p className="text-[13px] text-text-muted">No agents connected yet.</p>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="text-text-muted">
              <tr>
                <th className="py-1.5 font-medium">Runtime</th>
                <th className="py-1.5 font-medium">Agents</th>
                <th className="py-1.5 font-medium">Online</th>
                <th className="py-1.5 font-medium">Connected</th>
                <th className="py-1.5 font-medium">Spend (mo)</th>
              </tr>
            </thead>
            <tbody>
              {adapters.map(([adapter, b]) => (
                <tr key={adapter} className="border-t border-line">
                  <td className="py-1.5 font-mono text-text-primary">{adapter}</td>
                  <td className="py-1.5 text-text-secondary">{b.total}</td>
                  <td className="py-1.5 text-text-secondary">{b.online}</td>
                  <td className="py-1.5 text-text-secondary">{b.connected}</td>
                  <td className="py-1.5 text-text-secondary">{centsToUsd(b.spendCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {summary.cost.limitHitsToday > 0 && (
        <p className="flex items-center gap-1.5 text-[12px] text-warn">
          <AlertTriangle size={13} /> {summary.cost.limitHitsToday} budget limit hit{summary.cost.limitHitsToday === 1 ? '' : 's'} today.
        </p>
      )}
    </div>
  );
}

function Stat({ icon, label, value, hint, tone = 'default' }: {
  icon: React.ReactNode; label: string; value: string; hint?: string; tone?: 'default' | 'warn';
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center gap-1.5 text-text-muted">{icon}<span className="text-caption">{label}</span></div>
      <div className={`mt-1 text-heading ${tone === 'warn' ? 'text-warn' : 'text-text-primary'}`}>{value}</div>
      {hint && <div className="text-[11px] text-text-muted">{hint}</div>}
    </div>
  );
}
