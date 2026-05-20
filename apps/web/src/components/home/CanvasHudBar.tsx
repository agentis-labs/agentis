import { AlertTriangle, Maximize2, Minimize2, RadioTower, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import type { FleetCounts } from './homeCanvasTypes';

export function CanvasHudBar({
  counts,
  isFullscreen,
  onToggleFullscreen,
  onResetView,
}: {
  counts: FleetCounts;
  isFullscreen: boolean;
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
              <RadioTower size={13} className="text-accent" />
              Workspace Live
            </span>
          )}
          <Metric value={counts.activeAgents} label="active" tone="accent" />
          <Metric value={counts.idleAgents} label="idle" />
          <Metric value={counts.attentionCount} label="attention" tone={counts.attentionCount > 0 ? 'warn' : undefined} />
          <Metric value={counts.workflows} label="workflows" />
        </div>
        <div className="flex items-center gap-1.5">
          <HudButton label="Reset view" onClick={onResetView} icon={<RotateCcw size={14} />} />
          <HudButton label={isFullscreen ? 'Exit full screen' : 'Full screen'} onClick={onToggleFullscreen} icon={isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />} />
        </div>
      </div>
      {isFullscreen && counts.attentionCount > 0 && (
        <div className="mt-2 border-t border-line/50 pt-2">
          <div className="inline-flex items-center gap-2 rounded-pill border border-warn/30 bg-warn-soft px-3 py-1.5 text-[11px] font-medium text-warn">
            <AlertTriangle size={13} />
            {counts.attentionCount} need operator attention
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ value, label, tone }: { value: number; label: string; tone?: 'accent' | 'warn' }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={tone === 'warn' ? 'text-warn' : tone === 'accent' ? 'text-accent' : 'text-text-primary'}>{value}</span>
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
      className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
