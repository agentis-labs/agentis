import type { Vec2 } from './homeCanvasTypes';

export function CanvasRadialLight({
  orchestratorCanvasPos,
  isActive,
}: {
  orchestratorCanvasPos: Vec2 | null;
  isActive: boolean;
}) {
  if (!orchestratorCanvasPos) return null;
  const alpha = isActive ? 0.11 : 0.06;
  const spread = isActive ? 68 : 52;
  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{
        zIndex: 1,
        background: `radial-gradient(circle at ${orchestratorCanvasPos.x}px ${orchestratorCanvasPos.y}px, rgba(139,92,246,${alpha}) 0%, rgba(139,92,246,${alpha * 0.4}) 30%, transparent ${spread}%)`,
        transition: 'background 1.5s ease',
      }}
    />
  );
}


