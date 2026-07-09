import { cn } from '../../lib/utils';

interface IconProps { className?: string }

/** Antigravity runs on Google's Gemini — the Gemini spark, in its blue→violet
 *  gradient. */
export function AntigravityIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={cn(className)} aria-hidden>
      <defs>
        <linearGradient id="gemini-g" x1="3" y1="21" x2="21" y2="3" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4285F4" />
          <stop offset="0.5" stopColor="#9B72CB" />
          <stop offset="1" stopColor="#D96570" />
        </linearGradient>
      </defs>
      <path d="M12 0c0 6.627-5.373 12-12 12 6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12z" fill="url(#gemini-g)" />
    </svg>
  );
}
