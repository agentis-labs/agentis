/**
 * RunInspector — RTL component test (Batch 5 / D36).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunInspector, type RunInspectorEvent } from '../../src/components/runs/RunInspector';

function ev(over: Partial<RunInspectorEvent> = {}): RunInspectorEvent {
  return {
    id: 'e1',
    sequenceNumber: 1,
    eventType: 'run.started',
    nodeId: null,
    taskId: null,
    payload: {},
    createdAt: new Date('2026-04-28T12:00:00Z').toISOString(),
    ...over,
  };
}

describe('<RunInspector />', () => {
  it('renders the empty-ledger placeholder when given no events', () => {
    render(<RunInspector runId="00000000-aaaa-bbbb-cccc-000000000001" events={[]} />);
    expect(screen.getByText(/Ledger empty/i)).toBeInTheDocument();
    expect(screen.getByText(/0 ledger events/i)).toBeInTheDocument();
  });

  it('truncates the runId in the header to the first 8 chars', () => {
    render(<RunInspector runId="abcdef1234567890" events={[]} />);
    expect(screen.getByText('abcdef12')).toBeInTheDocument();
  });

  it('renders one row per event with sequence + eventType + nodeId', () => {
    render(
      <RunInspector
        runId="r1"
        events={[
          ev({ id: 'e1', sequenceNumber: 1, eventType: 'run.started' }),
          ev({ id: 'e2', sequenceNumber: 2, eventType: 'node.completed', nodeId: 'n42' }),
        ]}
      />,
    );
    expect(screen.getByText('run.started')).toBeInTheDocument();
    expect(screen.getByText('node.completed')).toBeInTheDocument();
    expect(screen.getByText(/node n42/i)).toBeInTheDocument();
    expect(screen.getByText(/2 ledger events/i)).toBeInTheDocument();
  });

  it('renders the JSON payload only when payload has at least one key', () => {
    render(
      <RunInspector
        runId="r1"
        events={[
          ev({ id: 'a', payload: {} }),
          ev({ id: 'b', sequenceNumber: 2, payload: { ok: true, foo: 'bar' } }),
        ]}
      />,
    );
    // Payload pre tag for the second event only.
    const pres = document.querySelectorAll('pre');
    expect(pres.length).toBe(1);
    expect(pres[0]!.textContent).toMatch(/"foo": "bar"/);
  });
});
