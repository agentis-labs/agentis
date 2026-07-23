/**
 * /v1/browser/real-chrome-control — per-workspace opt-in for letting agents
 * attach to and drive the user's REAL Chrome over CDP.
 *
 * OFF by default (an agent driving your logged-in Chrome is credential-grade
 * power). `master` reflects the deployment env override (AGENTIS_BROWSER_ALLOW_CDP):
 * true/false force the decision, null defers to this per-workspace switch — so the
 * UI can explain when the toggle is inert because the deployment forced it.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { isRealChromeControlEnabled, setRealChromeControlEnabled, realChromeEnvMaster } from '../services/browser/browserControlSettings.js';

const putSchema = z.object({ enabled: z.boolean() });

export function buildBrowserControlRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  const effective = (ws: string, enabled: boolean): boolean => {
    const master = realChromeEnvMaster();
    return master !== null ? master : enabled;
  };

  app.get('/real-chrome-control', (c) => {
    const ws = getWorkspace(c);
    const enabled = isRealChromeControlEnabled(deps.db, ws.workspaceId);
    return c.json({ enabled, master: realChromeEnvMaster(), effective: effective(ws.workspaceId, enabled) });
  });

  app.put('/real-chrome-control', async (c) => {
    const ws = getWorkspace(c);
    const body = putSchema.parse(await c.req.json());
    setRealChromeControlEnabled(deps.db, ws.workspaceId, body.enabled);
    return c.json({ enabled: body.enabled, master: realChromeEnvMaster(), effective: effective(ws.workspaceId, body.enabled) });
  });

  return app;
}
