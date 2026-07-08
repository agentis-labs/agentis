import { ArrowLeft, Maximize2, Minimize2, Minus, Plus, RadioTower, Scan } from 'lucide-react';
import clsx from 'clsx';

/**
 * Bottom-right control puck for the workspace canvas â€” mirrors the Brain /
 * Workflows ReactFlow controls, but with actions purpose-built for /home:
 * zoom, fit/recenter, fullscreen, the Live Workspace toggle, and (in focus
 * mode) a "back to overview" affordance. Replaces the old full-width HUD bar.
 */
export function CanvasControls({
  isFullscreen,
  liveCount = 0,
  liveActive = false,
  hasAttention = false,
  focusActive = false,
  onZoomIn,
  onZoomOut,
  onFit,
  onToggleFullscreen,
  onOpenLiveWorkspace,
  onExitFocus,
}: {
  isFullscreen: boolean;
  liveCount?: number;
  liveActive?: boolean;
  hasAttention?: boolean;
  focusActive?: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onToggleFullscreen: () => void;
  onOpenLiveWorkspace: () => void;
  onExitFocus: () => void;
}) {
  return (
    <div data-canvas-control className="absolute bottom-4 right-4 z-40 flex flex-col items-end gap-2">
      {focusActive && (
        <button
          type="button"
          onClick={onExitFocus}
          aria-label="Back to overview"
          title="Back to overview (Esc)"
          className="inline-flex h-9 items-center gap-1.5 rounded-btn border border-line bg-canvas/90 px-3 text-[12px] font-medium text-text-secondary shadow-2xl backdrop-blur-xl transition hover:bg-surface-3 hover:text-text-primary active:scale-[0.98]"
        >
          <ArrowLeft size={14} />
          Back to overview
        </button>
      )}

      <div className="flex flex-col overflow-hidden rounded-2xl border border-line/60 bg-canvas/90 shadow-2xl backdrop-blur-xl">
        <PuckButton label="Zoom in" onClick={onZoomIn} icon={<Plus size={15} />} />
        <Divider />
        <PuckButton label="Zoom out" onClick={onZoomOut} icon={<Minus size={15} />} />
        <Divider />
        <PuckButton label="Fit to view" onClick={onFit} icon={<Scan size={15} />} />
        <Divider />
        <PuckButton
          label={isFullscreen ? 'Exit full screen' : 'Full screen'}
          onClick={onToggleFullscreen}
          icon={isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        />
        <Divider />
        <LivePuckButton liveCount={liveCount} active={liveActive} hasAttention={hasAttention} onClick={onOpenLiveWorkspace} />
      </div>
    </div>
  );
}

function Divider() {
  return <span className="h-px w-full bg-line/50" />;
}

function PuckButton({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 items-center justify-center text-text-secondary transition hover:bg-surface-3 hover:text-text-primary active:scale-[0.96]"
    >
      {icon}
    </button>
  );
}

function LivePuckButton({
  liveCount,
  active,
  hasAttention,
  onClick,
}: {
  liveCount: number;
  active: boolean;
  hasAttention: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open Live Workspace"
      title="Open Live Workspace"
      className={clsx(
        'relative inline-flex h-9 w-9 items-center justify-center transition active:scale-[0.96]',
        active
          ? 'bg-gradient-to-br from-accent/15 to-accent/5 text-accent'
          : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary',
      )}
    >
      <span className="relative inline-flex h-4 w-4 items-center justify-center">
        {active && <span className="absolute h-5 w-5 animate-ping rounded-full border border-accent/45" />}
        <RadioTower size={15} className="relative" />
      </span>
      {hasAttention && (
        <span
          aria-label="Live Workspace needs attention"
          className="absolute left-1 top-1 h-2 w-2 rounded-full border border-canvas bg-warn shadow-[0_0_10px_rgba(245,158,11,0.7)]"
        />
      )}
      {liveCount > 0 && (
        <span className="absolute -right-1 -top-1 min-w-[16px] rounded-full border border-canvas bg-accent px-1 text-center font-mono text-[9px] font-semibold leading-[15px] text-canvas shadow-[0_0_12px_rgba(74,222,128,0.45)]">
          {liveCount > 9 ? '9+' : liveCount}
        </span>
      )}
    </button>
  );
}



