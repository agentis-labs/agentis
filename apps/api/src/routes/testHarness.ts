/**
 * /v1/_test/reset — Playwright harness only.
 *
 * Mounted exclusively when `AGENTIS_TEST_MODE=true`. Wipes every domain
 * table, then re-runs the seed so the operator + Personal workspace +
 * Local ambient come back with a deterministic password.
 *
 * Unauthenticated by design — Playwright invokes it before the login spec
 * runs. The mount-guard in `bootstrap.ts` is the only thing standing
 * between this and a production deployment.
 */

import { Hono } from 'hono';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { AgentisEnv } from '../env.js';
import type { Logger } from '../logger.js';
import { seedIfEmpty } from '../services/seed.js';

export function buildTestHarnessRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  env: AgentisEnv;
  logger: Logger;
}) {
  const app = new Hono();

  app.post('/reset', async (c) => {
    // Order matters: child rows first to satisfy FK if they're enabled.
    deps.db.delete(schema.ledgerEvents).run();
    deps.db.delete(schema.activityEvents).run();
    deps.db.delete(schema.approvalRequests).run();
    deps.db.delete(schema.tasks).run();
    deps.db.delete(schema.workflowRunSnapshots).run();
    deps.db.delete(schema.workflowRuns).run();
    deps.db.delete(schema.workflows).run();
    deps.db.delete(schema.conversationMessages).run();
    deps.db.delete(schema.conversations).run();
    deps.db.delete(schema.installedRegistryArtifacts).run();
    deps.db.delete(schema.webhookDeliveries).run();
    deps.db.delete(schema.channelDeliveries).run();
    deps.db.delete(schema.channelConnections).run();
    deps.db.delete(schema.triggers).run();
    deps.db.delete(schema.credentials).run();
    deps.db.delete(schema.skillExecutions).run();
    deps.db.delete(schema.skills).run();
    deps.db.delete(schema.agentPackages).run();
    deps.db.delete(schema.openclawGateways).run();
    deps.db.delete(schema.agents).run();
    deps.db.delete(schema.ambients).run();
    deps.db.delete(schema.workspaces).run();
    deps.db.delete(schema.users).run();

    const seed = await seedIfEmpty({
      db: deps.db,
      env: deps.env,
      auth: deps.auth,
      logger: deps.logger,
    });

    return c.json({
      ok: true,
      user: seed?.user ?? null,
      workspace: seed?.workspace ?? null,
      ambient: seed?.ambient ?? null,
    });
  });

  return app;
}
