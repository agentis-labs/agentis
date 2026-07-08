/**
 * AgentTurnTrace — the single, calm record of an agent's work inside one chat
 * turn. It replaces the old split between LiveActivityTrace (narration) and
 * ExecutionFeed (tool list) with one cohesive surface:
 *
 *  • While the turn is streaming, the agent's thoughts are written out as small
 *    one-line messages, appearing top-to-bottom. Older lines settle; the latest
 *    is alive. We keep only the last few visible so the stream never grows into
 *    a wall of text.
 *  • When the turn finishes, the whole thing collapses to a single minimal pill
 *    — "Used 3 tools · 4.2s ›" — that expands on click into the full timeline
 *    (every thought + each tool's input/result/error).
 *
 * Fed by the same `activity` deltas (which already narrate tool phases as
 * "Using …"/"Running …") and `toolCalls` the turn streams, plus the finalized
 * `turn` trace for duration. Trivial replies (a plain answer, no real work)
 * render nothing.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleSlash,
  Loader2,
} from 'lucide-react';
import clsx from 'clsx';
import * as Collapsible from '@radix-ui/react-collapsible';
import { compactActivityLabel, type ChatDelta, type ChatTurnTrace } from '@agentis/core';
import type { ToolCallData } from './toolCalls';
import { ChatArtifactAttachments, collectArtifactIds } from './ArtifactAttachments';

type ChatActivity = Extract<ChatDelta, { type: 'activity' }>;
type ThoughtState = 'active' | 'done' | 'error';

interface Thought {
  id: string;
  text: string;
  detail?: string;
  state: ThoughtState;
}

/** How many live thought lines stay on screen while streaming. */
const VISIBLE_WHILE_STREAMING = 4;

/**
 * Framework-setup narration (boot, context load, reply streaming) — real, worth
 * showing live, but not "work" on its own. A turn that only did these is a plain
 * conversational reply and should leave no collapsed pill behind.
 */
function isSetupThought(text: string): boolean {
  return /^(starting|reading context|writing the reply|thinking)\b/i.test(text);
}

function buildThoughts(activities: ChatActivity[], streaming: boolean): Thought[] {
  const meaningful = activities
    .map((activity) => ({ activity, label: compactActivityLabel(activity) }))
    .filter((entry): entry is { activity: ChatActivity; label: string } => Boolean(entry.label))
    // Collapse immediate repeats so a re-emitted phase doesn't double a line.
    .filter((entry, index, entries) => index === 0 || entries[index - 1]?.label !== entry.label);

  return meaningful.map(({ activity, label }, index, entries) => {
    const isLast = index === entries.length - 1;
    return {
      id: activity.id,
      text: label,
      detail: activity.detail,
      state: activity.status === 'error'
        ? 'error'
        : streaming && isLast && activity.status !== 'success'
          ? 'active'
          : 'done',
    } satisfies Thought;
  });
}

function resolveDurationMs(turn: ChatTurnTrace | undefined, activities: ChatActivity[]): number | null {
  if (turn?.durationMs && turn.durationMs > 0) return turn.durationMs;
  const startedAt = turn?.startedAt ? Date.parse(turn.startedAt) : NaN;
  const completedAt = turn?.completedAt ? Date.parse(turn.completedAt) : NaN;
  if (Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt > startedAt) {
    return completedAt - startedAt;
  }
  // Fallback: span the activity timestamps.
  const stamps = activities
    .flatMap((a) => [a.startedAt, a.completedAt])
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((value) => Number.isFinite(value)) as number[];
  if (stamps.length >= 2) {
    const min = Math.min(...stamps);
    const max = Math.max(...stamps);
    if (max > min) return max - min;
  }
  return null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100) / 10).toFixed(1)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

export function AgentTurnTrace({
  activities = [],
  toolCalls = [],
  turn,
  streaming,
  failed = false,
}: {
  activities?: ChatActivity[];
  toolCalls?: ToolCallData[];
  turn?: ChatTurnTrace;
  streaming: boolean;
  failed?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const thoughts = useMemo(() => buildThoughts(activities, streaming), [activities, streaming]);
  const turnFailed = failed || turn?.status === 'failed' || toolCalls.some((c) => c.status === 'error');
  const turnStopped = turn?.status === 'stopped';
  const toolCount = toolCalls.length;
  const durationMs = resolveDurationMs(turn, activities);

  // Once the turn settles, never leave the timeline pinned open from a previous
  // streaming session.
  useEffect(() => {
    if (streaming) setOpen(false);
  }, [streaming]);

  // ── Streaming: write the thoughts out, latest alive, older settling. ──────
  if (streaming) {
    const live = thoughts.length > 0
      ? thoughts
      : [{ id: 'preparing', text: 'Thinking', state: 'active' as const }];
    const visible = live.slice(-VISIBLE_WHILE_STREAMING);
    const hidden = live.length - visible.length;
    return (
      <div className="mb-2 flex w-full min-w-0 flex-col gap-1" data-testid="agent-turn-trace">
        {hidden > 0 && (
          <div className="pl-3.5 text-[10px] text-text-muted/60">+{hidden} earlier</div>
        )}
        {visible.map((thought, index) => {
          const isLast = index === visible.length - 1;
          return (
            <div
              key={thought.id}
              className={clsx(
                'flex min-w-0 items-start gap-2 transition-opacity duration-300',
                isLast ? 'opacity-100' : 'opacity-45',
              )}
            >
              {isLast && thought.state !== 'error' ? (
                <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-accent" />
              ) : thought.state === 'error' ? (
                <AlertTriangle size={12} className="mt-0.5 shrink-0 text-danger" />
              ) : (
                <Check size={12} className="mt-0.5 shrink-0 text-text-muted/70" />
              )}
              <span
                className={clsx(
                  'min-w-0 flex-1 text-[12px] leading-5',
                  isLast ? 'text-text-secondary break-words' : 'text-text-muted truncate',
                  thought.state === 'error' && 'text-danger',
                )}
              >
                {thought.text}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  // ── Settled: collapse to one pill, unless the turn was trivial. ───────────
  const substantiveThoughts = thoughts.filter((thought) => !isSetupThought(thought.text)).length;
  const worthShowing = turnFailed || turnStopped || toolCount > 0 || substantiveThoughts >= 1;
  if (!worthShowing) return null;

  const summary = turnFailed
    ? 'Failed'
    : turnStopped
      ? 'Stopped'
      : toolCount > 0
        ? `Used ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`
        : 'Done';
  const meta = durationMs != null ? formatDuration(durationMs) : null;

  const detailTools = toolCalls.filter(
    (call) => call.args !== undefined || call.result !== undefined || call.error,
  );

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="mb-2 w-full min-w-0" data-testid="agent-turn-trace">
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className="group flex w-full min-w-0 items-center gap-1.5 text-left text-[11px] text-text-muted transition-colors duration-150 hover:text-text-secondary"
          aria-label={open ? 'Hide work' : 'Show work'}
        >
          <ChevronRight
            size={12}
            className={clsx('shrink-0 transition-transform duration-200', open && 'rotate-90')}
          />
          {turnFailed ? (
            <AlertTriangle size={12} className="shrink-0 text-danger" />
          ) : turnStopped ? (
            <CircleSlash size={12} className="shrink-0 text-warn" />
          ) : (
            <Check size={12} className="shrink-0 text-accent/60" />
          )}
          <span className={clsx('shrink-0 font-medium', turnFailed && 'text-danger')}>{summary}</span>
          {meta && (
            <>
              <span className="shrink-0 text-text-muted/40">·</span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-muted/80">{meta}</span>
            </>
          )}
          <span className="ml-auto shrink-0 text-[10px] text-text-muted/0 transition-colors group-hover:text-text-muted/70">
            {open ? 'hide' : 'details'}
          </span>
        </button>
      </Collapsible.Trigger>

      <Collapsible.Content className="overflow-hidden animate-in fade-in duration-200">
        <div className="ml-1.5 mt-2 border-l border-line/55 pl-3">
          {thoughts.map((thought) => (
            <div key={thought.id} className="relative pb-2.5 last:pb-0">
              <span
                className={clsx(
                  'absolute -left-[17px] top-1.5 h-1.5 w-1.5 rounded-full border bg-surface',
                  thought.state === 'error' ? 'border-danger bg-danger' : 'border-line',
                )}
              />
              <div className={clsx('text-[12px] leading-5', thought.state === 'error' ? 'text-danger' : 'text-text-secondary')}>
                {thought.text}
              </div>
              {thought.detail && (
                <div className="mt-0.5 break-words text-[11px] leading-4 text-text-muted [overflow-wrap:anywhere]">
                  {thought.detail}
                </div>
              )}
            </div>
          ))}

          {detailTools.length > 0 && (
            <div className="mt-1 space-y-1 border-t border-line/40 pt-2">
              {detailTools.map((call) => (
                <ToolDetailRow key={call.id} data={call} />
              ))}
            </div>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function ToolDetailRow({ data }: { data: ToolCallData }) {
  const [detailOpen, setDetailOpen] = useState(data.status === 'error');
  const isError = data.status === 'error';

  const artifactIds = useMemo(() => {
    const ids = new Set<string>();
    collectArtifactIds(data.result, ids);
    return [...ids];
  }, [data.result]);

  return (
    <Collapsible.Root open={detailOpen} onOpenChange={setDetailOpen} className="min-w-0">
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left transition-colors duration-150 hover:bg-surface-2/50"
        >
          <ChevronRight
            size={11}
            className={clsx('shrink-0 text-text-muted/60 transition-transform duration-150', detailOpen && 'rotate-90')}
          />
          <code
            className={clsx(
              'min-w-0 truncate rounded border px-1.5 py-0.5 font-mono text-[10px]',
              isError ? 'border-danger/25 bg-danger-soft text-danger' : 'border-line bg-surface-3 text-text-muted',
            )}
          >
            {data.name}
          </code>
          {data.durationMs != null && (
            <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-text-muted/60">
              {formatDuration(data.durationMs)}
            </span>
          )}
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden animate-in fade-in duration-200">
        <div className="ml-4 mt-1.5 max-w-full overflow-hidden rounded-lg border border-line bg-canvas/80 p-2 shadow-sm">
          {data.args !== undefined && <JsonBlock label="Input" value={data.args} />}
          {isError ? (
            <JsonBlock label="Error" value={data.error ?? 'Unknown error'} tone="error" />
          ) : (
            data.result !== undefined && <JsonBlock label="Result" value={data.result} />
          )}
          {artifactIds.length > 0 && (
            <div className="mt-2 last:mb-0">
              <div className="mb-2 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-text-muted">Generated Assets</div>
              <ChatArtifactAttachments artifactIds={artifactIds} />
            </div>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function JsonBlock({ label, value, tone }: { label: string; value: unknown; tone?: 'error' }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className={clsx('mb-1 font-mono text-[9px] font-semibold uppercase tracking-[0.16em]', tone === 'error' ? 'text-danger' : 'text-text-muted')}>
        {label}
      </div>
      <pre className={clsx(
        'max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border p-2 font-mono text-[10.5px] leading-relaxed [overflow-wrap:anywhere]',
        tone === 'error'
          ? 'border-danger/25 bg-danger-soft/30 text-danger shadow-inner'
          : 'border-line/65 bg-canvas/90 text-text-secondary shadow-inner',
      )}>
        {formatJson(value)}
      </pre>
    </div>
  );
}

function formatJson(value: unknown): string {
  if (value === undefined || value === null) return '(empty)';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
