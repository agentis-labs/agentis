/**
 * Mission Control routes (Agent-Native §3.6) — the read model behind the
 * cross-agent command center: living/resident agents, the subject pipeline (on the
 * Durable Entity spine), and per-variant experiment results. Read-only + workspace
 * scoped; thin projections over the spine + experiment services. Mounted at /v1/mission.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';
import type { DurableEntityService } from '../services/durableEntities.js';
import type { ExperimentService } from '../services/experiments.js';
import type { ConnectionGrantService } from '../services/connectionGrants.js';
import { readResidency } from '../services/residency.js';

export function buildMissionControlRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  durableEntities: DurableEntityService;
  experiments: ExperimentService;
  connectionGrants: ConnectionGrantService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  /** Resident agents (the living workers): who wakes on a clock, and their connection reach. */
  app.get('/agents', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db.select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role, status: schema.agents.status, config: schema.agents.config })
      .from(schema.agents).where(eq(schema.agents.workspaceId, ws.workspaceId)).all();
    const agents = rows.map((a) => {
      const res = readResidency(a.config);
      return {
        id: a.id, name: a.name, role: a.role, status: a.status,
        resident: res != null,
        intervalMinutes: res?.intervalMinutes ?? null,
        grants: deps.connectionGrants.listForAgent(ws.workspaceId, a.id).filter((g) => g.status === 'active').length,
      };
    });
    return c.json({ agents, residentCount: agents.filter((a) => a.resident).length });
  });

  /** The subject pipeline (durable actors on the spine): stage + status per subject. */
  app.get('/subjects', (c) => {
    const ws = getWorkspace(c);
    const subjects = deps.durableEntities.listByKind(ws.workspaceId, 'subject').map((e) => {
      const state = e.stateJson as { stage?: string; facts?: Record<string, unknown> };
      return {
        id: e.id, key: e.key, status: e.status,
        stage: state?.stage ?? null,
        name: (state?.facts?.name as string | undefined) ?? null,
        parked: e.nextWakeAt == null && e.status === 'active',
        updatedAt: e.updatedAt,
      };
    });
    // Group into a pipeline (by stage) for the board.
    const byStage: Record<string, number> = {};
    for (const s of subjects) byStage[s.stage ?? 'unknown'] = (byStage[s.stage ?? 'unknown'] ?? 0) + 1;
    return c.json({ subjects, byStage, total: subjects.length });
  });

  /** Every experiment with its per-variant success rate (the A/B dashboard). */
  app.get('/experiments', (c) => {
    const ws = getWorkspace(c);
    const experiments = deps.experiments.listExperiments(ws.workspaceId).map((e) => ({
      key: e.key,
      status: e.status,
      results: deps.experiments.results(ws.workspaceId, e.key)?.variants ?? [],
    }));
    return c.json({ experiments });
  });

  /** One-call headline summary for the top strip. */
  app.get('/summary', (c) => {
    const ws = getWorkspace(c);
    const subjects = deps.durableEntities.listByKind(ws.workspaceId, 'subject');
    const experiments = deps.experiments.listExperiments(ws.workspaceId);
    const residents = deps.db.select({ config: schema.agents.config }).from(schema.agents)
      .where(eq(schema.agents.workspaceId, ws.workspaceId)).all().filter((a) => readResidency(a.config)).length;
    return c.json({
      residentAgents: residents,
      subjects: subjects.length,
      activeSubjects: subjects.filter((s) => s.status === 'active').length,
      experiments: experiments.length,
    });
  });

  return app;
}
