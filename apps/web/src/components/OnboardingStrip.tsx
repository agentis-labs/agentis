/**
 * OnboardingStrip — first-run guidance bar (V1-SPEC §3.2).
 *
 * Sits between the top header and the main content area when the operator
 * has not yet completed the three first-run milestones:
 *
 *   1. Connect an OpenClaw Gateway
 *   2. Register an agent
 *   3. Run a workflow at least once
 *
 * Each milestone is detected from `/v1/dashboard/fleet-overview` counts so
 * we don't need a dedicated endpoint. Once all three are satisfied the
 * strip dismisses itself permanently by writing
 * `agentis.onboarding.dismissed=true` to `localStorage`. The operator can
 * also dismiss manually via the × button — same persisted flag.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../lib/api';

const DISMISSED_KEY = 'agentis.onboarding.dismissed';

interface FleetOverview {
  agents: { total: number };
  gateways: { total: number };
  runs: { total: number };
}

interface Step {
  key: 'gateway' | 'agent' | 'run';
  label: string;
  to: string;
  done: boolean;
}

export function OnboardingStrip() {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [snap, setSnap] = useState<FleetOverview | null>(null);

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    void api<FleetOverview>('/v1/dashboard/fleet-overview')
      .then((d) => {
        if (!cancelled) setSnap(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dismissed]);

  // Auto-dismiss permanently once all three milestones are satisfied.
  useEffect(() => {
    if (!snap || dismissed) return;
    if (snap.gateways.total > 0 && snap.agents.total > 0 && snap.runs.total > 0) {
      try {
        localStorage.setItem(DISMISSED_KEY, 'true');
      } catch {
        /* ignore */
      }
      setDismissed(true);
    }
  }, [snap, dismissed]);

  if (dismissed || !snap) return null;

  const steps: Step[] = [
    {
      key: 'gateway',
      label: 'Connect a gateway',
      to: '/settings?tab=connections',
      done: snap.gateways.total > 0,
    },
    { key: 'agent', label: 'Register an agent', to: '/agents', done: snap.agents.total > 0 },
    { key: 'run', label: 'Run a workflow', to: '/workflows', done: snap.runs.total > 0 },
  ];

  function handleDismiss() {
    try {
      localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }

  return (
    <div
      role="region"
      aria-label="Onboarding"
      className="flex shrink-0 items-center gap-3 border-b border-line bg-surface-2 px-4 py-2 text-xs text-text-muted"
    >
      <span className="font-medium text-text-primary">Get started</span>
      <ol className="flex items-center gap-3">
        {steps.map((step, i) => (
          <li key={step.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={clsx(
                'inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px]',
                step.done
                  ? 'border-accent bg-accent/20 text-accent'
                  : 'border-line text-text-muted',
              )}
            >
              {step.done ? '✓' : i + 1}
            </span>
            <Link
              to={step.to}
              className={clsx(
                'hover:text-accent',
                step.done && 'line-through opacity-60',
              )}
            >
              {step.label}
            </Link>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss onboarding"
        className="ml-auto rounded-md border border-line px-2 py-0.5 text-[10px] text-text-muted hover:text-text-primary"
      >
        Dismiss
      </button>
    </div>
  );
}
