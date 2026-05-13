import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { CredentialVault } from './credentialVault.js';
import type { WorkflowDeploymentService } from './workflowDeployments.js';
import { assertSafeUrl } from './safeUrl.js';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken(): string {
  return `mcp_${randomBytes(24).toString('base64url')}`;
}

function safeEqualHash(expectedHash: string, token: string): boolean {
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(hashToken(token), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function assertSafeHttpUrl(rawUrl: string): Promise<void> {
  try {
    await assertSafeUrl(rawUrl, {
      allowPrivate: String(process.env.AGENTIS_MCP_ALLOW_PRIVATE ?? process.env.AGENTIS_SKILL_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
    });
  } catch (err) {
    if (err instanceof AgentisError) throw err;
    throw new AgentisError('SKILL_SSRF_BLOCKED', 'MCP server URL is invalid');
  }
}

function jsonRpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export class McpInteropService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly vault: CredentialVault,
    private readonly deployments: WorkflowDeploymentService,
  ) {}

  listServers(workspaceId: string) {
    return this.db
      .select()
      .from(schema.mcpServers)
      .where(eq(schema.mcpServers.workspaceId, workspaceId))
      .all()
      .map(({ apiKeyEncrypted: _encrypted, apiKeyHash: _hash, ...server }) => server);
  }

  async createServer(args: {
    workspaceId: string;
    userId: string;
    name: string;
    direction: 'consume' | 'expose';
    url?: string;
    apiKey?: string;
  }) {
    if (args.direction === 'consume') {
      if (!args.url) throw new AgentisError('VALIDATION_FAILED', 'MCP consume servers require a URL');
      await assertSafeHttpUrl(args.url);
    }
    const id = randomUUID();
    const generatedKey = args.direction === 'expose' ? newToken() : null;
    this.db.insert(schema.mcpServers).values({
      id,
      workspaceId: args.workspaceId,
      userId: args.userId,
      name: args.name,
      direction: args.direction,
      url: args.url ?? null,
      authType: args.apiKey ? 'bearer' : 'none',
      apiKeyEncrypted: args.apiKey ? this.vault.encrypt(args.apiKey) : null,
      apiKeyHash: generatedKey ? hashToken(generatedKey) : null,
      status: 'active',
    }).run();
    const server = this.db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, id)).get();
    return {
      server: server ? { ...server, apiKeyEncrypted: undefined, apiKeyHash: undefined } : null,
      apiKey: generatedKey,
    };
  }

  addExposedTool(args: {
    workspaceId: string;
    serverId: string;
    deploymentId: string;
    toolName: string;
    description?: string;
    inputSchema?: unknown;
  }) {
    const server = this.db
      .select()
      .from(schema.mcpServers)
      .where(and(eq(schema.mcpServers.id, args.serverId), eq(schema.mcpServers.workspaceId, args.workspaceId)))
      .get();
    if (!server || server.direction !== 'expose') throw new AgentisError('RESOURCE_NOT_FOUND', 'MCP server not found');
    this.deployments.get(args.workspaceId, args.deploymentId);
    const id = randomUUID();
    this.db.insert(schema.mcpServerTools).values({
      id,
      workspaceId: args.workspaceId,
      serverId: args.serverId,
      deploymentId: args.deploymentId,
      toolName: args.toolName,
      description: args.description ?? `Run deployment ${args.deploymentId}`,
      inputSchema: args.inputSchema ?? {},
    }).run();
    return this.db.select().from(schema.mcpServerTools).where(eq(schema.mcpServerTools.id, id)).get();
  }

  listExposedTools(serverId: string) {
    return this.db
      .select()
      .from(schema.mcpServerTools)
      .where(eq(schema.mcpServerTools.serverId, serverId))
      .all()
      .map((tool) => ({
        name: tool.toolName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
  }

  async listRemoteTools(workspaceId: string, serverIds: string[]) {
    const servers = this.db.select().from(schema.mcpServers).where(eq(schema.mcpServers.workspaceId, workspaceId)).all();
    const selected = servers.filter((server) => server.direction === 'consume' && serverIds.includes(server.id));
    const catalogs: Array<{ serverId: string; name: string; tools: McpTool[]; error?: string }> = [];
    for (const server of selected) {
      try {
        const tools = await this.fetchRemoteTools(server as typeof server & { url: string });
        catalogs.push({ serverId: server.id, name: server.name, tools });
      } catch (err) {
        catalogs.push({ serverId: server.id, name: server.name, tools: [], error: (err as Error).message });
      }
    }
    return catalogs;
  }

  async fetchRemoteTools(server: { url: string | null; apiKeyEncrypted: string | null }): Promise<McpTool[]> {
    if (!server.url) return [];
    await assertSafeHttpUrl(server.url);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (server.apiKeyEncrypted) headers.authorization = `Bearer ${this.vault.decrypt(server.apiKeyEncrypted)}`;
    const res = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'tools-list', method: 'tools/list', params: {} }),
      redirect: 'manual',
    });
    if (!res.ok) throw new Error(`MCP tools/list failed with ${res.status}`);
    const payload = (await res.json()) as { result?: { tools?: McpTool[] } };
    return payload.result?.tools ?? [];
  }

  async callRemoteTool(args: {
    workspaceId: string;
    serverId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown> {
    const server = this.db
      .select()
      .from(schema.mcpServers)
      .where(and(eq(schema.mcpServers.id, args.serverId), eq(schema.mcpServers.workspaceId, args.workspaceId)))
      .get();
    if (!server || server.direction !== 'consume' || server.status !== 'active') {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'MCP consume server not found');
    }
    if (!server.url) throw new AgentisError('VALIDATION_FAILED', 'MCP consume server URL is missing');
    await assertSafeHttpUrl(server.url);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (server.apiKeyEncrypted) headers.authorization = `Bearer ${this.vault.decrypt(server.apiKeyEncrypted)}`;
    const res = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `tool-${Date.now()}`,
        method: 'tools/call',
        params: { name: args.toolName, arguments: args.arguments ?? {} },
      }),
      redirect: 'manual',
    });
    if (!res.ok) throw new AgentisError('INTEGRATION_OPERATION_FAILED', `MCP tools/call failed with ${res.status}`);
    const payload = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (payload.error) {
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', payload.error.message ?? 'MCP tool call failed');
    }
    return payload.result ?? null;
  }

  async handleProtocol(serverId: string, token: string | null, request: JsonRpcRequest) {
    const server = this.db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, serverId)).get();
    if (!server || server.direction !== 'expose' || server.status !== 'active') {
      return jsonRpcError(request.id, -32601, 'MCP server not found');
    }
    if (!token || !server.apiKeyHash || !safeEqualHash(server.apiKeyHash, token)) {
      return jsonRpcError(request.id, -32001, 'Unauthorized');
    }

    if (request.method === 'initialize') {
      return jsonRpcResult(request.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: '0.1.0' },
      });
    }
    if (request.method === 'tools/list') {
      return jsonRpcResult(request.id, { tools: this.listExposedTools(serverId) });
    }
    if (request.method === 'tools/call') {
      const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const tool = this.db
        .select()
        .from(schema.mcpServerTools)
        .where(and(eq(schema.mcpServerTools.serverId, serverId), eq(schema.mcpServerTools.toolName, params?.name ?? '')))
        .get();
      if (!tool) return jsonRpcError(request.id, -32602, 'Unknown tool');
      const result = await this.deployments.execute({
        deploymentId: tool.deploymentId,
        inputs: params?.arguments ?? {},
        token: undefined,
        skipAuth: true,
        syncTimeoutMs: 5000,
        source: 'mcp',
      });
      return jsonRpcResult(request.id, {
        content: [{ type: 'text', text: JSON.stringify(result.response ?? { runId: result.runId, status: result.status }) }],
        isError: result.status === 'FAILED',
      });
    }
    return jsonRpcError(request.id, -32601, 'Method not found');
  }

  handleManifest(serverId: string, token: string | null) {
    const server = this.db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, serverId)).get();
    if (!server || server.direction !== 'expose' || server.status !== 'active') {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'MCP server not found');
    }
    if (!token || !server.apiKeyHash || !safeEqualHash(server.apiKeyHash, token)) {
      throw new AgentisError('AUTH_FORBIDDEN', 'MCP API key is required');
    }
    return {
      schemaVersion: '2024-11-05',
      name: server.name,
      capabilities: { tools: {} },
      tools: this.listExposedTools(serverId),
    };
  }
}
