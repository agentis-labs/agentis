/**
 * /v1/command/autonomy — per-workspace opt-in for the autonomous Command
 * Heartbeat (AUTONOMOUS-ORCHESTRATOR-COMMAND-MODEL Layer C).
 *
 * Autonomous action requires TWO switches ON: the deployment `master`
 * (env AGENTIS_COMMAND_AUTONOMY) AND this per-workspace `enabled`. The route
 * exposes/toggles the per-workspace switch and reports the master so the UI can
 * explain why the toggle is inert when the deployment hasn't enabled autonomy.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { isWorkspaceAutonomyEnabled, setWorkspaceAutonomy } from '../services/commandHeartbeat.js';

const putSchema = z.object({ enabled: z.boolean() });

export function buildCommandAutonomyRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; master: boolean }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/autonomy', (c) => {
    const ws = getWorkspace(c);
    const enabled = isWorkspaceAutonomyEnabled(deps.db, ws.workspaceId);
    // effective = both switches on — the only state in which managers actually act.
    return c.json({ enabled, master: deps.master, effective: enabled && deps.master });
  });

  app.put('/autonomy', async (c) => {
    const ws = getWorkspace(c);
    const body = putSchema.parse(await c.req.json());
    setWorkspaceAutonomy(deps.db, ws.workspaceId, body.enabled);
    return c.json({ enabled: body.enabled, master: deps.master, effective: body.enabled && deps.master });
  });

  return app;
}
