import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Eye,
  Loader2,
  Pencil,
  Search,
  Square,
  Wrench,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';
import * as Collapsible from '@radix-ui/react-collapsible';
import type { ChatDelta, ChatTurnTrace } from '@agentis/core';

type ChatActivity = Extract<ChatDelta, { type: 'activity' }>;
type StepKind = 'searching' | 'reading' | 'writing' | 'fixing' | 'reasoning' | 'generic';
type StepState = 'active' | 'done' | 'error';

interface ActivityStep {
  id: string;
  text: string;
  detail?: string;
  kind: StepKind;
  state: StepState;
}

const KIND_ICON: Record<StepKind, typeof Brain> = {
  searching: Search,
  reading: Eye,
  writing: Pencil,
  fixing: Wrench,
  reasoning: Brain,
  generic: Zap,
};

function inferStepKind(text: string): StepKind {
  const value = text.toLowerCase();
  if (/search|look|find|fetch|retriev|query/.test(value)) return 'searching';
  if (/read|analyz|review|check|inspect|examin|context/.test(value)) return 'reading';
  if (/write|draft|creat|generat|build|construct|response/.test(value)) return 'writing';
  if (/fix|repair|correct|adjust|update|modif|tool/.test(value)) return 'fixing';
  if (/think|reason|consider|evaluat|assess|plan|runtime|model|wait/.test(value)) return 'reasoning';
  return 'generic';
}

function reasoningSteps(text: string, active: boolean): ActivityStep[] {
  const lines = text
    .trim()
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)
    .map((line) => line.replace(/^\s*[-*\u2022]\s*/, '').trim())
    .filter(Boolean)
    .slice(-8);

  return lines.map((line, index) => ({
    id: `reasoning-${index}-${line.slice(0, 24)}`,
    text: line.length > 180 ? `${line.slice(0, 177)}...` : line,
    kind: inferStepKind(line),
    state: active && index === lines.length - 1 ? 'active' : 'done',
  }));
}

function activitySteps(activities: ChatActivity[], streaming: boolean): ActivityStep[] {
  return activities.slice(-14).map((activity, index, entries) => {
    const isLast = index === entries.length - 1;
    return {
      id: activity.id,
      text: activity.label,
      detail: activity.detail,
      kind: activity.phase === 'tool' || activity.phase === 'workflow'
        ? 'fixing'
        : activity.phase === 'context'
          ? 'reading'
          : activity.phase === 'runtime' || activity.phase === 'waiting'
            ? 'reasoning'
            : inferStepKind(activity.label),
      state: activity.status === 'error'
        ? 'error'
        : streaming && isLast && activity.status === 'running'
          ? 'active'
          : 'done',
    };
  });
}

function validTime(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDuration(durationMs?: number): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return '<1s';
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function LiveActivityTrace({
  text,
  activities = [],
  turn,
  streaming,
  failed = false,
  onStop,
}: {
  text: string;
  activities?: ChatActivity[];
  turn?: ChatTurnTrace;
  streaming: boolean;
  failed?: boolean;
  onStop?: () => void;
}) {
  const [open, setOpen] = useState(streaming);
  const [now, setNow] = useState(Date.now());
  const mountedAtRef = useRef(Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const firstActivityAt = activities.map((activity) => validTime(activity.startedAt)).find((value) => value !== null) ?? null;
  const startedAt = validTime(turn?.startedAt) ?? firstActivityAt ?? mountedAtRef.current;
  const terminalDuration = [...activities].reverse().find((activity) => activity.durationMs !== undefined)?.durationMs;
  const durationMs = streaming
    ? Math.max(0, now - startedAt)
    : turn?.durationMs ?? terminalDuration;
  const durationLabel = formatDuration(durationMs);
  const turnFailed = failed || turn?.status === 'failed';
  const turnStopped = turn?.status === 'stopped';

  const steps = useMemo(() => {
    const structured = activitySteps(activities, streaming);
    const reasoning = reasoningSteps(text, streaming && !structured.some((step) => step.state === 'active'));
    const combined = [...structured, ...reasoning];
    return combined.length > 0
      ? combined
      : [{
          id: 'preparing',
          text: 'Preparing response',
          kind: 'reasoning' as const,
          state: streaming ? 'active' as const : 'done' as const,
        }];
  }, [activities, streaming, text]);

  useEffect(() => {
    if (!streaming) return;
    setOpen(true);
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [streaming]);

  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);

  useEffect(() => {
    if (!open || typeof rootRef.current?.scrollIntoView !== 'function') return;
    const frame = window.requestAnimationFrame(() => {
      rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const summary = streaming
    ? 'Thinking'
    : turnFailed
      ? durationLabel ? `Failed after ${durationLabel}` : 'Failed'
      : turnStopped
        ? durationLabel ? `Stopped after ${durationLabel}` : 'Stopped'
        : durationLabel ? `Completed in ${durationLabel}` : 'Completed';

  const SummaryIcon = streaming
    ? Loader2
    : turnFailed
      ? AlertTriangle
      : turnStopped
        ? Clock3
        : CheckCircle2;

  return (
    <Collapsible.Root
      ref={rootRef}
      open={open}
      onOpenChange={setOpen}
      className="w-full"
      data-testid="live-activity-trace"
    >
      <div className="flex items-center gap-2">
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-[12px] text-text-secondary transition-colors duration-150 hover:text-text-primary"
            aria-label={open ? 'Collapse activity' : 'Expand activity'}
          >
            <SummaryIcon
              size={14}
              className={clsx(
                'shrink-0',
                streaming && 'animate-spin text-accent',
                turnFailed && 'text-danger',
                turnStopped && 'text-warn',
                !streaming && !turnFailed && !turnStopped && 'text-accent',
              )}
            />
            <span className="font-medium">{summary}</span>
            {streaming && durationLabel && (
              <span className="tabular-nums text-text-muted">{durationLabel}</span>
            )}
            <span className="ml-auto text-text-muted">
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          </button>
        </Collapsible.Trigger>
        {streaming && onStop && (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-line px-2 text-[10px] font-medium text-text-muted transition hover:border-danger/40 hover:text-danger"
            aria-label="Stop agent response"
          >
            <Square size={9} fill="currentColor" />
            Stop
          </button>
        )}
      </div>

      <Collapsible.Content className="overflow-hidden">
        <div className="relative ml-1.5 mt-2 border-l border-line/70 pb-1 pl-4">
          {steps.map((step, index) => {
            const Icon = KIND_ICON[step.kind];
            const active = step.state === 'active';
            const error = step.state === 'error';
            return (
              <div
                key={step.id}
                className={clsx(
                  'relative flex gap-2.5 pb-3 last:pb-0',
                  index === steps.length - 1 && active && 'chat-thinking-step',
                )}
              >
                <span
                  className={clsx(
                    'absolute -left-[21px] top-1 flex h-2.5 w-2.5 items-center justify-center rounded-full border bg-surface-2',
                    active && 'border-accent',
                    error && 'border-danger bg-danger',
                    !active && !error && 'border-line',
                  )}
                >
                  {active && <span className="h-1 w-1 rounded-full bg-accent" />}
                </span>
                <Icon
                  size={13}
                  className={clsx(
                    'mt-0.5 shrink-0',
                    active ? 'text-accent' : error ? 'text-danger' : 'text-text-muted',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className={clsx('text-[12px] leading-5', active ? 'text-text-primary' : error ? 'text-danger' : 'text-text-secondary')}>
                    {step.text}
                  </div>
                  {step.detail && (
                    <div className="mt-0.5 break-words text-[11px] leading-4 text-text-muted">
                      {step.detail}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {streaming && <div className="chat-thinking-progress mt-2 h-px w-full overflow-hidden bg-line/60" />}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
