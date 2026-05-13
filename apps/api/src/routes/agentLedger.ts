import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthService } from '../services/auth.js';
import type { AgentLedgerService } from '../services/agentLedger.js';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const columnSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  type: z.enum(['text', 'number', 'boolean', 'date', 'json']),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
});

const createTableSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  columns: z.array(columnSchema).min(1).max(50),
});

const rowWriteSchema = z.object({
  data: z.record(z.string(), z.unknown()),
  sourceAgentId: z.string().uuid().nullable().optional(),
  workflowId: z.string().uuid().nullable().optional(),
  runId: z.string().uuid().nullable().optional(),
});

const rowPatchSchema = z.object({
  data: z.record(z.string(), z.unknown()),
});

export function buildAgentLedgerRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; ledgerData: AgentLedgerService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({ tables: deps.ledgerData.listTables(ws.workspaceId) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createTableSchema.parse(await c.req.json());
    const table = deps.ledgerData.createTable({ workspaceId: ws.workspaceId, ...body });
    return c.json({ table }, 201);
  });

  app.get('/:tableId', (c) => {
    const ws = getWorkspace(c);
    const table = deps.ledgerData.getTable(ws.workspaceId, c.req.param('tableId'));
    return c.json({ table });
  });

  app.delete('/:tableId', (c) => {
    const ws = getWorkspace(c);
    const table = deps.ledgerData.archiveTable(ws.workspaceId, c.req.param('tableId'));
    return c.json({ table });
  });

  app.get('/:tableId/rows', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.ledgerData.queryRows({
      workspaceId: ws.workspaceId,
      tableId: c.req.param('tableId'),
      q: c.req.query('q'),
      agentId: c.req.query('agentId'),
      workflowId: c.req.query('workflowId'),
      runId: c.req.query('runId'),
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    });
    return c.json({ rows });
  });

  app.post('/:tableId/rows', async (c) => {
    const ws = getWorkspace(c);
    const body = rowWriteSchema.parse(await c.req.json());
    const row = deps.ledgerData.insertRow({
      workspaceId: ws.workspaceId,
      tableId: c.req.param('tableId'),
      ...body,
    });
    return c.json({ row }, 201);
  });

  app.patch('/:tableId/rows/:rowId', async (c) => {
    const ws = getWorkspace(c);
    const body = rowPatchSchema.parse(await c.req.json());
    const row = deps.ledgerData.updateRow(
      ws.workspaceId,
      c.req.param('tableId'),
      c.req.param('rowId'),
      body.data,
    );
    return c.json({ row });
  });

  app.delete('/:tableId/rows/:rowId', (c) => {
    const ws = getWorkspace(c);
    const row = deps.ledgerData.deleteRow(ws.workspaceId, c.req.param('tableId'), c.req.param('rowId'));
    return c.json({ row });
  });

  return app;
}
