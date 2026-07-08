/**
 * McpHarnessSession — wires a CLI harness (Codex / Claude Code) to Agentis's own
 * MCP server so it runs its OWN agentic loop calling Agentis tools natively,
 * instead of the platform driving the slow marker protocol (which re-spawns the
 * CLI per tool round). The harness stays the brain; Agentis is its tool surface.
 *
 * ## Zero configuration — the platform handles everything
 * The product rule: a user only adds their agent + harness; we handle the rest.
 * So this needs NO env vars to function:
 *   - **URL** is auto-derived as the server's own loopback address (the harness
 *     is a local subprocess, same machine as the API).
 *   - **Token** is auto-minted: a workspace-scoped Agentis API key, created on
 *     demand (hash persisted in `api_keys`, plaintext held in memory for the
 *     process lifetime), and rotated each boot so it's never stored in plaintext.
 *   - **On by default.** Opt OUT with `AGENTIS_HARNESS_MCP=false`; override the
 *     URL with `AGENTIS_HARNESS_MCP_URL` only for unusual remote-harness setups.
 *
 * ## Transport per harness
 * - **Claude Code** speaks streamable-HTTP MCP natively → `--mcp-config`.
 * - **Codex** mounts MCP over stdio → bridged with Agentis's local Node proxy,
 *   injected via `-c mcp_servers.*` TOML overrides (no global config file).
 *
 * ## Security
 * The harness authenticates with `Authorization: Bearer <token>` +
 * `x-agentis-workspace` and runs locally (same trust boundary as the API), so a
 * workspace-scoped key is appropriate for self-hosted. The key is rotated each
 * boot and never written to disk in plaintext. Claude config uses
 * `--strict-mcp-config` so the chat is hermetic.
 */

import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AdapterType } from '@agentis/core';
import type { Logger } from '../../logger.js';
import { createApiKeySecret, hashApiKey } from '../apiKeys.js';

/** A single MCP server descriptor the harness should mount. */
export interface McpHarnessServer {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface McpHarnessDeps {
  db: AgentisSqliteDb;
  /** False only when explicitly opted out. */
  enabled: boolean;
  /** Auto-derived loopback URL of this API (overridable for remote harnesses). */
  publicUrl: string;
  logger?: Logger;
}

const HARNESS_KEY_NAME = 'Harness MCP (auto)';
const MCP_STDIO_BRIDGE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/agentis-mcp-stdio-bridge.mjs',
);

export class McpHarnessSessionService {
  /** workspaceId → freshly-minted plaintext token (process lifetime). */
  readonly #tokens = new Map<string, string>();

  constructor(private readonly deps: McpHarnessDeps) {}

  get enabled(): boolean {
    return Boolean(this.deps.enabled && this.deps.publicUrl);
  }

  /** The Agentis MCP server a harness in this workspace should mount, or null. */
  forWorkspace(workspaceId: string, ambientId?: string | null, userId?: string | null, agentId?: string | null): McpHarnessServer | null {
    if (!this.enabled || !userId) return null;
    const token = this.#ensureToken(workspaceId, userId);
    if (!token) return null;
    const base = this.deps.publicUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'x-agentis-workspace': workspaceId,
    };
    if (ambientId) headers['x-agentis-ambient'] = ambientId;
    if (agentId) headers['x-agentis-agent'] = agentId;
    return { name: 'agentis', url: `${base}/v1/mcp/rpc`, headers };
  }

  /**
   * Mint (once per process) a workspace-scoped API key for the local harness.
   * Persists only the hash; rotates out any prior auto key so exactly one is live.
   */
  #ensureToken(workspaceId: string, userId: string): string | null {
    const cached = this.#tokens.get(workspaceId);
    if (cached) return cached;
    try {
      const secret = createApiKeySecret();
      const now = new Date().toISOString();
      this.deps.db
        .update(schema.apiKeys)
        .set({ revokedAt: now })
        .where(and(
          eq(schema.apiKeys.workspaceId, workspaceId),
          eq(schema.apiKeys.name, HARNESS_KEY_NAME),
          isNull(schema.apiKeys.revokedAt),
        ))
        .run();
      this.deps.db.insert(schema.apiKeys).values({
        id: randomUUID(),
        workspaceId,
        userId,
        name: HARNESS_KEY_NAME,
        keyHash: hashApiKey(secret),
        preview: `${secret.slice(0, 12)}…`,
        createdAt: now,
      }).run();
      this.#tokens.set(workspaceId, secret);
      return secret;
    } catch (err) {
      this.deps.logger?.warn?.('harness_mcp.token_mint_failed', { workspaceId, err: (err as Error).message });
      return null;
    }
  }

  /**
   * Build from env + the server's own bind address. ON by default; the only env
   * knobs are an opt-out and an optional URL override for remote harnesses.
   */
  static fromEnv(env: NodeJS.ProcessEnv, db: AgentisSqliteDb, logger?: Logger): McpHarnessSessionService {
    const enabled = String(env.AGENTIS_HARNESS_MCP ?? '').toLowerCase() !== 'false';
    const port = env.AGENTIS_HTTP_PORT ?? '8787';
    const publicUrl = env.AGENTIS_HARNESS_MCP_URL ?? env.AGENTIS_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
    return new McpHarnessSessionService({ db, enabled, publicUrl, logger });
  }
}

/**
 * Translate MCP server descriptors into the CLI flags a given harness needs.
 * Returns spawn `args` to append (and never mutates any global config file).
 * Pure + deterministic so it is unit-testable without the binaries installed.
 */
export function harnessMcpArgs(adapterType: AdapterType, servers: McpHarnessServer[]): string[] {
  if (servers.length === 0) return [];
  if (adapterType === 'claude_code') return claudeMcpArgs(servers);
  if (adapterType === 'codex') return codexMcpArgs(servers);
  // Cursor (`cursor-agent`) and Antigravity (`agy`) have NO spawn-arg MCP
  // emitter on purpose: neither CLI accepts an inline `--mcp-config`/`-c` server
  // override (cursor reads a `.cursor/mcp.json` file; agy uses its own settings),
  // so injecting one would break the spawn. Until a file-based emitter is added
  // and verified against the real binaries, these harnesses use the marker
  // protocol (see agentCommission.registerAdapter) rather than native MCP tools.
  return [];
}

/** Claude Code: native streamable-HTTP MCP via an inline `--mcp-config` JSON. */
function claudeMcpArgs(servers: McpHarnessServer[]): string[] {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.name] = { type: 'http', url: s.url, headers: s.headers };
  }
  // `--strict-mcp-config` makes the harness use ONLY these servers (ignore any
  // user-level `.mcp.json`), keeping the chat hermetic and deterministic.
  return ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers })];
}

/** Codex: bridge the remote HTTP endpoint to stdio via Agentis's local proxy. */
function codexMcpArgs(servers: McpHarnessServer[]): string[] {
  const args: string[] = [];
  for (const s of servers) {
    const proxyArgs = [MCP_STDIO_BRIDGE_PATH, s.url];
    for (const [key, value] of Object.entries(s.headers)) {
      proxyArgs.push('--header', `${key}: ${value}`);
    }
    args.push('-c', `mcp_servers.${s.name}.command=${tomlString(process.execPath)}`);
    args.push('-c', `mcp_servers.${s.name}.args=${tomlStringArray(proxyArgs)}`);
  }
  return args;
}

/** Serialize a string[] as a TOML inline array for a Codex `-c` override. */
function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
