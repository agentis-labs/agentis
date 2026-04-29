/**
 * FleetOverview — V1-SPEC §3.3, §11.1 dashboard hero card.
 *
 * Pure presentation. Renders the four headline counters from the
 * `/v1/dashboard/fleet-overview` payload.
 */

export interface FleetOverviewProps {
  data: {
    agents: { total: number; online: number };
    gateways: { total: number; connected: number };
    workflows: { total: number };
    runs: { active: number; total: number };
    approvals: { pending: number };
  } | null;
}

export function FleetOverview({ data }: FleetOverviewProps) {
  if (!data) return <div className="p-4 text-text-muted">Loading…</div>;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="Agents" value={`${data.agents.online}/${data.agents.total}`} hint="online" />
      <Stat label="Gateways" value={`${data.gateways.connected}/${data.gateways.total}`} hint="connected" />
      <Stat label="Active runs" value={data.runs.active} hint={`${data.runs.total} total`} />
      <Stat label="Approvals" value={data.approvals.pending} hint="pending" />
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 text-2xl font-medium">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-text-muted">{hint}</div>}
    </div>
  );
}
