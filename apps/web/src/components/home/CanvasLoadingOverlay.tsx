import clsx from 'clsx';


export function CanvasLoadingOverlay() {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-canvas">
      <div className="flex flex-col items-center gap-7">
        <div className="relative flex flex-col items-center gap-6">
          {/* connector lines fanning out to the manager skeletons */}
          <svg className="pointer-events-none absolute left-1/2 top-[46px] -translate-x-1/2" width="260" height="44" aria-hidden="true">
            <path d="M130 0 C130 22, 56 18, 56 44" fill="none" stroke="var(--color-line)" strokeWidth="1.5" opacity="0.5" />
            <path d="M130 0 C130 22, 204 18, 204 44" fill="none" stroke="var(--color-line)" strokeWidth="1.5" opacity="0.5" />
          </svg>
          <SkeletonNode className="h-[52px] w-52" />
          <div className="flex gap-10">
            <SkeletonNode className="h-12 w-44" delay="0.15s" />
            <SkeletonNode className="h-12 w-44" delay="0.3s" />
          </div>
        </div>
        <div className="flex items-center gap-2 text-[12px] font-medium tracking-wide text-text-muted">
          <span className="inline-flex h-4 w-4 items-center justify-center">
            <span className="absolute h-4 w-4 animate-ping rounded-full border border-accent/40" />
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
          Loading your workspaceâ€¦
        </div>
      </div>
    </div>
  );
}

function SkeletonNode({ className, delay }: { className?: string; delay?: string }) {
  return (
    <div
      className={clsx(
        'home-canvas-skeleton rounded-xl border border-line/70 bg-surface-2/70 shadow-card',
        className,
      )}
      style={delay ? { animationDelay: delay } : undefined}
    />
  );
}



