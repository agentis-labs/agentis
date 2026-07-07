import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type React from 'react';
import { PhaseLayer, stripPhasePrefix, derivePhaseStatus, type PhaseNode } from '../../src/components/canvas/PhaseLayer';

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useStore: <T,>(selector: (state: { transform: [number, number, number] }) => T) =>
      selector({ transform: [0, 0, 0.6] }),
  };
});

describe('PhaseLayer', () => {
  const nodes = [
    { id: 'start', position: { x: 0, y: 80 }, width: 240, height: 64, data: { pendingConfig: true } },
    { id: 'qualify', position: { x: 320, y: 80 }, width: 240, height: 64 },
    { id: 'return', position: { x: 640, y: 80 }, width: 240, height: 64, data: { liveStatus: 'completed' as const } },
    { id: 'loose', position: { x: 960, y: 80 }, width: 240, height: 64 },
  ];

  it('renders one decorative band per phase and ignores unassigned nodes', () => {
    render(
      <PhaseLayer
        phases={[
          {
            id: 'p1',
            name: 'Phase 1 - Intake',
            description: 'Receive and normalize inputs.',
            color: '#2563eb',
            nodeIds: ['start', 'qualify'],
          },
        ]}
        nodes={nodes}
      />,
    );

    // Exactly one band (the single phase); the loose/return nodes get no band.
    expect(screen.getAllByTestId('phase-band')).toHaveLength(1);
    expect(screen.getAllByTestId('phase-header')).toHaveLength(1);
    // Label shows the real name, with the "Phase 1 - " prefix stripped.
    expect(screen.getByText('Intake')).toBeInTheDocument();
    expect(screen.queryByText(/Unassigned/i)).toBeNull();
  });

  it('surfaces a setup count in the band when nodes need configuration', () => {
    render(
      <PhaseLayer
        phases={[{ id: 'p1', name: 'Intake', color: '#2563eb', nodeIds: ['start'] }]}
        nodes={nodes}
      />,
    );

    expect(screen.getByTitle(/1 node still need setup/i)).toBeInTheDocument();
  });

  it('shows the finished ✓ once every node in the phase completed (the missing icon)', () => {
    render(
      <PhaseLayer
        phases={[{ id: 'p1', name: 'Curation', color: '#059669', nodeIds: ['c1', 'c2'] }]}
        nodes={[
          { id: 'c1', position: { x: 0, y: 80 }, width: 240, height: 64, data: { liveStatus: 'completed' } },
          { id: 'c2', position: { x: 320, y: 80 }, width: 240, height: 64, data: { liveStatus: 'completed' } },
        ]}
      />,
    );
    expect(screen.getByTitle('Phase completed')).toBeInTheDocument();
  });

  it('keeps the readable header above the node layer without drawing a chip border', () => {
    render(
      <PhaseLayer
        phases={[{ id: 'p1', name: 'Qualification', color: '#0ea5e9', nodeIds: ['agent'] }]}
        nodes={[
          {
            id: 'agent',
            position: { x: 320, y: 80 },
            data: { kind: 'agent_task', runtimeLabel: 'Ready: Orchy' },
          },
        ]}
      />,
    );

    const header = screen.getByTestId('phase-header');
    const band = screen.getByTestId('phase-band');
    expect(header).toHaveStyle({ zIndex: '6' });
    expect(header.firstElementChild).not.toHaveClass('border');
    // Compact-card geometry: header room + card + bottom padding, and nothing
    // like the retired multi-section card heights.
    const bandHeight = Number.parseFloat(band.getAttribute('style')?.match(/height:\s*([0-9.]+)px/i)?.[1] ?? '0');
    expect(bandHeight).toBeGreaterThan(90);
    expect(bandHeight).toBeLessThan(160);
    // The header renders inside the band's reserved room above the card (node
    // top sits at y=80 in this fixture).
    const headerY = Number.parseFloat(header.getAttribute('style')?.match(/translate\([^,]+,\s*([0-9.-]+)px\)/i)?.[1] ?? '999');
    expect(headerY).toBeLessThan(80);
  });

  it('strips a numbered phase prefix from names', () => {
    expect(stripPhasePrefix('Phase 3 · Curation')).toBe('Curation');
    expect(stripPhasePrefix('Phase 4 - Seed and Validate')).toBe('Seed and Validate');
    expect(stripPhasePrefix('Finalization')).toBe('Finalization');
  });
});

describe('derivePhaseStatus (drives Live / Error / ✓ per phase)', () => {
  const node = (id: string, liveStatus?: NonNullable<PhaseNode['data']>['liveStatus'], pendingConfig?: boolean): PhaseNode => ({
    id,
    position: { x: 0, y: 0 },
    data: { ...(liveStatus ? { liveStatus } : {}), ...(pendingConfig ? { pendingConfig } : {}) },
  });

  it('is completed ONLY when every member completed', () => {
    expect(derivePhaseStatus([node('a', 'completed'), node('b', 'completed')]).status).toBe('completed');
  });
  it('is running when any member is running/retry/waiting', () => {
    expect(derivePhaseStatus([node('a', 'completed'), node('b', 'running')]).status).toBe('running');
    expect(derivePhaseStatus([node('a', 'retry')]).status).toBe('running');
    expect(derivePhaseStatus([node('a', 'waiting')]).status).toBe('running');
  });
  it('failed wins over running/completed', () => {
    expect(derivePhaseStatus([node('a', 'running'), node('b', 'failed')]).status).toBe('failed');
  });
  it('is idle (no premature ✓) until every node has reported', () => {
    expect(derivePhaseStatus([]).status).toBe('idle');
    expect(derivePhaseStatus([node('a', 'completed'), node('b')]).status).toBe('idle');
  });
  it('counts members needing config', () => {
    expect(derivePhaseStatus([node('a', undefined, true), node('b', undefined, true), node('c', 'completed')]).pending).toBe(2);
  });
});
