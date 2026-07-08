/**
 * Templated HTTP connectors (n8n-inspired plan §1.3): a `manifest_only` service
 * with a bound credential must actually reach its real API — rendering the URL,
 * auth header, and JSON body from the node's params — instead of falling through
 * to the generic connector and erroring on a missing `params.url`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConnectorRegistry } from '@agentis/integrations';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let captured: CapturedRequest | undefined;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  captured = undefined;
  // SSRF guard does a DNS lookup on real hosts; allow-private short-circuits it.
  process.env.AGENTIS_INTEGRATION_HTTP_ALLOW_PRIVATE = 'true';
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    captured = {
      url: String(input),
      method: String(init?.method ?? 'GET'),
      headers,
      body: typeof init?.body === 'string' ? parseCapturedBody(init.body) : init?.body,
    };
    return new Response(JSON.stringify({ id: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});

function parseCapturedBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AGENTIS_INTEGRATION_HTTP_ALLOW_PRIVATE;
});

describe('templated connectors', () => {
  it('renders Notion create_page with bearer auth + version header + passthrough body', async () => {
    const result = await defaultConnectorRegistry.execute('notion', {
      operation: 'create_page',
      params: { parent: { database_id: 'db1' }, properties: { Name: 'Hi' } },
      credential: { token: 'secret_abc' },
    });

    expect(result.ok).toBe(true);
    expect(captured?.method).toBe('POST');
    expect(captured?.url).toBe('https://api.notion.com/v1/pages');
    expect(captured?.headers.authorization).toBe('Bearer secret_abc');
    expect(captured?.headers['notion-version']).toBe('2022-06-28');
    expect(captured?.body).toEqual({ parent: { database_id: 'db1' }, properties: { Name: 'Hi' } });
  });

  it('fills path params (and removes them from the body) for Notion update_page', async () => {
    await defaultConnectorRegistry.execute('notion', {
      operation: 'update_page',
      params: { pageId: 'page_123', properties: { Status: 'Done' } },
      credential: { token: 't' },
    });
    expect(captured?.method).toBe('PATCH');
    expect(captured?.url).toBe('https://api.notion.com/v1/pages/page_123');
    expect(captured?.body).toEqual({ properties: { Status: 'Done' } });
  });

  it('uses a custom auth header for Anthropic messages', async () => {
    await defaultConnectorRegistry.execute('anthropic', {
      operation: 'messages',
      params: { model: 'claude', messages: [] },
      credential: { apiKey: 'sk-ant' },
    });
    expect(captured?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(captured?.headers['x-api-key']).toBe('sk-ant');
    expect(captured?.headers['anthropic-version']).toBe('2023-06-01');
    expect(captured?.headers.authorization).toBeUndefined();
  });

  it('applies the "Bot " prefix for Discord', async () => {
    await defaultConnectorRegistry.execute('discord', {
      operation: 'send_message',
      params: { channelId: '42', content: 'hello' },
      credential: { token: 'tok' },
    });
    expect(captured?.url).toBe('https://discord.com/api/v10/channels/42/messages');
    expect(captured?.headers.authorization).toBe('Bot tok');
    expect(captured?.body).toEqual({ content: 'hello' });
  });

  it('templates per-tenant base URLs (Shopify) and forwards GET params as query', async () => {
    await defaultConnectorRegistry.execute('airtable', {
      operation: 'query',
      params: { baseId: 'app1', tableName: 'Tasks', maxRecords: 5 },
      credential: { token: 'key' },
    });
    expect(captured?.method).toBe('GET');
    expect(captured?.url).toBe('https://api.airtable.com/v0/app1/Tasks?maxRecords=5');
    expect(captured?.body).toBeUndefined();
  });

  it('throws a clear error when a required path param is missing', async () => {
    await expect(
      defaultConnectorRegistry.execute('notion', {
        operation: 'update_page',
        params: { properties: {} },
        credential: { token: 't' },
      }),
    ).rejects.toThrow(/pageId is required/);
  });

  it('requires a credential token', async () => {
    await expect(
      defaultConnectorRegistry.execute('notion', {
        operation: 'create_page',
        params: {},
        credential: null,
      }),
    ).rejects.toThrow(/API key or token/);
  });

  it('puts Telegram bot tokens in the provider URL', async () => {
    await defaultConnectorRegistry.execute('telegram', {
      operation: 'send_message',
      params: { chat_id: '123', text: 'hello' },
      credential: { token: 'bot-secret' },
    });
    expect(captured?.url).toBe('https://api.telegram.org/botbot-secret/sendMessage');
    expect(captured?.headers.authorization).toBeUndefined();
    expect(captured?.body).toEqual({ chat_id: '123', text: 'hello' });
  });

  it('sends Stripe write operations as form-encoded bearer requests', async () => {
    await defaultConnectorRegistry.execute('stripe', {
      operation: 'create_payment_intent',
      params: { amount: 1200, currency: 'usd', metadata: { orderId: 'ord_1' } },
      credential: { token: 'sk_test' },
    });
    expect(captured?.url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(captured?.headers.authorization).toBe('Bearer sk_test');
    expect(captured?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(captured?.body).toContain('amount=1200');
    expect(captured?.body).toContain('metadata%5BorderId%5D=ord_1');
  });

  it('builds Linear GraphQL mutations from simple params', async () => {
    await defaultConnectorRegistry.execute('linear', {
      operation: 'create_issue',
      params: { teamId: 'team_1', title: 'Bug', description: 'Fix it' },
      credential: { token: 'lin' },
    });
    expect(captured?.url).toBe('https://api.linear.app/graphql');
    expect(captured?.headers.authorization).toBe('Bearer lin');
    expect(captured?.body).toMatchObject({
      variables: { input: { teamId: 'team_1', title: 'Bug', description: 'Fix it' } },
    });
  });

  it('uses multi-field basic credentials for Twilio', async () => {
    await defaultConnectorRegistry.execute('twilio', {
      operation: 'send_sms',
      params: { To: '+15551234567', From: '+15557654321', Body: 'hello' },
      credential: { accountSid: 'AC123', authToken: 'tw-secret' },
    });
    expect(captured?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(captured?.headers.authorization).toMatch(/^Basic /);
    expect(captured?.body).toContain('Body=hello');
  });

  it('uses Supabase project URL plus apikey and bearer headers', async () => {
    await defaultConnectorRegistry.execute('supabase', {
      operation: 'select',
      params: { table: 'tasks', select: '*', limit: 10 },
      credential: { projectUrl: 'https://demo.supabase.co', apiKey: 'service-role' },
    });
    expect(captured?.url).toBe('https://demo.supabase.co/rest/v1/tasks?select=*&limit=10');
    expect(captured?.headers.apikey).toBe('service-role');
    expect(captured?.headers.authorization).toBe('Bearer service-role');
  });
});
