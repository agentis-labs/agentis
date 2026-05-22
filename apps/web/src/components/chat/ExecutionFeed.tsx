import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Circle, ExternalLink, Loader2, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import type { ToolCallPillData } from '../ChatPanel/ToolCallPill';

export function ExecutionFeed({
  toolCalls,
  streaming,
}: {
  toolCalls: ToolCallPillData[];
  streaming: boolean;
}) {
  const [open, setOpen] = useState(true);
  const wasStreaming = useRef(streaming);
  const running = toolCalls.filter((call) => call.status === 'running').length;
  const failed = toolCalls.filter((call) => call.status === 'error').length;
  const completed = toolCalls.filter((call) => call.status !== 'running').length;
  const workflowId = firstStringFromResults(toolCalls, 'workflowId');
  const runId = firstStringFromResults(toolCalls, 'runId');

  useEffect(() => {
    if (streaming || running > 0) setOpen(true);
    if (wasStreaming.current && !streaming && running === 0) setOpen(false);
    wasStreaming.current = streaming;
  }, [running, streaming]);

  if (toolCalls.length === 0) return null;

  const title = running > 0
    ? `Running ${running} action${running === 1 ? '' : 's'}`
    : failed > 0
      ? `${failed} action${failed === 1 ? '' : 's'} need attention`
      : `${completed} action${completed === 1 ? '' : 's'} completed`;

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-line/70 bg-canvas/75 text-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]" data-testid="execution-feed">
      <div className="flex items-center gap-2 border-b border-line/60 px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 font-semibold text-text-primary transition hover:bg-surface-2 active:scale-[0.98]"
          aria-expanded={open}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Execution
        </button>
        <span className={clsx(
          'rounded-full px-2 py-0.5 font-medium',
          failed > 0
            ? 'bg-danger/10 text-danger'
            : running > 0
              ? 'bg-accent/10 text-accent'
              : 'bg-surface-2 text-text-muted',
        )}>
          {title}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {workflowId && (
            <Link to={`/workflows/${workflowId}`} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-accent transition hover:bg-accent/10">
              Canvas
              <ExternalLink size={10} />
            </Link>
          )}
          {runId && !String(runId).startsWith('build_') && (
            <Link to={`/runs/${runId}`} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-accent transition hover:bg-accent/10">
              Run
              <ExternalLink size={10} />
            </Link>
          )}
        </div>
      </div>
      {open && (
        <div className="divide-y divide-line/50">
          {toolCalls.map((call) => (
            <ExecutionFeedRow key={call.id} data={call} />
          ))}
        </div>
      )}
    </div>
  );
}

function ExecutionFeedRow({ data }: { data: ToolCallPillData }) {
  const [open, setOpen] = useState(data.status === 'error');
  const hasDetails = data.args !== undefined || data.result !== undefined || data.error;

  return (
    <div data-testid="execution-feed-row" data-status={data.status}>
      <button
        type="button"
        disabled={!hasDetails}
        onClick={() => setOpen((value) => !value)}
        className={clsx(
          'flex w-full items-center gap-2 px-2.5 py-2 text-left transition',
          hasDetails && 'hover:bg-surface-2/70 active:bg-surface-2',
          !hasDetails && 'cursor-default',
        )}
        aria-expanded={open}
      >
        <StatusIcon status={data.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-primary">{data.name}</span>
        <span className="font-mono text-[10px] text-text-muted">
          {data.status === 'running' ? 'running' : data.durationMs != null ? formatDuration(data.durationMs) : data.status}
        </span>
        {hasDetails ? (
          open ? <ChevronDown size={12} className="text-text-muted" /> : <ChevronRight size={12} className="text-text-muted" />
        ) : (
          <span className="w-3" />
        )}
      </button>
      {open && hasDetails && (
        <div className="grid gap-2 border-t border-line/50 bg-surface/40 px-2.5 py-2">
          {data.args !== undefined && <JsonBlock label="Input" value={data.args} />}
          {data.status === 'error' ? (
            <JsonBlock label="Error" value={data.error ?? 'Unknown error'} tone="error" />
          ) : (
            data.result !== undefined && <JsonBlock label="Result" value={data.result} />
          )}
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: ToolCallPillData['status'] }) {
  if (status === 'running') return <Loader2 size={13} className="shrink-0 animate-spin text-accent" />;
  if (status === 'success') return <CheckCircle2 size={13} className="shrink-0 text-accent" />;
  if (status === 'error') return <XCircle size={13} className="shrink-0 text-danger" />;
  return <Circle size={13} className="shrink-0 text-text-muted" />;
}

function JsonBlock({ label, value, tone }: { label: string; value: unknown; tone?: 'error' }) {
  return (
    <div>
      <div className={clsx('mb-1 text-[10px] font-semibold uppercase tracking-[0.16em]', tone === 'error' ? 'text-danger' : 'text-text-muted')}>
        {label}
      </div>
      <pre className={clsx(
        'max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-2 font-mono text-[10px] leading-relaxed',
        tone === 'error'
          ? 'border-danger/30 bg-danger/10 text-danger'
          : 'border-line/60 bg-canvas/80 text-text-secondary',
      )}>
        {formatJson(value)}
      </pre>
    </div>
  );
}

function firstStringFromResults(toolCalls: ToolCallPillData[], key: string): string | null {
  for (const call of toolCalls) {
    const value = readRecord(call.result)?.[key];
    if (typeof value === 'string' && value.trim()) return value;
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
