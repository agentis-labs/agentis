import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { hydrateAgentRuntimes } from '../../src/services/agent/agentRuntimeHydrator.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

describe('hydrateAgentRuntimes', () => {
  it('parks a needs-config runtime offline (needs setup), never leaving it setting_up', async () => {
    // An http agent with empty config is MISSING REQUIRED CONNECTION CONFIG (a
    // baseUrl/dispatch the operator must supply), not broken at runtime. The
    // hydrator classifies this as "needs setup" and parks it `offline` (with an
    // info log) rather than `error` — so an imported App whose agents lack their
    // connection details doesn't look catastrophically broken. A genuine runtime
    // failure (non-config) still resolves to `error`.
    const agentId = randomUUID();
    const { events, stop } = ctx.captureBus();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Unconfigured HTTP Agent',
      adapterType: 'http',
      capabilityTags: [],
      config: {},
      status: 'online',
    }).run();

    try {
      await hydrateAgentRuntimes({
        db: ctx.db,
        vault: ctx.vault,
        adapters: new AdapterManager(ctx.logger),
        logger: ctx.logger,
        bus: ctx.bus,
      });
    } finally {
      stop();
    }

    const row = ctx.db
      .select({ status: schema.agents.status })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .get();
    expect(row?.status).toBe('offline');
    expect(events
      .map((event) => event.payload && typeof event.payload === 'object'
        ? (event.payload as { status?: string }).status
        : undefined))
      .not.toContain('setting_up');
  });
});
