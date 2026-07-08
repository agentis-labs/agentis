/**
 * Workspace context routes - view + edit operator-authored workspace docs.
 * Runtime memory is DB-backed and exposed through brain/memory routes.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkspaceIntelligenceService, ContextFileName } from '../services/workspace/workspaceIntelligence.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const FILES: ContextFileName[] = ['WORKSPACE.md', 'DECISIONS.md', 'WORKFLOW.md'];

const putSchema = z.object({ content: z.string().max(200_000) });

function isContextFile(value: string): value is ContextFileName {
  return (FILES as string[]).includes(value);
}

export function buildWorkspaceContextRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  intelligence: WorkspaceIntelligenceService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', async (c) => {
    const ws = getWorkspace(c);
    const [workspace, decisions, workflow, block] = await Promise.all([
      deps.intelligence.getContextFile(ws.workspaceId, 'WORKSPACE.md'),
      deps.intelligence.getContextFile(ws.workspaceId, 'DECISIONS.md'),
      deps.intelligence.getContextFile(ws.workspaceId, 'WORKFLOW.md'),
      deps.intelligence.buildContextBlock(ws.workspaceId),
    ]);
    return c.json({
      files: {
        'WORKSPACE.md': workspace,
        'DECISIONS.md': decisions,
        'WORKFLOW.md': workflow,
      },
      contextBlock: block,
    });
  });

  app.get('/:file', async (c) => {
    const ws = getWorkspace(c);
    const file = c.req.param('file');
    if (!isContextFile(file)) throw new AgentisError('RESOURCE_NOT_FOUND', `Unknown context file: ${file}`);
    const content = await deps.intelligence.getContextFile(ws.workspaceId, file);
    return c.json({ file, content });
  });

  app.put('/:file', async (c) => {
    const ws = getWorkspace(c);
    const file = c.req.param('file');
    if (!isContextFile(file)) throw new AgentisError('RESOURCE_NOT_FOUND', `Unknown context file: ${file}`);
    const body = putSchema.parse(await c.req.json());
    await deps.intelligence.setContextFile(ws.workspaceId, file, body.content);
    return c.json({ file, ok: true });
  });

  return app;
}
