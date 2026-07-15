import { Download, PackagePlus, X } from 'lucide-react';
import { harnessOf } from './harnessMeta';
import {
  AgentImportSetupPanel,
  type AgentImportSetupValue,
} from './AgentImportSetupPanel';
import { Button } from '../shared/Button';
import { StatusBadge } from '../shared/StatusBadge';
import type { DomainOption } from './DomainEditorSheet';
import type { ImportUpdate } from '../../lib/agentImport';

export interface AgentRow {
  id: string;
  name: string;
  status?: string;
  description?: string;
  spaceId?: string | null;
  spaceName?: string | null;
  spaceColorHex?: string | null;
  adapterType?: string;
  runtimeModel?: string | null;
  adapter?: { type?: string; model?: string };
  avatarUrl?: string | null;
  currentTask?: string;
  currentTaskId?: string | null;
  lastActiveAt?: string;
  lastHeartbeatAt?: string | null;
  role?: string | null;
  reportsTo?: string | null;
  avatarGlyph?: string | null;
  colorHex?: string | null;
  isPaused?: boolean | null;
  monthlyBudgetCents?: number | null;
  currentMonthSpendCents?: number | null;
  canvasPosition?: { x: number; y: number } | null;
  runsToday?: number | null;
  spendTodayCents?: number | null;
  pendingApprovals?: number | null;
  connectionCounts?: { workflows: number } | null;
  spaceTag?: string | null;
  importOrigin?: { adapterType: string; externalId: string } | null;
}

export interface Space extends DomainOption {}

export interface PendingAgentPackageImport {
  fileName: string;
  manifest: unknown;
  setup: AgentImportSetupValue;
  packageName: string;
  packageDescription?: string | null;
}

/** Passive notice for imported agents with upstream memories or skills. */
export function ImportUpdatesBanner({
  updates,
  onReview,
  onDismiss,
}: {
  updates: ImportUpdate[];
  onReview: () => void;
  onDismiss: () => void;
}) {
  const totalMemories = updates.reduce((sum, update) => sum + (update.pendingMemory ?? update.pendingNew ?? 0), 0);
  const totalSkills = updates.reduce((sum, update) => sum + (update.pendingSkills ?? 0), 0);
  const harnesses = Array.from(new Set(updates.map((update) => update.adapterType)));
  const parts: string[] = [];
  if (totalMemories > 0) parts.push(`${totalMemories} new ${totalMemories === 1 ? 'memory' : 'memories'}`);
  if (totalSkills > 0) parts.push(`${totalSkills} new ${totalSkills === 1 ? 'skill' : 'skills'}`);

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-accent/30 bg-accent-soft/60 px-6 py-2.5">
      <div className="flex items-center gap-1.5">
        {harnesses.map((type) => {
          const { Icon, label } = harnessOf(type);
          return <Icon key={type} className="h-4 w-4 text-text-secondary" aria-label={label} />;
        })}
      </div>
      <div className="text-[13px] text-text-primary">
        <span className="font-semibold">{parts.join(' · ') || 'New memory'}</span>
        <span className="text-text-secondary">
          {' '}from {updates.length} imported {updates.length === 1 ? 'agent' : 'agents'} — pull it into Agentis Brain.
        </span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="primary" size="sm" iconLeft={<Download size={13} />} onClick={onReview}>
          Review &amp; pull
        </Button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="rounded-btn p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

export function AgentPackageSetupModal({
  pending,
  existingAgents,
  installing,
  onChange,
  onInstall,
  onClose,
}: {
  pending: PendingAgentPackageImport | null;
  existingAgents: AgentRow[];
  installing: boolean;
  onChange: (setup: AgentImportSetupValue) => void;
  onInstall: () => void;
  onClose: () => void;
}) {
  if (!pending) return null;
  const canInstall = pending.setup.name.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" role="dialog" aria-modal="true" aria-labelledby="agent-package-setup-title">
      <div className="w-full max-w-xl overflow-hidden rounded-modal border border-line bg-surface shadow-modal">
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <div id="agent-package-setup-title" className="flex items-center gap-2 text-subheading text-text-primary">
              <PackagePlus size={16} className="text-accent" /> Import agent package
            </div>
            <div className="mt-1 truncate text-[12px] text-text-muted">{pending.fileName}</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={installing}
            onClick={onClose}
            className="rounded-btn p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
            <div className="text-[13px] font-medium text-text-primary">{pending.packageName}</div>
            {pending.packageDescription && <div className="mt-1 text-[12px] leading-5 text-text-muted">{pending.packageDescription}</div>}
          </div>
          <AgentImportSetupPanel value={pending.setup} existingAgents={existingAgents} onChange={onChange} />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <Button variant="secondary" onClick={onClose} disabled={installing}>Cancel</Button>
          <Button variant="primary" loading={installing} disabled={!canInstall} iconLeft={<PackagePlus size={13} />} onClick={onInstall}>
            Install agent
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AgentTable({ rows, spaces, onSelect }: { rows: AgentRow[]; spaces: Space[]; onSelect: (id: string) => void }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <table className="w-full">
        <thead>
          <tr className="border-b border-line text-[11px] font-medium uppercase tracking-wider text-text-muted">
            <th className="px-4 py-2.5 text-left">Agent</th>
            <th className="px-4 py-2.5 text-left">Role / Domain</th>
            <th className="px-4 py-2.5 text-left">Status</th>
            <th className="px-4 py-2.5 text-left">Harness</th>
            <th className="px-4 py-2.5 text-left">Last active</th>
            <th className="px-2 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((agent) => (
            <tr
              key={agent.id}
              className="cursor-pointer border-b border-line/60 transition-colors hover:bg-surface-2 last:border-b-0"
              onClick={() => onSelect(agent.id)}
            >
              <td className="px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <Avatar name={agent.name} imageUrl={agent.avatarUrl ?? undefined} size={28} />
                  <span className="text-[13px] font-medium text-text-primary">{agent.name}</span>
                </div>
              </td>
              <td className="px-4 py-3">
                <span className="text-[12px] font-semibold capitalize text-text-primary">
                  {formatAgentRole(agent.role, agent.spaceId, agent.spaceTag, spaces)}
                </span>
              </td>
              <td className="px-4 py-3"><StatusBadge status={agent.status ?? 'offline'} size="sm" /></td>
              <td className="px-4 py-3 text-[12px] text-text-secondary">{agentHarnessLabel(agent)}</td>
              <td className="px-4 py-3 text-[12px] text-text-muted">{relativeTime(agent.lastActiveAt)}</td>
              <td className="px-2 py-3"><span className="text-text-muted">›</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function agentHarnessType(agent: AgentRow): string {
  return agent.adapterType ?? agent.adapter?.type ?? '';
}

function relativeTime(iso?: string): string {
  if (!iso) return '';
  try {
    const elapsed = Date.now() - new Date(iso).getTime();
    if (elapsed < 60_000) return 'just now';
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
    return `${Math.floor(elapsed / 86_400_000)}d ago`;
  } catch {
    return '';
  }
}

function initials(name: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}

function labelize(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatAgentRole(role: string | null | undefined, spaceId: string | null | undefined, spaceTag: string | null | undefined, spaces: Space[]): string {
  const normalized = (role ?? '').toLowerCase();
  if (normalized === 'orchestrator') return 'Orchestrator';
  if (normalized === 'manager') {
    const space = spaces.find((candidate) => candidate.id === spaceId);
    if (space?.name?.trim()) return `${labelize(space.name.trim())} Manager`;
    if (spaceTag?.trim()) return `${labelize(spaceTag.trim())} Manager`;
    return 'Manager';
  }
  if (normalized === 'worker') return 'Specialist';
  return normalized ? labelize(normalized) : 'Specialist';
}

function agentHarnessLabel(agent: AgentRow): string {
  const type = agentHarnessType(agent);
  const model = agent.runtimeModel ?? agent.adapter?.model;
  const label = harnessLabel(type);
  return model ? `${label} · ${model}` : label;
}

function harnessLabel(adapterType: string): string {
  switch (adapterType) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes_agent': return 'Hermes Agent';
    case 'claude_code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'antigravity': return 'Antigravity CLI';
    case 'http': return 'HTTP / Webhook';
    default: return 'No harness';
  }
}

function Avatar({ name, imageUrl, size = 36 }: { name: string; imageUrl?: string; size?: number }) {
  return (
    <div className="shrink-0 overflow-hidden rounded-full border border-line bg-surface-2" style={{ width: size, height: size }}>
      {imageUrl ? (
        <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-semibold text-text-primary" style={{ fontSize: Math.max(10, size / 3) }}>
          {initials(name)}
        </span>
      )}
    </div>
  );
}
