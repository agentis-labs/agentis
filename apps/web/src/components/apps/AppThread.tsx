/**
 * AppThread — APP-OUTPUT-REPLAN.md §5.3 + §5.4 + §5.7.
 *
 * Top-level App Output surface composed of:
 *   - Hero      → most recent app_results row
 *   - Conversation column (left, scrolling)
 *   - Activity Feed column (right, scrolling)
 *   - Composer  → POST /v1/apps/:slug/thread/send (SSE)
 *
 * Two-step realtime subscription (§5.4):
 *   - rtSubscribe('workflow', { workflowId: entryWorkflowId }) on mount.
 *     The server fans out APP_THREAD_MESSAGE_APPENDED + APP_RESULT_CREATED
 *     on the workflow room (no separate `app` room exists).
 *   - On RUN_CREATED for our entry workflow, rtSubscribe('run', { runId })
 *     so we can render granular run cards.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Link } from 'react-router-dom';
import { api, apiErrorMessage, streamSse } from '../../lib/api';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import { useToast } from '../shared/Toast';

export interface AppThreadAppRef {
  id: string;
  slug: string;
  name: string;
  entryWorkflowId: string | null;
}

export type ThreadKind = 'message' | 'progress' | 'result' | 'checkpoint' | 'error';
export type ThreadRole = 'operator' | 'app' | 'system';

export interface ThreadMessage {
  id: string;
  appId: string;
  workspaceId: string;
  role: ThreadRole;
  kind: ThreadKind;
  content: Record<string, unknown> & { text?: string; resultId?: string; outputKey?: string; summary?: string | null };
  runId: string | null;
  approvalId: string | null;
  operatorId: string | null;
  createdAt: string;
}

export interface AppResultRow {
  id: string;
  appId: string;
  runId: string;
  outputKey: string;
  artifactType: string;
  content: unknown;
  summary: string | null;
  triggeredBy: string;
  createdAt: string;
}

interface ThreadResponse { appId: string; messages: ThreadMessage[] }
interface ResultsResponse { appId: string; results: AppResultRow[] }
interface LatestResponse { appId: string; result: AppResultRow | null }

const EMPTY_STATE_PROMPT = 'Run the first analysis';

export function AppThread({ app, prefilledMessage }: { app: AppThreadAppRef; prefilledMessage?: string }) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [results, setResults] = useState<AppResultRow[]>([]);
  const [hero, setHero] = useState<AppResultRow | null>(null);
  const [composerValue, setComposerValue] = useState(prefilledMessage ?? '');
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedInitialData, setLoadedInitialData] = useState(false);
  const [activeRunIds, setActiveRunIds] = useState<string[]>([]);

  const toast = useToast();
  const seededComposerRef = useRef<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const showFirstRunState = loadedInitialData && !loadError && hero === null && results.length === 0;

  useEffect(() => {
    seededComposerRef.current = null;
    setComposerValue(prefilledMessage ?? '');
  }, [app.id, prefilledMessage]);

  // Initial load — thread + feed + hero in parallel.
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setLoadedInitialData(false);
    Promise.all([
      api<ThreadResponse>(`/v1/apps/${app.slug}/thread`),
      api<ResultsResponse>(`/v1/apps/${app.slug}/output?limit=50`),
      api<LatestResponse>(`/v1/apps/${app.slug}/output/latest`).catch(() => ({ appId: app.id, result: null })),
    ])
      .then(([threadRes, resultsRes, latestRes]) => {
        if (cancelled) return;
        setMessages(threadRes.messages);
        setResults(resultsRes.results);
        setHero(latestRes.result);
        setActiveRunIds(deriveActiveRunIds(threadRes.messages));
      })
      .catch((err: { message?: string }) => {
        if (!cancelled) setLoadError(err?.message ?? 'Failed to load App Thread');
      })
      .finally(() => {
        if (!cancelled) setLoadedInitialData(true);
      });
    return () => { cancelled = true; };
  }, [app.slug, app.id]);

  useEffect(() => {
    const candidate = typeof prefilledMessage === 'string' && prefilledMessage.trim()
      ? prefilledMessage.trim()
      : showFirstRunState
        ? EMPTY_STATE_PROMPT
        : null;
    if (!candidate || seededComposerRef.current === candidate) return;
    setComposerValue((current) => (current.trim() ? current : candidate));
    seededComposerRef.current = candidate;
  }, [prefilledMessage, showFirstRunState]);

  // Realtime subscription — workflow room (carries thread + result events).
  useEffect(() => {
    if (!app.entryWorkflowId) return;
    const unsubscribe = rtSubscribe('workflow', { workflowId: app.entryWorkflowId });
    return unsubscribe;
  }, [app.entryWorkflowId]);

  // Subscribe to per-run rooms for granular RUN_RUNNING/NODE_* events.
  useEffect(() => {
    const unsubs = activeRunIds.map((runId) => rtSubscribe('run', { runId }));
    return () => { for (const u of unsubs) u(); };
  }, [activeRunIds.join('|')]);

  useRealtime(
    [
      'app.thread.message_appended',
      'app.result.created',
      'run.created',
      'run.running',
      'run.completed',
      'run.failed',
    ],
    (env: RealtimeEnvelope) => {
      const payload = env.payload as Record<string, unknown>;
      const appId = typeof payload.appId === 'string' ? payload.appId : null;
      if (appId && appId !== app.id) return;

      if (env.event === 'app.thread.message_appended') {
        const msg = payload as unknown as ThreadMessage;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        setActiveRunIds((prev) => applyThreadMessageToActiveRuns(prev, msg));
        return;
      }
      if (env.event === 'app.result.created') {
        const resultId = typeof payload.resultId === 'string' ? payload.resultId : null;
        if (!resultId) return;
        api<{ result: AppResultRow }>(`/v1/apps/${app.slug}/output/${resultId}`)
          .then(({ result }) => {
            setResults((prev) => (prev.some((r) => r.id === result.id) ? prev : [result, ...prev]));
            setHero((prev) => (prev && prev.createdAt > result.createdAt ? prev : result));
            setActiveRunIds((prev) => prev.filter((runId) => runId !== result.runId));
          })
          .catch(() => undefined);
        return;
      }
      if (env.event === 'run.running') {
        const runId = typeof payload.runId === 'string' ? payload.runId : null;
        const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : null;
        if (runId && workflowId === app.entryWorkflowId) {
          if (payload.status === 'RUNNING') {
            setActiveRunIds((prev) => (prev.includes(runId) ? prev : [...prev, runId]));
          } else {
            setActiveRunIds((prev) => prev.filter((current) => current !== runId));
          }
        }
        return;
      }
      if (env.event === 'run.completed' || env.event === 'run.failed') {
        const runId = typeof payload.runId === 'string' ? payload.runId : null;
        if (runId) setActiveRunIds((prev) => prev.filter((current) => current !== runId));
      }
    },
  );

  // Auto-scroll conversation to bottom on new messages.
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const seedFirstRunPrompt = useCallback(() => {
    setComposerValue((current) => (current.trim() ? current : EMPTY_STATE_PROMPT));
    composerRef.current?.focus();
  }, []);

  const resolveCheckpoint = useCallback(async (approvalId: string, decision: 'approve' | 'reject') => {
    await api(`/v1/approvals/${approvalId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
    toast.success(decision === 'approve' ? 'Approval recorded' : 'Rejection recorded');
  }, [toast]);

  const send = useCallback(async () => {
    const text = composerValue.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await streamSse(`/v1/apps/${app.slug}/thread/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: text }),
      }, {
        onEvent: (event, data) => {
          if (event === 'message') {
            const msg = data as ThreadMessage;
            setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          }
        },
      });
      setComposerValue('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send message';
      setMessages((prev) => [...prev, {
        id: `local_err_${Date.now()}`,
        appId: app.id,
        workspaceId: '',
        role: 'system',
        kind: 'error',
        content: { text: message },
        runId: null,
        approvalId: null,
        operatorId: null,
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setSending(false);
    }
  }, [composerValue, sending, app.slug, app.id]);

  return (
    <div className="flex h-full flex-col gap-4">
      {activeRunIds.length > 0 && (
        <RunningBanner
          activeRunCount={activeRunIds.length}
          onViewProgress={() => conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })}
        />
      )}
      <Hero
        result={hero}
        appSlug={app.slug}
        muted={activeRunIds.length > 0}
        showFirstRunState={showFirstRunState}
        onSeedFirstPrompt={seedFirstRunPrompt}
      />
      <div className="grid flex-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_320px]">
        <Conversation
          messages={messages}
          loadError={loadError}
          composerValue={composerValue}
          setComposerValue={setComposerValue}
          onSend={send}
          sending={sending}
          composerRef={composerRef}
          onResolveCheckpoint={resolveCheckpoint}
          conversationEndRef={conversationEndRef}
        />
        <ActivityFeed results={results} appSlug={app.slug} />
      </div>
    </div>
  );
}

function RunningBanner({ activeRunCount, onViewProgress }: { activeRunCount: number; onViewProgress: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-5 py-3 text-sm text-amber-100">
      <div>
        <div className="font-medium text-amber-50">Running now</div>
        <div className="text-xs text-amber-100/80">
          {activeRunCount} active run{activeRunCount === 1 ? '' : 's'} in progress.
        </div>
      </div>
      <button
        type="button"
        onClick={onViewProgress}
        className="shrink-0 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs font-medium text-amber-50 transition hover:border-amber-300/30 hover:bg-amber-300/10"
      >
        View progress
      </button>
    </div>
  );
}

function Hero({
  result,
  appSlug,
  muted,
  showFirstRunState,
  onSeedFirstPrompt,
}: {
  result: AppResultRow | null;
  appSlug: string;
  muted: boolean;
  showFirstRunState: boolean;
  onSeedFirstPrompt: () => void;
}) {
  if (!result) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4 text-sm text-zinc-400">
        <div className="text-base font-medium text-zinc-100">
          {showFirstRunState ? 'This app is ready to run.' : 'No outputs yet.'}
        </div>
        <div className="mt-1">
          {showFirstRunState
            ? 'Start with the suggested prompt or type a custom instruction below.'
            : 'Once this app runs, the latest result will appear here.'}
        </div>
        {showFirstRunState && (
          <button
            type="button"
            onClick={onSeedFirstPrompt}
            className="mt-3 rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-xs font-medium text-zinc-100 transition hover:border-white/30"
          >
            {EMPTY_STATE_PROMPT}
          </button>
        )}
      </div>
    );
  }
  return (
    <Link
      to={`/apps/${appSlug}/results/${result.id}`}
      className={`block rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.06] to-white/[0.02] px-5 py-4 transition hover:border-white/20 ${muted ? 'opacity-75' : ''}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs uppercase tracking-wider text-zinc-500">{result.outputKey} · {result.artifactType}</span>
        <time className="text-xs text-zinc-500">{relativeTime(result.createdAt)}</time>
      </div>
      <div className="mt-2 text-base text-zinc-100 line-clamp-3">
        {result.summary ?? renderInlinePreview(result.content)}
      </div>
    </Link>
  );
}

function Conversation({
  messages,
  loadError,
  composerValue,
  setComposerValue,
  onSend,
  sending,
  composerRef,
  onResolveCheckpoint,
  conversationEndRef,
}: {
  messages: ThreadMessage[];
  loadError: string | null;
  composerValue: string;
  setComposerValue: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  composerRef: MutableRefObject<HTMLTextAreaElement | null>;
  onResolveCheckpoint: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
  conversationEndRef: MutableRefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-white/10 bg-white/[0.02]">
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {loadError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{loadError}</div>
        )}
        {messages.length === 0 && !loadError && (
          <div className="text-sm text-zinc-500">Conversation history is empty. Send a message to start.</div>
        )}
        {messages.map((msg) => (
          <ThreadCard key={msg.id} msg={msg} onResolveCheckpoint={onResolveCheckpoint} />
        ))}
        <div ref={conversationEndRef} />
      </div>
      <div className="border-t border-white/10 px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={composerRef}
            value={composerValue}
            onChange={(e) => setComposerValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={2}
            placeholder="Talk to this app - it will run the entry workflow if needed."
            className="min-h-[44px] flex-1 resize-none rounded-lg border border-white/10 bg-zinc-950/40 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/30"
          />
          <button
            type="button"
            onClick={onSend}
            disabled={sending || !composerValue.trim()}
            className="rounded-lg border border-white/15 bg-white/[0.06] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
        <div className="mt-1 text-[11px] text-zinc-500">Ctrl + Enter to send</div>
      </div>
    </div>
  );
}

function ThreadCard({
  msg,
  onResolveCheckpoint,
}: {
  msg: ThreadMessage;
  onResolveCheckpoint: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
}) {
  const isOperator = msg.role === 'operator';
  const align = isOperator ? 'items-end' : 'items-start';
  const bubble = isOperator
    ? 'bg-blue-500/15 border-blue-500/30 text-blue-50'
    : msg.kind === 'error'
      ? 'bg-red-500/10 border-red-500/30 text-red-100'
      : msg.kind === 'progress'
        ? 'bg-amber-500/10 border-amber-500/20 text-amber-100'
        : msg.kind === 'result'
          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-50'
          : msg.kind === 'checkpoint'
            ? 'bg-violet-500/10 border-violet-500/30 text-violet-100'
            : 'bg-white/[0.04] border-white/10 text-zinc-100';

  return (
    <div className={`flex flex-col gap-1 ${align}`}>
      <div className={`max-w-[80%] rounded-xl border px-3 py-2 text-sm ${bubble}`}>
        <ThreadCardBody msg={msg} onResolveCheckpoint={onResolveCheckpoint} />
      </div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
        {msg.role} · {msg.kind} · {relativeTime(msg.createdAt)}
      </div>
    </div>
  );
}

function ThreadCardBody({
  msg,
  onResolveCheckpoint,
}: {
  msg: ThreadMessage;
  onResolveCheckpoint: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
}) {
  const text = typeof msg.content?.text === 'string' ? msg.content.text : null;
  const [checkpointDecision, setCheckpointDecision] = useState<string | null>(() => readCheckpointDecision(msg));
  const [checkpointAction, setCheckpointAction] = useState<'approve' | 'reject' | null>(null);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);

  useEffect(() => {
    setCheckpointDecision(readCheckpointDecision(msg));
    setCheckpointAction(null);
    setCheckpointError(null);
  }, [msg]);

  if (msg.kind === 'message' || msg.kind === 'error') {
    return <div className="whitespace-pre-wrap">{text ?? JSON.stringify(msg.content, null, 2)}</div>;
  }
  if (msg.kind === 'result') {
    const summary = typeof msg.content?.summary === 'string' ? msg.content.summary : null;
    const outputKey = typeof msg.content?.outputKey === 'string' ? msg.content.outputKey : 'result';
    return (
      <div>
        <div className="text-xs uppercase tracking-wider text-emerald-200/80">{outputKey}</div>
        <div className="mt-0.5">{summary ?? 'New result available'}</div>
      </div>
    );
  }
  if (msg.kind === 'progress') {
    const status = readProgressStatus(msg) ?? 'updated';
    return <div>Run {status}{msg.runId ? ` · ${msg.runId.slice(0, 8)}` : ''}</div>;
  }
  if (msg.kind === 'checkpoint') {
    const title = typeof (msg.content as { title?: unknown }).title === 'string' ? (msg.content as { title: string }).title : 'Approval requested';
    const summary = typeof (msg.content as { summary?: unknown }).summary === 'string' ? (msg.content as { summary: string }).summary : null;
    const approvalId = msg.approvalId ?? (typeof (msg.content as { approvalId?: unknown }).approvalId === 'string'
      ? String((msg.content as { approvalId: string }).approvalId)
      : null);
    const isPending = !checkpointDecision || checkpointDecision === 'pending';

    async function handleResolve(decision: 'approve' | 'reject') {
      if (!approvalId || checkpointAction) return;
      setCheckpointAction(decision);
      setCheckpointError(null);
      try {
        await onResolveCheckpoint(approvalId, decision);
        setCheckpointDecision(decision === 'approve' ? 'approved' : 'rejected');
      } catch (error) {
        setCheckpointError(apiErrorMessage(error));
      } finally {
        setCheckpointAction(null);
      }
    }

    return (
      <div className="space-y-2">
        <div className="font-medium">{title}</div>
        {summary && <div className="text-xs text-violet-100/80">{summary}</div>}
        <div className="text-xs uppercase tracking-wider text-violet-100/70">
          {isPending ? 'Decision pending' : `Decision: ${checkpointDecision}`}
        </div>
        {approvalId && isPending && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => { void handleResolve('approve'); }}
              disabled={checkpointAction !== null}
              className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-50 transition hover:border-emerald-300/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checkpointAction === 'approve' ? 'Approving...' : 'Approve'}
            </button>
            <button
              type="button"
              onClick={() => { void handleResolve('reject'); }}
              disabled={checkpointAction !== null}
              className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-1.5 text-xs font-medium text-red-50 transition hover:border-red-300/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checkpointAction === 'reject' ? 'Rejecting...' : 'Reject'}
            </button>
          </div>
        )}
        {checkpointError && <div className="text-xs text-red-200">{checkpointError}</div>}
      </div>
    );
  }
  return <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(msg.content, null, 2)}</pre>;
}

function ActivityFeed({ results, appSlug }: { results: AppResultRow[]; appSlug: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-white/10 bg-white/[0.02]">
      <div className="border-b border-white/10 px-4 py-3 text-xs uppercase tracking-wider text-zinc-500">
        Activity feed
      </div>
      <div className="flex-1 overflow-y-auto">
        {results.length === 0 && (
          <div className="px-4 py-3 text-sm text-zinc-500">No results yet.</div>
        )}
        <ul className="divide-y divide-white/5">
          {results.map((result) => (
            <li key={result.id}>
              <Link
                to={`/apps/${appSlug}/results/${result.id}`}
                className="block px-4 py-3 transition hover:bg-white/[0.04]"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs uppercase tracking-wider text-zinc-500">
                    {result.outputKey} · {result.artifactType}
                  </span>
                  <time className="text-[11px] text-zinc-500">{relativeTime(result.createdAt)}</time>
                </div>
                <div className="mt-1 text-sm text-zinc-200 line-clamp-2">
                  {result.summary ?? renderInlinePreview(result.content)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function renderInlinePreview(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return '';
  }
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

function deriveActiveRunIds(messages: ThreadMessage[]): string[] {
  return messages.reduce<string[]>((active, msg) => applyThreadMessageToActiveRuns(active, msg), []);
}

function applyThreadMessageToActiveRuns(active: string[], msg: ThreadMessage): string[] {
  if (!msg.runId) return active;
  const next = new Set(active);
  const status = readProgressStatus(msg);
  if (msg.kind === 'progress' && status === 'running') next.add(msg.runId);
  if (
    msg.kind === 'error'
    || msg.kind === 'result'
    || (msg.kind === 'progress' && status === 'completed')
  ) {
    next.delete(msg.runId);
  }
  return [...next];
}

function readProgressStatus(msg: ThreadMessage): string | null {
  return typeof (msg.content as { status?: unknown }).status === 'string'
    ? String((msg.content as { status: string }).status)
    : null;
}

function readCheckpointDecision(msg: ThreadMessage): string | null {
  return typeof (msg.content as { decision?: unknown }).decision === 'string'
    ? String((msg.content as { decision: string }).decision)
    : null;
}
