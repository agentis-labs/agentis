/**
 * MCP server surface — Agentis as an MCP provider (UNIVERSAL-HARNESS §5, Pillar 5).
 *
 * Two layers, one source of truth:
 *
 *   1. Workflow publication (REST convenience):
 *        POST /v1/mcp/publish    { workflowId, slug? }  → mark a workflow published
 *        POST /v1/mcp/unpublish  { workflowId }
 *        GET  /v1/mcp/tools                              → list published tools
 *        POST /v1/mcp/tools/:slug { inputs }             → run it, await, return output
 *
 *   2. Protocol-compliant MCP endpoint (JSON-RPC 2.0, Streamable HTTP shape):
 *        POST /v1/mcp/rpc        { jsonrpc, method, params, id }
 *        GET  /v1/mcp/server-card                        → discovery metadata
 *      Methods: `initialize`, `tools/list`, `tools/call`. The tool surface is the
 *      union of (a) the workspace's published workflows and (b) the
 *      MCP-exposed entries of the shared AgentisToolRegistry — so external MCP
 *      clients (Claude Code, Cursor, Codex) call the exact same tools the engine
 *      and chat use. No second tool table.
 *
 * Publication state lives in `workflow.settings.mcp`.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  AgentisError,
  type AgentisToolContext,
  type WorkflowGraph,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { AgentisToolRegistry } from '../services/agentisToolRegistry.js';
import { AGENTIS_MCP_SERVER_INSTRUCTIONS } from '../services/orchestrator/orchestratorPrompt.js';
import { listMcpResources, readMcpResource } from '../services/mcp/mcpResources.js';
import { runPublishedWorkflow, inputSchemaFor } from '../engine/runPublishedWorkflow.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';
import type { ConversationTurnLeaseRegistry } from '../services/conversation/conversationTurnLease.js';
import { CONVERSATION_ID_HEADER, TURN_LEASE_HEADER } from '../services/mcp/mcpHarnessSession.js';

interface McpSettings { published?: boolean; slug?: string }

const WORKFLOW_TOOL_PREFIX = 'agentis__';
const PROTOCOL_VERSION = '2025-06-18';
const MCP_CAPABILITIES = {
  tools: { listChanged: false },
  resources: { listChanged: false },
};

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'workflow';
}

function mcpOf(settings: unknown): McpSettings {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).mcp : undefined;
  return s && typeof s === 'object' ? (s as McpSettings) : {};
}

export interface McpRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  engine: WorkflowEngine;
  /** Shared tool registry — the same tools chat and the engine use. */
  toolRegistry?: AgentisToolRegistry;
  /** Revocable capabilities for tools called by interactive CLI harness turns. */
  turnLeases?: ConversationTurnLeaseRegistry;
}

export function buildMcpRoutes(deps: McpRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // ── Workflow publication (REST convenience) ──────────────────────────────
  app.post('/publish', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as { workflowId?: string; slug?: string };
    if (!body.workflowId) throw new AgentisError('VALIDATION_FAILED', 'workflowId is required');
    const wf = deps.db.select().from(schema.workflows)
      .where(and(eq(schema.workflows.id, body.workflowId), eq(schema.workflows.workspaceId, ws.workspaceId))).get();
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${body.workflowId} not found`);
    const slug = slugify(body.slug ?? wf.title);
    const clash = deps.db.select({ id: schema.workflows.id, settings: schema.workflows.settings })
      .from(schema.workflows).where(eq(schema.workflows.workspaceId, ws.workspaceId)).all()
      .find((r) => r.id !== wf.id && mcpOf(r.settings).slug === slug && mcpOf(r.settings).published);
    if (clash) throw new AgentisError('RESOURCE_CONFLICT', `MCP slug '${slug}' is already in use`);
    const settings = { ...(wf.settings as Record<string, unknown> ?? {}), mcp: { published: true, slug } };
    deps.db.update(schema.workflows).set({ settings, updatedAt: new Date().toISOString() }).where(eq(schema.workflows.id, wf.id)).run();
    return c.json({ workflowId: wf.id, toolName: `${WORKFLOW_TOOL_PREFIX}${slug}`, slug, endpoint: `/v1/mcp/tools/${slug}` });
  });

  app.post('/unpublish', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as { workflowId?: string };
    const wf = body.workflowId ? deps.db.select().from(schema.workflows)
      .where(and(eq(schema.workflows.id, body.workflowId), eq(schema.workflows.workspaceId, ws.workspaceId))).get() : null;
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', 'workflow not found');
    const settings = { ...(wf.settings as Record<string, unknown> ?? {}), mcp: { published: false } };
    deps.db.update(schema.workflows).set({ settings, updatedAt: new Date().toISOString() }).where(eq(schema.workflows.id, wf.id)).run();
    return c.json({ workflowId: wf.id, published: false });
  });

  app.get('/tools', (c) => {
    const ws = getWorkspace(c);
    return c.json({ tools: listWorkflowTools(deps.db, ws.workspaceId) });
  });

  app.post('/tools/:slug', async (c) => {
    const ws = getWorkspace(c);
    const slug = c.req.param('slug');
    const body = (await c.req.json().catch(() => ({}))) as { inputs?: Record<string, unknown> };
    const wf = findPublishedBySlug(deps.db, ws.workspaceId, slug);
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `no published MCP tool '${slug}'`);
    const result = await runPublishedWorkflow({
      db: deps.db, engine: deps.engine,
      workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id,
      workflowId: wf.id, graph: wf.graph as WorkflowGraph, inputs: body.inputs ?? {},
    });
    return c.json({ runId: result.runId, status: result.status, output: result.output });
  });

  // ── Discovery card ───────────────────────────────────────────────────────
  app.get('/server-card', (c) => {
    const ws = getWorkspace(c);
    const tools = collectMcpTools(deps, ws.workspaceId);
    return c.json({
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: 'agentis', version: '1.0.0' },
      capabilities: MCP_CAPABILITIES,
      toolCount: tools.length,
      endpoint: '/v1/mcp/rpc',
      instructions: AGENTIS_MCP_SERVER_INSTRUCTIONS,
    });
  });

  // ── Protocol-compliant JSON-RPC endpoint ──────────────────────────────────
  app.post('/rpc', async (c) => {
    const ws = getWorkspace(c);
    const agentId = resolveMcpAgentId(deps.db, ws.workspaceId, c.req.header('x-agentis-agent'));
    // Per-turn permission posture: an mcp_native harness tags its descriptor with
    // this header, so the tool registry gates mutating tools for the harness's OWN
    // loop — real enforcement, not just the prompt addendum. `plan` hard-blocks,
    // `ask` blocks-and-instructs (operator approves), anything else = Auto (allow).
    const headerMode = c.req.header('x-agentis-execution-mode');
    const executionMode: 'chat' | 'plan' | 'ask' = headerMode === 'plan' ? 'plan' : headerMode === 'ask' ? 'ask' : 'chat';
    const body = (await c.req.json().catch(() => null)) as JsonRpcRequest | null;
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return c.json(rpcError(body?.id ?? null, -32600, 'Invalid Request'));
    }
    const id = body.id ?? null;

    try {
      switch (body.method) {
        case 'initialize':
          return c.json(rpcResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: { name: 'agentis', version: '1.0.0' },
            capabilities: MCP_CAPABILITIES,
            // PAVED-ROAD P2 — deliver the doctrine at the door. MCP clients
            // surface `instructions` to the model as system context, so an
            // external harness gets the build loop + data-flow contract instead
            // of a flat pile of ~70 undocumented tool names.
            instructions: AGENTIS_MCP_SERVER_INSTRUCTIONS,
          }));
        case 'notifications/initialized':
          // Notification — no response body expected, but return 202-style ack.
          return c.body(null, 202);
        case 'resources/list':
          return c.json(rpcResult(id, { resources: listMcpResources() }));
        case 'resources/templates/list':
          return c.json(rpcResult(id, { resourceTemplates: [] }));
        case 'resources/read': {
          const params = (body.params ?? {}) as { uri?: string };
          if (!params.uri) return c.json(rpcError(id, -32602, 'resources/read requires params.uri'));
          const contents = readMcpResource(deps.db, ws.workspaceId, params.uri);
          if (!contents) return c.json(rpcError(id, -32602, `Unknown resource '${params.uri}'`));
          return c.json(rpcResult(id, contents));
        }
        case 'tools/list':
          return c.json(rpcResult(id, { tools: collectMcpTools(deps, ws.workspaceId).map(toMcpDescriptor) }));
        case 'tools/call': {
          const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          if (!params.name) return c.json(rpcError(id, -32602, 'tools/call requires params.name'));
          const conversationId = c.req.header(CONVERSATION_ID_HEADER)?.trim();
          const turnLease = c.req.header(TURN_LEASE_HEADER)?.trim();
          if (Boolean(conversationId) !== Boolean(turnLease)) {
            throw new AgentisError('TURN_CANCELLED', 'Incomplete conversation turn capability. The tool was not executed.');
          }
          let turnSignal: AbortSignal | undefined;
          if (conversationId && turnLease) {
            if (!deps.turnLeases) throw new AgentisError('TURN_CANCELLED', 'Conversation turn capability enforcement is unavailable. The tool was not executed.');
            turnSignal = deps.turnLeases.assertActive(ws.workspaceId, conversationId, turnLease);
          }
          const startedAt = Date.now();
          const result = await callMcpTool(
            deps,
            { ...ws, agentId, executionMode, ...(conversationId ? { conversationId } : {}), ...(turnSignal ? { turnSignal } : {}) },
            params.name,
            params.arguments ?? {},
          );
          if (conversationId && turnLease && deps.turnLeases) {
            const mutating = params.name.startsWith(WORKFLOW_TOOL_PREFIX)
              || Boolean(deps.toolRegistry?.get(params.name)?.mutating);
            const observation = deps.turnLeases.recordToolResult({
              workspaceId: ws.workspaceId,
              conversationId,
              token: turnLease,
              name: params.name,
              toolArgs: params.arguments ?? {},
              result: experiencePayload(result),
              ok: result.isError !== true,
              mutating,
              durationMs: Date.now() - startedAt,
            });
            if (observation.repeated) {
              return c.json(rpcResult(id, textResult(JSON.stringify({
                unchanged: true,
                sameAsObservation: observation.observationIndex,
                stateVersion: observation.stateVersion,
                message: 'This read returned the same result at the same mutation frontier. Reuse the earlier observation; no payload was repeated.',
              }))));
            }
          }
          return c.json(rpcResult(id, result));
        }
        default:
          return c.json(rpcError(id, -32601, `Method not found: ${body.method}`));
      }
    } catch (err) {
      // §F7 — an AgentisError carries a code + directive remediation the platform
      // wrote for exactly this failure. Return it as JSON-RPC error `data` instead
      // of discarding everything but the message under a bare -32603.
      if (err instanceof AgentisError) {
        return c.json(rpcError(id, -32603, err.message, {
          code: err.code,
          ...(err.remediation ? { remediation: err.remediation } : {}),
          ...(err.details ? { details: err.details } : {}),
        }));
      }
      const message = err instanceof Error ? err.message : 'internal error';
      return c.json(rpcError(id, -32603, message));
    }
  });

  return app;
}

// ─── Tool collection (published workflows + registry) ───────────────────────

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: 'workflow' | 'registry';
  /** workflow slug or registry tool id. */
  ref: string;
}

function collectMcpTools(deps: McpRoutesDeps, workspaceId: string): McpTool[] {
  const tools: McpTool[] = listWorkflowTools(deps.db, workspaceId).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    kind: 'workflow' as const,
    ref: t.slug,
  }));
  if (deps.toolRegistry) {
    for (const def of deps.toolRegistry.catalog({ mcpOnly: true }).tools) {
      tools.push({
        name: def.id,
        description: def.description,
        inputSchema: (def.inputSchema && typeof def.inputSchema === 'object'
          ? def.inputSchema
          : { type: 'object' }) as Record<string, unknown>,
        kind: 'registry',
        ref: def.id,
      });
    }
  }
  return tools;
}

function listWorkflowTools(db: AgentisSqliteDb, workspaceId: string) {
  return db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all()
    .map((r) => ({ r, mcp: mcpOf(r.settings) }))
    .filter((x) => x.mcp.published && x.mcp.slug)
    .map(({ r, mcp }) => ({
      name: `${WORKFLOW_TOOL_PREFIX}${mcp.slug}`,
      slug: mcp.slug!,
      workflowId: r.id,
      description: r.description ?? r.title,
      inputSchema: inputSchemaFor(r.graph as WorkflowGraph),
      endpoint: `/v1/mcp/tools/${mcp.slug}`,
    }));
}

function findPublishedBySlug(db: AgentisSqliteDb, workspaceId: string, slug: string) {
  return db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all()
    .find((r) => { const m = mcpOf(r.settings); return Boolean(m.published && m.slug === slug); });
}

function resolveMcpAgentId(db: AgentisSqliteDb, workspaceId: string, agentId?: string): string | undefined {
  if (!agentId) return undefined;
  const agent = db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
    .get();
  if (!agent) throw new AgentisError('CROSS_WORKSPACE_ACCESS', 'Agent not in workspace');
  return agent.id;
}

function toMcpDescriptor(t: McpTool) {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema };
}

/** Execute an MCP tool call → MCP `content` result shape. */
async function callMcpTool(
  deps: McpRoutesDeps,
  ws: { workspaceId: string; ambientId: string | null; user: { id: string }; agentId?: string; executionMode?: 'chat' | 'plan' | 'ask'; conversationId?: string; turnSignal?: AbortSignal },
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  // Workflow tool?
  if (name.startsWith(WORKFLOW_TOOL_PREFIX)) {
    const slug = name.slice(WORKFLOW_TOOL_PREFIX.length);
    const wf = findPublishedBySlug(deps.db, ws.workspaceId, slug);
    if (!wf) return textResult(`No published MCP workflow tool '${name}'`, true);
    const result = await runPublishedWorkflow({
      db: deps.db, engine: deps.engine,
      workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id,
      workflowId: wf.id, graph: wf.graph as WorkflowGraph, inputs: args,
      conversationId: ws.conversationId ?? null,
    });
    const ok = result.status === 'COMPLETED' || result.status === 'COMPLETED_WITH_CONTRACT_VIOLATION';
    return textResult(JSON.stringify({ runId: result.runId, status: result.status, output: result.output }), !ok);
  }

  // Registry tool?
  if (deps.toolRegistry?.has(name)) {
    const def = deps.toolRegistry.get(name);
    if (!def?.mcpExposed) return textResult(`Tool '${name}' is not exposed over MCP`, true);
    const ctx: AgentisToolContext = {
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      ambientId: ws.ambientId,
      ...(ws.agentId ? { agentId: ws.agentId } : {}),
      ...(ws.executionMode ? { executionMode: ws.executionMode } : {}),
      ...(ws.conversationId ? { conversationId: ws.conversationId } : {}),
      ...(ws.turnSignal ? { signal: ws.turnSignal } : {}),
      caller: 'mcp',
    };
    const res = await deps.toolRegistry.execute({ id: '', toolId: name, arguments: args }, ctx);
    // §F7 — hand the agent the directive: code + message + remediation + details, not a bare enum.
    return res.ok
      ? textResult(JSON.stringify(compactMcpOutput(res.output, args)))
      : textResult(JSON.stringify({
          error: res.errorMessage,
          code: res.errorCode,
          ...(res.remediation ? { remediation: res.remediation } : {}),
          ...(res.details ? { details: res.details } : {}),
        }), true);
  }

  return textResult(`Unknown tool '${name}'`, true);
}

// Roughly 3k tokens: enough for a useful structured observation without making
// every subsequent native-harness inference re-ingest a 6k-token payload. Full
// fidelity remains explicit and resource-scoped, so this is progressive
// disclosure rather than a capability restriction.
const MAX_DEFAULT_MCP_OUTPUT_CHARS = 12_000;

/**
 * CLI harnesses append every MCP response to the model context. Keep the
 * default bounded; exact full payloads remain available through an explicit
 * detail:"full"/"graph" request on tools that support them.
 */
function compactMcpOutput(output: unknown, args: Record<string, unknown>): unknown {
  const serialized = JSON.stringify(output);
  if (serialized.length <= MAX_DEFAULT_MCP_OUTPUT_CHARS) return output;
  if (args.detail === 'full' || args.detail === 'graph') return output;
  return {
    truncated: true,
    originalChars: serialized.length,
    preview: serialized.slice(0, MAX_DEFAULT_MCP_OUTPUT_CHARS),
    remediation: 'Use narrower filters or request detail:"full"/"graph" for one exact resource only. Do not repeat broad full-result calls.',
  };
}

function textResult(text: string, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function experiencePayload(result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean }): unknown {
  const text = result.content.map((entry) => entry.text).join('\n');
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

// ─── JSON-RPC helpers ───────────────────────────────────────────────────────

interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown }

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}
