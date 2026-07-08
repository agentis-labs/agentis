/**
 * EmptyState — every empty state follows this pattern:
 * icon (48px, text-muted) + title + description + CTA.
 *
 * No empty state is ever blank gray text.
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
  variant?: 'inline' | 'page';
}

export function EmptyState({
  icon, title, body, primaryAction, secondaryAction, className, align = 'center', variant = 'inline',
}: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'flex flex-col gap-4 rounded-card border border-dashed border-line bg-surface/40',
        variant === 'page' ? 'px-8 py-16' : 'px-6 py-10',
        align === 'center' && 'items-center text-center',
        align === 'start' && 'items-start text-left',
        className,
      )}
    >
      {icon && (
        <span className="flex h-12 w-12 items-center justify-center text-text-muted opacity-70">
          {icon}
        </span>
      )}
      <div className="space-y-1.5">
        <h3 className="text-heading text-text-primary">{title}</h3>
        {body && <p className="max-w-md text-[13px] leading-relaxed text-text-secondary">{body}</p>}
      </div>
      {(primaryAction || secondaryAction) && (
        <div className="flex flex-wrap items-center gap-2">
          {primaryAction}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}



