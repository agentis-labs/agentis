import clsx from 'clsx';
import { Activity, BookOpen, GitCompare, Network } from 'lucide-react';

export type BrainMode = 'map' | 'knowledge' | 'health' | 'disputes';

export function BrainTabHeader({ mode, onChange }: { mode: BrainMode; onChange: (mode: BrainMode) => void }) {
  const items = [
    { value: 'map' as const, label: 'Map', icon: <Network size={12} /> },
    { value: 'knowledge' as const, label: 'Knowledge', icon: <BookOpen size={12} /> },
    { value: 'health' as const, label: 'Health', icon: <Activity size={12} /> },
    { value: 'disputes' as const, label: 'Disputes', icon: <GitCompare size={12} /> },
  ];
  return (
    <div className="flex items-center justify-end border-b border-line bg-surface px-5 py-2">
      <div className="inline-flex rounded-full border border-line bg-canvas p-0.5 text-[12px]">
        {items.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => onChange(item.value)}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium transition-colors',
              mode === item.value ? 'bg-accent text-canvas' : 'text-text-muted hover:text-text-primary',
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
