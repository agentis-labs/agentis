/**
 * OnboardingStrip — RTL component test (V1-SPEC §3.2).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OnboardingStrip } from '../../src/components/OnboardingStrip';

const DISMISSED_KEY = 'agentis.onboarding.dismissed';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFleet(snap: {
  agents?: number;
  gateways?: number;
  runs?: number;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      jsonResponse({
        agents: { total: snap.agents ?? 0 },
        gateways: { total: snap.gateways ?? 0 },
        runs: { total: snap.runs ?? 0 },
      }),
    ),
  );
}

describe('<OnboardingStrip />', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders three onboarding steps when no progress made', async () => {
    stubFleet({});
    render(
      <MemoryRouter>
        <OnboardingStrip />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/Connect a Gateway/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Register an agent/i)).toBeInTheDocument();
    expect(screen.getByText(/Run a workflow/i)).toBeInTheDocument();
  });

  it('marks completed steps with a check', async () => {
    stubFleet({ gateways: 1, agents: 0, runs: 0 });
    render(
      <MemoryRouter>
        <OnboardingStrip />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/Connect a Gateway/i)).toBeInTheDocument();
    });
    // The gateway step shows a ✓ glyph; raw count step icons render the index "2" / "3".
    expect(screen.getByText('✓')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('does not render once previously dismissed', async () => {
    localStorage.setItem(DISMISSED_KEY, 'true');
    stubFleet({});
    const { container } = render(
      <MemoryRouter>
        <OnboardingStrip />
      </MemoryRouter>,
    );
    // Nothing rendered, no fetch issued.
    expect(container.textContent).toBe('');
  });

  it('persists the dismissed flag when the close button is clicked', async () => {
    stubFleet({});
    render(
      <MemoryRouter>
        <OnboardingStrip />
      </MemoryRouter>,
    );
    const button = await screen.findByRole('button', { name: /dismiss onboarding/i });
    fireEvent.click(button);
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('true');
    await waitFor(() => {
      expect(screen.queryByText(/Connect a Gateway/i)).toBeNull();
    });
  });

  it('auto-dismisses permanently when all milestones are met', async () => {
    stubFleet({ gateways: 1, agents: 1, runs: 1 });
    render(
      <MemoryRouter>
        <OnboardingStrip />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(localStorage.getItem(DISMISSED_KEY)).toBe('true');
    });
    expect(screen.queryByText(/Connect a Gateway/i)).toBeNull();
  });
});
