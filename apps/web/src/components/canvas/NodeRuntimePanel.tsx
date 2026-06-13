/**
 * NodeRuntimePanel — the runtime half of a node's inspector card.
 *
 * The canvas should answer "what is this step doing, what did it produce, and
 * how has it behaved" without leaving the canvas. This panel shows, for the
 * selected node, minimalistically:
 *   • live status of the current run (pulses while running),
 *   • a compact history strip of recent runs (status per run, click to inspect),
 *   • the selected run's generated output (summary, expandable to full).
 *
 * One endpoint backs it (`/v1/runs/node-history`); it refreshes live off the
 * existing run-room realtime events the canvas already subscribes to.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, Clock, ExternalLink } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import { api } from '../../lib/api';
import { useRealtime } from '../../lib/realtime';

interface NodeRunEntry {
  runId: string;
  runStatus: string;
  startedAt: string;
  finishedAt?: string;
  node: {
    status: string;
    durationMs?: number;
    outputSummary?: string;
    output?: unknown;
    error?: string;
  } | null;
}

const NODE_EVENTS = [
  REALTIME_EVENTS.NODE_STARTED,
  REALTIME_EVENTS.NODE_COMPLETED,
  REALTIME_EVENTS.NODE_FAILED,
  REALTIME_EVENTS.NODE_WAITING_FOR_INPUT,
  REALTIME_EVENTS.NODE_RETRY_SCHEDULED,
  REALTIME_EVENTS.RUN_RUNNING,
  REALTIME_EVENTS.RUN_COMPLETED,
  REALTIME_EVENTS.RUN_FAILED,
];

/** status → {dot color, label}. Covers run + node statuses. */
function statusMeta(status: string | undefined): { color: string; label: string; live?: boolean } {
  switch ((status ?? '').toLowerCase()) {
    case 'running':
    case 'in_progress':
    case 'active':
      return { color: 'bg-accent', label: 'Running', live: true };
    case 'completed':
    case 'success':
      return { color: 'bg-emerald-500', label: 'Completed' };
    case 'failed':
    case 'error':
      return { color: 'bg-rose-500', label: 'Failed' };
    case 'waiting':
    case 'paused':
    case 'blocked':
      return { color: 'bg-amber-500', label: 'Waiting' };
    case 'pending':
    case 'queued':
      return { color: 'bg-text-muted', label: 'Pending' };
    case 'skipped':
      return { color: 'bg-text-muted/60', label: 'Skipped' };
    default:
      return { color: 'bg-text-muted/40', label: status ? status : 'Not run' };
  }
}

function fmtDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function relTime(iso?: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function renderOutput(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

export function NodeRuntimePanel({
  workflowId,
  nodeId,
  activeRunId,
  onOpenRun,
}: {
  workflowId: string;
  nodeId: string;
  /** The run currently being watched on the canvas, if any. */
  activeRunId?: string | null;
  /** Open a run in the canvas run drawer (stays on the canvas). */
  onOpenRun?: (runId: string) => void;
}) {
  const [history, setHistory] = useState<NodeRunEntry[] | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(true);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    void api<{ history: NodeRunEntry[] }>(
      `/v1/runs/node-history?workflowId=${encodeURIComponent(workflowId)}&nodeId=${encodeURIComponent(nodeId)}&limit=8`,
    )
      .then((res) => setHistory(res.history ?? []))
      .catch(() => setHistory([]));
  }, [workflowId, nodeId]);

  useEffect(() => {
    setHistory(null);
    setSelectedRunId(null);
    load();
  }, [load]);

  // Live: refetch (debounced) when a node/run event arrives for our active run.
  useRealtime(NODE_EVENTS, (env) => {
    const payloadRunId = (env.payload as { runId?: string } | undefined)?.runId;
    if (activeRunId && payloadRunId && payloadRunId !== activeRunId) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(load, 350);
  });

  const entries = history ?? [];
  // Default selection: the active run if present in history, else the newest.
  const selected = useMemo(() => {
    if (entries.length === 0) return null;
    if (selectedRunId) return entries.find((e) => e.runId === selectedRunId) ?? entries[0];
    if (activeRunId) return entries.find((e) => e.runId === activeRunId) ?? entries[0];
    return entries[0];
  }, [entries, selectedRunId, activeRunId]);

  if (history === null) {
    return (
      <div className="mb-3 rounded-input border border-line bg-surface-2 px-2.5 py-2 text-[11px] text-text-muted">
        Loading activity…
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="mb-3 rounded-input border border-line bg-surface-2 px-2.5 py-2 text-[11px] text-text-muted">
        No runs yet for this step. Run the workflow to see live status and output here.
      </div>
    );
  }

  const selMeta = statusMeta(selected?.node?.status);
  const outputText = selected?.node ? renderOutput(selected.node.output) : '';

  return (
    <div className="mb-3 overflow-hidden rounded-input border border-line bg-surface-2">
      {/* Live status row */}
      <div className="flex items-center justify-between gap-2 border-b border-line/60 px-2.5 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-text-primary">
          <span className={clsx('inline-block h-2 w-2 rounded-full', selMeta.color, selMeta.live && 'animate-pulse')} />
          {selMeta.label}
          {selected?.node?.durationMs != null && (
            <span className="font-normal text-text-muted">· {fmtDuration(selected.node.durationMs)}</span>
          )}
        </span>
        <span className="flex items-center gap-1 text-[10px] text-text-muted">
          <Clock size={10} /> {relTime(selected?.finishedAt ?? selected?.startedAt)}
        </span>
      </div>

      {/* History strip — recent runs (newest first), click to inspect that run's output */}
      <div className="flex items-center gap-1 px-2.5 py-2">
        <span className="mr-1 text-[10px] uppercase tracking-wider text-text-muted">History</span>
        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          {entries.map((entry) => {
            const meta = statusMeta(entry.node?.status);
            const isSelected = entry.runId === selected?.runId;
            return (
              <button
                key={entry.runId}
                type="button"
                onClick={() => setSelectedRunId(entry.runId)}
                title={`${meta.label}${entry.node?.durationMs != null ? ` · ${fmtDuration(entry.node.durationMs)}` : ''} · ${relTime(entry.finishedAt ?? entry.startedAt)}`}
                className={clsx(
                  'h-4 w-4 shrink-0 rounded-full border transition-transform hover:scale-110',
                  meta.color,
                  isSelected ? 'border-text-primary' : 'border-transparent',
                  meta.live && 'animate-pulse',
                )}
              />
            );
          })}
        </div>
        {selected && onOpenRun && (
          <button
            type="button"
            onClick={() => onOpenRun(selected.runId)}
            title="Open this run"
            className="ml-1 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-text-muted hover:text-accent"
          >
            <ExternalLink size={10} /> Run
          </button>
        )}
      </div>

      {/* Output / error of the selected run */}
      {(outputText || selected?.node?.error) && (
        <div className="border-t border-line/60">
          <button
            type="button"
            onClick={() => setShowOutput((v) => !v)}
            className="flex w-full items-center gap-1 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-text-muted hover:text-text-secondary"
          >
            {showOutput ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {selected?.node?.error ? 'Error' : 'Output'}
          </button>
          {showOutput && (
            <div className="px-2.5 pb-2.5">
              {selected?.node?.error ? (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-rose-500/10 p-2 text-[11px] leading-snug text-rose-300">
                  {selected.node.error}
                </pre>
              ) : (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-2 font-mono text-[10.5px] leading-snug text-text-secondary">
                  {outputText.length > 4000 ? `${outputText.slice(0, 4000)}\n…` : outputText}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
