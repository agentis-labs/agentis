import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdapterType } from '@agentis/core';

const execFileAsync = promisify(execFile);

export type V1HarnessAdapterType = Extract<AdapterType, 'openclaw' | 'hermes_agent' | 'claude_code' | 'codex' | 'cursor' | 'http'>;

export interface HarnessDetectionResult {
  adapterType: V1HarnessAdapterType;
  harness: string;
  status: 'found' | 'not_found' | 'error';
  detail?: string;
  installCommand?: string;
}

export interface HarnessCheck {
  level: 'info' | 'warn' | 'error';
  message: string;
  detail?: string;
}

export interface HarnessTestResult {
  status: 'pass' | 'warn' | 'fail';
  checks: HarnessCheck[];
}

const CLI_HARNESSES: Array<{
  adapterType: Extract<V1HarnessAdapterType, 'claude_code' | 'codex' | 'cursor' | 'hermes_agent'>;
  harness: string;
  binary: string;
  installCommand: string;
}> = [
  { adapterType: 'claude_code', harness: 'Claude Code', binary: 'claude', installCommand: 'npm install -g @anthropic-ai/claude-code' },
  { adapterType: 'codex', harness: 'Codex', binary: 'codex', installCommand: 'npm install -g @openai/codex' },
  { adapterType: 'cursor', harness: 'Cursor', binary: 'cursor', installCommand: 'Install Cursor and enable the Cursor Agent CLI' },
  { adapterType: 'hermes_agent', harness: 'Hermes Agent', binary: 'hermes', installCommand: 'Install the Hermes Agent CLI' },
];

export async function detectHarnesses(env: NodeJS.ProcessEnv = process.env): Promise<HarnessDetectionResult[]> {
  const cli = await Promise.all(
    CLI_HARNESSES.map(async (item) => {
      const probe = await probeBinary(item.binary);
      return {
        adapterType: item.adapterType,
        harness: item.harness,
        status: probe.ok ? 'found' as const : probe.error ? 'error' as const : 'not_found' as const,
        detail: probe.detail,
        installCommand: item.installCommand,
      };
    }),
  );
  const gatewayUrl = firstNonEmpty(
    env.AGENTIS_OPENCLAW_GATEWAY_URL,
    env.OPENCLAW_GATEWAY_URL,
    env.OPENCLAW_GATEWAY,
  );
  return [
    ...cli,
    {
      adapterType: 'openclaw',
      harness: 'OpenClaw',
      status: gatewayUrl ? 'found' : 'not_found',
      detail: gatewayUrl ? `Gateway URL configured: ${gatewayUrl}` : undefined,
    },
  ];
}

export async function testHarnessConfig(adapterType: V1HarnessAdapterType, config: Record<string, unknown>): Promise<HarnessTestResult> {
  const checks: HarnessCheck[] = [];
  if (adapterType === 'claude_code') {
    checks.push(await binaryCheck(String(config.binaryPath || 'claude'), 'Claude Code binary'));
    return resultFromChecks(checks);
  }
  if (adapterType === 'codex') {
    checks.push(await binaryCheck(String(config.binaryPath || 'codex'), 'Codex binary'));
    return resultFromChecks(checks);
  }
  if (adapterType === 'cursor') {
    checks.push(await binaryCheck(String(config.binaryPath || 'cursor'), 'Cursor binary'));
    return resultFromChecks(checks);
  }
  if (adapterType === 'hermes_agent') {
    checks.push(await binaryCheck(String(config.binaryPath || 'hermes'), 'Hermes Agent binary'));
    return resultFromChecks(checks);
  }
  if (adapterType === 'openclaw') {
    const gatewayUrl = String(config.gatewayUrl ?? '');
    if (!gatewayUrl) {
      checks.push({ level: 'error', message: 'OpenClaw gateway URL is required' });
      return resultFromChecks(checks);
    }
    const parsed = parseUrl(gatewayUrl);
    if (!parsed || (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')) {
      checks.push({ level: 'error', message: 'OpenClaw gateway URL must use ws:// or wss://', detail: gatewayUrl });
      return resultFromChecks(checks);
    }
    checks.push({ level: 'info', message: 'OpenClaw gateway URL is valid', detail: gatewayUrl });
    checks.push(await websocketCheck(gatewayUrl, openClawHeaders(config)));
    return resultFromChecks(checks);
  }
  const url = httpHealthUrl(config);
  if (!url) {
    checks.push({ level: 'error', message: 'HTTP base URL is required' });
    return resultFromChecks(checks);
  }
  checks.push(await httpCheck(url));
  return resultFromChecks(checks);
}

async function binaryCheck(binary: string, label: string): Promise<HarnessCheck> {
  const probe = await probeBinary(binary);
  if (probe.ok) return { level: 'info', message: `${label} found`, detail: probe.detail };
  return { level: 'error', message: `${label} not found`, detail: probe.detail };
}

async function probeBinary(binary: string): Promise<{ ok: boolean; detail?: string; error?: boolean }> {
  const version = await runProbe(binary, ['--version']);
  if (version.ok) return version;
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const located = await runProbe(locator, [binary]);
  if (located.ok) return located;
  return { ok: false, detail: firstNonEmpty(version.detail, located.detail), error: version.error && located.error };
}

async function runProbe(command: string, args: string[]): Promise<{ ok: boolean; detail?: string; error?: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 2000, windowsHide: true });
    return { ok: true, detail: firstLine(stdout || stderr) };
  } catch (err) {
    const error = err as { code?: string | number; signal?: string; stdout?: string; stderr?: string; message?: string };
    const missing = error.code === 'ENOENT' || error.code === 1;
    return {
      ok: false,
      error: !missing,
      detail: firstLine(error.stdout || error.stderr || error.message),
    };
  }
}

async function httpCheck(url: string): Promise<HarnessCheck> {
  const parsed = parseUrl(url);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return { level: 'error', message: 'HTTP URL must use http:// or https://', detail: url };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  timeout.unref?.();
  try {
    let response = await fetch(parsed, { method: 'HEAD', signal: controller.signal });
    if (response.status === 405) response = await fetch(parsed, { method: 'GET', signal: controller.signal });
    const level = response.ok || response.status === 401 ? 'info' : 'warn';
    return { level, message: 'HTTP endpoint reachable', detail: `${response.status} ${response.statusText}` };
  } catch (err) {
    return { level: 'error', message: 'HTTP endpoint unreachable', detail: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

async function websocketCheck(url: string, headers?: Record<string, string>): Promise<HarnessCheck> {
  const WebSocketCtor = await resolveWebSocketCtor();
  if (!WebSocketCtor) {
    return { level: 'warn', message: 'WebSocket runtime unavailable for live handshake' };
  }
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ level: 'error', message: 'OpenClaw gateway connection timed out' });
    }, 3000);
    timeout.unref?.();
    let socket: WebSocketLike;
    try {
      socket = new WebSocketCtor(url, undefined, headers && Object.keys(headers).length > 0 ? { headers } : undefined);
    } catch (err) {
      clearTimeout(timeout);
      resolve({ level: 'error', message: 'OpenClaw gateway connection failed', detail: (err as Error).message });
      return;
    }
    const cleanup = () => {
      clearTimeout(timeout);
      try { socket.close(); } catch {}
    };
    bindWebSocket(socket, 'open', () => {
      setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ level: 'info', message: 'OpenClaw gateway reachable' });
      }, 250).unref?.();
    });
    bindWebSocket(socket, 'message', (raw) => {
      const message = parseSocketMessage(raw);
      if (message?.kind !== 'connect.challenge') return;
      try {
        socket.send(JSON.stringify({ kind: 'req.connect', clientId: 'agentis-probe', role: 'operator', scopes: ['agent:request'], challenge: message.challenge }));
      } catch {}
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ level: 'info', message: 'OpenClaw gateway challenge received' });
    });
    bindWebSocket(socket, 'error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ level: 'error', message: 'OpenClaw gateway connection failed', detail: err instanceof Error ? err.message : String(err) });
    });
  });
}

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
};

type WebSocketCtor = new (url: string, protocols?: string | string[], options?: { headers?: Record<string, string> }) => WebSocketLike;

async function resolveWebSocketCtor(): Promise<WebSocketCtor | null> {
  const globalCtor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (globalCtor) return globalCtor;
  try {
    const mod = (await import('ws' as string)) as { WebSocket?: WebSocketCtor; default?: WebSocketCtor };
    return mod.WebSocket ?? mod.default ?? null;
  } catch {
    return null;
  }
}

function bindWebSocket(socket: WebSocketLike, event: string, handler: (...args: unknown[]) => void) {
  if (socket.addEventListener) socket.addEventListener(event, (...args) => handler(...args));
  else socket.on?.(event, (...args) => handler(...args));
}

function httpHealthUrl(config: Record<string, unknown>): string | null {
  const dispatchUrl = stringOf(config.dispatchUrl);
  if (dispatchUrl) return dispatchUrl;
  const baseUrl = stringOf(config.baseUrl);
  if (!baseUrl) return null;
  const healthPath = stringOf(config.healthPath);
  if (healthPath) return joinUrl(baseUrl, healthPath);
  return baseUrl;
}

function openClawHeaders(config: Record<string, unknown>): Record<string, string> | undefined {
  const headers = recordStringOf(config.headers) ?? {};
  const authToken = stringOf(config.authToken);
  const password = stringOf(config.password);
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
    headers['x-openclaw-token'] = authToken;
  }
  if (password) headers['x-openclaw-password'] = password;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function joinUrl(baseUrl: string, path: string): string {
  if (!path) return baseUrl;
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function resultFromChecks(checks: HarnessCheck[]): HarnessTestResult {
  const status = checks.some((check) => check.level === 'error')
    ? 'fail'
    : checks.some((check) => check.level === 'warn')
      ? 'warn'
      : 'pass';
  return { status, checks };
}

function firstLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 240);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function recordStringOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseSocketMessage(raw: unknown): Record<string, unknown> | null {
  const text = typeof raw === 'string'
    ? raw
    : raw instanceof Buffer
      ? raw.toString('utf8')
      : typeof MessageEvent !== 'undefined' && raw instanceof MessageEvent && typeof raw.data === 'string'
        ? raw.data
        : null;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
