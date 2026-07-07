/**
 * AgentisEdge — RTL component test.
 *
 * The edge renderer draws orthogonal smoothstep paths (rounded staircases in
 * the gutters) instead of long diagonal beziers, and keeps the error-branch
 * styling. Rendered with explicit coordinates inside a provider so the path
 * geometry is deterministic.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Position, ReactFlowProvider } from '@xyflow/react';
import { AgentisEdge } from '../../src/components/canvas/AgentisEdge';

function renderEdge(extra: Partial<Parameters<typeof AgentisEdge>[0]> = {}) {
  return render(
    <ReactFlowProvider>
      <svg>
        <AgentisEdge
          id="e1"
          source="a"
          target="b"
          sourceX={220}
          sourceY={27}
          targetX={0}
          targetY={200}
          sourcePosition={Position.Right}
          targetPosition={Position.Left}
          {...(extra as object)}
        />
      </svg>
    </ReactFlowProvider>,
  );
}

describe('<AgentisEdge />', () => {
  it('renders an orthogonal smoothstep path (no long diagonal segments)', () => {
    const { container } = renderEdge();
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).not.toBeNull();
    const d = path!.getAttribute('d')!;
    // Smoothstep paths are built from axis-aligned line segments joined by
    // small quadratic corner curves — a bezier would start with a single C.
    expect(d).toMatch(/^M/);
    expect(d).toContain('Q');
    expect(d).not.toMatch(/C/);
  });

  it('styles error branches dashed in the danger color', () => {
    const { container } = renderEdge({ data: { type: 'error' } } as never);
    const path = container.querySelector('path.react-flow__edge-path') as SVGPathElement;
    expect(path.style.strokeDasharray).toBe('6 4');
  });
});
