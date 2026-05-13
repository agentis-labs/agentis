import { Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { AppWindow, Bot, CheckCircle2, Clock, Database, PlayCircle, Workflow } from 'lucide-react';

type AppStatus = 'setup' | 'active' | 'paused' | 'error';

interface AppCardProps {
  app: {
    id: string;
    slug: string;
    name: string;
    version: string;
    status: AppStatus;
    entryWorkflowId?: string | null;
    counts: {
      agents: number;
      workflows: number;
      datasets: number;
      importedDatasets: number;
    };
    summary: {
      category?: string | null;
      replaces?: string | null;
      costSavedPerMonth?: string | null;
    };
  };
}

const STATUS_TONE: Record<AppStatus, string> = {
  setup: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  active: 'border-accent/30 bg-accent/10 text-accent',
  paused: 'border-line bg-surface-2 text-text-muted',
  error: 'border-danger/30 bg-danger/10 text-danger',
};

export function AppCard({ app }: AppCardProps) {
  const nav = useNavigate();
  return (
    <article className="rounded-md border border-line bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-accent">
          <AppWindow size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/apps/${app.slug}`} className="truncate text-sm font-medium text-text-primary hover:text-accent">
              {app.name}
            </Link>
            <span className={clsx('inline-flex rounded-full border px-2 py-0.5 text-[10px] uppercase', STATUS_TONE[app.status])}>
              {app.status}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
            <span>{app.slug}</span>
            <span>v{app.version}</span>
            {app.summary.category && <span>{app.summary.category}</span>}
          </div>
          {(app.summary.replaces || app.summary.costSavedPerMonth) && (
            <div className="mt-2 text-[11px] text-text-muted">
              {[app.summary.replaces, app.summary.costSavedPerMonth].filter(Boolean).join(' / ')}
            </div>
          )}
        </div>
        {app.entryWorkflowId && (
          <button
            type="button"
            onClick={() => nav(`/workflows/${app.entryWorkflowId}`)}
            className="rounded-md p-1.5 text-text-muted transition hover:bg-surface-2 hover:text-accent"
            title="Open entry workflow"
            aria-label="Open entry workflow"
          >
            <PlayCircle size={15} />
          </button>
        )}
      </div>
      <div className="mt-4 grid grid-cols-4 gap-2 text-[11px]">
        <Metric icon={<Workflow size={12} />} label="Flows" value={app.counts.workflows} />
        <Metric icon={<Bot size={12} />} label="Agents" value={app.counts.agents} />
        <Metric icon={<Database size={12} />} label="Data" value={`${app.counts.importedDatasets}/${app.counts.datasets}`} />
        <Metric icon={app.status === 'active' ? <CheckCircle2 size={12} /> : <Clock size={12} />} label="State" value={app.status} />
      </div>
    </article>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-line bg-canvas px-2 py-2">
      <div className="flex items-center gap-1 text-text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 truncate text-xs font-medium text-text-primary">{value}</div>
    </div>
  );
}