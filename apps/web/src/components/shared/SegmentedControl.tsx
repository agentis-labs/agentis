/**
 * SegmentedControl — central, segmented switcher.
 *
 * Used for compact, mutually exclusive surface switches.
 *
 * Heavier visual weight than Tabs — this is a *shell-level* control and the
 * design rule (§5) is that it should feel central and product-defining.
 */

import clsx from 'clsx';

export interface SegmentDef<T extends string = string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

interface Props<T extends string = string> {
  segments: ReadonlyArray<SegmentDef<T>>;
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}

export function SegmentedControl<T extends string = string>({
  segments, value, onChange, size = 'md', className,
}: Props<T>) {
  const padX = size === 'sm' ? 'px-3' : 'px-4';
  const padY = size === 'sm' ? 'py-1.5' : 'py-2';
  const text = size === 'sm' ? 'text-[12px]' : 'text-[13px]';

  return (
    <div
      role="tablist"
      className={clsx(
        'inline-flex items-center gap-1.5',
        className,
      )}
    >
      {segments.map((seg) => {
        const active = seg.value === value;
        return (
          <button
            key={seg.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(seg.value)}
            className={clsx(
              'group relative inline-flex items-center gap-2 rounded-full font-medium transition-colors',
              padX, padY, text,
              active
                ? 'bg-accent-soft text-accent'
                : 'text-text-muted hover:text-text-primary',
            )}
          >
            {seg.icon}
            <span>{seg.label}</span>
          </button>
        );
      })}
    </div>
  );
}



