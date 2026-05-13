import { createHmac } from 'node:crypto';
import { promises as dns } from 'node:dns';
import net from 'node:net';
import { AgentisError } from '@agentis/core';
import type { ConnectorExecuteOptions, ConnectorModule } from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const PRIVATE_V4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0a000000, 0x0affffff],
  [0xac100000, 0xac1fffff],
  [0xc0a80000, 0xc0a8ffff],
  [0x7f000000, 0x7fffffff],
  [0xa9fe0000, 0xa9feffff],
  [0x00000000, 0x00ffffff],
  [0x64400000, 0x647fffff],
  [0xe0000000, 0xefffffff],
];

export const httpRequestConnector: ConnectorModule = {
  service: 'http_request',
  operations: ['request'],
  async execute(opts) {
    return executeHttpRequest(opts.params, opts.credential, opts.timeoutMs);
  },
};

export const webhookSendConnector: ConnectorModule = {
  service: 'webhook_send',
  operations: ['send'],
  async execute(opts) {
    const headers = recordOf(opts.params.headers);
    const secret = stringValue(opts.params.secret ?? opts.credential?.webhookSecret ?? opts.credential?.secret);
    const body = opts.params.body ?? opts.inputData ?? {};
    if (secret) {
      const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
      headers['x-agentis-timestamp'] = String(Date.now());
      headers['x-agentis-delivery'] = stringValue(opts.params.deliveryId) || cryptoRandomId();
      headers['x-agentis-signature'] = createHmac('sha256', secret)
        .update(`${headers['x-agentis-timestamp']}.${rawBody}`)
        .digest('hex');
    }
    return executeHttpRequest(
      {
        ...opts.params,
        method: opts.params.method ?? 'POST',
        headers,
        body,
      },
      opts.credential,
      opts.timeoutMs,
    );
  },
};

export async function executeHttpRequest(
  params: Record<string, unknown>,
  credential: Record<string, unknown> | null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const url = await buildUrl(requiredString(params.url, 'url'), recordOf(params.query));
  const method = stringValue(params.method)?.toUpperCase() || 'GET';
  const headers = lowerHeaders(recordOf(params.headers));
  applyCredential(headers, credential);
  const responseMode = stringValue(params.responseMode) || 'auto';
  const body = requestBody(method, params.body, headers);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' });
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const text = await response.text();
    const responseBody = responseMode === 'text' ? text : parseBody(text, response.headers.get('content-type'));
    if (!response.ok && params.throwOnHttpError !== false) {
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `HTTP ${response.status} from ${url}`, {
        details: { status: response.status, statusText: response.statusText, body: responseBody },
      });
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: responseHeaders,
      body: responseBody,
    };
  } catch (error) {
    if (error instanceof AgentisError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentisError('INTEGRATION_OPERATION_FAILED', `HTTP request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export function requiredString(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!result) throw new AgentisError('VALIDATION_FAILED', `${field} is required`);
  return result;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function recordOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === undefined || raw === null) continue;
    out[key] = typeof raw === 'string' ? raw : JSON.stringify(raw);
  }
  return out;
}

export function jsonRecordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function bearerToken(credential: Record<string, unknown> | null): string {
  const token = stringValue(
    credential?.access_token ?? credential?.accessToken ?? credential?.bot_token ?? credential?.botToken ?? credential?.token ?? credential?.value,
  );
  if (!token) throw new AgentisError('INTEGRATION_CREDENTIAL_MISSING', 'connector requires a bearer token credential');
  return token;
}

async function buildUrl(rawUrl: string, query: Record<string, string>): Promise<string> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AgentisError('VALIDATION_FAILED', 'Only http and https URLs are allowed');
  }
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  await assertSafeHttpUrl(url);
  return url.toString();
}

async function assertSafeHttpUrl(url: URL): Promise<void> {
  if (integrationPrivateNetworkAllowed()) return;
  const host = url.hostname;
  const literal = net.isIP(host);
  let addresses: string[];
  if (literal === 4 || literal === 6) {
    addresses = [host];
  } else {
    try {
      const records = await dns.lookup(host, { all: true, verbatim: true });
      addresses = records.map((record) => record.address);
    } catch (err) {
      throw new AgentisError(
        'SKILL_SSRF_BLOCKED',
        `DNS resolution failed for ${host}: ${(err as Error).message}`,
      );
    }
  }
  for (const address of addresses) {
    const family = net.isIP(address);
    if (family === 4 && isPrivateIPv4(address)) {
      throw new AgentisError('SKILL_SSRF_BLOCKED', `Refusing to reach private/loopback IPv4 ${address}`);
    }
    if (family === 6 && isPrivateIPv6(address)) {
      throw new AgentisError('SKILL_SSRF_BLOCKED', `Refusing to reach private/loopback IPv6 ${address}`);
    }
  }
}

function integrationPrivateNetworkAllowed(): boolean {
  return String(
    process.env.AGENTIS_INTEGRATION_HTTP_ALLOW_PRIVATE
      ?? process.env.AGENTIS_SKILL_HTTP_ALLOW_PRIVATE
      ?? '',
  ).toLowerCase() === 'true';
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const value = Number(p);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    n = (n * 256 + value) >>> 0;
  }
  return n >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n == null) return false;
  return PRIVATE_V4_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80:')) return true;
  if (lower.startsWith('ff')) return true;
  const mapped = lower.match(/^::ffff:([\d.]+)$/u);
  return Boolean(mapped?.[1] && isPrivateIPv4(mapped[1]));
}

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

function applyCredential(headers: Record<string, string>, credential: Record<string, unknown> | null): void {
  if (!credential) return;
  const bearer = stringValue(credential.bearerToken ?? credential.access_token ?? credential.accessToken ?? credential.token);
  if (bearer && !headers.authorization) headers.authorization = `Bearer ${bearer}`;
  const apiKey = stringValue(credential.apiKey ?? credential.key ?? credential.value);
  const headerName = stringValue(credential.headerName);
  if (apiKey && headerName && !headers[headerName.toLowerCase()]) headers[headerName.toLowerCase()] = apiKey;
  const username = stringValue(credential.username);
  const password = stringValue(credential.password);
  if (username && password && !headers.authorization) {
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
}

function requestBody(method: string, body: unknown, headers: Record<string, string>): BodyInit | undefined {
  if (body === undefined || body === null || method === 'GET' || method === 'HEAD') return undefined;
  if (typeof body === 'string') return body;
  if (!headers['content-type']) headers['content-type'] = 'application/json';
  return JSON.stringify(body);
}

function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return null;
  if (contentType?.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
