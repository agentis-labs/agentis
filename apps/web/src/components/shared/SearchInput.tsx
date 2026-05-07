/**
 * SearchInput — standardized search input with icon, clear button, and `/` shortcut focus.
 */

import { forwardRef, useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import clsx from 'clsx';

interface SearchInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  value: string;
  onChange: (v: string) => void;
  onClear?: () => void;
  bindSlashShortcut?: boolean; // when true, pressing `/` globally focuses this input
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onChange, onClear, bindSlashShortcut, placeholder = 'Search…', className, ...rest },
  ref,
) {
  const innerRef = useRef<HTMLInputElement | null>(null);
  const setRef = (el: HTMLInputElement | null) => {
    innerRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = el;
  };

  useEffect(() => {
    if (!bindSlashShortcut) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea' || target?.isContentEditable;
      if (e.key === '/' && !isInput) {
        e.preventDefault();
        innerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bindSlashShortcut]);

  return (
    <div className={clsx('relative inline-flex w-full items-center', className)}>
      <Search size={14} className="pointer-events-none absolute left-3 text-text-muted" />
      <input
        ref={setRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-input border border-line bg-surface-2 pl-9 pr-9 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        {...rest}
      />
      {value && (
        <button
          type="button"
          onClick={() => { onChange(''); onClear?.(); }}
          aria-label="Clear search"
          className="absolute right-2 inline-flex h-6 w-6 items-center justify-center rounded text-text-muted hover:bg-surface-3 hover:text-text-primary"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
});
