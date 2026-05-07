/**
 * Button — standardized action surface.
 *
 * Variants: primary, secondary, ghost, danger, pill.
 * Sizes: sm (32px), md (36px default), lg (40px).
 * Built-in support for icon+label, loading state, and disabled state.
 */

import { forwardRef } from 'react';
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'pill';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  children?: React.ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-canvas border border-transparent hover:bg-accent-hover active:scale-[0.98] disabled:bg-accent/40 disabled:text-canvas/50 disabled:cursor-not-allowed disabled:active:scale-100',
  secondary:
    'bg-surface-2 text-text-primary border border-line hover:bg-surface-3 hover:border-line-strong active:scale-[0.98] disabled:bg-surface-2/50 disabled:text-text-disabled disabled:border-line/50 disabled:cursor-not-allowed disabled:active:scale-100',
  ghost:
    'bg-transparent text-text-muted border border-transparent hover:bg-surface-2 hover:text-text-primary disabled:text-text-disabled disabled:cursor-not-allowed',
  danger:
    'bg-danger-soft text-danger border border-danger/20 hover:bg-danger/20 hover:border-danger/30 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
  pill:
    'bg-surface-2 text-text-secondary border border-line hover:bg-surface-3 hover:text-text-primary hover:border-line-strong rounded-pill disabled:bg-surface-2/50 disabled:text-text-disabled disabled:cursor-not-allowed',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8  px-2.5 text-[12px] gap-1.5',
  md: 'h-9  px-3   text-[13px] gap-2',
  lg: 'h-10 px-4   text-[14px] gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, iconLeft, iconRight, className, disabled, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-muted focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        variant !== 'pill' && 'rounded-btn',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : iconLeft}
      {children && <span className="truncate">{children}</span>}
      {!loading && iconRight}
    </button>
  );
});

interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: React.ReactNode;
  label: string; // for aria-label
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'ghost', size = 'md', className, type, ...rest },
  ref,
) {
  const sizeClass = size === 'sm' ? 'h-8 w-8' : size === 'lg' ? 'h-10 w-10' : 'h-9 w-9';
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex items-center justify-center rounded-btn font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-muted focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        VARIANTS[variant],
        sizeClass,
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
});
