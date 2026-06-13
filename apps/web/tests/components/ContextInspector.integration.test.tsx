import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ContextInspector } from '../../src/components/canvas/ContextInspector';

const integrations = [
  {
    id: 'slack',
    service: 'slack',
    name: 'Slack',
    category: 'Communication',
    description: 'Post messages and reactions to Slack workspaces.',
    operations: ['send_message', 'add_reaction'],
    credentialSchema: { type: 'bearer_token', fields: ['token'] },
    runtime: 'implemented',
    builtin: true,
  },
  {
    id: 'github',
    service: 'github',
    name: 'GitHub',
    category: 'Code',
    description: 'Create issues and comments.',
    operations: ['create_issue', 'comment_issue'],
    credentialSchema: { type: 'bearer_token', fields: ['token'] },
    runtime: 'implemented',
    builtin: true,
  },
  {
    id: 'rss_feed',
    service: 'rss_feed',
    name: 'RSS Feed',
    category: 'Web',
    description: 'Fetch and parse feeds.',
    operations: ['fetch_feed'],
    credentialSchema: { type: 'none', fields: [] },
    runtime: 'manifest_only',
    builtin: true,
  },
  {
    id: 'twilio',
    service: 'twilio',
    name: 'Twilio',
    category: 'SMS & Voice',
    description: 'Send SMS messages.',
    operations: ['send_sms'],
    credentialSchema: { type: 'api_key', fields: ['accountSid', 'authToken'] },
    runtime: 'manifest_only',
    builtin: true,
  },
];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('<ContextInspector /> integration form', () => {
  it('loads manifests and writes integrationId plus operationId from the picker', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = String(input);
      if (path === '/v1/integrations') return json({ integrations });
      if (path === '/v1/credentials') return json({ credentials: [] });
      if (path === '/v1/oauth/providers') return json({ providers: [] });
      return json({});
    });
    const onSave = vi.fn();
    const user = userEvent.setup();

    render(
      <ContextInspector
        selection={{
          kind: 'node',
          nodeId: 'node-1',
          nodeType: 'integration',
          data: { kind: 'integration', integrationId: 'slack', operationId: 'send_message', inputs: {} },
        }}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    expect(await screen.findByText('Integration library')).toBeInTheDocument();
    expect(screen.getByText('Post messages and reactions to Slack workspaces.')).toBeInTheDocument();

    await user.click(screen.getAllByText('GitHub')[0]!);
    expect(screen.getByRole('combobox')).toHaveValue('create_issue');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      integrationId: 'github',
      operationId: 'create_issue',
    }));
  });

  it('creates an inline credential through the vault API and binds it to the node', async () => {
    let postedCredential: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === '/v1/integrations') return json({ integrations });
      if (path === '/v1/oauth/providers') return json({ providers: [] });
      if (path === '/v1/credentials' && init?.method === 'POST') {
        postedCredential = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ id: 'cred-slack', name: postedCredential.name, credentialType: postedCredential.credentialType }, 201);
      }
      if (path === '/v1/credentials') return json({ credentials: [] });
      return json({});
    });
    const onSave = vi.fn();
    const user = userEvent.setup();

    render(
      <ContextInspector
        selection={{
          kind: 'node',
          nodeId: 'node-1',
          nodeType: 'integration',
          data: { kind: 'integration', integrationId: 'slack', operationId: 'send_message', inputs: {} },
        }}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    await user.type(await screen.findByPlaceholderText('Slack Token'), 'xoxb-test');
    await user.click(screen.getByRole('button', { name: 'Save and connect' }));

    await waitFor(() => expect(postedCredential).toEqual(expect.objectContaining({
      credentialType: 'integration_slack',
      name: 'Slack (slack)',
    })));
    expect(JSON.parse(String(postedCredential!.value))).toEqual({ token: 'xoxb-test' });

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 'cred-slack' }));
  });

  it('creates multi-field inline credentials from the manifest schema', async () => {
    let postedCredential: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === '/v1/integrations') return json({ integrations });
      if (path === '/v1/oauth/providers') return json({ providers: [] });
      if (path === '/v1/credentials' && init?.method === 'POST') {
        postedCredential = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ id: 'cred-twilio', name: postedCredential.name, credentialType: postedCredential.credentialType }, 201);
      }
      if (path === '/v1/credentials') return json({ credentials: [] });
      return json({});
    });
    const user = userEvent.setup();

    render(
      <ContextInspector
        selection={{
          kind: 'node',
          nodeId: 'node-1',
          nodeType: 'integration',
          data: { kind: 'integration', integrationId: 'twilio', operationId: 'send_sms', inputs: {} },
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    await user.type(await screen.findByPlaceholderText('Twilio Account Sid'), 'AC123');
    await user.type(await screen.findByPlaceholderText('Twilio Auth Token'), 'tw-secret');
    await user.click(screen.getByRole('button', { name: 'Save and connect' }));

    await waitFor(() => expect(postedCredential).toBeTruthy());
    expect(JSON.parse(String(postedCredential!.value))).toEqual({
      accountSid: 'AC123',
      authToken: 'tw-secret',
    });
  });
});
