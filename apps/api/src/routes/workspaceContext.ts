/**
 * Workspace context routes — view + edit the three persistent context files
 * (WORKSPACE.md / MEMORY.md / DECISIONS.md) that power Layer 1 Workspace
 * Intelligence. Surfaced in the UI as Settings > Workspace > Context.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkspaceIntelligenceService, ContextFileName } from '../services/workspaceIntelligence.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const FILES: ContextFileName[] = ['WORKSPACE.md', 'MEMORY.md', 'DECISIONS.md'];

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

  // All three files at once, plus the assembled block (what agents actually see).
  app.get('/', async (c) => {
    const ws = getWorkspace(c);
    const [workspace, memory, decisions, block] = await Promise.all([
      deps.intelligence.getContextFile(ws.workspaceId, 'WORKSPACE.md'),
      deps.intelligence.getContextFile(ws.workspaceId, 'MEMORY.md'),
      deps.intelligence.getContextFile(ws.workspaceId, 'DECISIONS.md'),
      deps.intelligence.buildContextBlock(ws.workspaceId),
    ]);
    return c.json({ files: { 'WORKSPACE.md': workspace, 'MEMORY.md': memory, 'DECISIONS.md': decisions }, contextBlock: block });
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
