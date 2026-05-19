import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppCreationWizard } from '../../src/pages/AppCreationWizard';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('<AppCreationWizard />', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  it('creates an app and navigates to the API returned app path', async () => {
    let createBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/v1/apps' && init?.method === 'POST') {
        createBody = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({
          app: {
            id: 'app-1',
            slug: 'sdr-engine',
            path: '/apps/sdr-engine?layer=canvas&build=1',
          },
        }, 201);
      }
      return jsonResponse({});
    }));

    render(<AppCreationWizard />);

    await userEvent.type(screen.getByLabelText(/app name/i), 'SDR Engine');
    await userEvent.click(screen.getByRole('button', { name: /open canvas with orchestrator/i }));

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith('/apps/sdr-engine?layer=canvas&build=1');
    });
    expect(createBody).toMatchObject({
      name: 'SDR Engine',
      goal: 'Design and build SDR Engine as an Agentis agentic app.',
      creationMode: 'orchestrated_draft',
      surfaces: [{ type: 'thread' }],
    });
  });
});
