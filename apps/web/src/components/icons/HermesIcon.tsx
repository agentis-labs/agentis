import type { SVGProps } from 'react';
import { cn } from '../../lib/utils';

export function HermesIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={cn(className)} aria-hidden {...props}>
      <circle cx="16" cy="16" r="15" fill="#10151F" />
      <path
        d="M9 18.7c3.3-2.2 5.3-5.2 6.3-9.2.2-.8 1.2-.8 1.4 0 1 4 3 7 6.3 9.2.7.5.4 1.5-.4 1.5h-4.1l-1.9 3.9a.7.7 0 0 1-1.2 0l-1.9-3.9H9.4c-.8 0-1.1-1-.4-1.5Z"
        fill="#F4C96B"
      />
      <path
        d="M12 10.2 7.4 7.9M20 10.2l4.6-2.3M11.1 14.1H6.8M20.9 14.1h4.3"
        stroke="#7DD3FC"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M14 17h4" stroke="#10151F" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}



