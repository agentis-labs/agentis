/**
 * Connector runtime — the request-building, auth-injection, and SSRF-guard
 * logic that every integration / http_request node depends on at run time.
 * This package previously shipped with no tests; these lock in the behavior
 * that a bug would otherwise turn into a security hole (SSRF) or a silently
 * malformed outbound request.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { AgentisError } from '@agentis/core';
import { executeHttpRequest } from '../src/connectors/http.js';
import { manifestHttpConnector, executeManifestOperation } from '../src/connectors/manifestHttp.js';
import type { IntegrationManifest, IntegrationOperationSpec } from '../src/types.js';

/** Capture the fetch call without hitting the network. */
function stubFetch(response?: Partial<{ status: number; body: string; contentType: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const status = response?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      url: String(url),
      headers: new Headers({ 'content-type': response?.contentType ?? 'application/json' }),
      text: async () => response?.body ?? '{"ok":true}',
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AGENTIS_INTEGRATION_HTTP_ALLOW_PRIVATE;
  delete process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE;
});

describe('executeHttpRequest — SSRF guard', () => {
  // The metadata endpoint + private ranges are the classic SSRF targets. None
  // of these should ever reach fetch.
  const blocked = [
    ['IPv4 loopback', 'http://127.0.0.1/x'],
    ['IPv4 private 10/8', 'http://10.1.2.3/x'],
    ['IPv4 private 172.16/12', 'http://172.16.5.4/x'],
    ['IPv4 private 192.168/16', 'http://192.168.0.1/x'],
    ['IPv4 link-local (cloud metadata 169.254.169.254)', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv4 carrier-grade NAT 100.64/10', 'http://100.64.0.1/x'],
    ['IPv4 "this network" 0.0.0.0/8', 'http://0.0.0.0/x'],
    ['IPv6 loopback', 'http://[::1]/x'],
    ['IPv6 unique-local fc00::/7', 'http://[fd00::1]/x'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/x'],
  ] as const;

  for (const [label, url] of blocked) {
    it(`blocks ${label} before issuing a request`, async () => {
      const { fetchMock } = stubFetch();
      await expect(executeHttpRequest({ url })).rejects.toMatchObject({ code: 'EXTENSION_SSRF_BLOCKED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('rejects non-http(s) protocols', async () => {
    stubFetch();
    await expect(executeHttpRequest({ url: 'file:///etc/passwd' })).rejects.toThrow(/http and https/i);
    await expect(executeHttpRequest({ url: 'ftp://1.1.1.1/x' })).rejects.toThrow(/http and https/i);
  });

  it('allows a public IP literal and forwards method/query/headers', async () => {
    const { calls } = stubFetch();
    const res = await executeHttpRequest({
      url: 'https://1.1.1.1/path',
      method: 'post',
      query: { a: '1', b: '2' },
      headers: { 'X-Test': 'yes' },
      body: { hello: 'world' },
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://1.1.1.1/path?a=1&b=2');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-test']).toBe('yes');
    expect(headers['content-type']).toBe('application/json');
    expect(calls[0]!.init.body).toBe('{"hello":"world"}');
  });

  it('honors the private-network escape hatch when explicitly enabled', async () => {
    process.env.AGENTIS_INTEGRATION_HTTP_ALLOW_PRIVATE = 'true';
    const { fetchMock } = stubFetch();
    const res = await executeHttpRequest({ url: 'http://127.0.0.1/ok' });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('surfaces a non-2xx response as INTEGRATION_OPERATION_FAILED by default', async () => {
    stubFetch({ status: 500, body: 'boom' });
    await expect(executeHttpRequest({ url: 'https://1.1.1.1/x' })).rejects.toMatchObject({
      code: 'INTEGRATION_OPERATION_FAILED',
    });
  });

  it('does not throw on a non-2xx when throwOnHttpError is false', async () => {
    stubFetch({ status: 404, body: '{"err":"nope"}' });
    const res = await executeHttpRequest({ url: 'https://1.1.1.1/x', throwOnHttpError: false });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });
});

describe('executeManifestOperation — templating + auth', () => {
  const spec: IntegrationOperationSpec = {
    name: 'send_message',
    method: 'POST',
    urlTemplate: 'https://1.1.1.1/v1/channels/{channelId}/messages',
    headers: { 'X-Trace': '{params.traceId}' },
    query: { dry: '{params.dry}' },
    bodyTemplate: { text: '{text}', meta: { from: '{credential.botName}' } },
    responseMode: 'json',
  };
  const manifest = (auth?: IntegrationManifest['auth']): IntegrationManifest => ({
    service: 'demo',
    name: 'Demo',
    version: '1.0.0',
    category: 'Test',
    description: '',
    operations: ['send_message'],
    operationSpecs: [spec],
    auth,
    credentialSchema: {},
    nodeConfig: { kind: 'integration', service: 'demo', operation: 'send_message' },
    builtin: true,
    runtime: 'manifest_only',
  });

  it('renders url/header/query/body templates from params, credential, and input scopes', async () => {
    const { calls } = stubFetch();
    await executeManifestOperation({
      manifest: manifest({ type: 'bearer' }),
      spec,
      params: { channelId: 'C9', traceId: 'tr-1', dry: 'no', text: 'hi there' },
      credential: { access_token: 'tok-abc', botName: 'Helper' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://1.1.1.1/v1/channels/C9/messages?dry=no');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-trace']).toBe('tr-1');
    expect(headers.authorization).toBe('Bearer tok-abc');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ text: 'hi there', meta: { from: 'Helper' } });
  });

  it('injects an api_key into the configured header', async () => {
    const { calls } = stubFetch();
    await executeManifestOperation({
      manifest: manifest({ type: 'api_key', headerName: 'X-Api-Key' }),
      spec,
      params: { channelId: 'C1', traceId: 't', dry: 'no', text: 'x' },
      credential: { apiKey: 'secret-key', botName: 'B' },
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('secret-key');
    expect(headers.authorization).toBeUndefined();
  });

  it('injects an api_key into the configured query param', async () => {
    const { calls } = stubFetch();
    await executeManifestOperation({
      manifest: manifest({ type: 'api_key', queryParamName: 'api_key' }),
      spec,
      params: { channelId: 'C1', traceId: 't', dry: 'no', text: 'x' },
      credential: { apiKey: 'qkey', botName: 'B' },
    });
    expect(calls[0]!.url).toContain('api_key=qkey');
  });

  it('builds a Basic auth header from username/password', async () => {
    const { calls } = stubFetch();
    await executeManifestOperation({
      manifest: manifest({ type: 'basic' }),
      spec,
      params: { channelId: 'C1', traceId: 't', dry: 'no', text: 'x' },
      credential: { username: 'u', password: 'p', botName: 'B' },
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('throws INTEGRATION_CREDENTIAL_MISSING when an authed op has no credential', async () => {
    stubFetch();
    await expect(
      executeManifestOperation({
        manifest: manifest({ type: 'bearer' }),
        spec,
        params: { channelId: 'C1', traceId: 't', dry: 'no', text: 'x' },
        credential: null,
      }),
    ).rejects.toMatchObject({ code: 'INTEGRATION_CREDENTIAL_MISSING' });
  });

  it('throws VALIDATION_FAILED when a required template param is missing', async () => {
    stubFetch();
    await expect(
      executeManifestOperation({
        manifest: manifest({ type: 'none' }),
        spec,
        params: { traceId: 't', dry: 'no', text: 'x' }, // no channelId
        credential: { botName: 'B' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('manifestHttpConnector — operation contract derivation', () => {
  it('derives required params from url/body templates and the param schema', () => {
    const spec: IntegrationOperationSpec = {
      name: 'create_issue',
      method: 'POST',
      urlTemplate: 'https://api.example.com/repos/{repo}/issues',
      bodyTemplate: { title: '{title}', body: '{body}' },
      paramSchema: { required: ['repo', 'title'] },
    };
    const manifest: IntegrationManifest = {
      service: 'gh',
      name: 'GH',
      version: '1.0.0',
      category: 'Dev',
      description: '',
      operations: ['create_issue'],
      operationSpecs: [spec],
      credentialSchema: {},
      nodeConfig: { kind: 'integration', service: 'gh', operation: 'create_issue' },
      builtin: true,
      runtime: 'manifest_only',
    };
    const contract = manifestHttpConnector(manifest).operationContracts?.create_issue;
    expect(contract).toBeDefined();
    expect(new Set(contract!.required)).toEqual(new Set(['repo', 'title', 'body']));
    // `body`-ish fields get content aliases so loose synthesis still maps.
    expect(contract!.aliases?.body).toContain('text');
  });

  it('treats credential/input template refs as non-required params', () => {
    const spec: IntegrationOperationSpec = {
      name: 'op',
      method: 'GET',
      urlTemplate: 'https://api.example.com/{params.id}?t={credential.token}&i={input.foo}',
    };
    const manifest: IntegrationManifest = {
      service: 's', name: 'S', version: '1.0.0', category: 'C', description: '',
      operations: ['op'], operationSpecs: [spec], credentialSchema: {},
      nodeConfig: { kind: 'integration', service: 's', operation: 'op' }, builtin: true, runtime: 'manifest_only',
    };
    const contract = manifestHttpConnector(manifest).operationContracts?.op;
    // Only `id` (params scope) is required — credential/input refs don't gate.
    expect(contract!.required).toEqual(['id']);
  });
});
