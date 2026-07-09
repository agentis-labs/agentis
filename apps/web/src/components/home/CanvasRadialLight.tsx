import type { Vec2 } from './homeCanvasTypes';

export function CanvasRadialLight({
  orchestratorCanvasPos,
  isActive,
}: {
  orchestratorCanvasPos: Vec2 | null;
  isActive: boolean;
}) {
  if (!orchestratorCanvasPos) return null;
  const a = isActive ? 0.16 : 0.09;
  const spread = isActive ? 68 : 52;
  // A cool slate-grey glow — reads as depth/ambient light around the orchestrator,
  // never the harsh white that a pure-accent tint produced.
  const inner = `rgba(130, 136, 152, ${a})`;
  const outer = `rgba(130, 136, 152, ${(a * 0.4).toFixed(3)})`;
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


