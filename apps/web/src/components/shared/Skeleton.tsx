/**
 * Skeleton — shimmer placeholder for loading states.
 *
 * Use to keep layout stable while data loads. Always render skeletons
 * for at least 150ms to prevent flashing on fast loads.
 */

import clsx from 'clsx';

interface SkeletonProps {
  className?: string;
  width?: string | number;
  height?: string | number;
  rounded?: 'sm' | 'md' | 'lg' | 'pill' | 'full';
}

const ROUND: Record<NonNullable<SkeletonProps['rounded']>, string> = {
  sm:   'rounded',
  md:   'rounded-md',
  lg:   'rounded-card',
  pill: 'rounded-pill',
  full: 'rounded-full',
};

export function Skeleton({ className, width, height, rounded = 'md' }: SkeletonProps) {
  const style: React.CSSProperties = {};
  if (width != null) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height != null) style.height = typeof height === 'number' ? `${height}px` : height;
  return <div className={clsx('skeleton', ROUND[rounded], className)} style={style} />;
}

export function SkeletonText({ lines = 1, className }: { lines?: number; className?: string }) {
  return (
    <div className={clsx('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={12}
          width={i === lines - 1 ? '60%' : '100%'}
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={clsx('rounded-card border border-line bg-surface p-4', className)}>
      <div className="mb-3 flex items-center gap-3">
        <Skeleton width={32} height={32} rounded="full" />
        <div className="flex-1 space-y-2">
          <Skeleton height={12} width="40%" />
          <Skeleton height={10} width="60%" />
        </div>
      </div>
      <SkeletonText lines={2} />
    </div>
  );
}

export function SkeletonRow({ className }: { className?: string }) {
  return (
    <div className={clsx('flex items-center gap-3 px-3 py-3', className)}>
      <Skeleton width={8} height={8} rounded="full" />
      <Skeleton height={12} width="30%" />
      <Skeleton height={12} width="20%" />
      <div className="ml-auto">
        <Skeleton height={12} width={80} />
      </div>
    </div>
  );
}



