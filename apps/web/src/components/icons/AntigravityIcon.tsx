import { cn } from '../../lib/utils';

interface IconProps { className?: string }

/** Google Antigravity mark — an upward "anti-gravity" chevron rising through an
 *  orbital ring, in Antigravity's blue→violet gradient. */
export function AntigravityIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={cn(className)} aria-hidden>
      <defs>
        <linearGradient id="antigravity-g" x1="6" y1="28" x2="26" y2="6" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4285F4" />
          <stop offset="1" stopColor="#9B72CB" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="13" stroke="url(#antigravity-g)" strokeWidth="2" fill="none" opacity="0.55" />
      <path d="M16 7l7 9h-4v8h-6v-8H9l7-9z" fill="url(#antigravity-g)" />
    </svg>
  );
}
