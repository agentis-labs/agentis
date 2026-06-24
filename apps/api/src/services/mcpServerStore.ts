/**
 * Shared persistence for external MCP server configs (Agentis as an MCP
 * consumer, Pillar 5). Server configs live per-workspace in `workspace_kv`
 * under a single `mcp:servers` key — no dedicated table.
 *
 * Both the REST surface (routes/mcpServers.ts) and the agent-facing bridge
 * (mcpToolBridge.ts) read/write through here so the shape stays in one place.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AgentAffordance } from '@agentis/core';

export const MCP_SERVERS_KV_KEY = 'mcp:servers';

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  headers?: Record<string, string>;
  /**
   * The HAL affordance this server grants (e.g. `computerUse` for a desktop-
   * control MCP). Informational: surfaced to agents so they know what power a
   * server unlocks. Untagged servers are generic tool providers.
   */
  affordance?: AgentAffordance;
  /** Allow loopback/LAN targets — needed for a locally-run computer-use server. */
  allowPrivateNetwork?: boolean;
  createdAt: string;
}

export function loadMcpServers(db: AgentisSqliteDb, workspaceId: string): McpServerConfig[] {
  const row = db
    .select()
    .from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, MCP_SERVERS_KV_KEY)))
    .get();
  const value = row?.value;
  return Array.isArray(value) ? (value as McpServerConfig[]) : [];
}

export function saveMcpServers(db: AgentisSqliteDb, workspaceId: string, servers: McpServerConfig[]): void {
  const now = new Date().toISOString();
  const existing = db
    .select({ id: schema.workspaceKv.id })
    .from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, MCP_SERVERS_KV_KEY)))
    .get();
  if (existing) {
    db.update(schema.workspaceKv).set({ value: servers, updatedAt: now }).where(eq(schema.workspaceKv.id, existing.id)).run();
  } else {
    db.insert(schema.workspaceKv)
      .values({ id: randomUUID(), workspaceId, key: MCP_SERVERS_KV_KEY, value: servers, createdAt: now, updatedAt: now })
      .run();
  }
}
