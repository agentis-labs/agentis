/**
 * McpToolBridge — make external MCP servers callable as agent tools
 * (Agent-capabilities 10x, Phase 2; computer-use mount = Phase 3A).
 *
 * Agentis already CONSUMES external MCP servers via `McpClient`, but their tools
 * were only reachable over REST (`/v1/mcp-servers/:id/call`) — never offered to
 * an agent's own reasoning loop. This bridge resolves the MCP servers available
 * to a workspace, lists their tools (cached), and invokes them, so the
 * in-process agent loop and the chat orchestrator can call a desktop-control /
 * browser / any MCP tool by name.
 *
 * Servers come from two places:
 *   1. Workspace-registered servers (workspace_kv `mcp:servers`).
 *   2. A built-in **computer-use** server configured via env (Phase 3A,
 *      `AGENTIS_COMPUTER_USE_MCP_URL`) — the operator opts in by pointing Agentis
 *      at a running computer-use MCP server, and every agent in the workspace can
 *      then control the desktop, the same way a native Hermes/Codex session can.
 *
 * Tool ids are namespaced `mcp__<serverSlug>__<toolName>` so they never collide
 * with the static `AgentTool` enum and are obviously bridged in logs/transcripts.
 */

import { AGENT_AFFORDANCES, type AgentAffordance } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import { McpClient, type McpToolDescriptor } from './mcpClient.js';
import { loadMcpServers, resolveMcpServerHeaders, type McpServerConfig } from './mcpServerStore.js';
import type { CredentialVault } from './credentialVault.js';

export interface BridgedToolSpec {
  /** Namespaced tool id offered to the model: `mcp__<slug>__<tool>`. */
  id: string;
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  /** The HAL affordance this server grants, when tagged (e.g. `computerUse`). */
  provides?: AgentAffordance;
  inputSchema?: Record<string, unknown>;
}

export interface BridgedCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Minimal MCP client surface the bridge depends on (injectable for tests). */
export interface McpClientLike {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown; isError: boolean }>;
}

export interface ComputerUseServerConfig {
  url: string;
  headers?: Record<string, string>;
  allowPrivateNetwork?: boolean;
}

export interface McpToolBridgeDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  /** Secrets plane: resolves a server's `credentialId` into headers at call time. */
  vault?: CredentialVault;
  /** Default outbound network policy (mirrors the engine/MCP routes). */
  allowPrivateNetwork?: boolean;
  /** Built-in computer-use MCP server (Phase 3A). When set, mounted for every workspace. */
  computerUse?: ComputerUseServerConfig;
  /** Injectable client factory (tests). */
  clientFactory?: (url: string, headers: Record<string, string>, opts: { allowPrivateNetwork?: boolean }) => McpClientLike;
  /** tools/list cache TTL per server. Default 60s. */
  cacheTtlMs?: number;
}

const BUILTIN_COMPUTER_USE_ID = 'builtin:computer-use';
const TOOL_ID_PREFIX = 'mcp__';

interface CacheEntry {
  expiresAt: number;
  specs: BridgedToolSpec[];
}

export class McpToolBridge {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #ttl: number;

  constructor(private readonly deps: McpToolBridgeDeps) {
    this.#ttl = deps.cacheTtlMs ?? 60_000;
  }

  /** True when any MCP server (registered or built-in) is available to this workspace. */
  hasServers(workspaceId: string): boolean {
    return this.#servers(workspaceId).length > 0;
  }

  /**
   * The MCP tools available to an agent in this workspace, across all resolved
   * servers. Per-server failures are logged and skipped so one unreachable
   * server never breaks the agent's loop.
   */
  async listTools(workspaceId: string): Promise<BridgedToolSpec[]> {
    const out: BridgedToolSpec[] = [];
    const usedSlugs = new Map<string, number>();
    for (const server of this.#servers(workspaceId)) {
      let specs: BridgedToolSpec[];
      try {
        specs = await this.#serverTools(workspaceId, server, usedSlugs);
      } catch (err) {
        this.deps.logger.warn('mcp_bridge.list_failed', { workspaceId, server: server.name, error: (err as Error).message });
        continue;
      }
      out.push(...specs);
    }
    return out;
  }

  /** Invoke a bridged tool by its namespaced id. */
  async call(workspaceId: string, toolId: string, args: Record<string, unknown>): Promise<BridgedCallResult> {
    const specs = await this.listTools(workspaceId);
    const spec = specs.find((s) => s.id === toolId);
    if (!spec) return { ok: false, error: `bridged MCP tool '${toolId}' is not available in this workspace` };
    const server = this.#servers(workspaceId).find((s) => s.id === spec.serverId);
    if (!server) return { ok: false, error: `MCP server for '${toolId}' is no longer configured` };
    try {
      const client = this.#client(workspaceId, server);
      const res = await client.callTool(spec.toolName, args);
      return res.isError
        ? { ok: false, error: stringify(res.content) }
        : { ok: true, result: res.content };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Resolve the servers visible to a workspace: registered + built-in computer-use. */
  #servers(workspaceId: string): McpServerConfig[] {
    const registered = loadMcpServers(this.deps.db, workspaceId);
    if (!this.deps.computerUse) return registered;
    // Don't double-mount if the operator also registered the same URL by hand.
    const already = registered.some((s) => s.url === this.deps.computerUse!.url);
    if (already) return registered;
    const builtin: McpServerConfig = {
      id: BUILTIN_COMPUTER_USE_ID,
      name: 'computer-use',
      url: this.deps.computerUse.url,
      affordance: 'computerUse',
      createdAt: '1970-01-01T00:00:00.000Z',
      ...(this.deps.computerUse.headers ? { headers: this.deps.computerUse.headers } : {}),
      ...(this.deps.computerUse.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    };
    return [builtin, ...registered];
  }

  async #serverTools(workspaceId: string, server: McpServerConfig, usedSlugs: Map<string, number>): Promise<BridgedToolSpec[]> {
    // Allowlist rides the cache key so a PATCH takes effect immediately.
    const cacheKey = `${workspaceId}:${server.id}:${server.url}:${(server.allowedTools ?? []).join(',')}`;
    const cached = this.#cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.specs;

    const client = this.#client(workspaceId, server);
    const listed = await client.listTools();
    // Least privilege: a non-empty allowlist makes ONLY those tools visible —
    // to agents, to `mcp` nodes, and to REST — the rest of the server's
    // surface simply does not exist for this workspace.
    const allow = Array.isArray(server.allowedTools) && server.allowedTools.length > 0
      ? new Set(server.allowedTools)
      : null;
    const tools = allow ? listed.filter((tool) => allow.has(tool.name)) : listed;
    const slug = this.#uniqueSlug(server, usedSlugs);
    const specs: BridgedToolSpec[] = tools.map((tool) => ({
      id: `${TOOL_ID_PREFIX}${slug}__${tool.name}`,
      serverId: server.id,
      serverName: server.name,
      toolName: tool.name,
      description: tool.description ?? `MCP tool ${tool.name} on ${server.name}`,
      ...(server.affordance ? { provides: server.affordance } : {}),
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    }));
    this.#cache.set(cacheKey, { expiresAt: Date.now() + this.#ttl, specs });
    return specs;
  }

  #uniqueSlug(server: McpServerConfig, usedSlugs: Map<string, number>): string {
    const base = slugify(server.name);
    const seen = usedSlugs.get(base) ?? 0;
    usedSlugs.set(base, seen + 1);
    return seen === 0 ? base : `${base}${seen + 1}`;
  }

  #client(workspaceId: string, server: McpServerConfig): McpClientLike {
    // Secrets plane: merge the vault credential into the headers at call time
    // (JSON object → headers; bare token → Authorization: Bearer). The secret
    // never rests in plaintext KV or travels through prompts/node configs.
    const resolved = resolveMcpServerHeaders(this.deps.db, this.deps.vault, workspaceId, server);
    if (resolved.credentialError) {
      this.deps.logger.warn('mcp_bridge.credential_unresolved', {
        workspaceId, server: server.name, error: resolved.credentialError,
      });
    }
    const opts = { allowPrivateNetwork: server.allowPrivateNetwork ?? this.deps.allowPrivateNetwork };
    return this.deps.clientFactory
      ? this.deps.clientFactory(server.url, resolved.headers, opts)
      : new McpClient(server.url, resolved.headers, opts);
  }
}

/** Parse the env-configured built-in computer-use server, if set. */
export function computerUseServerFromEnv(env: Record<string, string | undefined>): ComputerUseServerConfig | undefined {
  const url = env.AGENTIS_COMPUTER_USE_MCP_URL?.trim();
  if (!url) return undefined;
  const headers = parseHeaders(env.AGENTIS_COMPUTER_USE_MCP_HEADERS);
  const out: ComputerUseServerConfig = { url };
  if (headers) out.headers = headers;
  if (String(env.AGENTIS_COMPUTER_USE_MCP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true') out.allowPrivateNetwork = true;
  return out;
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'server';
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** True when a string is a recognized HAL affordance key. */
export function isAgentAffordance(value: unknown): value is AgentAffordance {
  return typeof value === 'string' && (AGENT_AFFORDANCES as readonly string[]).includes(value);
}
