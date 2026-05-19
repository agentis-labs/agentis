import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { Vec2 } from './homeCanvasTypes';

export interface CanvasBackgroundHandle {
  farPattern: SVGPatternElement | null;
  nearPattern: SVGPatternElement | null;
}

export const CanvasBackground = forwardRef<CanvasBackgroundHandle, { pan: Vec2; zoom: number }>(
  function CanvasBackground({ pan, zoom }, ref) {
    const farRef = useRef<SVGPatternElement | null>(null);
    const nearRef = useRef<SVGPatternElement | null>(null);
    useImperativeHandle(ref, () => ({
      get farPattern() { return farRef.current; },
      get nearPattern() { return nearRef.current; },
    }));
    return (
      <svg className="absolute inset-0 h-full w-full pointer-events-none" style={{ zIndex: 0 }} aria-hidden="true">
        <defs>
          <pattern
            ref={farRef}
            id="home-bg-far"
            width="56"
            height="56"
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${pan.x * 0.65} ${pan.y * 0.65}) scale(${zoom * 0.75})`}
          >
            <circle cx="28" cy="28" r="1.5" fill="rgba(255,255,255,0.065)" />
          </pattern>
          <pattern
            ref={nearRef}
            id="home-bg-near"
            width="24"
            height="24"
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}
          >
            <circle cx="12" cy="12" r="0.8" fill="rgba(255,255,255,0.20)" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#home-bg-far)" />
        <rect width="100%" height="100%" fill="url(#home-bg-near)" />
      </svg>
    );
  },
);