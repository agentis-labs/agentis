import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useRealtimeStatus } from '../../lib/realtime';

/**
 * Unobtrusive realtime-link indicator. The realtime socket is a SEPARATE channel
 * from the chat SSE stream; when it drops, the canvas stops animating and
 * proactive pushes stop arriving. Rather than fail silently (the old behavior —
 * "Agentis is broken"), surface it: invisible while connected, a small pill when
 * the link is down or reconnecting, with a plain-language explanation on hover.
 * A short grace period avoids flashing during the normal initial connect.
 */
export function RealtimeStatusIndicator() {
  const status = useRealtimeStatus();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (status === 'connected' || status === 'fallback') {
      setShow(false);
      return;
    }
    // Only surface a persistent problem, not the momentary initial handshake.
    const t = window.setTimeout(() => setShow(true), 1500);
    return () => window.clearTimeout(t);
  }, [status]);

  if (!show || status === 'connected' || status === 'fallback') return null;

  const reconnecting = status === 'connecting';
  const label = reconnecting ? 'Reconnecting…' : 'Live link offline';

  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            className="inline-flex h-9 items-center gap-1.5 rounded-btn border border-warn/30 bg-warn-soft px-2.5 text-[11px] font-medium text-warn"
            role="status"
            aria-live="polite"
          >
            <WifiOff size={12} className={reconnecting ? 'animate-pulse' : undefined} />
            {label}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className="max-w-[260px] rounded-md border border-line bg-surface px-3 py-2 text-[11px] leading-relaxed text-text-secondary shadow-card"
          >
            The live update channel is {reconnecting ? 'reconnecting' : 'disconnected'}. Chat still
            works, but the canvas won’t animate builds/runs live and proactive nudges are paused
            until it’s back.
            <Tooltip.Arrow className="fill-line" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
