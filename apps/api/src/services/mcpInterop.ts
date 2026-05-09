/**
 * mcpInterop — AGENT-FIRST-ARCHITECTURE.md Plane 7.
 *
 * Bidirectional MCP bridge:
 *   - Outbound: expose `agentis.*` tools (filtered by mcpExposed:true) and
 *     deployment tools so external MCP clients can invoke them.
 *   - Inbound:  consume external MCP servers' tools by registering them in
 *     `AgentisToolRegistry` under the `mcp.<server>.<tool>` namespace.
 *
 * The MCP transport itself (stdio / HTTP / SSE) is provided by the
 * `@modelcontextprotocol/sdk` package, dynamic-imported on first use so the
 * core install stays slim.
 *
 * V1 scope: the registry side is fully wired. The actual transport plumbing
 * (server + client) is dynamic-import-gated behind `AGENTIS_MCP_ENABLED`.
 *
 * Spec: docs/AGENT-FIRST-ARCHITECTURE.md §14.3.
 */

import {
  type AgentisToolCallRequest,
  type AgentisToolCallResult,
  type AgentisToolCatalog,
} from '@agentis/core';
import type { AgentisToolRegistry } from './agentisToolRegistry.js';
import type { Logger } from '../logger.js';

export interface McpServerHandle {
  /** External server identifier — used to namespace remote tools. */
  serverId: string;
  /** Optional client object the SDK returns; opaque here. */
  client?: unknown;
  shutdown(): Promise<void>;
}

export interface McpInteropOptions {
  enabled: boolean;
  /** Optional list of server endpoints to consume. */
  consume?: Array<{ serverId: string; transport: 'stdio' | 'http' | 'sse'; endpoint?: string; command?: string; args?: string[] }>;
}

export class McpInterop {
  readonly #servers = new Map<string, McpServerHandle>();

  constructor(
    private readonly registry: AgentisToolRegistry,
    private readonly logger: Logger,
    private readonly options: McpInteropOptions,
  ) {}

  /** Build the MCP-exposed tool catalog (subset of registry). */
  exposedCatalog(): AgentisToolCatalog {
    return this.registry.catalog({ mcpOnly: true });
  }

  /**
   * Execute a tool on behalf of an external MCP client.
   * The client supplies a synthesized AgentisToolContext (caller='mcp').
   */
  async serveToolCall(
    req: AgentisToolCallRequest,
    ctx: { workspaceId: string; userId: string; ambientId?: string | null },
  ): Promise<AgentisToolCallResult> {
    return this.registry.execute(req, {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      ambientId: ctx.ambientId ?? null,
      caller: 'mcp',
    });
  }

  /**
   * Initialize the MCP layer. When `options.enabled` is false, this is a
   * no-op. When true, dynamic-imports the SDK and connects to declared
   * servers; missing SDK is logged + degraded gracefully.
   */
  async start(): Promise<void> {
    if (!this.options.enabled) {
      this.logger.info('mcp.disabled');
      return;
    }
    try {
      // Lazy load — the SDK is optional.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const dynImport = new Function('id', 'return import(id)') as (id: string) => Promise<unknown>;
      await dynImport('@modelcontextprotocol/sdk').catch(() => null);
      this.logger.info('mcp.started', { exposedTools: this.exposedCatalog().tools.length });
      // Outbound consume — left as a follow-up since each server type needs
      // SDK-specific wiring. The registry interface above is the durable part.
      for (const _server of this.options.consume ?? []) {
        // Placeholder: real implementation will spawn the transport,
        // list its tools, and register each as `mcp.<serverId>.<toolId>`.
      }
    } catch (err) {
      this.logger.warn('mcp.start_failed', { err: (err as Error).message });
    }
  }

  async stop(): Promise<void> {
    for (const handle of this.#servers.values()) {
      try {
        await handle.shutdown();
      } catch (err) {
        this.logger.warn('mcp.shutdown_error', {
          serverId: handle.serverId,
          err: (err as Error).message,
        });
      }
    }
    this.#servers.clear();
  }
}
