import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { BudgetService } from '../services/budget.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const budgetPatchSchema = z.object({
  monthlyBudgetCents: z.number().int().nonnegative().nullable().optional(),
  budgetResetDay: z.number().int().min(1).max(28).optional(),
});
const spendSchema = z.object({ agentId: z.string().uuid(), runId: z.string().uuid().nullable().optional(), amountCents: z.number().int().nonnegative() });
const extensionSchema = spendSchema.omit({ amountCents: true }).extend({ amountCents: z.number().int().positive() });

export function buildBudgetRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; budget: BudgetService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => c.json(deps.budget.list(getWorkspace(c).workspaceId)));

  app.patch('/agents/:id', async (c) => {
    const ws = getWorkspace(c);
    const body = budgetPatchSchema.parse(await c.req.json());
    deps.db.update(schema.agents).set({ ...body, updatedAt: new Date().toISOString() }).where(eq(schema.agents.id, c.req.param('id'))).run();
    return c.json({ ok: true });
  });

  app.post('/spend', async (c) => {
    const ws = getWorkspace(c);
    const body = spendSchema.parse(await c.req.json());
    return c.json({ event: deps.budget.recordSpend({ workspaceId: ws.workspaceId, ...body }) });
  });

  app.post('/extension', async (c) => {
    const ws = getWorkspace(c);
    const body = extensionSchema.parse(await c.req.json());
    return c.json({ event: deps.budget.grantExtension({ workspaceId: ws.workspaceId, ...body }) });
  });

  return app;
}
