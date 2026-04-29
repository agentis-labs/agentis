/**
 * Drawer — right-anchored side panel with scroll-locked overlay.
 *
 * Used for register/edit/inspector flows that don't deserve a full route
 * but need more room than a popover. Overlay click + Escape close. The
 * panel scrolls internally; the page underneath stays fixed.
 */

import { useEffect } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
  side?: 'right' | 'left';
  footer?: React.ReactNode;
  children: React.ReactNode;
}

const WIDTHS: Record<NonNullable<DrawerProps['width']>, string> = {
  sm: 'w-[22rem]',
  md: 'w-[28rem]',
  lg: 'w-[36rem]',
  xl: 'w-[44rem]',
};

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  width = 'md',
  side = 'right',
  footer,
  children,
}: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex" aria-modal role="dialog">
      <div
        className={clsx('absolute inset-0 bg-black/55 backdrop-blur-[2px]', side === 'right' ? '' : '')}
        onClick={onClose}
      />
      <aside
        className={clsx(
          'relative flex h-full max-h-screen flex-col border-line bg-surface shadow-card',
          side === 'right' ? 'ml-auto border-l' : 'mr-auto border-r',
          WIDTHS[width],
        )}
      >
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            {title && <h2 className="truncate text-sm font-medium text-text-primary">{title}</h2>}
            {subtitle && <div className="mt-0.5 truncate text-xs text-text-muted">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">{children}</div>
        {footer && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface-2 px-4 py-3">
            {footer}
          </footer>
        )}
      </aside>
    </div>
  );
}
