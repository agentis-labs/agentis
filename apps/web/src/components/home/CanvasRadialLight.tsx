import type { Vec2 } from './homeCanvasTypes';

export function CanvasRadialLight({
  orchestratorCanvasPos,
  isActive,
}: {
  orchestratorCanvasPos: Vec2 | null;
  isActive: boolean;
}) {
  if (!orchestratorCanvasPos) return null;
  const pct = isActive ? 11 : 6;
  const spread = isActive ? 68 : 52;
  // Theme-neutral orchestrator glow: derives from --color-accent (white on dark,
  // black on light) so it never reads as a purple brand tint.
  const inner = `color-mix(in srgb, var(--color-accent) ${pct}%, transparent)`;
  const outer = `color-mix(in srgb, var(--color-accent) ${(pct * 0.4).toFixed(1)}%, transparent)`;
  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{
        zIndex: 1,
        background: `radial-gradient(circle at ${orchestratorCanvasPos.x}px ${orchestratorCanvasPos.y}px, ${inner} 0%, ${outer} 30%, transparent ${spread}%)`,
        transition: 'background 1.5s ease',
      }}
    />
  );
}


