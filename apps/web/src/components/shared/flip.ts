/**
 * FLIP utility — V1-SPEC §13.5.
 *
 * "First, Last, Invert, Play" animation pattern for status transitions on
 * canvas nodes. Capture geometry before a layout change, capture again
 * after, then animate the delta with the WAAPI at FLIP_ANIMATION_DURATION_MS.
 *
 * We use raw WAAPI (Element.animate) instead of pulling Motion One; the
 * primitives are tiny and the dependency footprint matters for the
 * dashboard's cold-start budget.
 */

import { CONSTANTS } from '@agentis/core';

export interface FlipSnapshot {
  rect: DOMRect;
  opacity: number;
}

export function captureFlip(el: HTMLElement | null): FlipSnapshot | null {
  if (!el) return null;
  return {
    rect: el.getBoundingClientRect(),
    opacity: Number(getComputedStyle(el).opacity || 1),
  };
}

export function playFlip(
  el: HTMLElement | null,
  before: FlipSnapshot | null,
  options: { durationMs?: number; easing?: string } = {},
): Animation | null {
  if (!el || !before) return null;
  const after = captureFlip(el);
  if (!after) return null;
  const dx = before.rect.left - after.rect.left;
  const dy = before.rect.top - after.rect.top;
  const sx = before.rect.width / Math.max(1, after.rect.width);
  const sy = before.rect.height / Math.max(1, after.rect.height);
  const dOpacity = before.opacity - after.opacity;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01 && Math.abs(dOpacity) < 0.01) {
    return null;
  }
  const duration = options.durationMs ?? CONSTANTS.FLIP_ANIMATION_DURATION_MS;
  return el.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: after.opacity + dOpacity },
      { transform: 'translate(0, 0) scale(1, 1)', opacity: after.opacity },
    ],
    {
      duration,
      easing: options.easing ?? 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'both',
    },
  );
}
