/**
 * McpClient — Agentis as an MCP *consumer* (UNIVERSAL-HARNESS §5, Pillar 5).
 *
 * Connects to an external MCP server over the Streamable-HTTP transport (a
 * single endpoint that accepts JSON-RPC 2.0 over HTTP POST) and exposes the
 * three operations Agentis needs: handshake (`initialize`), discovery
 * (`tools/list`), and invocation (`tools/call`). This is the consume half that
 * complements the provide half in `routes/mcp.ts` — together they make Agentis
 * bilateral on MCP.
 *
 * The client is deliberately transport-thin: it owns no persistence and no
 * registry. Server configs live in `workspace_kv` (see `routes/mcpServers.ts`),
 * and discovered tools are surfaced on demand rather than mirrored into the
 * global tool registry (which is workspace-agnostic — external servers are
 * per-workspace, so mirroring them there would leak across workspaces).
 *
 * Every outbound URL passes the SSRF guard before a request is made.
 */

import { AgentisError } from '@agentis/core';
import { assertSafeUrl } from './safeUrl.js';

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  /** MCP `content` blocks (text/json/etc.). */
  content: unknown;
  isError: boolean;
}

export interface McpClientOptions {
  /** Allow loopback/private targets (tests, self-hosted servers on a LAN). */
  allowPrivateNetwork?: boolean;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #opts: McpClientOptions;
  #rpcId = 0;
  // Streamable-HTTP session state (spec §Session Management): a server MAY
  // return an `Mcp-Session-Id` on the initialize response; if it does, every
  // later request MUST carry it or the server 400s. We establish the session
  // (initialize → initialized notification) once, lazily, before any op.
  #sessionId: string | null = null;
  #negotiatedVersion = PROTOCOL_VERSION;
  #initialized = false;

  constructor(url: string, headers: Record<string, string> = {}, opts: McpClientOptions = {}) {
    this.#url = url;
    this.#headers = headers;
    this.#opts = opts;
  }

  /** Handshake. Returns the server's advertised info/capabilities. */
  async initialize(): Promise<{ serverInfo?: { name?: string; version?: string }; capabilities?: unknown }> {
    await this.#ensureSession();
    return this.#lastInitResult;
  }

  /** Discover the server's tools. */
  async listTools(): Promise<McpToolDescriptor[]> {
    await this.#ensureSession();
    const result = (await this.#rpc('tools/list', {})) as { tools?: McpToolDescriptor[] } | null;
    return Array.isArray(result?.tools) ? result!.tools : [];
  }

  /** Invoke a tool by name. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.#ensureSession();
    const result = (await this.#rpc('tools/call', { name, arguments: args })) as
      | { content?: unknown; isError?: boolean }
      | null;
    return { content: result?.content ?? null, isError: Boolean(result?.isError) };
  }

  #lastInitResult: { serverInfo?: { name?: string; version?: string }; capabilities?: unknown } = {};

  /**
   * Establish a session once: POST `initialize` (capturing `Mcp-Session-Id` and
   * the negotiated protocol version from the response), then send the
   * `notifications/initialized` notification. Idempotent per client instance.
   */
  async #ensureSession(): Promise<void> {
    if (this.#initialized) return;
    const { payload, response } = await this.#send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'agentis', version: '1.0.0' },
    }, /*isNotification*/ false, /*includeSession*/ false);
    this.#throwOnRpcError('initialize', payload);
    const sid = response.headers.get('mcp-session-id');
    if (sid) this.#sessionId = sid;
    const result = (payload as { result?: { protocolVersion?: string; serverInfo?: unknown; capabilities?: unknown } } | null)?.result;
    if (result?.protocolVersion) this.#negotiatedVersion = result.protocolVersion;
    this.#lastInitResult = { serverInfo: result?.serverInfo as { name?: string } | undefined, capabilities: result?.capabilities };
    this.#initialized = true;
    // Notify the server we're ready (required by many servers before tools/*).
    await this.#send('notifications/initialized', {}, /*isNotification*/ true, /*includeSession*/ true).catch(() => {});
  }

  async #rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const { payload } = await this.#send(method, params, false, true);
    this.#throwOnRpcError(method, payload);
    return (payload as { result?: unknown } | null)?.result ?? null;
  }

  #throwOnRpcError(method: string, payload: { error?: unknown } | null): void {
    if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
      const e = payload.error as { code?: number; message?: string };
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `MCP ${method} error ${e.code ?? ''}: ${e.message ?? 'unknown'}`);
    }
  }

  /** One HTTP POST to the MCP endpoint, carrying session + protocol-version headers. */
  async #send(
    method: string,
    params: Record<string, unknown>,
    isNotification: boolean,
    includeSession: boolean,
  ): Promise<{ payload: { result?: unknown; error?: unknown } | null; response: Response }> {
    const url = await assertSafeUrl(this.#url, { allowPrivate: this.#opts.allowPrivateNetwork ?? false });
    const fetchImpl = this.#opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      // Required on every request after init (missing/invalid → 400).
      'mcp-protocol-version': this.#negotiatedVersion,
      ...this.#headers,
    };
    if (includeSession && this.#sessionId) headers['mcp-session-id'] = this.#sessionId;
    // A notification has no `id`; a request does.
    const message = isNotification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: ++this.#rpcId, method, params };
    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(message), signal: controller.signal });
    } catch (err) {
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `MCP request to ${this.#url} failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    // A notification's happy path is 202 Accepted with no body.
    if (isNotification) return { payload: null, response };
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `MCP server returned ${response.status} for ${method}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
    }
    return { payload: await this.#readBody(response), response };
  }

  /** Read either a JSON body or the first data frame of an SSE stream. */
  async #readBody(response: Response): Promise<{ result?: unknown; error?: unknown } | null> {
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (contentType.includes('text/event-stream')) {
      // Grab the first `data:` line that parses as a JSON-RPC envelope.
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.startsWith('data:') ? line.slice(5).trim() : '';
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') return parsed;
        } catch { /* keep scanning */ }
      }
      return null;
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', 'MCP server returned a non-JSON body');
    }
  }
}
