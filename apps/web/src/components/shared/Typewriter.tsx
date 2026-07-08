/**
 * Typewriter â€” V1-SPEC Â§13.5.
 *
 * Streams a string character-by-character at TYPEWRITER_CHAR_DELAY_MS
 * (28ms/char). When `text` changes mid-stream we restart from zero so the
 * audience always sees the latest content from the beginning, never a
 * blended interpolation.
 *
 * Used for tool-call previews under WorkflowNodes, agent intent in the
 * run inspector, and extension registry install status messages.
 */

import { useEffect, useState } from 'react';
import { CONSTANTS } from '@agentis/core';

export function Typewriter({
  text,
  className,
  charDelayMs = CONSTANTS.TYPEWRITER_CHAR_DELAY_MS,
  onDone,
}: {
  text: string;
  className?: string;
  charDelayMs?: number;
  onDone?: () => void;
}) {
  const [shown, setShown] = useState('');

  useEffect(() => {
    setShown('');
    if (!text) return;
    let i = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) {
        if (onDone) onDone();
        return;
      }
      window.setTimeout(tick, charDelayMs);
    };
    window.setTimeout(tick, charDelayMs);
    return () => {
      cancelled = true;
    };
  }, [text, charDelayMs, onDone]);

  return <span className={className}>{shown}</span>;
}



