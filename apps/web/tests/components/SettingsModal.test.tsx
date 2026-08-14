import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../../src/components/settings/SettingsModal';
import { useAgentisStore, type SettingsTab } from '../../src/store/agentisStore';

function renderSettings() {
  return render(<MemoryRouter><SettingsModal /></MemoryRouter>);
}

describe('SettingsModal', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/v1/auth/me')
        ? { user: { id: 'user-1', email: 'operator@example.com', displayName: 'Operator' } }
        : url.includes('/v1/sovereignty/overview')
          ? {
              storage: { engine: 'sqlite', location: 'local', path: null, sizeBytes: 0, ownedBy: 'operator' },
              counts: { memories: 0, knowledge: 0, notes: 0, agents: 0 },
              provenance: [], recent: [], agents: [],
            }
          : url.includes('/v1/mcp-servers/catalog') ? { catalog: [] }
          : url.includes('/v1/mcp-servers') ? { servers: [] }
          : url.includes('/v1/mcp/server-card') ? { protocolVersion: '1', serverInfo: { name: 'Agentis', version: '1' }, toolCount: 0, endpoint: '/v1/mcp/rpc' }
          : url.includes('/v1/integrations') ? { integrations: [] }
          : url.includes('/v1/credentials') ? { credentials: [] }
          : url.includes('/v1/oauth/providers') ? { providers: [] }
          : url.includes('/v1/channels/identities') ? { identities: [] }
          : url.includes('/v1/channels') ? { connections: [] }
          : url.includes('/v1/gateways') ? { gateways: [] }
          : url.includes('/v1/agents') ? { agents: [] }
          : url.includes('/v1/auth/api-keys') ? { keys: [] }
          : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    useAgentisStore.setState({
      settingsOpen: false,
      settingsTab: 'profile',
      settingsDestination: 'account',
      settingsSubsection: 'profile',
    });
  });

  it.each([
    ['profile', 'account', 'profile'],
    ['data', 'account', 'data'],
    ['workspace', 'workspace', 'workspace'],
    ['budget', 'workspace', 'budget'],
    ['channels', 'connections', 'channels'],
    ['integrations', 'connections', 'integrations'],
    ['mcp', 'connections', 'mcp'],
    ['apiKeys', 'connections', 'apiKeys'],
    ['runtimes', 'advanced', 'runtimes'],
    ['governance', 'advanced', 'governance'],
  ] as const)('maps the legacy %s entry point to %s / %s', (legacy, destination, subsection) => {
    useAgentisStore.getState().setSettingsOpen(true, legacy as SettingsTab);
    expect(useAgentisStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsDestination: destination,
      settingsSubsection: subsection,
    });
  });

  it('presents five task-oriented destinations in an accessible dialog', async () => {
    useAgentisStore.getState().setSettingsOpen(true, 'account');
    renderSettings();

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toBeInTheDocument();
    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(navigation.querySelectorAll('button')).toHaveLength(5);
    expect(screen.getByRole('heading', { name: 'Account', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeInTheDocument();
  });

  it('navigates between destinations and closes with Escape', async () => {
    const user = userEvent.setup();
    useAgentisStore.getState().setSettingsOpen(true, 'account');
    renderSettings();

    await user.click(screen.getByRole('button', { name: 'Connections' }));
    expect(useAgentisStore.getState().settingsDestination).toBe('connections');
    expect(screen.getByRole('heading', { name: 'Connections', level: 1 })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('protects unsaved section edits when navigating away', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    useAgentisStore.getState().setSettingsOpen(true, 'account');
    renderSettings();

    const name = await screen.findByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'New operator');
    await user.click(screen.getByRole('button', { name: 'Connections' }));

    expect(confirm).toHaveBeenCalledWith('Discard your unsaved changes?');
    expect(useAgentisStore.getState().settingsDestination).toBe('account');
  });
});
