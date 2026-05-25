/**
 * Builder Session §9 — create a workflow from a natural-language description over
 * HTTP (the non-chat twin of the `build_workflow` tool). Runs the full creation
 * pipeline (brief → synthesis → pre-flight) and streams the live canvas build
 * events so the Builder's right-pane canvas animates the graph in.
 *
 *   POST /v1/workflows/build  { description, title?, workflowId?, stream? }
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import type { AuthService } from '../services/auth.js';
import type { ToolHandlerDeps } from '../services/agentisToolHandlers/deps.js';
import { createWorkflowFromDescription } from '../services/agentisToolHandlers/build.js';
import type { WorkflowPlan } from '../services/creationPipeline.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

// An approved/edited plan from the Builder. Loose by design — it's advisory
// input we assemble deterministically (and still preflight-validate).
const planSchema = z.object({
  archetype: z.enum(['atomic', 'pipeline', 'orchestrated', 'enterprise']).default('pipeline'),
  phases: z.array(z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).default(''),
    nodeKinds: z.array(z.string()).default([]),
    agentRole: z.string().optional(),
    requiredCredential: z.string().optional(),
    model: z.string().optional(),
    estimatedCostCents: z.tuple([z.number(), z.number()]).default([0, 0]),
  })).max(20),
  totalEstimatedCostCents: z.tuple([z.number(), z.number()]).default([0, 0]),
  missingDependencies: z.array(z.string()).default([]),
  requiresConfirmation: z.boolean().default(false),
}).partial({ totalEstimatedCostCents: true, missingDependencies: true, requiresConfirmation: true });

export function buildWorkflowBuildRoutes(deps: { auth: AuthService; tools: ToolHandlerDeps }) {
  const app = new Hono();
  const mw = { db: deps.tools.db, auth: deps.auth };
  app.use('*', requireAuth(mw), requireWorkspace(mw));

  app.post('/build', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      description?: string; title?: string; workflowId?: string; stream?: boolean; plan?: unknown;
    };
    const description = String(body.description ?? '').trim();
    if (!description) throw new AgentisError('VALIDATION_FAILED', 'build requires a `description`');
    const plan = body.plan != null ? (planSchema.parse(body.plan) as WorkflowPlan) : undefined;
    const result = await createWorkflowFromDescription(deps.tools, {
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId ?? null,
      userId: ws.user.id,
      description,
      title: body.title,
      workflowId: body.workflowId ?? null,
      stream: body.stream !== false,
      plan,
    });
    return c.json(result, 201);
  });

  return app;
}
