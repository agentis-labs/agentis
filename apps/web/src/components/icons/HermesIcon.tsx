import { cn } from '../../lib/utils';

interface IconProps { className?: string }

export function HermesIcon({ className }: IconProps) {
  return (
    <img
      src="https://pbs.twimg.com/profile_images/1816254738234761216/TX7TW-Mp_400x400.jpg"
      alt="Hermes"
      className={cn('rounded-full object-cover h-full w-full', className)}
    />
  );
}
