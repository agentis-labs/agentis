import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdapterType } from '@agentis/core';
import { resolveCommandPath, resolveSpawnTarget, withExpandedPath } from './pathExpander.js';

const execFileAsync = promisify(execFile);

export type V1HarnessAdapterType = Extract<AdapterType, 'openclaw' | 'hermes_agent' | 'claude_code' | 'codex' | 'cursor' | 'http'>;

export interface HarnessDetectionResult {
  adapterType: V1HarnessAdapterType;
  harness: string;
  status: 'found' | 'not_found' | 'error';
  detail?: string;
  binaryPath?: string;
  detectedModel?: string;
  detectedVersion?: string;
  config?: Record<string, unknown>;
  installCommand?: string;
}

interface ProbeResult {
  ok: boolean;
  detail?: string;
  error?: boolean;
  binaryPath?: string;
  version?: string;
}

export interface HarnessCheck {
  /** Stable machine code for the check, e.g. `binary`, `auth`, `live_probe`. */
  code?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  detail?: string;
  /** Actionable, human-readable next step when the check is not a clean pass. */
  hint?: string;
}

export interface HarnessTestResult {
  status: 'pass' | 'warn' | 'fail';
  checks: HarnessCheck[];
}

export interface HarnessTestOptions {
  /**
   * When true, CLI harnesses are exercised live (the binary is actually run
   * against a tiny prompt) instead of only being probed for presence. Deep
   * tests are slow (tens of seconds) and must only run on explicit user
   * action — never on the agent-registration hot path.
   */
  deep?: boolean;
  env?: NodeJS.ProcessEnv;
}

const CLI_HARNESSES: Array<{
  adapterType: Extract<V1HarnessAdapterType, 'claude_code' | 'codex' | 'cursor' | 'hermes_agent'>;
  harness: string;
  binaries: string[];
  installCommand: string;
}> = [
  { adapterType: 'claude_code', harness: 'Claude Code', binaries: ['claude'], installCommand: 'npm install -g @anthropic-ai/claude-code' },
  { adapterType: 'codex', harness: 'Codex', binaries: ['codex'], installCommand: 'npm install -g @openai/codex' },
  { adapterType: 'cursor', harness: 'Cursor', binaries: ['agent', 'cursor-agent', 'cursor'], installCommand: 'Install Cursor and enable the Cursor Agent CLI' },
  { adapterType: 'hermes_agent', harness: 'Hermes Agent', binaries: ['hermes', 'hermes-agent'], installCommand: 'Install the Hermes Agent CLI' },
];

export async function detectHarnesses(env: NodeJS.ProcessEnv = process.env): Promise<HarnessDetectionResult[]> {
  const envWithPath = withExpandedPath(env);
  const cli = await Promise.all(
    CLI_HARNESSES.map(async (item) => {
      const probe = await probeBinaryCandidates(item.binaries, envWithPath);
      const detectedModel = detectModel(item.adapterType, probe.detail);
      return {
        adapterType: item.adapterType,
        harness: item.harness,
        status: probe.ok ? 'found' as const : probe.error ? 'error' as const : 'not_found' as const,
        detail: probe.detail,
        binaryPath: probe.binaryPath,
        detectedVersion: probe.version,
        detectedModel,
        config: probe.ok ? compactRecord({ binaryPath: probe.binaryPath, command: probe.binaryPath, model: detectedModel }) : undefined,
        installCommand: item.installCommand,
      };
    }),
  );
  const gatewayUrl = normalizeOpenClawGatewayUrl(firstNonEmpty(
    env.AGENTIS_OPENCLAW_GATEWAY_URL,
    env.OPENCLAW_GATEWAY_URL,
    env.OPENCLAW_GATEWAY,
  ));
  const httpBaseUrl = firstNonEmpty(
    env.AGENTIS_HTTP_AGENT_BASE_URL,
    env.AGENTIS_HTTP_BASE_URL,
    env.HTTP_AGENT_BASE_URL,
  );
  const httpDispatchPath = firstNonEmpty(
    env.AGENTIS_HTTP_AGENT_DISPATCH_PATH,
    env.AGENTIS_HTTP_DISPATCH_PATH,
  );
  return [
    ...cli,
    {
      adapterType: 'openclaw',
      harness: 'OpenClaw',
      status: gatewayUrl ? 'found' : 'not_found',
      detail: gatewayUrl ? `Gateway URL configured: ${gatewayUrl}` : undefined,
      config: gatewayUrl ? { gatewayUrl } : undefined,
    },
    {
      adapterType: 'http',
      harness: 'HTTP endpoint',
      status: httpBaseUrl ? 'found' : 'not_found',
      detail: httpBaseUrl ? `Base URL configured: ${httpBaseUrl}` : undefined,
      config: httpBaseUrl ? compactRecord({ baseUrl: httpBaseUrl, dispatchPath: httpDispatchPath }) : undefined,
    },
  ];
}

export async function testHarnessConfig(
  adapterType: V1HarnessAdapterType,
  config: Record<string, unknown>,
  options: HarnessTestOptions = {},
): Promise<HarnessTestResult> {
  const checks: HarnessCheck[] = [];
  const env = withExpandedPath(options.env ?? process.env);

  if (adapterType === 'claude_code') {
    const command = cliCommandFromConfig(config, 'claude');
    const binary = await binaryCheck(command, 'Claude Code binary', 'binary');
    checks.push(binary);
    checks.push(claudeAuthCheck(env));
    if (binary.level !== 'error' && options.deep) {
      checks.push(await liveProbe('claude_code', command, env));
    }
    return resultFromChecks(checks);
  }
  if (adapterType === 'codex') {
    const command = cliCommandFromConfig(config, 'codex');
    const binary = await binaryCheck(command, 'Codex binary', 'binary');
    checks.push(binary);
    checks.push(codexAuthCheck(env));
    if (binary.level !== 'error' && options.deep) {
      checks.push(await liveProbe('codex', command, env));
    }
    return resultFromChecks(checks);
  }
  if (adapterType === 'cursor') {
    checks.push(await binaryCheck(cliCommandFromConfig(config, 'agent'), 'Cursor binary', 'binary'));
    return resultFromChecks(checks);
  }
  if (adapterType === 'hermes_agent') {
    checks.push(await binaryCheck(cliCommandFromConfig(config, 'hermes'), 'Hermes Agent binary', 'binary'));
    return resultFromChecks(checks);
  }
  if (adapterType === 'openclaw') {
    const gatewayUrl = normalizeOpenClawGatewayUrl(stringOf(config.gatewayUrl) ?? '') ?? '';
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

async function binaryCheck(binary: string, label: string, code = 'binary'): Promise<HarnessCheck> {
  const probe = await probeBinary(binary, withExpandedPath());
  if (probe.ok) {
    return {
      code,
      level: 'info',
      message: probe.version ? `${label} found (v${probe.version})` : `${label} found`,
      detail: probe.detail,
    };
  }
  return {
    code,
    level: 'error',
    message: `${label} not found`,
    detail: probe.detail,
    hint: `Install the runtime, or set an explicit binary path in connection settings. (\`${binary}\` was not on PATH.)`,
  };
}

/**
 * Inspect the environment for Claude Code credentials. This is a fast,
 * env-only check — it never blocks commissioning, only surfaces *why* a live
 * run might fail. Mirrors the auth modes Claude Code supports: Bedrock,
 * Vertex, a raw API key, or an interactive `claude login` subscription.
 */
function claudeAuthCheck(env: NodeJS.ProcessEnv): HarnessCheck {
  if (isTruthyEnv(env.CLAUDE_CODE_USE_BEDROCK)) {
    return { code: 'auth', level: 'info', message: 'Auth: Amazon Bedrock', detail: 'CLAUDE_CODE_USE_BEDROCK is set.' };
  }
  if (isTruthyEnv(env.CLAUDE_CODE_USE_VERTEX)) {
    return { code: 'auth', level: 'info', message: 'Auth: Google Vertex AI', detail: 'CLAUDE_CODE_USE_VERTEX is set.' };
  }
  if (firstNonEmpty(env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN)) {
    return { code: 'auth', level: 'info', message: 'Auth: Anthropic API key', detail: 'ANTHROPIC_API_KEY is set.' };
  }
  return {
    code: 'auth',
    level: 'warn',
    message: 'No API key detected — subscription login assumed',
    detail: 'ANTHROPIC_API_KEY is not set in this environment.',
    hint: 'If the live probe fails with a login error, run `claude login` in this environment.',
  };
}

function codexAuthCheck(env: NodeJS.ProcessEnv): HarnessCheck {
  if (firstNonEmpty(env.OPENAI_API_KEY, env.CODEX_API_KEY)) {
    return { code: 'auth', level: 'info', message: 'Auth: OpenAI API key', detail: 'OPENAI_API_KEY is set.' };
  }
  return {
    code: 'auth',
    level: 'warn',
    message: 'No API key detected — subscription login assumed',
    detail: 'OPENAI_API_KEY is not set in this environment.',
    hint: 'If the live probe fails with a login error, run `codex login` in this environment.',
  };
}

/**
 * Best-in-class deep probe: actually run the CLI against a one-word prompt and
 * interpret the outcome. Distinguishes a clean pass, a login/auth failure, a
 * timeout, and unexpected output — each with an actionable hint.
 */
async function liveProbe(
  adapterType: 'claude_code' | 'codex',
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<HarnessCheck> {
  const label = adapterType === 'claude_code' ? 'Claude Code' : 'Codex';
  const args = adapterType === 'claude_code'
    ? ['--print', '--output-format=stream-json', '--verbose', '--max-turns=1']
    : ['exec', '--skip-git-repo-check', 'Respond with the single word: hello.'];
  const prompt = 'Respond with the single word: hello.';
  const cwd = process.cwd();

  try {
    const target = resolveSpawnTarget(command, args, cwd, env);
    const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(target.command, target.args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45_000);
      timer.unref?.();
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
      if (adapterType === 'claude_code') child.stdin?.end(prompt);
      else child.stdin?.end();
    });

    if (outcome.timedOut) {
      return {
        code: 'live_probe',
        level: 'warn',
        message: `${label} probe timed out`,
        detail: 'No response within 45s.',
        hint: 'The runtime is installed but slow or stuck. Try a model override or check network access.',
      };
    }

    const combined = `${outcome.stdout}\n${outcome.stderr}`.toLowerCase();
    if (/log ?in|not authenticated|unauthorized|api key|credit balance|invalid_request_error|authentication/.test(combined)) {
      return {
        code: 'live_probe',
        level: 'error',
        message: `${label} is installed but not authenticated`,
        detail: firstLine(outcome.stderr || outcome.stdout),
        hint: adapterType === 'claude_code'
          ? 'Run `claude login`, or set ANTHROPIC_API_KEY in this environment.'
          : 'Run `codex login`, or set OPENAI_API_KEY in this environment.',
      };
    }

    if (outcome.code === 0 && /hello/i.test(combined)) {
      return { code: 'live_probe', level: 'info', message: `${label} responded — runtime is live`, detail: 'Completed a one-word round-trip.' };
    }

    if (outcome.code === 0) {
      return {
        code: 'live_probe',
        level: 'warn',
        message: `${label} ran but the response was unexpected`,
        detail: firstLine(outcome.stdout || outcome.stderr),
        hint: 'The CLI works but did not echo the probe word. It should still be usable.',
      };
    }

    return {
      code: 'live_probe',
      level: 'error',
      message: `${label} exited with code ${outcome.code ?? 'unknown'}`,
      detail: firstLine(outcome.stderr || outcome.stdout),
      hint: 'Inspect the runtime CLI directly — it failed a minimal prompt.',
    };
  } catch (err) {
    return {
      code: 'live_probe',
      level: 'error',
      message: `${label} could not be launched`,
      detail: (err as Error).message,
      hint: 'Verify the binary path in connection settings.',
    };
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

async function probeBinary(binary: string, env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  const cwd = process.cwd();
  const binaryPath = resolveCommandPath(binary, cwd, env);
  const version = await runProbe(binary, ['--version'], env, cwd);

  if (version.ok || binaryPath) {
    return {
      ok: true,
      detail: firstNonEmpty(version.detail, binaryPath ?? undefined),
      binaryPath: binaryPath ?? undefined,
      version: version.ok ? parseVersion(version.detail) : undefined,
    };
  }

  return {
    ok: false,
    detail: version.detail,
    error: version.error,
  };
}

async function probeBinaryCandidates(binaries: string[], env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  let best: ProbeResult | undefined;
  for (const binary of binaries) {
    const probe = await probeBinary(binary, env);
    if (probe.ok) {
      return probe.binaryPath ? probe : { ...probe, binaryPath: binary };
    }
    if (!best || probe.error) best = probe;
  }
  return best ?? { ok: false };
}

async function runProbe(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = process.cwd()): Promise<ProbeResult> {
  try {
    const target = resolveSpawnTarget(command, args, cwd, env);
    const { stdout, stderr } = await execFileAsync(target.command, target.args, { cwd, env, timeout: 2000, windowsHide: true });
    return { ok: true, detail: firstLine(stdout || stderr) };
  } catch (err) {
    const error = err as { code?: string | number; signal?: string; stdout?: string; stderr?: string; message?: string };
    const missing = error.code === 'ENOENT' || error.code === 1;
    return {
      ok: false,
      error: !missing,
      detail: error.code === 'ENOENT'
        ? `Command not found in PATH: "${command}"`
        : firstLine(error.stdout || error.stderr || error.message),
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

function parseVersion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/(\d+\.\d+(?:\.\d+)?)/);
  return match?.[1];
}

function detectModel(adapterType: V1HarnessAdapterType, detail: string | undefined): string | undefined {
  if (!detail || adapterType === 'openclaw' || adapterType === 'http') return undefined;
  const explicit = detail.match(/default:\s*([^\)]+)/i)?.[1]?.trim();
  if (explicit) return explicit;
  return undefined;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cliCommandFromConfig(config: Record<string, unknown>, fallback: string): string {
  return stringOf(config.binaryPath) ?? stringOf(config.command) ?? fallback;
}

function recordStringOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactRecord(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeOpenClawGatewayUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    return parsed.toString();
  } catch {
    return raw;
  }
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
