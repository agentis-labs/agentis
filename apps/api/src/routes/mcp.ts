/**
 * MCP Publication Layer — WORKFLOW-10X-MASTERPLAN §5.
 *
 * Exposes published workflows as MCP-style tools callable by Claude Code, Cursor,
 * Codex, or any MCP client:
 *   POST /v1/mcp/publish        { workflowId, slug? }  → mark a workflow published
 *   GET  /v1/mcp/tools                                  → list published tools
 *   POST /v1/mcp/tools/:slug    { inputs }              → run it, await, return output
 *
 * Publication state lives in `workflow.settings.mcp`. Run-and-return polls the run
 * to terminal so MCP callers get the result synchronously.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError, type WorkflowGraph, type WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import { buildInitialRunState } from '../engine/initialRunState.js';
import { validateWorkflowGraph } from '../engine/validateGraph.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

interface McpSettings { published?: boolean; slug?: string }

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'workflow';
}

function mcpOf(settings: unknown): McpSettings {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).mcp : undefined;
  return s && typeof s === 'object' ? (s as McpSettings) : {};
}

export function buildMcpRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; engine: WorkflowEngine }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // Publish (or re-publish) a workflow as an MCP tool.
  app.post('/publish', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as { workflowId?: string; slug?: string };
    if (!body.workflowId) throw new AgentisError('VALIDATION_FAILED', 'workflowId is required');
    const wf = deps.db.select().from(schema.workflows)
      .where(and(eq(schema.workflows.id, body.workflowId), eq(schema.workflows.workspaceId, ws.workspaceId))).get();
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${body.workflowId} not found`);
    const slug = slugify(body.slug ?? wf.title);
    // Reject slug collisions across the workspace.
    const clash = deps.db.select({ id: schema.workflows.id, settings: schema.workflows.settings })
      .from(schema.workflows).where(eq(schema.workflows.workspaceId, ws.workspaceId)).all()
      .find((r) => r.id !== wf.id && mcpOf(r.settings).slug === slug && mcpOf(r.settings).published);
    if (clash) throw new AgentisError('RESOURCE_CONFLICT', `MCP slug '${slug}' is already in use`);
    const settings = { ...(wf.settings as Record<string, unknown> ?? {}), mcp: { published: true, slug } };
    deps.db.update(schema.workflows).set({ settings, updatedAt: new Date().toISOString() }).where(eq(schema.workflows.id, wf.id)).run();
    return c.json({ workflowId: wf.id, toolName: `agentis__${slug}`, slug, endpoint: `/v1/mcp/tools/${slug}` });
  });

  // Unpublish.
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

  // List published tools as MCP descriptors.
  app.get('/tools', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, ws.workspaceId)).all();
    const tools = rows
      .map((r) => ({ r, mcp: mcpOf(r.settings) }))
      .filter((x) => x.mcp.published && x.mcp.slug)
      .map(({ r, mcp }) => ({
        name: `agentis__${mcp.slug}`,
        slug: mcp.slug!,
        workflowId: r.id,
        description: r.summary ?? r.title,
        inputSchema: inputSchemaFor(r.graph as WorkflowGraph),
        endpoint: `/v1/mcp/tools/${mcp.slug}`,
      }));
    return c.json({ tools });
  });

  // Invoke a published workflow by slug, await completion, return the output.
  app.post('/tools/:slug', async (c) => {
    const ws = getWorkspace(c);
    const slug = c.req.param('slug');
    const body = (await c.req.json().catch(() => ({}))) as { inputs?: Record<string, unknown> };
    const wf = deps.db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, ws.workspaceId)).all()
      .find((r) => { const m = mcpOf(r.settings); return m.published && m.slug === slug; });
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `no published MCP tool '${slug}'`);

    const graph = wf.graph as WorkflowGraph;
    validateWorkflowGraph(graph, { currentWorkflowId: wf.id });
    const runId = randomUUID();
    const inputs = body.inputs ?? {};
    const initialState = buildInitialRunState({ runId, workflowId: wf.id, graph, inputs });
    deps.db.insert(schema.workflowRuns).values({
      id: runId, workspaceId: ws.workspaceId, ambientId: ws.ambientId, workflowId: wf.id,
      userId: ws.user.id, status: 'CREATED', runState: initialState,
    }).run();
    await deps.engine.startRun({
      workspaceId: ws.workspaceId, ambientId: ws.ambientId, workflowId: wf.id, userId: ws.user.id,
      triggerId: null, inputs, initialState, graph,
    });

    const final = await awaitRun(deps.db, runId, 60_000);
    return c.json({
      runId,
      status: final.status,
      output: final.status === 'COMPLETED' || final.status === 'COMPLETED_WITH_CONTRACT_VIOLATION'
        ? finalOutput(graph, final.runState as WorkflowRunState)
        : null,
    });
  });

  return app;
}

/** Poll a run to a terminal state (or timeout → returns last seen). */
async function awaitRun(db: AgentisSqliteDb, runId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let row = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  while (Date.now() < deadline && !isTerminal(row.status)) {
    await sleep(250);
    row = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  }
  return row;
}

function isTerminal(status: string): boolean {
  return ['COMPLETED', 'COMPLETED_WITH_CONTRACT_VIOLATION', 'FAILED', 'CANCELLED'].includes(status);
}

/** Final output: declared output nodes (return_output / isOutput), else last completed node. */
function finalOutput(graph: WorkflowGraph, state: WorkflowRunState): unknown {
  const declared = (graph.nodes ?? []).filter((n) => {
    const c = n.config as { kind?: string; isOutput?: boolean };
    return c.kind === 'return_output' || c.isOutput === true;
  });
  // Unwrap return_output nodes to their rendered `value` for a clean MCP payload.
  const pick = (id: string, kind?: string) => {
    const o = state.nodeStates?.[id]?.outputData ?? null;
    if (kind === 'return_output' && o && typeof o === 'object' && 'value' in o) return (o as { value: unknown }).value;
    return o;
  };
  if (declared.length > 0) {
    const out: Record<string, unknown> = {};
    for (const n of declared) { const o = pick(n.id, (n.config as { kind?: string }).kind); if (o !== null && o !== undefined) out[n.id] = o; }
    return out;
  }
  const last = state.completedNodeIds?.at(-1);
  return last ? pick(last) : null;
}

/** Build a minimal JSON schema from the workflow's inputContract (if any). */
function inputSchemaFor(graph: WorkflowGraph): Record<string, unknown> {
  const fields = (graph as { inputContract?: { fields?: Array<{ key: string; type: string; required?: boolean }> } }).inputContract?.fields ?? [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.key] = { type: f.type === 'any' ? 'string' : f.type };
    if (f.required) required.push(f.key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
}
