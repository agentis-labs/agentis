import clsx from 'clsx';
import { AlertTriangle, CircleDashed, HelpCircle } from 'lucide-react';

export type BrainVisibleLayers = Record<'knowledge' | 'memory' | 'judgment', boolean>;

const LAYERS = [
  { key: 'knowledge' as const, label: 'Knowledge', color: '#22d3ee' },
  { key: 'memory' as const, label: 'Memory', color: '#a78bfa' },
  { key: 'judgment' as const, label: 'Judgment', color: '#f59e0b' },
];

export function LayerFilterChips({
  visibleLayers,
  onToggleLayer,
  showWarnings,
  onToggleWarnings,
  hasWarnings,
  showGaps,
  onToggleGaps,
  hasGaps,
}: {
  visibleLayers: BrainVisibleLayers;
  onToggleLayer: (layer: keyof BrainVisibleLayers) => void;
  showWarnings: boolean;
  onToggleWarnings: () => void;
  hasWarnings: boolean;
  showGaps: boolean;
  onToggleGaps: () => void;
  hasGaps: boolean;
}) {
  return (
    <div className="absolute bottom-3 left-3 z-30 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1.5 rounded-card border border-line bg-surface/90 p-1.5 shadow-card backdrop-blur-md">
      {LAYERS.map((layer) => (
        <button
          type="button"
          key={layer.key}
          aria-pressed={visibleLayers[layer.key]}
          onClick={() => onToggleLayer(layer.key)}
          className={clsx(
            'inline-flex h-8 items-center gap-2 rounded-btn px-2.5 text-[11px] font-medium transition-colors',
            visibleLayers[layer.key] ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:bg-surface-2',
          )}
        >
          <span
            className={clsx('h-2.5 w-2.5 rounded-full transition-opacity', !visibleLayers[layer.key] && 'opacity-30')}
            style={{ backgroundColor: layer.color, boxShadow: visibleLayers[layer.key] ? `0 0 8px ${layer.color}` : undefined }}
          />
          <span className={clsx(!visibleLayers[layer.key] && 'line-through')}>{layer.label}</span>
        </button>
      ))}
      {hasWarnings && (
        <Chip active={showWarnings} onClick={onToggleWarnings} label="Warnings" icon={<AlertTriangle size={12} className="text-amber-300" />} />
      )}
      {hasGaps && (
        <Chip active={showGaps} onClick={onToggleGaps} label="Gaps" icon={<CircleDashed size={12} />} />
      )}
      <span className="mx-0.5 h-5 w-px bg-line" />
      <button
        type="button"
        aria-label="Map help"
        title="Size = connections. Glow = confidence. Drag to arrange."
        className="flex h-8 w-8 items-center justify-center rounded-btn text-text-muted transition hover:bg-surface-2 hover:text-text-primary"
      >
        <HelpCircle size={13} />
      </button>
    </div>
  );
}

function Chip({ active, onClick, label, icon }: { active: boolean; onClick: () => void; label: string; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        'inline-flex h-8 items-center gap-1.5 rounded-btn px-2.5 text-[11px] font-medium transition-colors',
        active ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:bg-surface-2',
      )}
    >
      <span className={clsx(!active && 'opacity-40')}>{icon}</span>
      <span className={clsx(!active && 'line-through')}>{label}</span>
    </button>
  );
}
