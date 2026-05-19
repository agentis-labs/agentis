import { useCallback, useEffect, useState } from 'react';
import { Archive, Clock, GitMerge, RefreshCw, Scissors, ShieldAlert } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import { api } from '../../lib/api';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';

type ResolveAction = 'keep_a' | 'keep_b' | 'merge' | 'context_split' | 'snooze';

interface DisputeAtom {
  id: string;
  title: string;
  content: string;
  confidence: number;
  contextCondition?: string | null;
  updatedAt?: string;
}

interface BrainDispute {
  id: string;
  appId: string | null;
  reason: string;
  createdAt: string;
  updatedAt: string;
  atomA: DisputeAtom;
  atomB: DisputeAtom;
}

interface DisputeDraft {
  contextA: string;
  contextB: string;
  snoozeDays: number;
}

export function DisputeResolutionPanel({ slug }: { slug: string | null }) {
  const [disputes, setDisputes] = useState<BrainDispute[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DisputeDraft>>({});
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const toast = useToast();
  const basePath = slug ? `/v1/apps/${slug}/brain` : '/v1/brain';

  const load = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      const response = await api<{ disputes: BrainDispute[] }>(`${basePath}/disputes`);
      setDisputes(response.disputes);
      setDrafts((current) => {
        const next = { ...current };
        for (const dispute of response.disputes) {
          if (!next[dispute.id]) next[dispute.id] = { contextA: '', contextB: '', snoozeDays: 30 };
        }
        return next;
      });
    } catch (err) {
      toast.error('Failed to load Brain disputes', String(err));
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [basePath, toast]);

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => rtSubscribe('workspace', {}), []);
  useRealtime([
    REALTIME_EVENTS.BRAIN_DISPUTE_FLAGGED,
    REALTIME_EVENTS.BRAIN_DISPUTE_RESOLVED,
    REALTIME_EVENTS.BRAIN_DISPUTE_AUTO_RESOLVED,
  ], () => {
    void load(false);
  });

  async function resolve(dispute: BrainDispute, action: ResolveAction) {
    setResolving(`${dispute.id}:${action}`);
    const draft = drafts[dispute.id] ?? { contextA: '', contextB: '', snoozeDays: 30 };
    try {
      await api(`${basePath}/disputes/${encodeURIComponent(dispute.id)}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          contextA: draft.contextA.trim() || undefined,
          contextB: draft.contextB.trim() || undefined,
          snoozeDays: draft.snoozeDays,
        }),
      });
      toast.success('Dispute resolved');
      await load(false);
    } catch (err) {
      toast.error('Failed to resolve dispute', String(err));
    } finally {
      setResolving(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton height={80} />
        <Skeleton height={280} />
        <Skeleton height={280} />
      </div>
    );
  }

  return (
    <main className="h-full overflow-y-auto px-5 py-5">
      <div className="mx-auto max-w-7xl space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-btn bg-amber-500/12 text-amber-300">
              <ShieldAlert size={17} />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-text-primary">Brain Disputes</h2>
              <p className="mt-0.5 text-[12px] text-text-muted">{disputes.length} contradiction{disputes.length === 1 ? '' : 's'} waiting for resolution</p>
            </div>
          </div>
          <Button size="sm" variant="ghost" iconLeft={<RefreshCw size={13} />} onClick={() => load(true)}>
            Refresh
          </Button>
        </header>

        {disputes.length === 0 ? (
          <div className="rounded-card border border-line bg-surface px-4 py-12 text-center">
            <ShieldAlert size={28} className="mx-auto text-emerald-300" />
            <div className="mt-3 text-[14px] font-medium text-text-primary">No open disputes</div>
            <div className="mt-1 text-[12px] text-text-muted">Contradictions will appear here when the Brain links incompatible atoms.</div>
          </div>
        ) : (
          disputes.map((dispute) => (
            <DisputeCard
              key={dispute.id}
              dispute={dispute}
              draft={drafts[dispute.id] ?? { contextA: '', contextB: '', snoozeDays: 30 }}
              resolving={resolving}
              onDraft={(patch) => setDrafts((current) => ({ ...current, [dispute.id]: { ...(current[dispute.id] ?? { contextA: '', contextB: '', snoozeDays: 30 }), ...patch } }))}
              onResolve={(action) => resolve(dispute, action)}
            />
          ))
        )}
      </div>
    </main>
  );
}

function DisputeCard({
  dispute,
  draft,
  resolving,
  onDraft,
  onResolve,
}: {
  dispute: BrainDispute;
  draft: DisputeDraft;
  resolving: string | null;
  onDraft: (patch: Partial<DisputeDraft>) => void;
  onResolve: (action: ResolveAction) => void;
}) {
  return (
    <article className="rounded-card border border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-[14px] font-semibold text-text-primary">{dispute.reason}</h3>
            <time className="mt-0.5 block text-[11px] text-text-muted" dateTime={dispute.updatedAt}>Updated {formatTime(dispute.updatedAt)}</time>
          </div>
          <Button size="sm" variant="secondary" loading={resolving === `${dispute.id}:merge`} iconLeft={<GitMerge size={13} />} onClick={() => onResolve('merge')}>
            Merge
          </Button>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-2">
        <AtomPane label="Atom A" atom={dispute.atomA} keepLabel="Keep A" loading={resolving === `${dispute.id}:keep_a`} onKeep={() => onResolve('keep_a')} />
        <AtomPane label="Atom B" atom={dispute.atomB} keepLabel="Keep B" loading={resolving === `${dispute.id}:keep_b`} onKeep={() => onResolve('keep_b')} />
      </div>

      <div className="grid gap-3 border-t border-line px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
        <label className="min-w-0">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-muted">Context A</span>
          <input
            value={draft.contextA}
            onChange={(event) => onDraft({ contextA: event.target.value })}
            placeholder="Where atom A applies"
            className="h-9 w-full rounded-btn border border-line bg-bg-base px-3 text-[13px] text-text-primary outline-none focus:border-accent"
          />
        </label>
        <label className="min-w-0">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-muted">Context B</span>
          <input
            value={draft.contextB}
            onChange={(event) => onDraft({ contextB: event.target.value })}
            placeholder="Where atom B applies"
            className="h-9 w-full rounded-btn border border-line bg-bg-base px-3 text-[13px] text-text-primary outline-none focus:border-accent"
          />
        </label>
        <Button size="sm" variant="secondary" loading={resolving === `${dispute.id}:context_split`} iconLeft={<Scissors size={13} />} onClick={() => onResolve('context_split')}>
          Split
        </Button>
        <div className="flex items-end gap-2">
          <input
            type="number"
            min={1}
            max={365}
            value={draft.snoozeDays}
            onChange={(event) => onDraft({ snoozeDays: Number(event.target.value) || 30 })}
            className="h-8 w-16 rounded-btn border border-line bg-bg-base px-2 text-[12px] text-text-primary outline-none focus:border-accent"
            aria-label="Snooze days"
          />
          <Button size="sm" variant="ghost" loading={resolving === `${dispute.id}:snooze`} iconLeft={<Clock size={13} />} onClick={() => onResolve('snooze')}>
            Snooze
          </Button>
        </div>
      </div>
    </article>
  );
}

function AtomPane({ label, atom, keepLabel, loading, onKeep }: { label: string; atom: DisputeAtom; keepLabel: string; loading: boolean; onKeep: () => void }) {
  return (
    <div className="border-line px-4 py-4 first:border-b lg:first:border-b-0 lg:first:border-r">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{label}</div>
          <h4 className="mt-1 truncate text-[14px] font-medium text-text-primary">{atom.title}</h4>
        </div>
        <span className="shrink-0 rounded-full bg-surface-2 px-2 py-1 text-[11px] text-text-secondary">{Math.round(atom.confidence * 100)}%</span>
      </div>
      <p className="mt-3 min-h-[72px] text-[13px] leading-relaxed text-text-secondary">{atom.content}</p>
      {atom.contextCondition && (
        <div className="mt-3 rounded-btn border border-line bg-bg-base px-3 py-2 text-[12px] text-text-muted">{atom.contextCondition}</div>
      )}
      <div className="mt-4 flex justify-end">
        <Button size="sm" variant="danger" loading={loading} iconLeft={<Archive size={13} />} onClick={onKeep}>
          {keepLabel}
        </Button>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}
