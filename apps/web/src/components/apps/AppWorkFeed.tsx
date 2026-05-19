/**
 * AppWorkFeed — the unified Surface timeline (SURFACE-PAGE-REDESIGN.md §4 + §5).
 *
 * A single reverse-chronological feed that merges four event types:
 *   a) run completion cards
 *   b) data record cards (one per data_write)
 *   c) running swarm cards (runs in progress)
 *   d) App Brain conversation messages
 *
 * The feed IS the thread — there is no separate conversation panel. Below the
 * feed sits the App Brain composer and a small "Continue in workspace chat"
 * escape-hatch link.
 */

import { useMemo, useState } from 'react';
import { ArrowRight, Check, Database, Loader2, Send, X } from 'lucide-react';
import clsx from 'clsx';
import {
  clipText,
  formatCellValue,
  formatMoney,
  humanizeLabel,
  normalizeRunStatus,
  relativeTime,
  type SurfaceDataTable,
  type SurfaceRecord,
  type SurfaceRun,
  type SurfaceThreadMessage,
} from './appSurfaceShared';

const RESERVED_FIELDS = new Set(['id', 'created_at', 'updated_at']);

type FeedItem =
  | { type: 'run'; id: string; createdAt: string; run: SurfaceRun }
  | { type: 'record'; id: string; createdAt: string; record: SurfaceRecord }
  | { type: 'message'; id: string; createdAt: string; msg: SurfaceThreadMessage };

export function AppWorkFeed({
  appName,
  runs,
  messages,
  records,
  dataTables,
  workflowNameById,
  composerValue,
  sending,
  onComposerChange,
  onSend,
  onContinueInWorkspace,
  onOpenRun,
  onOpenDataTable,
  onCancelRun,
}: {
  appName: string;
  runs: SurfaceRun[];
  messages: SurfaceThreadMessage[];
  records: SurfaceRecord[];
  dataTables: SurfaceDataTable[];
  workflowNameById: Map<string, string>;
  composerValue: string;
  sending: boolean;
  onComposerChange: (value: string) => void;
  onSend: () => void;
  onContinueInWorkspace: () => void;
  onOpenRun: (runId: string) => void;
  onOpenDataTable: (table: string) => void;
  onCancelRun: (runId: string) => Promise<void>;
}) {
  const items = useMemo<FeedItem[]>(() => {
    const merged: FeedItem[] = [
      ...runs.map((run) => ({ type: 'run' as const, id: `run_${run.id}`, createdAt: run.startedAt, run })),
      ...records.map((record) => ({
        type: 'record' as const,
        id: `rec_${record.table}_${record.recordId}`,
        createdAt: record.createdAt,
        record,
      })),
      ...messages.map((msg) => ({ type: 'message' as const, id: `msg_${msg.id}`, createdAt: msg.createdAt, msg })),
    ];
    return merged
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50);
  }, [runs, records, messages]);

  const fieldOrderByTable = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const table of dataTables) {
      map.set(
        table.name,
        table.fields.map((f) => f.name).filter((name) => !RESERVED_FIELDS.has(name)),
      );
    }
    return map;
  }, [dataTables]);

  return (
    <section className="flex min-h-0 flex-col">
      <div className="space-y-3">
        {items.length === 0 ? (
          <div className="rounded-[20px] border border-dashed border-line bg-surface px-4 py-8 text-center text-[13px] text-text-secondary">
            No activity yet. Send {appName} an instruction below to start the first run.
          </div>
        ) : (
          items.map((item) => {
            if (item.type === 'run') {
              const status = normalizeRunStatus(item.run.status);
              return status === 'running' || status === 'pending' ? (
                <RunningCard key={item.id} run={item.run} onOpenRun={onOpenRun} onCancelRun={onCancelRun} />
              ) : (
                <RunCompletionCard key={item.id} run={item.run} onOpenRun={onOpenRun} />
              );
            }
            if (item.type === 'record') {
              return (
                <RecordCard
                  key={item.id}
                  record={item.record}
                  fieldOrder={fieldOrderByTable.get(item.record.table) ?? null}
                  onOpenDataTable={onOpenDataTable}
                />
              );
            }
            return <MessageBubble key={item.id} msg={item.msg} appName={appName} workflowNameById={workflowNameById} />;
          })
        )}
      </div>

      <Composer
        appName={appName}
        value={composerValue}
        sending={sending}
        onChange={onComposerChange}
        onSend={onSend}
        onContinueInWorkspace={onContinueInWorkspace}
      />
    </section>
  );
}

function RunCompletionCard({ run, onOpenRun }: { run: SurfaceRun; onOpenRun: (runId: string) => void }) {
  const status = normalizeRunStatus(run.status);
  const failed = status === 'failed';
  return (
    <article
      className={clsx(
        'overflow-hidden rounded-[18px] border bg-surface',
        failed ? 'border-danger/30' : 'border-line',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <span
          className={clsx(
            'flex h-5 w-5 items-center justify-center rounded-full',
            failed ? 'bg-danger/15 text-danger' : 'bg-accent/15 text-accent',
          )}
        >
          {failed ? <X size={11} /> : <Check size={11} />}
        </span>
        <span className="text-[13px] font-medium text-text-primary">{run.workflowName ?? 'Workflow'}</span>
        <span className="text-[11px] text-text-muted">· {relativeTime(run.startedAt)}</span>
        <span className="ml-auto font-mono text-[11px] text-text-muted">run_{run.id.slice(-6)}</span>
      </div>
      <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-1.5">
        <div className="text-[12px] text-text-secondary">
          {failed
            ? `Failed${run.failedNode ? ` at ${run.failedNode}` : ''}`
            : 'Completed'}
          {run.cost != null && <span className="text-text-muted"> · {formatMoney(run.cost)}</span>}
        </div>
        <button
          type="button"
          onClick={() => onOpenRun(run.id)}
          className="inline-flex items-center gap-1 text-[12px] text-accent transition-opacity hover:opacity-80"
        >
          View <ArrowRight size={11} />
        </button>
      </div>
    </article>
  );
}

function RunningCard({
  run,
  onOpenRun,
  onCancelRun,
}: {
  run: SurfaceRun;
  onOpenRun: (runId: string) => void;
  onCancelRun: (runId: string) => Promise<void>;
}) {
  const [cancelling, setCancelling] = useState(false);
  return (
    <article className="overflow-hidden rounded-[18px] border border-warn/30 bg-warn-soft/40">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Loader2 size={14} className="animate-spin text-warn" />
        <span className="text-[13px] font-medium text-text-primary">{run.workflowName ?? 'Workflow'} running</span>
        <span className="text-[11px] text-text-muted">· started {relativeTime(run.startedAt)}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenRun(run.id)}
            className="inline-flex items-center gap-1 text-[12px] text-accent transition-opacity hover:opacity-80"
          >
            Open run <ArrowRight size={11} />
          </button>
          <button
            type="button"
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                await onCancelRun(run.id);
              } finally {
                setCancelling(false);
              }
            }}
            className="rounded-btn border border-line px-2 py-1 text-[11px] text-text-muted transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
          >
            {cancelling ? 'Cancelling…' : 'Cancel run'}
          </button>
        </div>
      </div>
    </article>
  );
}

function RecordCard({
  record,
  fieldOrder,
  onOpenDataTable,
}: {
  record: SurfaceRecord;
  fieldOrder: string[] | null;
  onOpenDataTable: (table: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const keys = (
    fieldOrder ?? Object.keys(record.record).filter((k) => !RESERVED_FIELDS.has(k))
  ).slice(0, 5);

  return (
    <article className="overflow-hidden rounded-[18px] border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <Database size={13} className="text-text-muted" />
        <span className="text-[13px] font-medium text-text-primary">{record.table}</span>
        <span className="text-[11px] text-text-muted">· {relativeTime(record.createdAt)}</span>
        <button
          type="button"
          onClick={() => onOpenDataTable(record.table)}
          className="ml-auto inline-flex items-center gap-1 text-[12px] text-accent transition-opacity hover:opacity-80"
        >
          View in Data <ArrowRight size={11} />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-1 px-4 pb-3 pt-2 sm:grid-cols-2">
        {keys.map((key) => {
          const raw = formatCellValue(record.record[key]);
          const long = raw.length > 64;
          return (
            <div key={key} className="text-[12px]">
              <span className="text-text-muted">{humanizeLabel(key)}: </span>
              <button
                type="button"
                onClick={() => long && setExpanded((prev) => !prev)}
                className={clsx('text-left text-text-primary', long && 'hover:text-accent')}
              >
                {long && !expanded ? clipText(raw, 64) : raw}
              </button>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function MessageBubble({
  msg,
  appName,
  workflowNameById,
}: {
  msg: SurfaceThreadMessage;
  appName: string;
  workflowNameById: Map<string, string>;
}) {
  const isOperator = msg.role === 'operator';

  if (msg.kind === 'progress' || msg.kind === 'result' || msg.kind === 'error') {
    const text =
      msg.kind === 'result'
        ? msg.content.summary ?? `${msg.content.outputKey ?? 'Result'} produced`
        : msg.kind === 'error'
          ? msg.content.text ?? 'Run error'
          : `Run ${msg.content.status ?? 'updated'}${
              msg.runId ? ` · ${workflowNameById.get(msg.runId) ?? msg.runId.slice(0, 8)}` : ''
            }`;
    return (
      <div
        className={clsx(
          'rounded-[14px] border px-3 py-2 text-[12px]',
          msg.kind === 'error'
            ? 'border-danger/30 bg-danger-soft/40 text-danger'
            : 'border-line bg-surface-2 text-text-secondary',
        )}
      >
        {text}
        <span className="ml-1.5 text-[10px] text-text-muted">· {relativeTime(msg.createdAt)}</span>
      </div>
    );
  }

  const text = msg.content.text ?? '';
  return (
    <div className={clsx('flex flex-col', isOperator ? 'items-end' : 'items-start')}>
      <div
        className={clsx(
          'max-w-[85%] rounded-[16px] border px-3.5 py-2.5 text-[13px] leading-relaxed',
          isOperator
            ? 'border-accent/30 bg-accent-soft text-text-primary'
            : 'border-line bg-surface text-text-primary',
        )}
      >
        <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
          {isOperator ? 'You' : `${appName} Brain`}
        </div>
        <div className="whitespace-pre-wrap">{text}</div>
      </div>
      <div className="mt-0.5 text-[10px] text-text-muted">{relativeTime(msg.createdAt)}</div>
    </div>
  );
}

function Composer({
  appName,
  value,
  sending,
  onChange,
  onSend,
  onContinueInWorkspace,
}: {
  appName: string;
  value: string;
  sending: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onContinueInWorkspace: () => void;
}) {
  return (
    <div className="mt-4">
      <div className="flex items-end gap-2 rounded-[18px] border border-line bg-surface-2 px-3 py-2.5 focus-within:border-accent/40">
        <textarea
          value={value}
          aria-label={`Send instruction to ${appName}`}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              onSend();
            }
          }}
          rows={2}
          placeholder={`Tell ${appName} what to do next…`}
          className="min-h-[44px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={sending || !value.trim()}
          aria-label={`Send instruction to ${appName}`}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-btn bg-accent text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[11px] text-text-muted">Ctrl + Enter to send</span>
        <button
          type="button"
          onClick={onContinueInWorkspace}
          className="text-[12px] text-text-muted transition-colors hover:text-text-secondary"
        >
          Continue in workspace chat →
        </button>
      </div>
    </div>
  );
}
