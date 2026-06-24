import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type React from 'react';
import { PhaseLayer, stripPhasePrefix } from '../../src/components/canvas/PhaseLayer';

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
    expect(Number.parseFloat(band.getAttribute('style')?.match(/height:\s*([0-9.]+)px/i)?.[1] ?? '0')).toBeGreaterThan(240);
    const headerY = Number.parseFloat(header.getAttribute('style')?.match(/translate\([^,]+,\s*([0-9.-]+)px\)/i)?.[1] ?? '80');
    expect(headerY).toBeLessThan(-20);
  });

  it('strips a numbered phase prefix from names', () => {
    expect(stripPhasePrefix('Phase 3 · Curation')).toBe('Curation');
    expect(stripPhasePrefix('Phase 4 - Seed and Validate')).toBe('Seed and Validate');
    expect(stripPhasePrefix('Finalization')).toBe('Finalization');
  });
});
