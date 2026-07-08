import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SelfHealConsole } from '../../src/components/canvas/SelfHealConsole';
import type { WorkspaceSelfHealIncident } from '../../src/lib/workspaceData';
import type { RealtimeActivity } from '../../src/lib/realtimeActivity';

function incident(patch: Partial<WorkspaceSelfHealIncident> = {}): WorkspaceSelfHealIncident {
  return {
    nodeId: 'node-draft',
    nodeTitle: 'Draft digest',
    status: 'DIAGNOSING',
    mode: 'guarded',
    attempt: 1,
    maxAttempts: 2,
    startedAt: '2026-06-19T12:00:00.000Z',
    updatedAt: '2026-06-19T12:00:01.000Z',
    ...patch,
  };
}

describe('SelfHealConsole', () => {
  it('shows the live diagnosis while the agent is diagnosing', () => {
    render(<SelfHealConsole incident={incident({ status: 'DIAGNOSING', diagnosis: 'Upstream returned no items.' })} />);
    expect(screen.getByText('Diagnosing the failure')).toBeInTheDocument();
    expect(screen.getByTestId('self-heal-console')).toBeInTheDocument();
  });

  it('offers Apply fix / Dismiss when a fix awaits approval', () => {
    const onResolve = vi.fn();
    render(
      <SelfHealConsole
        incident={incident({ status: 'AWAITING_APPROVAL', approvalId: 'appr-1', diagnosis: 'Re-route around the dead source.' })}
        onResolve={onResolve}
      />,
    );
    expect(screen.getByText('Fix ready for your approval')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Apply fix/ }));
    expect(onResolve).toHaveBeenCalledWith('appr-1', 'approve');
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    expect(onResolve).toHaveBeenCalledWith('appr-1', 'reject');
  });

  it('lets the operator report to the team when blocked', () => {
    const onReport = vi.fn();
    const blocked = incident({ status: 'BLOCKED', reason: 'No safe repair could be grounded.' });
    render(<SelfHealConsole incident={blocked} onReport={onReport} />);
    expect(screen.getByText(/Couldn't safely repair/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Report to team/ }));
    expect(onReport).toHaveBeenCalledWith(blocked);
  });

  it('celebrates a successful heal', () => {
    render(<SelfHealConsole incident={incident({ status: 'APPLIED', diagnosis: 'Recovered the declared field.' })} />);
    expect(screen.getByText('Workflow self-healed')).toBeInTheDocument();
  });

  it('shows the live repair stream and a five-rung recovery ladder', () => {
    const activity: RealtimeActivity[] = [{
      id: 'repair-thought', event: 'agent.terminal.message', kind: 'message', tone: 'muted',
      title: 'Orchy', detail: 'Checked the completed digest bundle for a valid target.',
      at: '2026-06-19T12:00:02.000Z', nodeId: 'node-draft', raw: {},
    }];
    render(<SelfHealConsole incident={incident({ status: 'PLANNING' })} activity={activity} />);
    expect(screen.getByText('Live orchestration')).toBeInTheDocument();
    expect(screen.getByText('Checked the completed digest bundle for a valid target.')).toBeInTheDocument();
    expect(screen.getByText('Recovery ladder')).toBeInTheDocument();
    expect(screen.getByText('Verify')).toBeInTheDocument();
  });
});
