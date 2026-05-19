import { Link } from 'react-router-dom';
import { AlertTriangle, Bot, PlugZap, Workflow } from 'lucide-react';
import clsx from 'clsx';

interface FleetMetricBarProps {
  liveAgents: number;
  totalAgents: number;
  activeRuns: number;
  connectedGateways: number;
  totalGateways: number;
  attentionCount: number;
  onAttentionClick: () => void;
}

export function FleetMetricBar({
  liveAgents,
  totalAgents,
  activeRuns,
  connectedGateways,
  totalGateways,
  attentionCount,
  onAttentionClick,
}: FleetMetricBarProps) {
  const gatewayTone = totalGateways === 0 ? 'muted' : connectedGateways === totalGateways ? 'healthy' : 'warn';

  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
      <MetricLink
        to="/agents"
        icon={<Bot size={13} />}
        label="Agents online"
        value={`${liveAgents}/${totalAgents}`}
        active={liveAgents > 0}
      />
      <MetricLink
        to="/history?tab=runs"
        icon={<Workflow size={13} />}
        label="Active runs"
        value={String(activeRuns)}
        active={activeRuns > 0}
      />
      <MetricLink
        to="/settings?tab=connections"
        icon={<PlugZap size={13} />}
        label="Connections"
        value={`${connectedGateways}/${totalGateways}`}
        active={gatewayTone === 'healthy'}
        warn={gatewayTone === 'warn'}
      />
      <button
        type="button"
        onClick={onAttentionClick}
        disabled={attentionCount === 0}
        className={clsx(
          'inline-flex h-8 items-center gap-2 rounded-pill border px-3 text-[12px] font-medium transition-colors',
          attentionCount > 0
            ? 'border-warn/30 bg-warn-soft text-warn hover:border-warn/50 hover:bg-warn-soft/80'
            : 'cursor-default border-line bg-surface-2 text-text-muted',
        )}
      >
        <AlertTriangle size={13} />
        <span>{attentionCount}</span>
        <span className="text-text-muted">attention</span>
      </button>
    </div>
  );
}

function MetricLink({
  to,
  icon,
  label,
  value,
  active,
  warn,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  value: string;
  active?: boolean;
  warn?: boolean;
}) {
  return (
    <Link
      to={to}
      className={clsx(
        'inline-flex h-8 items-center gap-2 rounded-pill border px-3 text-[12px] font-medium transition-colors',
        warn
          ? 'border-warn/30 bg-warn-soft text-warn hover:border-warn/50'
          : active
            ? 'border-accent/25 bg-accent-soft text-accent hover:border-accent/40'
            : 'border-line bg-surface-2 text-text-secondary hover:border-line-strong hover:bg-surface-3 hover:text-text-primary',
      )}
    >
      {icon}
      <span className="text-text-primary">{value}</span>
      <span className="text-text-muted">{label}</span>
    </Link>
  );
}