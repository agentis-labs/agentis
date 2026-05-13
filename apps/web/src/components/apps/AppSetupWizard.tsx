import { AppWindow, CheckCircle2, CircleDashed, Database, KeyRound, PlayCircle } from 'lucide-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';

type AppStatus = 'setup' | 'active' | 'paused' | 'error';

interface AppSetupWizardProps {
  app: {
    status: AppStatus;
    counts: { credentials: number; datasets: number; importedDatasets: number };
    contents: { credentialSlots: Array<{ key: string; label: string; required: boolean }> };
  };
  busy?: boolean;
  onActivate: () => void;
}

export function AppSetupWizard({ app, busy, onActivate }: AppSetupWizardProps) {
  const requiredCredentials = app.contents.credentialSlots.filter((slot) => slot.required).length;
  const datasetsReady = app.counts.datasets === 0 || app.counts.importedDatasets >= app.counts.datasets;
  const ready = requiredCredentials === 0 && datasetsReady;
  const steps = [
    { label: 'Overview', icon: <AppWindow size={12} />, done: true },
    { label: 'Credentials', icon: <KeyRound size={12} />, done: requiredCredentials === 0, meta: requiredCredentials === 0 ? 'ready' : `${requiredCredentials} required` },
    { label: 'Import Data', icon: <Database size={12} />, done: datasetsReady, meta: `${app.counts.importedDatasets}/${app.counts.datasets}` },
    { label: 'Review & Activate', icon: <PlayCircle size={12} />, done: app.status !== 'setup' || ready, meta: app.status },
  ];
  return (
    <section className="rounded-md border border-line bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md border border-line bg-surface-2 text-accent">
          {ready ? <CheckCircle2 size={17} /> : <CircleDashed size={17} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary">Setup</div>
          <div className="mt-2 grid gap-2 md:grid-cols-4">
            {steps.map((step, index) => (
              <Step key={step.label} icon={step.icon} done={step.done} label={step.label} meta={step.meta} index={index + 1} />
            ))}
          </div>
        </div>
        {app.status === 'setup' && (
          <button
            type="button"
            onClick={onActivate}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2.5 text-xs text-accent transition hover:border-accent/60 disabled:opacity-60"
          >
            <PlayCircle size={13} />
            Activate
          </button>
        )}
      </div>
    </section>
  );
}

function Step({ icon, done, label, meta, index }: { icon: ReactNode; done: boolean; label: string; meta?: string; index: number }) {
  return (
    <div className={clsx('min-w-0 rounded-md border px-2 py-2', done ? 'border-accent/30 bg-accent/10 text-accent' : 'border-line bg-canvas text-text-muted')}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-primary">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-current/25 text-[10px]">{index}</span>
        {icon}
        <span className="truncate">{label}</span>
      </div>
      {meta && <div className="mt-1 truncate text-[10px] uppercase text-current/80">{meta}</div>}
    </div>
  );
}