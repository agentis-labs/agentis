import { cn } from '../../lib/utils';

interface IconProps { className?: string }

export function CodexIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={cn(className)} aria-hidden>
      <circle cx="16" cy="16" r="15" fill="#000" />
      <path d="M16 6L16 26M11 11L16 6L21 11M11 21L16 26L21 21" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
