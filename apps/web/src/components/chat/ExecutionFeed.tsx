import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Loader2, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import * as Collapsible from '@radix-ui/react-collapsible';
import type { ToolCallData } from './toolCalls';
import { openRunModal } from '../../lib/runModal';

export function ExecutionFeed({
  toolCalls,
  streaming,
}: {
  toolCalls: ToolCallData[];
  streaming: boolean;
}) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const wasStreaming = useRef(streaming);
  const running = toolCalls.filter((call) => call.status === 'running').length;
  const failed = toolCalls.filter((call) => call.status === 'error').length;
  const completed = toolCalls.filter((call) => call.status !== 'running').length;
  const workflowId = firstStringFromResults(toolCalls, 'workflowId');
  const runId = firstStringFromResults(toolCalls, 'runId');
  const isActive = streaming || running > 0;
  const latestCall = [...toolCalls]
    .reverse()
    .find((call) => call.status === 'running' || call.status === 'paused')
    ?? toolCalls.at(-1);

  useEffect(() => {
    if (wasStreaming.current && !streaming && running === 0) {
      setSummaryOpen(false);
    }
    if (streaming || running > 0) setSummaryOpen(false);
    wasStreaming.current = streaming;
  }, [running, streaming]);

  if (toolCalls.length === 0) return null;
  if (!isActive && failed === 0 && !summaryOpen) return null;

  if (!isActive && !summaryOpen) {
    return (
      <button
        type="button"
        onClick={() => setSummaryOpen(true)}
        data-testid="execution-feed"
        className={clsx(
          'mb-3 flex w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-xl px-3 py-2.5 text-left text-xs',
          'border border-line bg-surface-2/60 shadow-card transition-colors duration-150',
          'hover:border-warn/35 hover:bg-surface-2/80 active:scale-[0.99]',
        )}
      >
        <AlertTriangle size={13} className="shrink-0 text-warn" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">
          {failed === 1 ? 'Tool failed' : `${failed} tools failed`}
        </span>
        <ExecutionLinks workflowId={workflowId} runId={runId} />
        <ChevronRight size={13} className="shrink-0 text-text-muted/60" />
      </button>
    );
  }

  if (summaryOpen) {
    return (
      <div className="mb-3 min-w-0 max-w-full overflow-hidden rounded-xl border border-line bg-surface-2/45 text-xs shadow-card" data-testid="execution-feed">
        <button
          type="button"
          onClick={() => setSummaryOpen(false)}
          className="flex w-full min-w-0 items-center gap-2 border-b border-line/45 px-3 py-2 text-left font-semibold text-text-primary transition-colors duration-150 hover:bg-surface-2/65"
        >
          <ChevronDown size={13} className="text-text-muted" />
          <span className="min-w-0 truncate">{isActive ? 'Live execution details' : 'Execution details'}</span>
          <span className="ml-auto">
            <ExecutionLinks workflowId={workflowId} runId={runId} />
          </span>
        </button>
        <div className="divide-y divide-line/25 bg-surface/35">
          {toolCalls.map((call) => (
            <CompletedStepRow key={call.id} data={call} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setSummaryOpen(true)}
      className="mb-1 flex min-h-7 w-full min-w-0 items-center gap-2 overflow-hidden text-left text-[11px] text-text-secondary transition-colors duration-150 hover:text-text-primary active:scale-[0.99]"
      data-testid="execution-feed"
    >
      <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
      <code className="min-w-0 flex-1 truncate font-mono text-[10px]">
        {latestCall?.name ?? 'Running tool'}
      </code>
      {completed > 0 && <span className="shrink-0 text-text-muted">{completed} done</span>}
      <ChevronRight size={12} className="shrink-0 text-text-muted" />
    </button>
  );
}

function ExecutionLinks({ workflowId, runId }: { workflowId: string | null; runId: string | null }) {
  if (!workflowId && !runId) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      {workflowId && (
        <Link
          to={`/apps/workflows/${workflowId}`}
          onClick={(event) => event.stopPropagation()}
          className="inline-flex items-center gap-1 rounded bg-accent/8 px-1.5 py-0.5 text-[10px] font-medium text-accent transition-colors duration-150 hover:bg-accent/15"
        >
          Canvas <ExternalLink size={9} />
        </Link>
      )}
      {runId && !String(runId).startsWith('build_') && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            openRunModal({ runId, workflowId, source: 'chat-execution-feed' });
          }}
          className="inline-flex items-center gap-1 rounded bg-accent/8 px-1.5 py-0.5 text-[10px] font-medium text-accent transition-colors duration-150 hover:bg-accent/15"
        >
          Run <ExternalLink size={9} />
        </button>
      )}
    </span>
  );
}

function CompletedStepRow({ data }: { data: ToolCallData }) {
  const [detailOpen, setDetailOpen] = useState(data.status === 'error');
  const hasDetails = data.args !== undefined || data.result !== undefined || data.error;
  const isError = data.status === 'error';

  return (
    <Collapsible.Root open={detailOpen} onOpenChange={setDetailOpen} className="group min-w-0 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {isError ? (
          <XCircle size={12} className="shrink-0 text-danger" />
        ) : (
          <CheckCircle2 size={12} className="shrink-0 text-accent/50" />
        )}
        <span className="min-w-0 flex-1 truncate">
          <code
            className={clsx(
              'rounded border px-1.5 py-0.5 font-mono text-[10px]',
              isError
                ? 'border-danger/25 bg-danger-soft text-danger'
                : 'border-line bg-surface-3 text-text-muted',
            )}
          >
            {data.name}
          </code>
        </span>
        {hasDetails && (
          <Collapsible.Trigger asChild>
            <button
              type="button"
              className="shrink-0 rounded-lg p-1 text-text-muted/50 transition-colors duration-150 hover:bg-surface-3 hover:text-text-primary focus:outline-none"
            >
              {detailOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </Collapsible.Trigger>
        )}
      </div>

      {hasDetails && (
        <Collapsible.Content className="overflow-hidden animate-in fade-in duration-200">
          <div className="ml-5 mt-2 max-w-full overflow-hidden rounded-xl border border-line bg-canvas/80 p-2.5 shadow-sm">
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

function firstStringFromResults(toolCalls: ToolCallData[], key: string): string | null {
  for (const call of toolCalls) {
    const value = readRecord(call.result)?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
