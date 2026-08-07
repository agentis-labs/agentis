import { AlertTriangle, CheckCircle2, GitBranch, Hammer, Loader2, ShieldCheck } from 'lucide-react';
import type { AppBlueprint, BuildSession } from '@agentis/core';
import clsx from 'clsx';

const STAGES = ['discover', 'plan', 'validate', 'materialize', 'execute', 'verify', 'repair', 'deliver'] as const;

export function BuildSessionCard({ session, blueprint }: { session: BuildSession; blueprint: AppBlueprint }) {
  const stageIndex = STAGES.indexOf(session.stage);
  const failed = session.status === 'blocked' || session.status === 'failed';
  const complete = session.status === 'completed';
  return (
    <section className="mb-2 overflow-hidden rounded-xl border border-cyan-400/20 bg-canvas/60 shadow-[0_14px_38px_-30px_rgba(34,211,238,0.7)]">
      <header className="flex items-start gap-2.5 border-b border-line/70 px-3 py-2.5">
        <div className={clsx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', complete ? 'bg-emerald-400/10 text-emerald-400' : failed ? 'bg-danger/10 text-danger' : 'bg-cyan-400/10 text-cyan-300')}>
          {complete ? <ShieldCheck size={14} /> : failed ? <AlertTriangle size={14} /> : <Hammer size={14} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-[12px] font-semibold text-text-primary">{blueprint.name}</h3>
            <span className="rounded-full border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-text-muted">Build {session.status}</span>
            <span className="font-mono text-[9px] text-cyan-300">revision {blueprint.revision}</span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-text-secondary">{blueprint.intent}</p>
        </div>
      </header>
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-1" aria-label={`Build stage: ${session.stage}`}>
          {STAGES.map((stage, index) => {
            const reached = index <= stageIndex;
            const current = stage === session.stage;
            return (
              <div key={stage} className="min-w-0 flex-1">
                <div className={clsx('h-1 rounded-full', reached ? failed && current ? 'bg-danger' : complete || !current ? 'bg-cyan-400/70' : 'bg-accent' : 'bg-surface-3')} />
                {(current || index === 0 || index === STAGES.length - 1) && <div className={clsx('mt-1 truncate font-mono text-[8px] uppercase', current ? 'text-text-secondary' : 'text-text-muted')}>{stage}</div>}
              </div>
            );
          })}
        </div>
        <div className="mt-2.5 grid grid-cols-4 gap-1.5">
          <Metric label="Roles" value={blueprint.roles.length} />
          <Metric label="Swarms" value={blueprint.swarms.length} />
          <Metric label="Workflows" value={blueprint.workflows.length} />
          <Metric label="Checks" value={blueprint.acceptanceCriteria.length} />
        </div>
        {session.diagnostic && (
          <div className="mt-2.5 rounded-lg border border-danger/25 bg-danger/5 px-2.5 py-2 text-[10px] leading-relaxed text-text-secondary">
            <div className="font-semibold text-danger">{session.diagnostic.code}</div>
            <div className="mt-0.5">{session.diagnostic.message}</div>
            {session.diagnostic.remediation && <div className="mt-1 text-text-muted">Next: {session.diagnostic.remediation}</div>}
          </div>
        )}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line/60 px-3 py-2 font-mono text-[9px] text-text-muted">
        <span className="flex items-center gap-1"><GitBranch size={10} /> Session {session.id}</span>
        <span className="flex items-center gap-1">{complete ? <CheckCircle2 size={10} /> : <Loader2 size={10} className={session.status === 'running' ? 'animate-spin' : ''} />} Updated {new Date(session.updatedAt).toLocaleString()}</span>
      </footer>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg border border-line/60 bg-surface-1/60 px-2 py-1.5 text-center"><div className="font-mono text-[11px] text-text-primary">{value}</div><div className="text-[8px] uppercase tracking-wide text-text-muted">{label}</div></div>;
}
