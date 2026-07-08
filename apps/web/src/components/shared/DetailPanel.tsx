/**
 * DetailPanel — right-side slide-in panel for inline detail viewing.
 *
 * Lighter alternative to Drawer for "click row to inspect" patterns.
 * No overlay; main content stays interactive.
 */

import { useEffect } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';

interface DetailPanelProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  width?: 'sm' | 'md' | 'lg';
  actions?: React.ReactNode;
  children: React.ReactNode;
}

const WIDTHS: Record<NonNullable<DetailPanelProps['width']>, string> = {
  sm: 'w-[360px]',
  md: 'w-[440px]',
  lg: 'w-[560px]',
};

export function DetailPanel({
  open, onClose, title, subtitle, width = 'md', actions, children,
}: DetailPanelProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <aside
      className={clsx(
        'animate-slide-in-right fixed right-0 top-12 z-30 flex h-[calc(100vh-3rem)] flex-col border-l border-line bg-surface shadow-card',
        WIDTHS[width],
      )}
      role="complementary"
    >
      <header className="flex items-start gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-heading text-text-primary">{title}</h2>
          {subtitle && <div className="mt-1 truncate text-[12px] text-text-muted">{subtitle}</div>}
        </div>
        {actions}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
        >
          <X size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
    </aside>
  );
}



