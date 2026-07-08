import { useEffect, useMemo, useState } from 'react';
import { REALTIME_EVENTS } from '@agentis/core';
import clsx from 'clsx';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import type { CanvasNode, Vec2 } from './homeCanvasTypes';

interface LiveRow {
  id: string;
  label: string;
  detail: string;
  tone: 'accent' | 'warn' | 'muted';
}

const HOVER_EVENTS = [
  REALTIME_EVENTS.AGENT_HEARTBEAT,
  REALTIME_EVENTS.AGENT_STATUS_CHANGED,
  REALTIME_EVENTS.AGENT_WORK_STEP,
  REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL,
  REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE,
] as const;

export function CanvasActivityPopover({ node, screenPos }: { node: CanvasNode | null; screenPos: Vec2 | null }) {
  const [rows, setRows] = useState<LiveRow[]>([]);

  useEffect(() => {
    setRows([]);
    if (!node?.agent?.id) return undefined;
    return rtSubscribe('agent', { agentId: node.agent.id });
  }, [node?.agent?.id]);

  useRealtime([...HOVER_EVENTS], (env) => {
    if (!node?.agent?.id) return;
    const next = describeEvent(env);
    if (!next) return;
    setRows((current) => [next, ...current].slice(0, 3));
  });

  const displayRows = useMemo(() => {
    if (rows.length > 0) return rows;
    if (!node) return [];
    return node.tooltipLines.slice(0, 3).map((line, index) => ({
      id: `${node.id}-${index}`,
      label: index === 0 ? node.subtitle : 'Detail',
      detail: line,
      tone: node.warn ? 'warn' : node.active ? 'accent' : 'muted' as LiveRow['tone'],
    }));
  }, [node, rows]);

  if (!node || !screenPos) return null;

  return (
    <div
      className="pointer-events-none absolute z-50 w-72 rounded-card border border-line bg-surface/95 p-3 shadow-dropdown backdrop-blur-md"
      style={{ left: screenPos.x + 18, top: screenPos.y - 24 }}
    >
      <div className="text-[10px] font-semibold uppercase text-text-muted">{kindLabel(node.kind)}</div>
      <div className="mt-0.5 truncate text-[13px] font-semibold text-text-primary">{node.title}</div>
      <div className="mt-1 truncate text-[11px] text-text-secondary">{node.subtitle}</div>
      {displayRows.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-line pt-2">
          {displayRows.map((row) => (
            <div key={row.id} className="flex gap-2">
              <span
                className={clsx(
                  'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                  row.tone === 'accent' && 'bg-accent',
                  row.tone === 'warn' && 'bg-warn',
                  row.tone === 'muted' && 'bg-text-muted/60',
                )}
              />
              <div className="min-w-0">
                <div className="truncate text-[10px] uppercase text-text-muted">{row.label}</div>
                <div className="truncate text-[11px] text-text-secondary">{row.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function describeEvent(env: RealtimeEnvelope): LiveRow | null {
  const payload = isRecord(env.payload) ? env.payload : {};
  const id = `${env.event}-${env.emittedAt}`;
  if (env.event === REALTIME_EVENTS.AGENT_HEARTBEAT) return { id, label: 'Heartbeat', detail: 'Runtime is alive', tone: 'accent' };
  if (env.event === REALTIME_EVENTS.AGENT_STATUS_CHANGED) {
    return { id, label: 'Status', detail: stringField(payload, ['status', 'nextStatus']) ?? 'Status changed', tone: 'accent' };
  }
  if (env.event === REALTIME_EVENTS.AGENT_WORK_STEP) {
    return { id, label: 'Work step', detail: stringField(payload, ['summary', 'step', 'message']) ?? 'Step updated', tone: 'accent' };
  }
  if (env.event === REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL) {
    return { id, label: 'Tool call', detail: stringField(payload, ['tool', 'name', 'command']) ?? 'Tool invoked', tone: 'muted' };
  }
  if (env.event === REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE) {
    return { id, label: 'Terminal', detail: stringField(payload, ['message', 'text', 'line']) ?? 'Terminal output', tone: 'muted' };
  }
  return null;
}

function kindLabel(kind: CanvasNode['kind']): string {
  if (kind === 'orchestrator') return 'Orchestrator';
  if (kind === 'manager') return 'Manager';
  if (kind === 'worker') return 'Specialist';
  if (kind === 'workflow') return 'Workflow';
  if (kind === 'knowledge') return 'Brain';
  if (kind === 'approval') return 'Approval';
  if (kind === 'ghost') return 'Planned node';
  return 'Artifact';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}


