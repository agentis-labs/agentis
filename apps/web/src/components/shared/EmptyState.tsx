/**
 * EmptyState — empty / zero-data slot with a clear next action.
 *
 * Empty states should never look like errors. They explain what would
 * normally appear here, then offer the single most useful action.
 */

import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
  align?: 'center' | 'start';
}

export function EmptyState({
  icon,
  title,
  body,
  primaryAction,
  secondaryAction,
  className,
  align = 'center',
}: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'flex flex-col gap-3 rounded-2xl border border-dashed border-line bg-surface/60 p-8',
        align === 'center' && 'items-center text-center',
        align === 'start' && 'items-start text-left',
        className,
      )}
    >
      {icon && (
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-2 text-text-muted">
          {icon}
        </span>
      )}
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-text-primary">{title}</h3>
        {body && <p className="max-w-md text-xs leading-relaxed text-text-muted">{body}</p>}
      </div>
      {(primaryAction || secondaryAction) && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {primaryAction}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
