import { useEffect, useState } from 'react';
import { ExternalLink, MessageCircle, Network } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { AgentConfigPanel } from './AgentConfigPanel';
import { Button } from '../shared/Button';
import { DetailPanel } from '../shared/DetailPanel';
import { EmptyState } from '../shared/EmptyState';
import { Skeleton } from '../shared/Skeleton';
import { StatusBadge } from '../shared/StatusBadge';

interface AgentSummary {
  id: string;
  name: string;
  description?: string | null;
  status?: string | null;
  adapterType?: string | null;
  runtimeModel?: string | null;
  role?: string | null;
  runsToday?: number | null;
  spendTodayCents?: number | null;
  pendingApprovals?: number | null;
  connectionCounts?: {
    apps: number;
    workflows: number;
    memoryPlanes: number;
  } | null;
}

interface AgentPanelDetail {
  id: string;
  name: string;
  description?: string | null;
  status?: string | null;
  adapterType?: string | null;
  runtimeModel?: string | null;
  config?: Record<string, unknown> | null;
  role?: string | null;
  colorHex?: string | null;
  capabilityTags?: string[] | null;
  instructions?: string | null;
  avatarGlyph?: string | null;
  monthlyBudgetCents?: number | null;
  currentMonthSpendCents?: number | null;
  isPaused?: boolean | null;
  spaceId?: string | null;
  reportsTo?: string | null;
  adapter?: { type?: string; model?: string; config?: Record<string, unknown> };
}

interface AgentConnections {
  apps: Array<{ id: string; name?: string; title?: string }>;
  workflows: Array<{ id: string; title?: string; name?: string }>;
  tasks: Array<{ id: string; title: string; status: string }>;
  memoryPlanes: Array<{ id: string; name: string }>;
}

const EMPTY_CONNECTIONS: AgentConnections = {
  apps: [],
  workflows: [],
  tasks: [],
  memoryPlanes: [],
};

export function AgentHierarchyDetailPanel({
  open,
  summaryAgent,
  allAgents,
  onClose,
  onChanged,
}: {
  open: boolean;
  summaryAgent: AgentSummary | null;
  allAgents: Array<{ id: string; name: string }>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const nav = useNavigate();
  const [agent, setAgent] = useState<AgentPanelDetail | null>(null);
  const [connections, setConnections] = useState<AgentConnections>(EMPTY_CONNECTIONS);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!open || !summaryAgent) {
      setAgent(null);
      setConnections(EMPTY_CONNECTIONS);
      setLoading(false);
      return () => { cancelled = true; };
    }

    setLoading(true);
    void (async () => {
      const [agentResult, connectionsResult] = await Promise.allSettled([
        api<{ agent: AgentPanelDetail }>(`/v1/agents/${summaryAgent.id}`),
        api<AgentConnections>(`/v1/agents/${summaryAgent.id}/connections`),
      ]);
      if (cancelled) return;
      setAgent(agentResult.status === 'fulfilled' ? agentResult.value.agent : null);
      setConnections(connectionsResult.status === 'fulfilled' ? normalizeConnections(connectionsResult.value) : EMPTY_CONNECTIONS);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [open, reloadKey, summaryAgent]);

  if (!open || !summaryAgent) return null;

  const connectionCounts = summaryAgent.connectionCounts ?? {
    apps: connections.apps.length,
    workflows: connections.workflows.length,
    memoryPlanes: connections.memoryPlanes.length,
  };

  return (
    <DetailPanel
      open={open}
      onClose={onClose}
      width="lg"
      title={summaryAgent.name}
      subtitle={`${roleLabel(summaryAgent.role)} · ${summaryAgent.runtimeModel ?? harnessLabel(summaryAgent.adapterType)}`}
      actions={(
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" iconLeft={<MessageCircle size={12} />} onClick={() => nav(`/chat/agent/${summaryAgent.id}`)}>
            Talk
          </Button>
          <Button variant="secondary" size="sm" iconLeft={<ExternalLink size={12} />} onClick={() => nav(`/agents/${summaryAgent.id}`)}>
            Open page
          </Button>
        </div>
      )}
    >
      {loading && !agent ? (
        <div className="space-y-4">
          <Skeleton height={96} />
          <Skeleton height={120} />
          <Skeleton height={480} />
        </div>
      ) : !agent ? (
        <EmptyState
          icon={<Network size={40} />}
          title="Agent details unavailable"
          body="The agent could not be loaded. Try refreshing the page or reopening the panel."
        />
      ) : (
        <div className="space-y-5">
          <section className="rounded-xl border border-line bg-surface-2 p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line bg-canvas text-sm font-medium text-text-primary" style={{ color: agent.colorHex ?? undefined }}>
                {agent.avatarGlyph || '◈'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={agent.status ?? summaryAgent.status ?? 'offline'} size="sm" />
                  <span className="text-[12px] text-text-muted">{roleLabel(agent.role ?? summaryAgent.role)} · {agent.runtimeModel ?? summaryAgent.runtimeModel ?? harnessLabel(agentHarnessType(agent))}</span>
                </div>
                {agent.description || summaryAgent.description ? (
                  <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">{agent.description ?? summaryAgent.description}</p>
                ) : null}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <MetricCard label="Spend today" value={formatMoney(summaryAgent.spendTodayCents ?? 0)} />
              <MetricCard label="Runs today" value={String(summaryAgent.runsToday ?? 0)} />
              <MetricCard label="Pending approvals" value={String(summaryAgent.pendingApprovals ?? 0)} />
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <ConnectionChip label={countLabel(connectionCounts.apps, 'app')} />
              <ConnectionChip label={countLabel(connectionCounts.workflows, 'workflow')} />
              <ConnectionChip label={countLabel(connectionCounts.memoryPlanes, 'memory plane', 'memory planes')} />
            </div>
          </section>

          <section className="grid gap-3 md:grid-cols-3">
            <ConnectionList title="Apps" items={connections.apps.map((item) => item.name ?? item.title ?? item.id)} empty="No linked apps" />
            <ConnectionList title="Workflows" items={connections.workflows.map((item) => item.title ?? item.name ?? item.id)} empty="No linked workflows" />
            <ConnectionList title="Memory" items={connections.memoryPlanes.map((item) => item.name)} empty="No linked memory" />
          </section>

          {connections.tasks.length > 0 ? (
            <section className="rounded-xl border border-line bg-surface p-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">Recent tasks</div>
              <div className="space-y-2">
                {connections.tasks.slice(0, 4).map((task) => (
                  <div key={task.id} className="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate text-text-primary">{task.title}</span>
                    <span className="capitalize text-text-muted">{task.status.toLowerCase()}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <AgentConfigPanel
            agent={{
              id: agent.id,
              name: agent.name,
              adapterType: agentHarnessType(agent),
              runtimeModel: agent.runtimeModel ?? agent.adapter?.model ?? summaryAgent.runtimeModel ?? null,
              role: agent.role ?? summaryAgent.role ?? null,
              status: agent.status ?? summaryAgent.status ?? 'offline',
              colorHex: agent.colorHex ?? null,
              capabilityTags: agent.capabilityTags ?? null,
              instructions: agent.instructions ?? null,
              avatarGlyph: agent.avatarGlyph ?? null,
              isPaused: agent.isPaused ?? null,
              monthlyBudgetCents: agent.monthlyBudgetCents ?? null,
              currentMonthSpendCents: agent.currentMonthSpendCents ?? null,
              config: agent.config ?? agent.adapter?.config ?? null,
              reportsTo: agent.reportsTo ?? null,
              spaceId: agent.spaceId ?? null,
            }}
            allAgents={allAgents}
            onSaved={() => {
              setReloadKey((value) => value + 1);
              onChanged();
            }}
          />
        </div>
      )}
    </DetailPanel>
  );
}

function normalizeConnections(value: AgentConnections): AgentConnections {
  return {
    apps: Array.isArray(value.apps) ? value.apps : [],
    workflows: Array.isArray(value.workflows) ? value.workflows : [],
    tasks: Array.isArray(value.tasks) ? value.tasks : [],
    memoryPlanes: Array.isArray(value.memoryPlanes) ? value.memoryPlanes : [],
  };
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-canvas px-3 py-3">
      <div className="text-lg font-semibold text-text-primary">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
}

function ConnectionChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-pill border border-line bg-canvas px-2.5 py-1 text-[11px] font-medium text-text-secondary">
      {label}
    </span>
  );
}

function ConnectionList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">{title}</div>
      {items.length === 0 ? (
        <div className="text-[12px] text-text-muted">{empty}</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items.slice(0, 6).map((item) => (
            <ConnectionChip key={`${title}-${item}`} label={item} />
          ))}
        </div>
      )}
    </section>
  );
}

function roleLabel(role?: string | null) {
  if (!role) return 'Unassigned';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function countLabel(value: number, singular: string, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function formatMoney(cents: number) {
  const dollars = cents / 100;
  return dollars >= 10 ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`;
}

function agentHarnessType(agent: AgentPanelDetail) {
  return agent.adapterType ?? agent.adapter?.type ?? 'http';
}

function harnessLabel(adapterType?: string | null) {
  switch (adapterType) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes_agent': return 'Hermes Agent';
    case 'claude_code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'http': return 'HTTP / Webhook';
    default: return 'Harness';
  }
}