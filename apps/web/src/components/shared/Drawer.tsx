/**
 * Drawer — modal right/left panel with overlay (heavier than DetailPanel).
 *
 * Use for register/edit/inspector flows that need a focused workspace.
 * Overlay click + Escape close. Body scroll-locked while open.
 */

import { useEffect } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl' | 'brain';
  side?: 'right' | 'left';
  footer?: React.ReactNode;
  children: React.ReactNode;
}

const WIDTHS: Record<NonNullable<DrawerProps['width']>, string> = {
  sm: 'w-[22rem]',
  md: 'w-[28rem]',
  lg: 'w-[36rem]',
  xl: 'w-[44rem]',
  brain: 'w-[min(30rem,100vw)]',
};

export function Drawer({
  open, onClose, title, subtitle, width = 'md', side = 'right', footer, children,
}: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
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
    <div className="fixed inset-0 z-[50] flex" aria-modal role="dialog">
      <div
        className="animate-fade-in absolute inset-0 bg-overlay"
        onClick={onClose}
      />
      <aside
        className={clsx(
          'animate-slide-in-right relative flex h-full max-h-screen flex-col border-line bg-surface shadow-modal',
          side === 'right' ? 'ml-auto border-l' : 'mr-auto border-r',
          WIDTHS[width],
        )}
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            {title && <h2 className="truncate text-heading text-text-primary">{title}</h2>}
            {subtitle && <div className="mt-1 truncate text-[12px] text-text-muted">{subtitle}</div>}
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
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
            {footer}
          </footer>
        )}
      </aside>
    </div>
  );
}
