import { useMemo } from 'react';

/**
 * PhaseLayer — colored region backgrounds that group canvas nodes into
 * logical phases. Renders behind nodes as an absolutely-positioned SVG layer
 * so the React Flow viewport transforms apply cleanly.
 *
 * A "phase" is a named bag of node ids with a color. The layer computes a
 * bounding rect around the contained nodes (with padding), draws a tinted
 * rectangle + label, and lets the canvas keep rendering its own nodes on top.
 * Large workflows (50+ nodes) become legible because operators can read the
 * graph as "first this phase, then that one" instead of as an indecipherable
 * spaghetti.
 *
 * The shape (`WorkflowPhase`) mirrors what brain-apps' AppLayoutSection will
 * use — keep this dumb and dependency-free.
 */

export interface PhaseNode {
  id: string;
  position: { x: number; y: number };
  /** Optional measured size; defaults to the standard 200x100 node footprint. */
  width?: number;
  height?: number;
}

export interface PhaseSpec {
  id: string;
  name: string;
  color: string;
  nodeIds: string[];
  collapsed?: boolean;
}

interface PhaseLayerProps {
  phases: PhaseSpec[];
  nodes: PhaseNode[];
  /** Padding around the bounding rect, in canvas units. */
  padding?: number;
  /** Triggered when the user clicks the phase label — wire to collapse/expand UI. */
  onPhaseClick?: (phaseId: string) => void;
}

interface ComputedPhaseRect {
  spec: PhaseSpec;
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_NODE_WIDTH = 200;
const DEFAULT_NODE_HEIGHT = 100;

export function PhaseLayer({ phases, nodes, padding = 24, onPhaseClick }: PhaseLayerProps) {
  const rects = useMemo<ComputedPhaseRect[]>(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const out: ComputedPhaseRect[] = [];
    for (const phase of phases) {
      const contained = phase.nodeIds.map((nid) => byId.get(nid)).filter((n): n is PhaseNode => Boolean(n));
      if (contained.length === 0) continue;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const node of contained) {
        const w = node.width ?? DEFAULT_NODE_WIDTH;
        const h = node.height ?? DEFAULT_NODE_HEIGHT;
        if (node.position.x < minX) minX = node.position.x;
        if (node.position.y < minY) minY = node.position.y;
        if (node.position.x + w > maxX) maxX = node.position.x + w;
        if (node.position.y + h > maxY) maxY = node.position.y + h;
      }
      out.push({
        spec: phase,
        x: minX - padding,
        y: minY - padding,
        width: (maxX - minX) + padding * 2,
        height: (maxY - minY) + padding * 2,
      });
    }
    return out;
  }, [phases, nodes, padding]);

  if (rects.length === 0) return null;

  return (
    <div
      // React Flow renders viewport transforms on the parent; we just sit
      // inside the same coordinate space at z-index 0 so nodes (z-index 5+)
      // render on top of our region tint.
      style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}
    >
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        {rects.map((rect) => (
          <g key={rect.spec.id}>
            <rect
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              fill={rect.spec.color}
              fillOpacity={0.08}
              stroke={rect.spec.color}
              strokeOpacity={0.35}
              strokeWidth={1}
              strokeDasharray="6 4"
              rx={12}
              ry={12}
            />
            <foreignObject
              x={rect.x + 12}
              y={rect.y + 8}
              width={Math.max(180, rect.width - 24)}
              height={24}
              style={{ overflow: 'visible' }}
            >
              <div
                onClick={() => onPhaseClick?.(rect.spec.id)}
                style={{
                  pointerEvents: 'auto',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: rect.spec.color,
                  color: 'var(--color-canvas, #0c0d10)',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: onPhaseClick ? 'pointer' : 'default',
                  userSelect: 'none',
                }}
              >
                {rect.spec.name}
              </div>
            </foreignObject>
          </g>
        ))}
      </svg>
    </div>
  );
}
