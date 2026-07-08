/**
 * Tabs — accessible tabbed navigation with sliding indicator.
 *
 * Use for in-page sub-section navigation. URL-stateful via the `param`
 * prop (writes to ?tab= search param so reloads preserve the tab).
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import clsx from 'clsx';

export interface TabDef<T extends string = string> {
  value: T;
  label: string;
  count?: number;
  icon?: React.ReactNode;
  disabled?: boolean;
}

interface TabsProps<T extends string = string> {
  tabs: ReadonlyArray<TabDef<T>>;
  value?: T;
  defaultValue?: T;
  onChange?: (v: T) => void;
  param?: string; // URL search param key; if set, syncs with URL
  className?: string;
}

export function Tabs<T extends string = string>({
  tabs, value, defaultValue, onChange, param, className,
}: TabsProps<T>) {
  const [search, setSearch] = useSearchParams();
  const initial = (defaultValue ?? tabs[0]?.value) as T;
  const [internal, setInternal] = useState<T>(value ?? (param ? (search.get(param) as T) || initial : initial));

  useEffect(() => {
    if (value !== undefined) setInternal(value);
  }, [value]);

  useEffect(() => {
    if (param) {
      const v = search.get(param) as T | null;
      if (v && v !== internal && tabs.some((t) => t.value === v)) {
        setInternal(v);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [param, search]);

  function setActive(v: T) {
    setInternal(v);
    onChange?.(v);
    if (param) {
      const next = new URLSearchParams(search);
      next.set(param, v);
      setSearch(next, { replace: true });
    }
  }

  return (
    <div role="tablist" className={clsx('flex items-center gap-0.5 border-b border-line', className)}>
      {tabs.map((tab) => {
        const active = tab.value === internal;
        return (
          <button
            key={tab.value}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={tab.disabled}
            onClick={() => !tab.disabled && setActive(tab.value)}
            className={clsx(
              'group relative inline-flex items-center gap-2 px-3 py-2.5 text-[13px] font-medium transition-colors',
              tab.disabled
                ? 'text-text-disabled cursor-not-allowed'
                : active
                  ? 'text-text-primary'
                  : 'text-text-muted hover:text-text-primary',
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.count != null && tab.count > 0 && (
              <span
                className={clsx(
                  'inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold',
                  active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-text-muted',
                )}
              >
                {tab.count > 99 ? '99+' : tab.count}
              </span>
            )}
            {active && (
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-accent" />
            )}
          </button>
        );
      })}
    </div>
  );
}



