import { Panel } from '@xyflow/react';
import clsx from 'clsx';
import { Search } from 'lucide-react';

export type FleetFilterValue = 'all' | 'active' | 'idle' | 'setup_needed';

const FILTERS: Array<{ value: FleetFilterValue; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'idle', label: 'Idle' },
  { value: 'setup_needed', label: 'Setup' },
];

export function FleetToolbar({
  search,
  filter,
  onSearchChange,
  onFilterChange,
}: {
  search: string;
  filter: FleetFilterValue;
  onSearchChange: (value: string) => void;
  onFilterChange: (value: FleetFilterValue) => void;
}) {
  return (
    <Panel position="top-left" className="pointer-events-auto">
      <div className="flex h-12 items-center gap-2 rounded-xl border border-line/60 bg-surface/90 px-3 py-2 shadow-card backdrop-blur-sm">
        <div className="flex items-center gap-2 rounded-lg border border-line/60 bg-canvas/60 px-2.5 py-1.5">
          <Search size={13} className="text-text-muted" />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search agents..."
            className="w-[180px] bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
            aria-label="Search agents"
          />
        </div>
        <div className="mx-1 h-4 w-px bg-line" />
        <div className="flex items-center gap-1.5">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onFilterChange(option.value)}
              className={clsx(
                'inline-flex h-7 items-center rounded-full border px-2.5 text-[11px] font-medium transition-colors',
                filter === option.value
                  ? 'border-accent/60 bg-accent/15 text-text-primary'
                  : 'border-line/70 bg-canvas/40 text-text-muted hover:border-line hover:text-text-primary',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
}