import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { REALTIME_EVENTS } from '@agentis/core';
import clsx from 'clsx';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import { describeRealtimeActivity } from '../../lib/realtimeActivity';
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

  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  // Keep the popover inside the canvas viewport: flip to the cursor's left when
  // it would overflow the right edge, and clamp vertically. Measured pre-paint
  // against the positioned ancestor (the canvas container) so there's no flicker.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !screenPos) { setCoords(null); return; }
    const parent = el.offsetParent as HTMLElement | null;
    const boundsW = parent?.clientWidth ?? window.innerWidth;
    const boundsH = parent?.clientHeight ?? window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 12;
    let left = screenPos.x + 18;
    let top = screenPos.y - 24;
    if (left + w > boundsW - margin) left = screenPos.x - 18 - w; // flip left of cursor
    if (left < margin) left = margin;
    if (top + h > boundsH - margin) top = boundsH - margin - h;
    if (top < margin) top = margin;
    setCoords({ left, top });
  }, [screenPos?.x, screenPos?.y, displayRows]);

  if (!node || !screenPos) return null;

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-50 w-72 rounded-card border border-line bg-surface/95 p-3 shadow-dropdown backdrop-blur-md"
      style={coords ?? { left: screenPos.x + 18, top: screenPos.y - 24, visibility: 'hidden' }}
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

/**
 * Presentation for each event this popover renders.
 *
 * The popover deliberately fixes its OWN label and tone per event — it is a
 * compact three-row hover card, not the full activity feed, so it doesn't want
 * the normalizer's semantic tones (`success`/`danger`) which its `LiveRow` type
 * can't express anyway. That part is legitimately local.
 *
 * What is NOT local is pulling the detail text out of the payload. Hand-rolling
 * a second copy of that is what let this file's AGENT_WORK_STEP field order
 * drift out of sync with `describeRealtimeActivity` until it checked `step`
 * (which carries the node KIND) before `detail`, and every work step rendered
 * the literal string "agent_task". Extraction now has one owner.
 */
const ROW_PRESENTATION: Partial<Record<string, { label: string; tone: LiveRow['tone']; fallback: string }>> = {
  [REALTIME_EVENTS.AGENT_STATUS_CHANGED]: { label: 'Status', tone: 'accent', fallback: 'Status changed' },
  [REALTIME_EVENTS.AGENT_WORK_STEP]: { label: 'Work step', tone: 'accent', fallback: 'Step updated' },
  [REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL]: { label: 'Tool call', tone: 'muted', fallback: 'Tool invoked' },
  [REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE]: { label: 'Terminal', tone: 'muted', fallback: 'Terminal output' },
};

function describeEvent(env: RealtimeEnvelope): LiveRow | null {
  const id = `${env.event}-${env.emittedAt}`;
  // AGENT_HEARTBEAT has no branch in the shared normalizer (it carries no
  // payload worth formatting — the signal IS the event), so it stays local.
  if (env.event === REALTIME_EVENTS.AGENT_HEARTBEAT) {
    return { id, label: 'Heartbeat', detail: 'Runtime is alive', tone: 'accent' };
  }
  const presentation = ROW_PRESENTATION[env.event];
  if (!presentation) return null;
  // The normalizer returns null when an event carries nothing worth showing
  // (e.g. a terminal message with no text) — fall back rather than drop the row,
  // matching what this popover did before.
  const detail = describeRealtimeActivity(env)?.detail?.trim();
  return { id, label: presentation.label, detail: detail || presentation.fallback, tone: presentation.tone };
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


