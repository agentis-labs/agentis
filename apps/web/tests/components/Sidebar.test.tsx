/**
 * Sidebar — RTL test locking in the e2e selector contract (AGENTIS-UX-V2 §2.3).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../../src/components/Sidebar';

function silenceFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ approvals: [], runs: [], agents: [], gateways: [], teams: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ),
  );
}

describe('<Sidebar />', () => {
  beforeEach(() => {
    silenceFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('renders title attribute on every nav link (e2e selector contract)', () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    for (const label of ['Home', 'Apps', 'Agents', 'Brain', 'Assets']) {
      const link = document.querySelector(`a[title="${label}"]`);
      expect(link, `expected an <a title="${label}"> in Sidebar`).not.toBeNull();
    }
  });

  it('does not render the legacy V1 nav entries', () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    for (const removed of [
      'Fleet',
      'Activity',
      'Workflows',
      'Issues',
      'Runs',
      'Gateways',
      'Channels',
      'Inbox',
      'History',
      'Memory',
      'Approvals',
      'Scheduler',
      'Records',
      'Library',
      'Teams',
      'Spaces',
    ]) {
      const link = document.querySelector(`a[title="${removed}"]`);
      expect(link, `did not expect <a title="${removed}"> in Sidebar`).toBeNull();
    }
  });
});
