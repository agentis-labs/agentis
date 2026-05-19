import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppDetailPage } from '../../src/pages/AppDetailPage';

vi.mock('../../src/components/apps/AppDispatchSurface', () => ({
  AppDispatchSurface: () => <div>mock morning office surface</div>,
}));

vi.mock('../../src/components/app-graph/AppCanvasView', () => ({
  AppCanvasView: () => <div>mock app canvas</div>,
}));

vi.mock('../../src/components/brain/BrainView', () => ({
  BrainView: () => <div>mock brain</div>,
}));

vi.mock('../../src/components/brain/BrainManageView', () => ({
  BrainManageView: () => <div>mock brain manage</div>,
}));

vi.mock('../../src/components/app-detail/DataView', () => ({
  DataView: () => <div>mock data</div>,
}));

vi.mock('../../src/components/app-detail/DeployView', () => ({
  DeployView: () => <div>mock deploy</div>,
}));

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPage(path = '/apps/social-listening') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/apps/:slug" element={<AppDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('<AppDetailPage /> app surface shell', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith('/v1/apps/social-listening/results')) {
        return jsonResponse({
          window: '7d',
          successRate: 0,
          runCount: 0,
          totalCost: 0,
          avgCostPerRun: 0,
          avgDurationMs: 0,
          metrics: [],
          pendingApprovals: [],
          recentRuns: [],
          costByAgent: [],
          trend: { previousTotalCost: 0, previousSpendCents: 0, deltaPct: 0, direction: 'flat' },
          budget: { currentSpendCents: 0, status: 'ok' },
        });
      }
      if (path === '/v1/spaces') return jsonResponse({ spaces: [] });
      if (path === '/v1/apps/social-listening') {
        return jsonResponse({
          app: {
            id: 'app-1',
            slug: 'social-listening',
            name: 'Social Listening',
            status: 'active',
            version: '1.0.0',
            entryWorkflowId: 'workflow-1',
            workflows: [],
            agents: [],
            triggers: [],
            credentialSlots: [],
            datasetStatuses: [],
            outputLabels: [],
            spendSummary: { totalCost30d: 0, avgCostPerRun30d: 0, runCount30d: 0 },
          },
        });
      }
      return jsonResponse({});
    }));
  });

  it('renders the rebuilt Surface without the old internal tab row', async () => {
    renderPage();

    await screen.findByText('mock morning office surface');
    expect(screen.queryByRole('tab', { name: 'Results' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Performance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Activity' })).not.toBeInTheDocument();
  });

  it('routes legacy performance query into config performance', async () => {
    renderPage('/apps/social-listening?tab=performance');

    await waitFor(() => expect(screen.getByText('Cost, reliability, run history, and agent spend for this app.')).toBeInTheDocument());
    expect(screen.getAllByText('Performance').length).toBeGreaterThan(0);
  });
});
