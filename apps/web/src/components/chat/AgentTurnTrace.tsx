import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, CircleSlash, FileCheck2, Loader2, TerminalSquare } from 'lucide-react';
import clsx from 'clsx';
import * as Collapsible from '@radix-ui/react-collapsible';
import {
  compactActivityLabel,
  type ChatCommentary,
  type ChatContextManifest,
  type ChatDelta,
  type ChatExecutionEnvelope,
  type ChatTurnTrace,
} from '@agentis/core';
import type { ToolCallData } from './toolCalls';
import { ChatArtifactAttachments, collectArtifactIds } from './ArtifactAttachments';

type ChatActivity = Extract<ChatDelta, { type: 'activity' }>;
type TimelineEntry =
  | { id: string; kind: 'commentary'; text: string; at: string; order: number }
  | { id: string; kind: 'activity'; text: string; detail?: string; phase: ChatActivity['phase']; status: ChatActivity['status']; at: string; order: number };

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, '0')}s`;
}

function resolvedDuration(turn: ChatTurnTrace | undefined, now: number): number | null {
  if (turn?.durationMs != null && turn.durationMs >= 0) return turn.durationMs;
  if (!turn?.startedAt) return null;
  const started = Date.parse(turn.startedAt);
  if (!Number.isFinite(started)) return null;
  const completed = turn.completedAt ? Date.parse(turn.completedAt) : now;
  return Number.isFinite(completed) ? Math.max(0, completed - started) : null;
}

function timeline(commentary: ChatCommentary[], activities: ChatActivity[]): TimelineEntry[] {
  const comments: TimelineEntry[] = commentary
    .filter((entry) => entry.text.trim())
    .filter((entry) => !isGenericHostCommentary(entry.text))
    .filter((entry, index, entries) => entries.findIndex((candidate) => normalizeText(candidate.text) === normalizeText(entry.text)) === index)
    .map((entry, index) => ({
      id: entry.id,
      kind: 'commentary',
      text: entry.text.trim(),
      at: entry.createdAt,
      order: index * 2,
    }));
  const visibleActivities = activities
    .map((activity, index) => ({ activity, label: compactActivityLabel(activity), index }))
    .filter((entry): entry is { activity: ChatActivity; label: string; index: number } => Boolean(entry.label))
    .filter((entry) => !isInternalActivity(entry.label))
    .filter((entry) => !isGenericRuntimeActivity(entry.label, entry.activity))
    // The host receipt becomes the neutral Starting spinner. Connectivity is
    // not an agent-authored thought and should not look like one.
    .filter((entry) => entry.activity.phase !== 'received');
  // The waiting heartbeat is a temporary honesty signal, not permanent log
  // history. As soon as real commentary or a real operation arrives, replace it
  // visually so the live transcript stays as clean as the Codex reference.
  const hasRealProgress = comments.length > 0
    || visibleActivities.some((entry) => entry.activity.phase !== 'waiting');
  const prepared = visibleActivities.filter((entry) =>
    !(hasRealProgress && entry.activity.phase === 'waiting'));
  const latestByMeaning = new Map<string, number>();
  prepared.forEach((entry, index) => latestByMeaning.set(activityMeaning(entry.label), index));
  const actions: TimelineEntry[] = prepared
    // Retries are an implementation detail. Keep only the latest state for the
    // same semantic operation, so a recovered failure becomes one successful row.
    .filter((entry, index) => latestByMeaning.get(activityMeaning(entry.label)) === index)
    .map(({ activity, label, index }) => ({
      id: activity.id,
      kind: 'activity',
      text: label,
      detail: activity.detail,
      phase: activity.phase,
      status: activity.status,
      at: activity.startedAt ?? activity.completedAt ?? '',
      order: index * 2 + 1,
    }));
  return [...comments, ...actions].sort((a, b) => {
    const left = Date.parse(a.at);
    const right = Date.parse(b.at);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
    return a.order - b.order;
  });
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function activityMeaning(label: string): string {
  return normalizeText(label)
    .replace(/^(?:using|used|failed|running|ran|executing)\s+/, '')
    .replace(/\s+[—-]\s+\d+.*elapsed.*$/, '');
}

function isInternalActivity(label: string): boolean {
  return /(?:agentis\s+(?:orient|tools\s+(?:search|describe)|task\s+set\s+steps|canvas\s+context|app\s+goal|workflow\s+loop\s+status|run\s+query|data\s+query)|^run\s+(?:completed|failed)(?::|$)|^used\s+(?:agentis\s+)?(?:orient|workflow\s+loop\s+status|run\s+query|data\s+query)|^failed\s+(?:agentis\s+)?(?:orient|workflow\s+loop\s+status|run\s+query|data\s+query))/i.test(label);
}

function isGenericRuntimeActivity(label: string, activity?: ChatActivity): boolean {
  if (activity && /(?:local-start|local-rewrite|room-waiting|antigravity-runtime)/i.test(activity.id)) return true;
  return /(?:^request received$|^response ready$|^starting (?:antigravity|hermes(?: runtime)?|openclaw|agy|agent)$|response ready|runtime step|is working|is reasoning|waiting for (?:model|runtime) output|waiting for runtime|reading context|starting up|writing the reply)/i.test(label);
}

function isGenericHostCommentary(text: string): boolean {
  return /(?:review the context and confirm what must be done|still executing and verifying the work|report the next concrete finding or result|revisar o contexto e confirmar o que precisa ser feito|continuo executando e verificando o trabalho|informar a pr[oó]xima descoberta ou resultado concreto|run .* now, inspect the observed result)/i.test(text);
}

export function AgentTurnTrace({
  activities = [],
  commentary = [],
  toolCalls = [],
  turn,
  envelope,
  context,
  streaming,
  failed = false,
}: {
  activities?: ChatActivity[];
  commentary?: ChatCommentary[];
  toolCalls?: ToolCallData[];
  turn?: ChatTurnTrace;
  envelope?: ChatExecutionEnvelope;
  context?: ChatContextManifest;
  streaming: boolean;
  failed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const entries = useMemo(() => timeline(commentary, activities), [commentary, activities]);
  const turnFailed = failed || turn?.status === 'failed';
  const stopped = turn?.status === 'stopped' || turn?.status === 'interrupted';
  const duration = resolvedDuration(turn, now);
  const durationLabel = duration == null ? null : formatDuration(duration);
  const hasProviderProgress = commentary.some((entry) => entry.text.trim() && !isGenericHostCommentary(entry.text))
    || toolCalls.length > 0
    || activities.some((activity) => activity.phase !== 'received' && activity.phase !== 'waiting');
  const starting = streaming
    && !hasProviderProgress
    && !activities.some((activity) => activity.phase === 'waiting');
  const meaningful = entries.some((entry) => entry.kind === 'commentary' || !/^(reading context|starting up|writing the reply|thinking)$/i.test(entry.text));
  const worthShowing = streaming || turnFailed || stopped || meaningful || toolCalls.length > 0;

  useEffect(() => {
    if (!streaming) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [streaming]);

  useEffect(() => {
    if (streaming) setOpen(false);
  }, [streaming]);

  if (!worthShowing) return null;

  if (streaming) {
    return (
      <section className="chat-work-transcript mb-4 min-w-0" aria-label="Agent work in progress" data-testid="agent-turn-trace">
        <div className="chat-work-heading">
          {starting && <Loader2 size={12} className="shrink-0 animate-spin text-text-muted" />}
          <span>{starting ? 'Starting' : durationLabel ? `Working for ${durationLabel}` : 'Working'}</span>
          <span className="chat-work-rule" />
        </div>
        <Timeline entries={entries} live />
        <LiveToolRows toolCalls={toolCalls} entries={entries} />
      </section>
    );
  }

  const summary = turnFailed ? 'Work failed' : stopped ? 'Work stopped' : 'Worked';
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="chat-work-transcript mb-3 min-w-0" data-testid="agent-turn-trace">
      <Collapsible.Trigger asChild>
        <button type="button" className="chat-work-heading group w-full text-left" aria-label={open ? 'Hide work' : 'Show work'}>
          <span className={clsx(turnFailed && 'text-danger', stopped && 'text-warn')}>
            {summary}{durationLabel ? ` for ${durationLabel}` : ''}
          </span>
          <ChevronRight size={12} className={clsx('shrink-0 transition-transform duration-200', open && 'rotate-90')} />
          <span className="chat-work-rule" />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden animate-in fade-in slide-in-from-top-1 duration-200">
        <Timeline entries={entries} />
        <WorkDetails toolCalls={toolCalls} envelope={envelope} context={context} />
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function Timeline({ entries, live = false }: { entries: TimelineEntry[]; live?: boolean }) {
  if (entries.length === 0) return null;
  return (
    <div className="space-y-3 py-3">
      {entries.map((entry, index) => {
        const latest = live && index === entries.length - 1;
        if (entry.kind === 'commentary') {
          return (
            <p key={entry.id} className={clsx('max-w-[720px] whitespace-pre-wrap text-[13px] leading-5 text-text-secondary', !latest && live && 'text-text-secondary/80')}>
              {entry.text}
            </p>
          );
        }
        // A recoverable attempt should not remain as a red tombstone after the
        // live agent has visibly moved on to another operation.
        if (live && entry.status === 'error' && !latest) return null;
        const recovered = entry.status === 'error' && entries.slice(index + 1).some((next) => next.kind === 'activity' && next.status === 'success');
        const retrying = live && entry.status === 'error';
        const visibleText = retrying ? `Retrying ${activityMeaning(entry.text)}` : entry.text;
        return (
          <div key={entry.id} className="group flex min-w-0 items-start gap-2 text-[11.5px] leading-5 text-text-muted">
            {(latest && entry.status === 'running') || retrying ? (
              <Loader2 size={12} className={clsx('mt-1 shrink-0 animate-spin', retrying ? 'text-warn' : 'text-text-muted')} />
            ) : entry.status === 'error' ? (
              <AlertTriangle size={12} className={clsx('mt-1 shrink-0', recovered ? 'text-warn' : 'text-danger')} />
            ) : (
              <Check size={12} className="mt-1 shrink-0 text-text-muted/65" />
            )}
            <div className="min-w-0">
              <div className={entry.status === 'error' ? (recovered || retrying ? 'text-warn' : 'text-danger') : undefined}>{visibleText}</div>
              {entry.detail && <div className="line-clamp-2 text-[10.5px] text-text-muted/65">{entry.detail}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function operationKey(value: string): string {
  return activityMeaning(value).replace(/[^a-z0-9]+/g, '');
}

/**
 * Tool protocol events arrive before execution and carry the most accurate
 * loading state. Render them during the live turn (not only in the completed
 * details drawer), updating retries in place by semantic tool name.
 */
function LiveToolRows({ toolCalls, entries }: { toolCalls: ToolCallData[]; entries: TimelineEntry[] }) {
  const activityKeys = new Set(entries.filter((entry) => entry.kind === 'activity').map((entry) => operationKey(entry.text)));
  const latestByTool = new Map<string, ToolCallData>();
  toolCalls.forEach((call) => latestByTool.set(operationKey(call.name), call));
  const visible = [...latestByTool.entries()]
    .filter(([key]) => !activityKeys.has(key))
    .map(([, call]) => call)
    .slice(-8);
  if (visible.length === 0) return null;
  return (
    <div className="space-y-2.5 pb-3 pt-2" aria-label="Live tool operations">
      {visible.map((call) => {
        const retrying = call.status === 'error';
        const running = call.status === 'running' || call.status === 'paused' || retrying;
        const verb = retrying ? 'Retrying' : running ? 'Running' : call.status === 'success' ? 'Used' : 'Stopped';
        return (
          <div key={call.id} className="flex min-w-0 items-start gap-2 text-[11.5px] leading-5 text-text-muted">
            {running ? (
              <Loader2 size={12} className={clsx('mt-1 shrink-0 animate-spin', retrying && 'text-warn')} />
            ) : call.status === 'success' ? (
              <Check size={12} className="mt-1 shrink-0 text-text-muted/65" />
            ) : (
              <CircleSlash size={12} className="mt-1 shrink-0" />
            )}
            <span className={clsx('min-w-0 truncate', retrying && 'text-warn')}>{verb} {call.name}</span>
          </div>
        );
      })}
    </div>
  );
}

function WorkDetails({
  toolCalls,
  envelope,
  context,
}: {
  toolCalls: ToolCallData[];
  envelope?: ChatExecutionEnvelope;
  context?: ChatContextManifest;
}) {
  const detailed = toolCalls.filter((call) => call.args !== undefined || call.result !== undefined || call.error);
  const readyFiles = context?.attachments.filter((file) => file.status === 'ready').length ?? 0;
  if (detailed.length === 0 && !envelope && !context) return null;
  return (
    <div className="mt-1 border-t border-line/45 py-3">
      {(envelope || context) && (
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-text-muted">
          {envelope && <span>{envelope.model ?? envelope.adapterType}{envelope.effectiveReasoningEffort ? ` · ${envelope.effectiveReasoningEffort}` : ''}</span>}
          {envelope?.durable && <span>Background work</span>}
          {readyFiles > 0 && <span><FileCheck2 size={11} className="mr-1 inline" />{readyFiles} file{readyFiles === 1 ? '' : 's'}</span>}
        </div>
      )}
      <div className="space-y-1">
        {detailed.map((call) => <ToolDetail key={call.id} data={call} />)}
      </div>
    </div>
  );
}

function ToolDetail({ data }: { data: ToolCallData }) {
  const [open, setOpen] = useState(data.status === 'error');
  const artifactIds = useMemo(() => {
    const ids = new Set<string>();
    collectArtifactIds(data.result, ids);
    return [...ids];
  }, [data.result]);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left text-[11px] text-text-muted hover:text-text-secondary">
          {data.status === 'error' ? <AlertTriangle size={11} className="text-danger" /> : data.status === 'stopped' ? <CircleSlash size={11} /> : <TerminalSquare size={11} />}
          <span className="min-w-0 truncate font-mono">{data.name}</span>
          <ChevronRight size={11} className={clsx('ml-auto transition-transform', open && 'rotate-90')} />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div className="ml-5 mt-1 rounded-lg border border-line/60 bg-canvas/55 p-2">
          {data.args !== undefined && <JsonBlock label="Input" value={data.args} />}
          {data.error ? <JsonBlock label="Error" value={data.error} error /> : data.result !== undefined && <JsonBlock label="Result" value={data.result} />}
          {artifactIds.length > 0 && <ChatArtifactAttachments artifactIds={artifactIds} />}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function JsonBlock({ label, value, error = false }: { label: string; value: unknown; error?: boolean }) {
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch { text = String(value); }
  return (
    <div className="mb-2 last:mb-0">
      <div className={clsx('mb-1 text-[9px] font-semibold uppercase tracking-[0.14em]', error ? 'text-danger' : 'text-text-muted')}>{label}</div>
      <pre className={clsx('max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed', error ? 'text-danger' : 'text-text-secondary')}>{text}</pre>
    </div>
  );
}
