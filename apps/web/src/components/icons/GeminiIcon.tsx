import { cn } from '../../lib/utils';

interface IconProps { className?: string }

/** Google Gemini's four-point "spark" mark in its signature blue gradient. */
export function GeminiIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={cn(className)} aria-hidden>
      <defs>
        <linearGradient id="gemini-spark" x1="4" y1="6" x2="28" y2="26" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4285F4" />
          <stop offset="0.5" stopColor="#9B72CB" />
          <stop offset="1" stopColor="#D96570" />
        </linearGradient>
      </defs>
      <path
        d="M16 2c.6 6.9 6.1 12.4 13 13-6.9.6-12.4 6.1-13 13-.6-6.9-6.1-12.4-13-13C9.9 14.4 15.4 8.9 16 2Z"
        fill="url(#gemini-spark)"
      />
    </svg>
  );
}
