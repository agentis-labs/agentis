import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import clsx from 'clsx';
import * as Collapsible from '@radix-ui/react-collapsible';
import type { ChatDelta, ChatTurnTrace } from '@agentis/core';

type ChatActivity = Extract<ChatDelta, { type: 'activity' }>;
type StepState = 'active' | 'done' | 'error';

interface ActivityStep {
  id: string;
  text: string;
  detail?: string;
  state: StepState;
}

function compactActivityLabel(activity: ChatActivity): string | null {
  const label = activity.label.trim();
  if (!label) return null;
  if (/response ready|request received/i.test(label)) return null;
  if (/loading workspace context|collecting viewport|memory|instructions/i.test(label)) return 'Reading context';
  if (/invoking agent runtime/i.test(label)) return 'Starting runtime';
  if (/streaming the turn/i.test(label)) return 'Streaming response';
  return label.replace(/^Run Tool:\s*/i, 'Using ');
}

function activitySteps(activities: ChatActivity[], streaming: boolean): ActivityStep[] {
  const meaningful = activities
    .map((activity) => ({ activity, label: compactActivityLabel(activity) }))
    .filter((entry): entry is { activity: ChatActivity; label: string } => Boolean(entry.label))
    .filter((entry, index, entries) => index === 0 || entries[index - 1]?.label !== entry.label);

  return meaningful.slice(-8).map(({ activity, label }, index, entries) => {
    const isLast = index === entries.length - 1;
    return {
      id: activity.id,
      text: label,
      detail: activity.detail,
      state: activity.status === 'error'
        ? 'error'
        : streaming && isLast && activity.status === 'running'
          ? 'active'
          : 'done',
    };
  });
}

export function LiveActivityTrace({
  activities = [],
  turn,
  streaming,
  failed = false,
}: {
  activities?: ChatActivity[];
  turn?: ChatTurnTrace;
  streaming: boolean;
  failed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const turnFailed = failed || turn?.status === 'failed';
  const turnStopped = turn?.status === 'stopped';

  const steps = useMemo(() => {
    const structured = activitySteps(activities, streaming);
    return structured.length > 0
      ? structured
      : [{
          id: 'preparing',
          text: 'Working',
          state: streaming ? 'active' as const : 'done' as const,
        }];
  }, [activities, streaming]);

  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);

  const latestStep = [...steps].reverse().find((step) => step.state === 'active') ?? steps.at(-1);
  const summary = streaming
    ? latestStep?.text ?? 'Working'
    : turnFailed
      ? 'Failed'
      : turnStopped
        ? 'Stopped'
        : null;

  const SummaryIcon = streaming
    ? Loader2
    : turnFailed
      ? AlertTriangle
      : AlertTriangle;

  if (!summary) return null;

  if (streaming) {
    return (
      <div className="mb-1 flex min-h-7 w-full min-w-0 items-center gap-2 overflow-hidden" data-testid="live-activity-trace">
        <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-secondary">
          {summary}
        </span>
      </div>
    );
  }

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="mb-2 w-full min-w-0"
      data-testid="live-activity-trace"
    >
      <div className="flex min-h-7 min-w-0 items-center gap-2">
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-[12px] text-text-secondary transition-colors duration-150 hover:text-text-primary active:scale-[0.99]"
            aria-label={open ? 'Collapse activity' : 'Expand activity'}
          >
            <SummaryIcon
              size={14}
              className={clsx(
                'shrink-0',
                streaming && 'animate-spin text-accent',
                turnFailed && 'text-danger',
                turnStopped && 'text-warn',
              )}
            />
            <span className="min-w-0 truncate font-medium">{summary}</span>
            <span className="ml-auto text-text-muted">
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          </button>
        </Collapsible.Trigger>
      </div>

      <Collapsible.Content className="overflow-hidden">
        <div className="ml-1.5 mt-1.5 border-l border-line/55 pl-3">
          {steps.map((step) => {
            const active = step.state === 'active';
            const error = step.state === 'error';
            return (
              <div
                key={step.id}
                className="relative pb-2.5 last:pb-1"
              >
                <span
                  className={clsx(
                    'absolute -left-[17px] top-1.5 h-1.5 w-1.5 rounded-full border bg-surface',
                    active && 'border-accent',
                    error && 'border-danger bg-danger',
                    !active && !error && 'border-line',
                  )}
                />
                <div className="min-w-0">
                  <div className={clsx('text-[12px] leading-5', active ? 'text-text-primary' : error ? 'text-danger' : 'text-text-secondary')}>
                    {step.text}
                  </div>
                  {step.detail && (
                    <div className="mt-0.5 break-words text-[11px] leading-4 text-text-muted [overflow-wrap:anywhere]">
                      {step.detail}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
