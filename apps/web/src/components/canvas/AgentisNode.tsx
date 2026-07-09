/**
 * AgentisNode — the compact, icon-first canvas card.
 *
 * Reference-builder parity: a small fixed-footprint card (200px) with a real
 * pictogram (brand logo for integration/MCP providers, lucide icon otherwise),
 * a one-line title and a one-line identity subtitle. Everything else moved off
 * the card: live state is a corner badge + border tint, loop progress is a
 * thin bottom bar, live agent narration floats in a pill *below* the card so
 * the card never changes size, and dense diagnostics live in the inspector.
 * The fixed footprint is what lets the shared layered layout pack a large
 * workflow into a screen-shaped, readable canvas.
 */

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Handle, Position } from '@xyflow/react';
import { AlertCircle, CheckCircle2, LoaderCircle, Pause, RefreshCw } from 'lucide-react';
import type { RealtimeActivityTone } from '../../lib/realtimeActivity';
import { nodeKindMeta, nodeKindColor } from './nodeKindMeta';
import { nodeKindIcon } from './nodeKindIcon';
import { connectorLogoUrl } from './connectorLogo';
import { stripPhasePrefix } from './PhaseLayer';

export type LiveStatus = 'running' | 'completed' | 'failed' | 'retry' | 'waiting';
export type LiveExtra = {
  progress?: { completed?: number; total?: number };
  runtimeActivity?: { kind: string; title: string; detail: string; tone: RealtimeActivityTone };
};

export interface CanvasAgentMatch {
  id: string;
  name: string;
  satisfied: boolean;
  provided?: string[];
  missing: string[];
}

export interface AgentisNodeData {
  label: string;
  kind: string;
  type: string;
  operationName?: string;
  toolId?: string;
  integrationId?: string;
  operationId?: string;
  toolPreview?: string;
  liveStatus?: LiveStatus;
  liveExtra?: LiveExtra;
  pendingConfig?: boolean;
  readinessMessage?: string;
  requiredCapabilities?: string[];
  agentMatches?: CanvasAgentMatch[];
  runtimeLabel?: string;
  lastRunAt?: string;
  lastDurationMs?: number;
  phaseDimmed?: boolean;
  [key: string]: unknown;
}

export function AgentisNode({ data, selected }: { data: AgentisNodeData; selected?: boolean }) {
  const meta = nodeKindMeta(data.kind);
  const Icon = nodeKindIcon(data.kind);
  const accentColor = nodeKindColor(data.kind);
  const isTrigger = data.kind === 'trigger';
  const isSticky = data.kind === 'sticky_note';
  const status = data.liveStatus;
  const isRunning = status === 'running';
  const progress = data.liveExtra?.progress;
  const hasDeterminateProgress =
    !!progress && typeof progress.total === 'number' && typeof progress.completed === 'number' && progress.total > 0;
  const runtimeActivity = data.liveExtra?.runtimeActivity;
  const title = stripPhasePrefix(data.label);

  // Provider identity beats the generic kind label: the card should read
  // "supabase · insert_row", not "MCP tool" (reference-builder parity).
  const mcpIdentity = data.kind === 'mcp' && data.toolId
    ? (() => {
        const m = /^mcp__([^_].*?)__(.+)$/.exec(data.toolId!);
        return m ? `${m[1]} · ${m[2]}` : data.toolId!;
      })()
    : null;
  const integrationIdentity = data.kind === 'integration' && data.integrationId
    ? `${data.integrationId}${data.operationId ? ` · ${data.operationId}` : ''}`
    : null;
  const subtitle =
    data.kind === 'extension_task' && data.operationName
      ? data.operationName
      : mcpIdentity ?? integrationIdentity ?? meta.label;

  // Brand identity on the icon tile: a real bundled brand SVG for integrations
  // and MCP mounts (supabase, slack, …), the kind icon as the fallback.
  const brandSlug = data.kind === 'integration'
    ? data.integrationId ?? null
    : data.kind === 'mcp' && data.toolId
      ? (/^mcp__(.+?)__/.exec(data.toolId)?.[1] ?? null)
      : null;
  const brandLogo = brandSlug ? connectorLogoUrl(brandSlug) : null;
  const [brandLogoFailed, setBrandLogoFailed] = useState(false);

  const missingAgentMatches = (data.agentMatches ?? []).filter((match) => !match.satisfied);
  const satisfiedMatch = (data.agentMatches ?? []).find((match) => match.satisfied);
  const agentAlarm = !satisfiedMatch && missingAgentMatches.length > 0;

  // Re-render every 30s so the "Ran 3m ago" tooltip stays honest while idle.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Calm state styling — a thin colored border, never an animated outline.
  // Motion is reserved for the corner badge so an idle canvas stays still.
  const stateRing =
    status === 'running'
      ? '' // handled by the animated .agentis-node-running halo below
      : status === 'completed'
        ? 'border-success/55'
        : status === 'failed'
          ? 'border-danger/70'
          : status === 'waiting'
            ? 'border-warn/70'
            : status === 'retry'
              ? 'border-warn/60 border-dashed'
              : agentAlarm
                ? 'border-danger/45'
                : data.pendingConfig
                  ? 'border-warn/50'
                  : 'border-line hover:border-line-strong';

  // Quiet connection points — visible dots only when the card is engaged.
  const handleClass =
    '!h-2 !w-2 !rounded-full !border !border-line-strong !bg-surface opacity-50 transition-opacity group-hover:opacity-100';

  const hoverDetail = [
    title,
    subtitle !== title ? subtitle : null,
    data.lastRunAt
      ? `Ran ${relativeRunTime(data.lastRunAt)}${data.lastDurationMs != null ? ` · ${formatNodeDuration(data.lastDurationMs)}` : ''}`
      : null,
    data.toolPreview ?? null,
  ]
    .filter(Boolean)
    .join('\n');

  if (isSticky) {
    return (
      <div
        className={clsx(
          'relative w-[220px] rounded-node border border-warn/35 bg-warn/10 px-3 py-2.5 shadow-card',
          data.phaseDimmed && 'opacity-25',
          selected && 'ring-2 ring-accent/45',
        )}
      >
        <div className="flex items-start gap-2">
          <Icon size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden />
          <div className="min-w-0 text-[11.5px] leading-snug text-text-secondary">{title}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'agentis-workflow-node group relative w-[220px] border bg-surface-2 shadow-card transition-[border-color,box-shadow,opacity] duration-200',
        isTrigger ? 'rounded-r-node rounded-l-[28px]' : 'rounded-node',
        stateRing,
        isRunning && 'agentis-node-running',
        // Nodes needing setup stand out with a warn ring so they're not missed.
        data.pendingConfig && !isRunning && !selected && 'border-warn/60 ring-1 ring-warn/40',
        // A running or needs-setup node always reads at full strength, even inside a dimmed phase.
        data.phaseDimmed && !isRunning && !data.pendingConfig && 'opacity-25',
        selected && 'ring-2 ring-accent/45',
      )}
      title={hoverDetail}
    >
      {!isTrigger && <Handle type="target" position={Position.Left} className={handleClass} />}
      <Handle type="source" position={Position.Right} className={handleClass} />
      {/* Error / catch branch — quiet until hovered so it doesn't add noise. */}
      {!isTrigger && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="error"
          style={{ left: 'auto', right: 14 }}
          className="!h-2 !w-2 !rounded-full !border-2 !border-danger/50 !bg-surface opacity-40 transition-opacity group-hover:opacity-100"
        />
      )}

      <div className="flex items-center gap-3 px-3 py-2.5">
        {/* The signature element: one vivid, identity-carrying icon tile. */}
        <span
          className={clsx(
            'flex h-9 w-9 shrink-0 items-center justify-center',
            isTrigger ? 'rounded-full' : 'rounded-[11px]',
          )}
          style={
            isRunning
              ? { backgroundColor: 'var(--color-accent-soft)', color: 'var(--color-accent)', boxShadow: 'inset 0 0 0 1px var(--color-accent)' }
              : { backgroundColor: `${accentColor}26`, color: accentColor, boxShadow: `inset 0 0 0 1px ${accentColor}42` }
          }
          aria-hidden
        >
          {brandLogo && !brandLogoFailed ? (
            <img
              src={brandLogo}
              alt=""
              className="h-[22px] w-[22px] object-contain"
              onError={() => setBrandLogoFailed(true)}
            />
          ) : (
            <Icon size={18} strokeWidth={1.9} />
          )}
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[13px] font-semibold text-text-primary">{title}</div>
          <div
            className={clsx(
              'mt-px truncate text-[10.5px]',
              data.kind === 'extension_task' && data.operationName
                ? 'font-mono text-text-secondary'
                : 'text-text-muted',
            )}
          >
            {subtitle}
          </div>
        </div>
      </div>

      {/* Live loop progress — a thin determinate bar along the card's bottom. */}
      {hasDeterminateProgress && (
        <div className="absolute inset-x-3 bottom-[3px] h-[3px] overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-accent transition-all duration-300"
            style={{ width: `${Math.min(100, (progress!.completed! / progress!.total!) * 100)}%` }}
          />
        </div>
      )}

      {/* Indeterminate "working" sweep — a bright accent segment gliding along
          the card's bottom whenever it's running without a known step count. */}
      {isRunning && !hasDeterminateProgress && (
        <div className="pointer-events-none absolute inset-x-2.5 bottom-[3px] h-[3px] overflow-hidden rounded-full bg-accent/15">
          <div className="agentis-node-sweep h-full w-1/3 rounded-full bg-accent" />
        </div>
      )}

      <StatusBadge
        status={status}
        pending={data.pendingConfig}
        pendingMessage={data.readinessMessage}
        agentAlarm={agentAlarm}
        agentAlarmMessage={
          agentAlarm
            ? `No connected agent satisfies: ${missingAgentMatches[0]?.missing.join(', ') || 'required capabilities'}`
            : undefined
        }
      />

      {/* Live narration floats below the card — the card itself never grows. */}
      {runtimeActivity && status && (
        <div className="pointer-events-none absolute left-0 top-full mt-1.5 w-full">
          <div
            className={clsx(
              'truncate rounded-md border px-2 py-1 text-[9.5px] leading-tight shadow-card',
              runtimeActivityToneClass(runtimeActivity.tone),
            )}
            title={`${runtimeActivity.title}: ${runtimeActivity.detail}`}
          >
            <span className="font-medium">{runtimeActivity.title}</span>
            <span className="opacity-75"> — {runtimeActivity.detail}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Corner badge — the single live-state indicator and the only animated element. */
function StatusBadge({
  status,
  pending,
  pendingMessage,
  agentAlarm,
  agentAlarmMessage,
}: {
  status?: LiveStatus;
  pending?: boolean;
  pendingMessage?: string;
  agentAlarm?: boolean;
  agentAlarmMessage?: string;
}) {
  const badge = (icon: React.ReactNode, tone: string, label: string, tooltip?: string) => (
    <span
      className={clsx(
        'absolute -right-1.5 -top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border bg-surface shadow-card',
        tone,
      )}
      title={tooltip ?? label}
      aria-label={label}
    >
      {icon}
    </span>
  );
  if (status === 'running') return badge(<LoaderCircle size={11} className="animate-spin" />, 'border-accent/50 text-accent', 'running');
  if (status === 'completed') return badge(<CheckCircle2 size={11} />, 'border-success/50 text-success', 'completed');
  if (status === 'failed') return badge(<AlertCircle size={11} />, 'border-danger/50 text-danger', 'failed');
  if (status === 'waiting') return badge(<Pause size={10} />, 'border-warn/50 text-warn', 'waiting');
  if (status === 'retry') return badge(<RefreshCw size={10} />, 'border-warn/50 text-warn', 'retrying');
  if (agentAlarm) return badge(<AlertCircle size={11} />, 'border-danger/50 text-danger', 'no matching agent', agentAlarmMessage);
  if (pending)
    return badge(
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />,
      'border-warn/50 text-warn',
      'needs setup',
      pendingMessage ?? 'Needs setup',
    );
  return null;
}

function runtimeActivityToneClass(tone: RealtimeActivityTone): string {
  if (tone === 'success') return 'border-success/25 bg-success-soft text-success';
  if (tone === 'warn') return 'border-warn/35 bg-warn/10 text-warn';
  if (tone === 'danger') return 'border-danger/30 bg-danger-soft text-danger';
  if (tone === 'accent') return 'border-accent/25 bg-accent-soft text-text-primary';
  return 'border-line bg-surface text-text-secondary';
}

function relativeRunTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

function formatNodeDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
