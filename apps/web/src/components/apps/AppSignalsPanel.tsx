/**
 * AppSignalsPanel — sticky right sidebar (SURFACE-PAGE-REDESIGN.md §6).
 *
 * Auto-generated from the app's declared dataTables (signals are derived
 * server-side at /v1/apps/:id/data/signals) plus live run stats and budget.
 * Clicking a signal opens the Data tab pre-filtered to that table.
 */

import type { ReactNode } from 'react';
import {
  Activity,
  Clock,
  Hexagon,
  Infinity as InfinityIcon,
  Plug,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import clsx from 'clsx';
import { formatDate, formatMoney, type SurfaceBudget, type SurfaceSignal } from './appSurfaceShared';

export function AppSignalsPanel({
  signals,
  runsToday,
  successRate,
  budget,
  deployTarget,
  installedAt,
  onOpenTable,
}: {
  signals: SurfaceSignal[];
  runsToday: number;
  successRate: number | null;
  budget?: SurfaceBudget;
  deployTarget?: string;
  installedAt?: string | null;
  onOpenTable: (table: string) => void;
}) {
  const spendDollars = (budget?.currentSpendCents ?? 0) / 100;
  const capDollars = budget?.monthlyBudgetCents != null ? budget.monthlyBudgetCents / 100 : null;
  const usagePct = budget?.usageRatio != null ? Math.round(budget.usageRatio * 100) : null;

  return (
    <aside className="lg:sticky lg:top-4">
      <div className="overflow-hidden rounded-[22px] border border-line bg-surface">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
          <Activity size={13} />
          Signals
        </div>

        <div className="space-y-3 px-4 py-4">
          {signals.length > 0 ? (
            signals.map((signal) => (
              <button
                key={signal.id}
                type="button"
                onClick={() => onOpenTable(signal.table)}
                className="block w-full rounded-[14px] border border-line/70 bg-surface-2 px-3 py-2.5 text-left transition-colors hover:border-line-strong"
              >
                <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{signal.label}</div>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="text-[20px] font-semibold tracking-[-0.03em] text-text-primary">
                    {signal.value}
                  </span>
                  {signal.trend === 'up' && <TrendingUp size={13} className="text-accent" />}
                  {signal.trend === 'down' && <TrendingDown size={13} className="text-danger" />}
                </div>
              </button>
            ))
          ) : (
            <div className="rounded-[14px] border border-dashed border-line/70 px-3 py-3 text-[11px] leading-relaxed text-text-muted">
              No data signals yet. As workflows write to this app's tables, leads, sentiment and spend metrics surface here automatically.
            </div>
          )}
        </div>

        <Divider />
        <div className="px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">Runs today</div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="text-[20px] font-semibold tracking-[-0.03em] text-text-primary">{runsToday}</span>
            <span className="text-[11px] text-text-muted">
              Success {successRate == null ? '—' : `${successRate}%`}
            </span>
          </div>
        </div>

        <Divider />
        <div className="px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">Budget</div>
          <div className="mt-1 text-[13px] text-text-primary">
            {formatMoney(spendDollars)}
            {capDollars != null && (
              <span className="text-text-muted">
                {' '}· {usagePct ?? 0}% of {formatMoney(capDollars)}
              </span>
            )}
          </div>
          {capDollars != null && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
              <div
                className={clsx(
                  'h-full rounded-full',
                  (usagePct ?? 0) >= 90 ? 'bg-danger' : (usagePct ?? 0) >= 70 ? 'bg-warn' : 'bg-accent',
                )}
                style={{ width: `${Math.min(100, Math.max(0, usagePct ?? 0))}%` }}
              />
            </div>
          )}
        </div>

        <Divider />
        <div className="px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">Deploy</div>
          <div className="mt-1.5 flex items-center gap-2">
            <DeployBadge target={deployTarget} />
            <span className="text-[11px] text-text-muted">since {formatDate(installedAt)}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function Divider() {
  return <div className="border-t border-line/70" />;
}

function DeployBadge({ target }: { target?: string }) {
  const meta = deployMeta(target);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-text-secondary">
      {meta.icon}
      {meta.label}
    </span>
  );
}

function deployMeta(target?: string): { label: string; icon: ReactNode } {
  switch (target) {
    case 'always_on':
      return { label: 'Always on', icon: <InfinityIcon size={12} className="text-accent" /> };
    case 'api_server':
      return { label: 'API server', icon: <Plug size={12} className="text-accent" /> };
    case 'scheduled':
      return { label: 'Scheduled', icon: <Clock size={12} className="text-accent" /> };
    default:
      return { label: 'Local', icon: <Hexagon size={12} className="text-text-muted" /> };
  }
}
