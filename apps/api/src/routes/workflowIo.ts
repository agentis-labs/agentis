/**
 * Workflow as Code — YAML export / import (WORKFLOW-10X-MASTERPLAN §4).
 *
 *   GET  /v1/workflows/:id/export   → text/yaml (versionable, reviewable)
 *   POST /v1/workflows/import       { yaml }  → validated workflow
 *
 * The serialization is lossless: the full graph round-trips. Import validates via
 * `validateGraph()` so a hand-edited / PR-reviewed YAML can't introduce a bad graph.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { parse, stringify } from 'yaml';
import { AgentisError, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { validateWorkflowGraph } from '../engine/validateGraph.js';
import { buildWorkspaceInventory, classifyIntent, planWorkflow } from '../services/creationPipeline.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

interface WorkflowDoc { name: string; description?: string | null; graph: WorkflowGraph }

export function buildWorkflowIoRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/:id/export', (c) => {
    const ws = getWorkspace(c);
    const wf = deps.db.select().from(schema.workflows)
      .where(and(eq(schema.workflows.id, c.req.param('id')), eq(schema.workflows.workspaceId, ws.workspaceId))).get();
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', 'workflow not found');
    const doc: WorkflowDoc = { name: wf.title, description: wf.summary ?? null, graph: wf.graph as WorkflowGraph };
    const yaml = stringify(doc, { lineWidth: 0 });
    return c.body(yaml, 200, { 'content-type': 'text/yaml; charset=utf-8', 'content-disposition': `attachment; filename="${slug(wf.title)}.workflow.yaml"` });
  });

  // Builder Session §9 Step 2 — Phase Cards. Returns the deterministic plan
  // (named phases + cast specialists + cost range) for a natural-language request,
  // before any node is built. Drives the PhaseCards UI.
  app.post('/plan', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as { description?: string };
    const description = String(body.description ?? '').trim();
    if (!description) throw new AgentisError('VALIDATION_FAILED', 'plan requires a `description`');
    const inventory = await buildWorkspaceInventory({ db: deps.db }, ws.workspaceId);
    const classification = classifyIntent(description, inventory);
    return c.json({ plan: planWorkflow(description, classification) });
  });

  app.post('/import', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as { yaml?: string };
    if (!body.yaml || typeof body.yaml !== 'string') throw new AgentisError('VALIDATION_FAILED', 'import requires a `yaml` string');
    let doc: WorkflowDoc;
    try {
      doc = parse(body.yaml) as WorkflowDoc;
    } catch (err) {
      throw new AgentisError('VALIDATION_FAILED', `invalid YAML: ${(err as Error).message}`);
    }
    if (!doc || !doc.graph || !Array.isArray(doc.graph.nodes)) {
      throw new AgentisError('VALIDATION_FAILED', 'YAML must contain a `graph` with `nodes`');
    }
    const graph: WorkflowGraph = {
      version: 1,
      nodes: doc.graph.nodes,
      edges: Array.isArray(doc.graph.edges) ? doc.graph.edges : [],
      viewport: doc.graph.viewport ?? { x: 0, y: 0, zoom: 1 },
      ...(doc.graph.phases ? { phases: doc.graph.phases } : {}),
      ...(doc.graph.inputContract ? { inputContract: doc.graph.inputContract } : {}),
      ...(doc.graph.outputContract ? { outputContract: doc.graph.outputContract } : {}),
    };
    validateWorkflowGraph(graph); // reject bad graphs on import (CI-style gate)
    const id = randomUUID();
    const now = new Date().toISOString();
    deps.db.insert(schema.workflows).values({
      id, workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id,
      title: doc.name || 'Imported workflow', summary: doc.description ?? null, graph,
      settings: {}, concurrencyOverflow: 'queue', createdAt: now, updatedAt: now,
    }).run();
    return c.json({ workflowId: id, title: doc.name || 'Imported workflow', nodeCount: graph.nodes.length }, 201);
  });

  return app;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workflow';
}
