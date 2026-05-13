/**
 * AgentWorkStream — UIUX-REFACTOR §8.3.
 *
 * Live "currently doing" surface. Subscribes to `AGENT_WORK_STEP` and
 * keeps the most recent step per agent in a small rotating list. When
 * no agent is actively working, the component renders nothing so it
 * stays out of the way.
 *
 * Empty by default until backend adapters start emitting work steps;
 * the surface is wired now so the moment the runtime sends a payload
 * the UI lights up without a deploy.
 */

import { useState } from 'react';
import { Activity } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import { useRealtime } from '../lib/realtime';

interface WorkStep {
  agentId: string;
  agentName?: string;
  step: string;
  description: string;
  detail?: string;
  at: number;
}

const TTL_MS = 30_000;

export function AgentWorkStream() {
  const [steps, setSteps] = useState<WorkStep[]>([]);

  useRealtime([REALTIME_EVENTS.AGENT_WORK_STEP], (env) => {
    const p = env.payload as Partial<WorkStep> | undefined;
    if (!p?.agentId || !p.description) return;
    const next: WorkStep = {
      agentId: p.agentId,
      agentName: p.agentName,
      step: p.step ?? 'working',
      description: p.description,
      detail: p.detail,
      at: Date.now(),
    };
    setSteps((prev) => {
      const fresh = prev.filter((s) => Date.now() - s.at < TTL_MS && s.agentId !== p.agentId);
      return [next, ...fresh].slice(0, 4);
    });
  });

  if (steps.length === 0) return null;

  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        <Activity size={11} className="text-accent" />
        Currently doing
      </div>
      <ul className="space-y-1">
        {steps.map((s) => (
          <li key={`${s.agentId}-${s.at}`} className="flex items-baseline gap-2 text-xs">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
            <span className="font-medium text-text-primary">{s.agentName ?? s.agentId.slice(0, 8)}</span>
            <span className="truncate text-text-muted">{s.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
