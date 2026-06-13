import { useMemo } from 'react';
import { ViewportPortal } from '@xyflow/react';

/**
 * PhaseLayer — colored region backgrounds that group canvas nodes into
 * logical phases. Rendered through React Flow's `ViewportPortal` so the
 * regions live in flow coordinates and pan/zoom with the nodes.
 *
 * A "phase" is a named bag of node ids with a color. The layer computes a
 * bounding rect around the contained nodes (with padding), draws a tinted
 * region + label behind the nodes. Large workflows (50+ nodes) become legible
 * because operators can read the graph as "first this phase, then that one"
 * instead of as indecipherable spaghetti.
 *
 * The shape (`WorkflowPhase`) mirrors what the Brain' layout section will
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

  // ViewportPortal renders children into the flow's transformed coordinate
  // space — so absolute positions in flow units pan/zoom with the nodes.
  // Each region is its own absolutely-positioned div behind the nodes.
  return (
    <ViewportPortal>
      {rects.map((rect) => (
        <div
          key={rect.spec.id}
          style={{
            position: 'absolute',
            transform: `translate(${rect.x}px, ${rect.y}px)`,
            width: rect.width,
            height: rect.height,
            background: rect.spec.color,
            opacity: 0.08,
            border: `1px dashed ${rect.spec.color}`,
            borderRadius: 12,
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      ))}
      {rects.map((rect) => (
        <div
          key={`${rect.spec.id}-label`}
          onClick={() => onPhaseClick?.(rect.spec.id)}
          style={{
            position: 'absolute',
            transform: `translate(${rect.x + 12}px, ${rect.y + 8}px)`,
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
            pointerEvents: onPhaseClick ? 'auto' : 'none',
            zIndex: 1,
            whiteSpace: 'nowrap',
          }}
        >
          {rect.spec.name}
        </div>
      ))}
    </ViewportPortal>
  );
}
