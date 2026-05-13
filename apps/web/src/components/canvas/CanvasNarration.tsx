/**
 * CanvasNarration — UIUX-REFACTOR §5.2.1.
 *
 * Floating bottom-left log that narrates what the agent is doing while
 * it builds or executes a workflow on the canvas. Subscribes to
 * AGENT_WORK_STEP and CANVAS_NODE_PLACED / CANVAS_EDGE_CONNECTED /
 * CANVAS_BUILD_COMPLETE events filtered by the current workflowId.
 *
 * Renders nothing when no narration has arrived in the last 60 seconds,
 * keeping the canvas uncluttered for the steady-state editor.
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import { useRealtime } from '../../lib/realtime';

interface NarrationLine {
  key: string;
  status: 'running' | 'done';
  text: string;
  at: number;
}

const TTL_MS = 60_000;
const MAX_LINES = 6;

interface CanvasNarrationProps {
  workflowId: string;
}

export function CanvasNarration({ workflowId }: CanvasNarrationProps) {
  const [lines, setLines] = useState<NarrationLine[]>([]);
  const [done, setDone] = useState(false);

  function append(line: Omit<NarrationLine, 'at'>) {
    setLines((prev) => {
      const fresh = prev.filter((l) => Date.now() - l.at < TTL_MS);
      const next: NarrationLine = { ...line, at: Date.now() };
      const merged = [...fresh, next];
      return merged.slice(-MAX_LINES);
    });
  }

  useRealtime([REALTIME_EVENTS.AGENT_WORK_STEP], (env) => {
    const p = env.payload as {
      workflowId?: string;
      description?: string;
      step?: string;
    } | undefined;
    if (!p?.description) return;
    if (p.workflowId && p.workflowId !== workflowId) return;
    append({
      key: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      status: 'running',
      text: p.description,
    });
  });

  useRealtime([REALTIME_EVENTS.CANVAS_NODE_PLACED], (env) => {
    const p = env.payload as { workflowId?: string; nodeLabel?: string; reason?: string } | undefined;
    if (!p || (p.workflowId && p.workflowId !== workflowId)) return;
    append({
      key: `node-${Date.now()}`,
      status: 'done',
      text: p.reason ?? `Added node ${p.nodeLabel ?? ''}`.trim(),
    });
  });

  useRealtime([REALTIME_EVENTS.CANVAS_EDGE_CONNECTED], (env) => {
    const p = env.payload as { workflowId?: string; from?: string; to?: string } | undefined;
    if (!p || (p.workflowId && p.workflowId !== workflowId)) return;
    append({
      key: `edge-${Date.now()}`,
      status: 'done',
      text: `Connected ${p.from ?? '?'} → ${p.to ?? '?'}`,
    });
  });

  useRealtime([REALTIME_EVENTS.CANVAS_BUILD_COMPLETE], (env) => {
    const p = env.payload as { workflowId?: string } | undefined;
    if (p?.workflowId && p.workflowId !== workflowId) return;
    setDone(true);
    append({
      key: `done-${Date.now()}`,
      status: 'done',
      text: 'Build complete — ready to test.',
    });
    window.setTimeout(() => setDone(false), 8_000);
  });

  // Auto-prune expired lines every 5s so the panel collapses cleanly.
  useEffect(() => {
    const t = window.setInterval(() => {
      setLines((prev) => prev.filter((l) => Date.now() - l.at < TTL_MS));
    }, 5_000);
    return () => window.clearInterval(t);
  }, []);

  if (lines.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute bottom-4 left-4 z-30 max-w-sm"
      role="status"
      aria-live="polite"
    >
      <div className="pointer-events-auto rounded-xl border border-line bg-surface/95 p-3 shadow-card backdrop-blur">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
          {done ? (
            <CheckCircle2 size={11} className="text-accent" />
          ) : (
            <Loader2 size={11} className="animate-spin text-accent" />
          )}
          Agent narration
        </div>
        <ul className="space-y-1">
          {lines.map((l) => (
            <li key={l.key} className="flex items-baseline gap-1.5 text-xs text-text-primary">
              <span
                className={
                  l.status === 'done'
                    ? 'text-accent'
                    : 'animate-pulse text-text-muted'
                }
              >
                {l.status === 'done' ? '✓' : '⟳'}
              </span>
              <span className="truncate">{l.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
