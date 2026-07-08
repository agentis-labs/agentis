/**
 * FilterBar — standardized filter pill row.
 *
 * One source of truth for the [All] [Active] [Failed] style controls
 * that appear on every list page. Active item is bg-accent-soft + text-accent.
 */

import clsx from 'clsx';

export interface FilterOption<T extends string = string> {
  value: T;
  label: string;
  count?: number;
}

interface FilterBarProps<T extends string = string> {
  options: ReadonlyArray<FilterOption<T>>;
  value: T;
  onChange: (v: T) => void;
  className?: string;
  size?: 'sm' | 'md';
}

export function FilterBar<T extends string = string>({
  options, value, onChange, className, size = 'md',
}: FilterBarProps<T>) {
  return (
    <div className={clsx('flex flex-wrap items-center gap-1.5', className)}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-pill border font-medium transition-colors',
              size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[12px]',
              active
                ? 'border-accent-muted bg-accent-soft text-accent'
                : 'border-line bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary',
            )}
          >
            {opt.label}
            {opt.count != null && (
              <span className={clsx('text-[11px]', active ? 'text-accent/80' : 'text-text-muted')}>
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}



