import { CircleAlert } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';

/** Small "!" affordance that reveals a description on hover or click. */
export function InfoHint({ text }: { text: string }) {
  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            role="button"
            tabIndex={0}
            aria-label="More info"
            onClick={(e) => e.stopPropagation()}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
          >
            <CircleAlert size={14} />
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            className="z-50 max-w-[220px] rounded-md border border-line bg-surface px-2.5 py-2 text-[11px] leading-relaxed text-text-secondary shadow-card"
          >
            {text}
            <Tooltip.Arrow className="fill-line" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
