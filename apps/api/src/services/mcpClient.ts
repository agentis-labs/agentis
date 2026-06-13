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

  constructor(url: string, headers: Record<string, string> = {}, opts: McpClientOptions = {}) {
    this.#url = url;
    this.#headers = headers;
    this.#opts = opts;
  }

  /** Handshake. Returns the server's advertised info/capabilities. */
  async initialize(): Promise<{ serverInfo?: { name?: string; version?: string }; capabilities?: unknown }> {
    return this.#rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'agentis', version: '1.0.0' },
    }) as Promise<{ serverInfo?: { name?: string; version?: string }; capabilities?: unknown }>;
  }

  /** Discover the server's tools. */
  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.#rpc('tools/list', {})) as { tools?: McpToolDescriptor[] } | null;
    return Array.isArray(result?.tools) ? result!.tools : [];
  }

  /** Invoke a tool by name. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.#rpc('tools/call', { name, arguments: args })) as
      | { content?: unknown; isError?: boolean }
      | null;
    return { content: result?.content ?? null, isError: Boolean(result?.isError) };
  }

  async #rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const url = await assertSafeUrl(this.#url, { allowPrivate: this.#opts.allowPrivateNetwork ?? false });
    const fetchImpl = this.#opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Streamable HTTP servers may return JSON or an SSE stream; accept both.
          accept: 'application/json, text/event-stream',
          ...this.#headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#rpcId, method, params }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `MCP request to ${this.#url} failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `MCP server returned ${response.status} for ${method}`);
    }

    const payload = await this.#readBody(response);
    if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
      const e = payload.error as { code?: number; message?: string };
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `MCP ${method} error ${e.code ?? ''}: ${e.message ?? 'unknown'}`);
    }
    return (payload as { result?: unknown } | null)?.result ?? null;
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
