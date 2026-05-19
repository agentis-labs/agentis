import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppDispatchSurface } from '../../src/components/apps/AppDispatchSurface';

vi.mock('../../src/lib/realtime', () => ({
  useRealtime: vi.fn(),
  rtSubscribe: vi.fn(() => vi.fn()),
}));

const baseApp = {
  id: 'app-1',
  slug: 'social-listening',
  name: 'Social Listening',
  entryWorkflowId: 'workflow-1',
  deployTarget: 'always_on',
  domains: [],
  dataTables: [],
  workflows: [],
  agents: [],
  triggers: [],
  datasetStatuses: [],
};

describe('<AppDispatchSurface />', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a loading skeleton, then the App Brain composer once the skeleton clears', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));

    const { container } = render(
      <MemoryRouter>
        <AppDispatchSurface
          app={baseApp}
          onManage={vi.fn()}
          onOpenCanvas={vi.fn()}
          onOpenData={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(container.querySelector('.skeleton')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(container.querySelector('.skeleton')).not.toBeInTheDocument();
    expect(screen.getByText('Continue in workspace chat →')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send instruction to Social Listening' }),
    ).toBeInTheDocument();
  });
});
