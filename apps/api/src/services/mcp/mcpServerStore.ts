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
import type { CredentialVault } from '../credentialVault.js';

export const MCP_SERVERS_KV_KEY = 'mcp:servers';

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  headers?: Record<string, string>;
  /**
   * MCP CAPABILITY PLANE (secrets plane): reference a VAULT credential instead
   * of inline headers. At call time the decrypted value is merged into the
   * request headers — a JSON object is used verbatim as headers; a bare string
   * becomes `Authorization: Bearer <value>`. This is the paved road: the
   * secret never sits in plaintext KV, node configs, or agent prompts.
   */
  credentialId?: string;
  /**
   * Per-tool allowlist (least privilege): when non-empty, ONLY these tool
   * names are bridged to agents and callable from `mcp` nodes / REST — the
   * rest of the server's surface stays invisible. Empty/absent = all tools.
   */
  allowedTools?: string[];
  /**
   * The RAL affordance this server grants (e.g. `computerUse` for a desktop-
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

/**
 * Resolve the headers a server call should use: inline headers merged with the
 * vault credential (vault wins on conflicts). The decrypted credential value is
 * either a JSON object of headers or a bare token (→ `Authorization: Bearer`).
 * Resolution failures degrade to inline headers with a warning-shaped return —
 * an unreachable credential must not take every mounted tool down silently.
 */
export function resolveMcpServerHeaders(
  db: AgentisSqliteDb,
  vault: CredentialVault | undefined,
  workspaceId: string,
  server: McpServerConfig,
): { headers: Record<string, string>; credentialError?: string } {
  const base = { ...(server.headers ?? {}) };
  if (!server.credentialId) return { headers: base };
  if (!vault) return { headers: base, credentialError: 'credential vault not wired' };
  try {
    const row = db
      .select({ encryptedValue: schema.credentials.encryptedValue, workspaceId: schema.credentials.workspaceId })
      .from(schema.credentials)
      .where(and(eq(schema.credentials.id, server.credentialId), eq(schema.credentials.workspaceId, workspaceId)))
      .get();
    if (!row) return { headers: base, credentialError: `credential ${server.credentialId} not found in workspace` };
    const secret = vault.decrypt(row.encryptedValue).trim();
    if (secret.startsWith('{')) {
      const parsed = JSON.parse(secret) as Record<string, unknown>;
      // OAuth mounts: an OAuth-minted credential is a token BUNDLE
      // ({ accessToken | access_token, refreshToken, … }), not a header map —
      // resolve it to a Bearer header instead of leaking bundle fields as headers.
      const accessToken = typeof parsed.accessToken === 'string'
        ? parsed.accessToken
        : typeof parsed.access_token === 'string'
          ? parsed.access_token
          : null;
      if (accessToken) {
        base.Authorization = `Bearer ${accessToken}`;
        return { headers: base };
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') base[key] = value;
      }
      return { headers: base };
    }
    base.Authorization = `Bearer ${secret}`;
    return { headers: base };
  } catch (err) {
    return { headers: base, credentialError: (err as Error).message };
  }
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
