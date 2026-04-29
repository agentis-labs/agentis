/**
 * PageHeader — consistent title row for primary surfaces.
 *
 * Title left, optional eyebrow + subtitle stacked under it, actions
 * pinned right. Keeps every page's hero band on the same baseline so
 * the canvas reads as one cockpit rather than a stack of admin pages.
 */

import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  meta,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={clsx(
        'flex flex-wrap items-end justify-between gap-3 border-b border-line bg-surface px-6 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
            {eyebrow}
          </div>
        )}
        <h1 className="truncate text-lg font-medium text-text-primary">{title}</h1>
        {subtitle && (
          <div className="mt-1 text-xs leading-relaxed text-text-muted">{subtitle}</div>
        )}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
