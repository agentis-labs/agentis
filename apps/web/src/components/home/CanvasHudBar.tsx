import { Maximize2, Minimize2, RadioTower, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import type { FleetCounts } from './homeCanvasTypes';

export function CanvasHudBar({
  counts,
  connected,
  isFullscreen,
  onOpenTriage,
  onToggleFullscreen,
  onResetView,
}: {
  counts: FleetCounts;
  connected: boolean;
  isFullscreen: boolean;
  onOpenTriage: () => void;
  onToggleFullscreen: () => void;
  onResetView: () => void;
}) {
  return (
    <div
      data-canvas-control
      className={clsx(
        'absolute z-40 border border-line/60 bg-canvas/90 shadow-2xl backdrop-blur-xl',
        isFullscreen
          ? 'inset-x-0 bottom-0 rounded-none border-x-0 border-b-0 px-6 py-3'
          : 'inset-x-4 bottom-4 rounded-2xl px-4 py-3',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-text-secondary">
          {isFullscreen && (
            <span className="mr-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-text-primary">
              <RadioTower size={13} className={connected ? 'text-text-primary' : 'text-text-muted'} />
              Agentis Workspace
            </span>
          )}
          <Metric value={counts.runningAgents ?? counts.activeAgents} label="running" tone="active" />
          <Metric value={counts.idleAgents} label="idle" />
          <Metric value={counts.artifactsToday ?? 0} label="today" />
        </div>
        <div className="flex items-center gap-1.5">
          <HudButton label="Triage" onClick={onOpenTriage} icon={<span className="font-mono text-[11px]">T</span>} />
          <HudButton label="Reset view" onClick={onResetView} icon={<RotateCcw size={14} />} />
          <HudButton label={isFullscreen ? 'Exit full screen' : 'Full screen'} onClick={onToggleFullscreen} icon={isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />} />
        </div>
      </div>
    </div>
  );
}

function Metric({ value, label, tone }: { value: number; label: string; tone?: 'active' | 'warn' | 'danger' }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={clsx(
          tone === 'warn' && 'text-warn',
          tone === 'danger' && 'text-danger',
          tone === 'active' && 'text-text-primary',
          !tone && 'text-text-primary',
        )}
      >
        {value}
      </span>
      <span className="text-text-muted">{label}</span>
    </span>
  );
}

function HudButton({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] text-text-secondary hover:bg-surface-3 hover:text-text-primary active:scale-[0.98]"
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
