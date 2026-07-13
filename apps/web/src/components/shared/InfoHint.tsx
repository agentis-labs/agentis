import type { ReactNode } from 'react';
import { CircleAlert, HelpCircle } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import clsx from 'clsx';

interface InfoHintProps {
  /** Plain-text tooltip (compact, single line-ish). Ignored when `children` is set. */
  text?: string;
  /** Bold header for a richer info card. */
  title?: string;
  /** Rich content (bullets, paragraphs) for a wider explanatory card. */
  children?: ReactNode;
  /** `alert` (default, "!") for inline caveats; `help` ("?") for "how this works". */
  icon?: 'alert' | 'help';
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}

/** Small "!"/"?" affordance that reveals a description or a richer info card on hover or click. */
export function InfoHint({ text, title, children, icon = 'alert', side = 'top', align = 'center' }: InfoHintProps) {
  const Icon = icon === 'help' ? HelpCircle : CircleAlert;
  const rich = Boolean(children || title);
  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            role="button"
            tabIndex={0}
            aria-label={icon === 'help' ? 'How this works' : 'More info'}
            onClick={(e) => e.stopPropagation()}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
          >
            <Icon size={14} />
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side={side}
            align={align}
            sideOffset={8}
            className={clsx(
              'z-50 rounded-md border border-line bg-surface text-text-secondary shadow-card',
              rich ? 'w-[280px] p-3 text-[12px] leading-relaxed' : 'max-w-[220px] px-2.5 py-2 text-[11px] leading-relaxed',
            )}
          >
            {title && <div className="mb-1.5 text-[12.5px] font-semibold text-text-primary">{title}</div>}
            {children ?? text}
            <Tooltip.Arrow className="fill-line" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
