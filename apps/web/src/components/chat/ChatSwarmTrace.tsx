import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, Pause, Play, Square, Users } from 'lucide-react';
import clsx from 'clsx';
import type { ChatSwarm } from '@agentis/core';
import { api } from '../../lib/api';

function elapsed(startedAt?: string | null, completedAt?: string | null): string | null {
  if (!startedAt) return null;
  const ms = Math.max(0, (completedAt ? Date.parse(completedAt) : Date.now()) - Date.parse(startedAt));
  if (!Number.isFinite(ms)) return null;
  const seconds = Math.max(1, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Compact, intentionally non-loggy projection of a temporary chat team. */
export function ChatSwarmTrace({ swarm: source, agentId }: { swarm: ChatSwarm; agentId?: string }) {
  const [swarm, setSwarm] = useState(source);
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setSwarm(source), [source]);
  const counts = useMemo(() => ({
    active: swarm.workers.filter((worker) => worker.status === 'running').length,
    done: swarm.workers.filter((worker) => worker.status === 'completed').length,
    blocked: swarm.workers.filter((worker) => worker.status === 'failed' || worker.status === 'blocked').length,
  }), [swarm.workers]);
  const terminal = ['completed', 'failed', 'blocked', 'cancelled'].includes(swarm.status);
  const call = async (path: string, body?: unknown) => {
    if (!agentId) return;
    setBusy(path);
    try { setSwarm(await api<ChatSwarm>(`/v1/conversations/${agentId}/swarms/${swarm.id}${path}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) })); }
    finally { setBusy(null); }
  };
  return (
    <section className="mb-3 max-w-[760px] rounded-xl border border-line/65 bg-surface-2/35 text-[12px]" aria-label="Team at work">
      <div className="flex min-h-11 items-center gap-2 px-3">
        <button type="button" onClick={() => setOpen((value) => !value)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open}>
          <Users size={14} className="shrink-0 text-text-muted" />
          <span className="truncate font-medium text-text-primary">{terminal ? 'Team finished' : swarm.status === 'paused' ? 'Team paused' : 'Team at work'}</span>
          <span className="truncate text-text-muted">{counts.active} active · {counts.done}/{swarm.workers.length} done{counts.blocked ? ` · ${counts.blocked} blocked` : ''}</span>
          <ChevronRight size={14} className={clsx('ml-auto shrink-0 text-text-muted transition-transform', open && 'rotate-90')} />
        </button>
        {elapsed(swarm.startedAt, swarm.completedAt) && <span className="shrink-0 text-text-muted">{elapsed(swarm.startedAt, swarm.completedAt)}</span>}
        {!terminal && agentId && (
          <div className="flex shrink-0 items-center gap-1">
            {swarm.status === 'paused' ? <IconButton label="Resume team" onClick={() => void call('/resume')} disabled={Boolean(busy)}><Play size={13} /></IconButton> : <IconButton label="Pause team" onClick={() => void call('/pause')} disabled={Boolean(busy)}><Pause size={13} /></IconButton>}
            <IconButton label="Stop team" onClick={() => void call('/stop')} disabled={Boolean(busy)}><Square size={12} /></IconButton>
          </div>
        )}
      </div>
      {open && <div className="border-t border-line/55 px-3 py-2.5">
        <div className="space-y-2">
          {swarm.workers.map((worker) => <div key={worker.id} className="rounded-lg bg-surface/45 px-2.5 py-2">
            <div className="flex gap-2"><span className="min-w-0 flex-1 truncate font-medium text-text-secondary">{worker.role}</span><span className="shrink-0 capitalize text-text-muted">{worker.status}</span>{agentId && worker.status === 'running' && <button type="button" onClick={() => void call(`/workers/${worker.id}/stop`)} className="text-text-muted hover:text-danger">Stop</button>}{agentId && ['failed', 'blocked', 'cancelled'].includes(worker.status) && !terminal && <button type="button" onClick={() => void call(`/workers/${worker.id}/retry`)} className="text-text-muted hover:text-text-primary">Retry</button>}</div>
            <p className="mt-0.5 line-clamp-2 text-text-muted">{worker.task}</p>
            {(worker.latestProgress || worker.error) && <p className={clsx('mt-1 line-clamp-2', worker.error ? 'text-danger' : 'text-text-secondary')}>{worker.error || worker.latestProgress}</p>}
          </div>)}
        </div>
        {!terminal && agentId && <form className="mt-2.5 flex gap-1.5" onSubmit={(event) => { event.preventDefault(); if (!instruction.trim()) return; void call('/steer', { instruction }).then(() => setInstruction('')); }}>
          <input value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Steer lead…" aria-label="Steer lead" className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] outline-none focus:border-accent" />
          <button type="submit" disabled={!instruction.trim() || Boolean(busy)} className="rounded-md border border-line px-2 text-text-secondary hover:text-text-primary disabled:opacity-50">Send</button>
        </form>}
      </div>}
    </section>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="grid h-6 w-6 place-items-center rounded-md text-text-muted hover:bg-surface-3 hover:text-text-primary disabled:opacity-45">{children}</button>;
}
