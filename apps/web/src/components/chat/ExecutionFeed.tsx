import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Circle, Clock3, ExternalLink, Loader2, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import * as Collapsible from '@radix-ui/react-collapsible';
import type { ToolCallData } from './toolCalls';

export function ExecutionFeed({
  toolCalls,
  streaming,
}: {
  toolCalls: ToolCallData[];
  streaming: boolean;
}) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const wasStreaming = useRef(streaming);
  const running = toolCalls.filter((c) => c.status === 'running').length;
  const failed = toolCalls.filter((c) => c.status === 'error').length;
  const completed = toolCalls.filter((c) => c.status !== 'running').length;
  const workflowId = firstStringFromResults(toolCalls, 'workflowId');
  const runId = firstStringFromResults(toolCalls, 'runId');
  const totalDuration = toolCalls.reduce((sum, tc) => sum + (tc.durationMs ?? 0), 0);
  const isActive = streaming || running > 0;

  useEffect(() => {
    // Auto-collapse to summary pill when streaming ends and no tools running
    if (wasStreaming.current && !streaming && running === 0) {
      setSummaryOpen(false);
    }
    if (streaming || running > 0) setSummaryOpen(false); // reset expanded detail when active
    wasStreaming.current = streaming;
  }, [running, streaming]);

  if (toolCalls.length === 0) return null;

  // Collapsed summary pill (shown after streaming completes)
  if (!isActive && !summaryOpen) {
    const hasErrors = failed > 0;
    return (
      <button
        type="button"
        onClick={() => setSummaryOpen(true)}
        data-testid="execution-feed"
        className={clsx(
          'mb-3 flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs',
          'border border-line bg-surface-2/60 backdrop-blur-sm transition-all duration-200 shadow-card',
          'hover:border-accent/30 hover:bg-surface-2/80 active:scale-[0.99]',
        )}
      >
        {hasErrors ? (
          <AlertTriangle size={13} className="shrink-0 text-warn" />
        ) : (
          <CheckCircle2 size={13} className="shrink-0 text-accent" />
        )}
        <span className="flex-1 font-mono text-[11px] text-text-secondary">
          Executed {toolCalls.length} tool{toolCalls.length !== 1 ? 's' : ''}
          {failed > 0 && <span className="ml-1.5 font-medium text-warn">· {failed} failed</span>}
          <span className="ml-1.5 text-text-muted">· {formatDuration(totalDuration)}</span>
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {workflowId && (
            <Link
              to={`/workflows/${workflowId}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded bg-accent/8 px-1.5 py-0.5 text-[10px] font-medium text-accent transition hover:bg-accent/15"
            >
              Canvas <ExternalLink size={9} />
            </Link>
          )}
          {runId && !String(runId).startsWith('build_') && (
            <Link
              to={`/runs/${runId}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded bg-accent/8 px-1.5 py-0.5 text-[10px] font-medium text-accent transition hover:bg-accent/15"
            >
              Run <ExternalLink size={9} />
            </Link>
          )}
          <ChevronRight size={13} className="text-text-muted/60" />
        </div>
      </button>
    );
  }

  // Expanded detail (when summaryOpen after completion)
  if (!isActive && summaryOpen) {
    return (
      <div className="mb-3 overflow-hidden rounded-xl border border-line bg-surface-2/45 shadow-card text-xs" data-testid="execution-feed">
        <button
          type="button"
          onClick={() => setSummaryOpen(false)}
          className="flex w-full items-center gap-2 border-b border-line/45 px-3 py-2 text-left font-semibold text-text-primary transition hover:bg-surface-2/65"
        >
          <ChevronDown size={13} className="text-text-muted" />
          <span>Execution Details</span>
          <span className="ml-auto font-normal text-text-muted text-[10px]">{formatDuration(totalDuration)}</span>
        </button>
        <div className="divide-y divide-line/25 bg-surface/35">
          {toolCalls.map((call) => (
            <CompletedStepRow key={call.id} data={call} />
          ))}
        </div>
      </div>
    );
  }

  // Active state: live step list
  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-accent/25 bg-surface-2/50 text-xs shadow-card" data-testid="execution-feed">
      {/* Progress header */}
      <div className="flex items-center gap-2 border-b border-line/45 px-3 py-2 bg-surface/40">
        <Loader2 size={13} className="animate-spin text-accent" />
        <span className="font-semibold text-text-primary">Executing Tools</span>
        <span className="rounded-full bg-accent/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-accent">
          {completed}/{toolCalls.length}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {workflowId && (
            <Link to={`/workflows/${workflowId}`} className="inline-flex items-center gap-1 rounded bg-accent/8 px-1.5 py-0.5 text-[10px] font-medium text-accent transition hover:bg-accent/15">
              Canvas <ExternalLink size={9} />
            </Link>
          )}
          {runId && !String(runId).startsWith('build_') && (
            <Link to={`/runs/${runId}`} className="inline-flex items-center gap-1 rounded bg-accent/8 px-1.5 py-0.5 text-[10px] font-medium text-accent transition hover:bg-accent/15">
              Run <ExternalLink size={9} />
            </Link>
          )}
        </div>
      </div>

      {/* Sequential step list */}
      <div className="divide-y divide-line/25">
        {toolCalls.map((call, idx) => (
          <ActiveStepRow
            key={call.id}
            data={call}
            idx={idx}
            isLatest={idx === toolCalls.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function ActiveStepRow({
  data,
  isLatest,
}: {
  data: ToolCallData;
  idx: number;
  isLatest: boolean;
}) {
  const isRunning = data.status === 'running';
  const isPaused = data.status === 'paused';
  const isError = data.status === 'error';
  const isDone = data.status === 'success';
  const [detailOpen, setDetailOpen] = useState(isError);
  const hasDetails = data.args !== undefined || data.result !== undefined || data.error;

  return (
    <Collapsible.Root
      open={detailOpen}
      onOpenChange={setDetailOpen}
      className={clsx(
        'group relative px-3 py-2 transition-colors duration-200',
        isRunning && 'bg-accent-soft/5',
        isError && 'bg-danger-soft/5',
      )}
    >
      {/* Running shimmer */}
      {isRunning && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute inset-y-0 -left-full w-1/2 animate-[shimmer_1.5s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-accent/5 to-transparent" />
        </div>
      )}

      <div className="flex items-center gap-2">
        {/* Status icon */}
        <span className="shrink-0 flex items-center justify-center h-4 w-4">
          {isRunning ? (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
            </span>
          ) : isPaused ? (
            <Clock3 size={12} className="text-warn" />
          ) : isError ? (
            <XCircle size={12} className="text-danger" />
          ) : isDone ? (
            <CheckCircle2 size={12} className="text-accent/70" />
          ) : (
            <Circle size={12} className="text-text-muted/40" />
          )}
        </span>

        {/* Step name / code-style chip */}
        <span className="min-w-0 flex-1 truncate">
          <code
            className={clsx(
              'px-1.5 py-0.5 rounded border text-[10px] font-mono transition-all',
              isRunning
                ? 'bg-accent/8 border-accent/20 text-accent font-semibold'
                : isError
                  ? 'bg-danger-soft border-danger/25 text-danger font-medium'
                  : isDone
                    ? 'bg-surface-3 border-line text-text-secondary'
                    : 'bg-surface-2 border-line text-text-muted'
            )}
          >
            {data.name}
          </code>
        </span>

        {/* Duration */}
        <span
          className={clsx(
            'shrink-0 font-mono text-[10px] tabular-nums',
            isRunning ? 'text-accent animate-pulse' : isPaused ? 'text-warn' : isError ? 'text-danger' : 'text-text-muted/60',
          )}
        >
          {isRunning ? 'running…' : isPaused ? 'paused' : data.durationMs != null ? formatDuration(data.durationMs) : data.status}
        </span>

        {/* Details toggle */}
        {hasDetails && (
          <Collapsible.Trigger asChild>
            <button
              type="button"
              className="shrink-0 rounded-lg p-1 text-text-muted/50 hover:bg-surface-3 hover:text-text-primary transition duration-150 focus:outline-none"
            >
              {detailOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </Collapsible.Trigger>
        )}
      </div>

      {/* Expandable details */}
      {hasDetails && (
        <Collapsible.Content className="overflow-hidden animate-in fade-in duration-200">
          <div className="ml-6 mt-2 rounded-xl border border-line bg-canvas/80 p-2.5 shadow-sm">
            {data.args !== undefined && <JsonBlock label="Input" value={data.args} />}
            {isError ? (
              <JsonBlock label="Error" value={data.error ?? 'Unknown error'} tone="error" />
            ) : (
              data.result !== undefined && <JsonBlock label="Result" value={data.result} />
            )}
          </div>
        </Collapsible.Content>
      )}
    </Collapsible.Root>
  );
}

function CompletedStepRow({ data }: { data: ToolCallData }) {
  const [detailOpen, setDetailOpen] = useState(data.status === 'error');
  const hasDetails = data.args !== undefined || data.result !== undefined || data.error;
  const isError = data.status === 'error';

  return (
    <Collapsible.Root open={detailOpen} onOpenChange={setDetailOpen} className="group px-3 py-2">
      <div className="flex items-center gap-2">
        {isError ? (
          <XCircle size={12} className="shrink-0 text-danger" />
        ) : (
          <CheckCircle2 size={12} className="shrink-0 text-accent/50" />
        )}
        <span className="min-w-0 flex-1 truncate">
          <code
            className={clsx(
              'px-1.5 py-0.5 rounded border text-[10px] font-mono',
              isError
                ? 'bg-danger-soft border-danger/25 text-danger'
                : 'bg-surface-3 border-line text-text-muted'
            )}
          >
            {data.name}
          </code>
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-muted/50 mr-1">
          {data.durationMs != null ? formatDuration(data.durationMs) : ''}
        </span>
        {hasDetails && (
          <Collapsible.Trigger asChild>
            <button
              type="button"
              className="shrink-0 rounded-lg p-1 text-text-muted/50 hover:bg-surface-3 hover:text-text-primary transition duration-150 focus:outline-none"
            >
              {detailOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </Collapsible.Trigger>
        )}
      </div>

      {hasDetails && (
        <Collapsible.Content className="overflow-hidden animate-in fade-in duration-200">
          <div className="ml-5 mt-2 rounded-xl border border-line bg-canvas/80 p-2.5 shadow-sm">
            {data.args !== undefined && <JsonBlock label="Input" value={data.args} />}
            {isError ? (
              <JsonBlock label="Error" value={data.error ?? 'Unknown error'} tone="error" />
            ) : (
              data.result !== undefined && <JsonBlock label="Result" value={data.result} />
            )}
          </div>
        </Collapsible.Content>
      )}
    </Collapsible.Root>
  );
}

function JsonBlock({ label, value, tone }: { label: string; value: unknown; tone?: 'error' }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className={clsx('mb-1 text-[9px] font-semibold uppercase tracking-[0.16em] font-mono', tone === 'error' ? 'text-danger' : 'text-text-muted')}>
        {label}
      </div>
      <pre className={clsx(
        'max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-2 font-mono text-[10.5px] leading-relaxed',
        tone === 'error'
          ? 'border-danger/25 bg-danger-soft/30 text-danger shadow-inner'
          : 'border-line/65 bg-canvas/90 text-text-secondary shadow-inner',
      )}>
        {formatJson(value)}
      </pre>
    </div>
  );
}

function firstStringFromResults(toolCalls: ToolCallData[], key: string): string | null {
  for (const call of toolCalls) {
    const val = readRecord(call.result)?.[key];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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
