/**
 * AgentMail connector — agent-native email (each agent has its own inbox).
 * Verifies it's registered and that send_message resolves an inbox then sends
 * from it, with the API key as a Bearer token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIntegrationDeliveryReceipt, defaultConnectorRegistry } from '@agentis/integrations';

function mockResponse(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    url: 'https://api.agentmail.to/v0',
    headers: new Headers({ 'content-type': 'application/json' }),
    async text() { return JSON.stringify(json); },
  } as unknown as Response;
}

describe('agentMailConnector', () => {
  beforeEach(() => {
    // Skip the SSRF DNS check for the mocked external host.
    vi.stubEnv('AGENTIS_INTEGRATION_HTTP_ALLOW_PRIVATE', 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is registered as a built-in connector', () => {
    expect(defaultConnectorRegistry.has('agentmail')).toBe(true);
    expect(defaultConnectorRegistry.get('agentmail').operations).toContain('send_message');
  });

  it('auto-resolves an inbox then sends the message from it (Bearer auth)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/inboxes')) return mockResponse(200, { inbox_id: 'inbox_123', email: 'agent@agentmail.to' });
      return mockResponse(200, { message_id: 'm_1', thread_id: 't_1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await defaultConnectorRegistry.execute('agentmail', {
      operation: 'send_message',
      params: { to: 'op@acme.com', subject: 'Hi', text: 'Hello' },
      credential: { token: 'am_test_key' },
    });

    // 1) create/resolve inbox, 2) send from it
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://api.agentmail.to/v0/inboxes');
    expect(calls[1]!.url).toBe('https://api.agentmail.to/v0/inboxes/inbox_123/messages/send');
    const sentBody = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
    expect(sentBody).toMatchObject({ to: 'op@acme.com', subject: 'Hi', text: 'Hello' });
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer am_test_key');
    expect((result.body as { message_id?: string }).message_id).toBe('m_1');
  });

  it('normalizes common email aliases before sending', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/inboxes')) return mockResponse(200, { inbox_id: 'inbox_alias' });
      return mockResponse(200, { message_id: 'm_alias' });
    }));

    await defaultConnectorRegistry.execute('agentmail', {
      operation: 'send_message',
      params: { to: 'op@acme.com', subject: 'Alias subject', body: 'Alias body' },
      credential: { token: 'am_test_key' },
    });

    const sentBody = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
    expect(sentBody).toMatchObject({
      to: 'op@acme.com',
      subject: 'Alias subject',
      text: 'Alias body',
    });
  });

  it('fills missing canonical fields from parsed upstream output envelopes', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/inboxes')) return mockResponse(200, { inbox_id: 'inbox_upstream' });
      return mockResponse(200, { message_id: 'm_upstream' });
    }));

    await defaultConnectorRegistry.execute('agentmail', {
      operation: 'send_message',
      params: { to: 'op@acme.com', subject: '', body: '' },
      inputData: {
        text: [
          '```json',
          JSON.stringify({ subject: 'Upstream subject', markdownBody: 'Upstream markdown body' }),
          '```',
        ].join('\n'),
      },
      credential: { token: 'am_test_key' },
    });

    const sentBody = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
    expect(sentBody).toMatchObject({
      to: 'op@acme.com',
      subject: 'Upstream subject',
      text: 'Upstream markdown body',
    });
    expect(sentBody.html).toContain('<p>Upstream markdown body</p>');
  });

  it('fills missing canonical fields from object output envelopes', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/inboxes')) return mockResponse(200, { inbox_id: 'inbox_object' });
      return mockResponse(200, { message_id: 'm_object' });
    }));

    await defaultConnectorRegistry.execute('agentmail', {
      operation: 'send_message',
      params: { to: 'op@acme.com' },
      inputData: {
        result: { subject: 'Object subject', markdownBody: 'Object body' },
      },
      credential: { token: 'am_test_key' },
    });

    const sentBody = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
    expect(sentBody).toMatchObject({
      to: 'op@acme.com',
      subject: 'Object subject',
      text: 'Object body',
    });
    expect(sentBody.html).toContain('<p>Object body</p>');
  });

  it('honors declared markdown on generic body fields and sends safe multipart content', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/inboxes')) return mockResponse(200, { inbox_id: 'inbox_markdown' });
      return mockResponse(200, { message_id: 'm_markdown' });
    }));

    await defaultConnectorRegistry.execute('agentmail', {
      operation: 'send_message',
      params: {
        to: 'op@acme.com',
        subject: 'Digest',
        format: 'markdown',
        body: [
          '# Top stories',
          '',
          '| Story | Why it matters |',
          '| --- | --- |',
          '| [Agent release](https://example.com) | Faster execution |',
          '',
          '<script>alert("no")</script>',
        ].join('\n'),
      },
      credential: { token: 'am_test_key' },
    });

    const sentBody = JSON.parse(String(calls[1]!.init.body)) as Record<string, string>;
    expect(sentBody.text).toContain('Top stories');
    expect(sentBody.html).toContain('<table');
    expect(sentBody.html).toContain('href="https://example.com"');
    expect(sentBody.html).not.toContain('<script');
  });

  it('captures the exact normalized HTML in a presentation-safe delivery receipt', () => {
    const receipt = buildIntegrationDeliveryReceipt('agentmail', 'send_message', {
      to: 'op@acme.com',
      subject: 'Digest',
      format: 'markdown',
      body: '# Headline\n\n**Important** update',
      apiKey: 'must-not-leak',
    });

    expect(receipt).toMatchObject({
      integrationId: 'agentmail',
      operationId: 'send_message',
      recipient: 'op@acme.com',
      subject: 'Digest',
      contentType: 'html',
    });
    expect(receipt?.content).toContain('<h1>Headline</h1>');
    expect(receipt?.content).toContain('<strong>Important</strong>');
    expect(receipt).not.toHaveProperty('apiKey');
  });

  it('renders markdown as multipart/alternative for Gmail', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return mockResponse(200, { id: 'gmail_1' });
    }));

    await defaultConnectorRegistry.execute('gmail', {
      operation: 'send_email',
      params: {
        to: 'op@acme.com',
        subject: 'Digest',
        contentType: 'text/markdown',
        body: '**Important** update',
      },
      credential: { access_token: 'gmail_token' },
    });

    const request = JSON.parse(String(calls[0]!.init.body)) as { raw: string };
    const padded = request.raw.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(request.raw.length / 4) * 4, '=');
    const mime = Buffer.from(padded, 'base64').toString('utf8');
    expect(mime).toContain('Content-Type: multipart/alternative');
    expect(mime).toContain('Content-Type: text/plain; charset=utf-8');
    expect(mime).toContain('Content-Type: text/html; charset=utf-8');
    expect(mime).toContain('<strong>Important</strong> update');
  });

  it('uses an explicit inbox_id without creating one', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return mockResponse(200, { message_id: 'm_2', thread_id: 't_2' });
    }));

    await defaultConnectorRegistry.execute('agentmail', {
      operation: 'send_message',
      params: { to: 'a@b.com', subject: 'S', text: 'T', inbox_id: 'my_inbox' },
      credential: { token: 'am_test_key' },
    });

    expect(calls).toEqual(['https://api.agentmail.to/v0/inboxes/my_inbox/messages/send']);
  });

  it('falls back to the AGENTMAIL_API_KEY env when no credential is bound', async () => {
    vi.stubEnv('AGENTMAIL_API_KEY', 'am_env_key');
    const headersSeen: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      headersSeen.push(init.headers as Record<string, string>);
      if (String(_url).endsWith('/inboxes')) return mockResponse(200, { inbox_id: 'i' });
      return mockResponse(200, { message_id: 'm', thread_id: 't' });
    }));

    await defaultConnectorRegistry.execute('agentmail', {
      operation: 'send_message',
      params: { to: 'a@b.com', subject: 'S', text: 'T' },
      credential: null,
    });

    expect(headersSeen[0]!.authorization).toBe('Bearer am_env_key');
  });
});
