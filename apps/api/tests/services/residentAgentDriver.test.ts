/**
 * ResidentAgentDriver — residency folded onto the Durable Entity spine (§3.1). Proves
 * the fold: the reconciler mints one `agent` entity per resident+autonomy agent, the
 * dispatcher wakes it (carrying its state) and reschedules, and de-residency/autonomy-off
 * terminates it — all on the ONE dispatcher, no separate residency sweep, no double-drive.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { DurableEntityService, DurableEntityDispatcher } from '../../src/services/durableEntities.js';
import { AgentSessionService } from '../../src/services/agentSession.js';
import { ResidentAgentDriver, AGENT_ENTITY_KIND } from '../../src/services/residentAgentDriver.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function seedAgent(config?: unknown): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Scout', adapterType: 'http',
    ...(config !== undefined ? { config } : {}),
  } as typeof schema.agents.$inferInsert).run();
  return id;
}

function setResidency(agentId: string, config: unknown) {
  ctx.db.update(schema.agents).set({ config: config as never }).where(eq(schema.agents.id, agentId)).run();
}

function makeDriver(opts: { autonomy: boolean; woke: string[] }) {
  const svc = new DurableEntityService(ctx.db);
  const sessions = new AgentSessionService(ctx.db, ctx.logger);
  const driver = new ResidentAgentDriver(svc, {
    db: ctx.db,
    wakeAgent: ({ message }) => { opts.woke.push(message); },
    residentState: (ws, agent) => sessions.residentState(ws, agent),
    autonomyEnabled: () => opts.autonomy,
  });
  return { svc, sessions, driver };
}

describe('ResidentAgentDriver', () => {
  it('reconcile mints an agent entity only for resident + autonomy-enabled agents', () => {
    const { svc, driver } = makeDriver({ autonomy: true, woke: [] });
    const resident = seedAgent({ residency: { enabled: true, intervalMinutes: 5 } });
    seedAgent(); // not resident
    seedAgent({ residency: { enabled: false } });
    driver.reconcile();
    expect(svc.getByKey(ctx.workspace.id, AGENT_ENTITY_KIND, resident)).toBeTruthy();
    expect(svc.listByKind(ctx.workspace.id, AGENT_ENTITY_KIND)).toHaveLength(1);
  });

  it('autonomy off → no agent entities', () => {
    const { svc, driver } = makeDriver({ autonomy: false, woke: [] });
    seedAgent({ residency: { enabled: true, intervalMinutes: 5 } });
    driver.reconcile();
    expect(svc.listByKind(ctx.workspace.id, AGENT_ENTITY_KIND)).toHaveLength(0);
  });

  it('on the dispatcher: reconcile → wake (carrying state) → reschedule, all in one tick', async () => {
    const woke: string[] = [];
    const { svc, sessions, driver } = makeDriver({ autonomy: true, woke });
    const agentId = seedAgent({ residency: { enabled: true, intervalMinutes: 5, wake: 'message new leads' } });
    sessions.rememberResident(ctx.workspace.id, agentId, { plan: 'work the pipeline', observations: 'lead #7 awaiting reply' });

    const disp = new DurableEntityDispatcher(svc, { logger: ctx.logger });
    disp.registerHandler(AGENT_ENTITY_KIND, driver.handler);
    disp.registerReconciler(() => driver.reconcile());

    expect(await disp.tick()).toBe(1);
    expect(woke).toHaveLength(1);
    expect(woke[0]).toContain('message new leads');    // the standing wake instruction
    expect(woke[0]).toContain('work the pipeline');     // carried plan
    expect(woke[0]).toContain('lead #7 awaiting reply'); // carried observations

    // Rescheduled into the future → not due again this instant (interval not elapsed).
    const entity = svc.getByKey(ctx.workspace.id, AGENT_ENTITY_KIND, agentId)!;
    expect(Date.parse(entity.nextWakeAt!)).toBeGreaterThan(Date.now());
    expect(await disp.tick()).toBe(0);
    expect(woke).toHaveLength(1);
  });

  it('de-residency terminates the agent entity (stops waking)', async () => {
    const woke: string[] = [];
    const { svc, driver } = makeDriver({ autonomy: true, woke });
    const agentId = seedAgent({ residency: { enabled: true, intervalMinutes: 5 } });
    driver.reconcile();
    const entity = svc.getByKey(ctx.workspace.id, AGENT_ENTITY_KIND, agentId)!;

    // Operator disables residency; the handler must terminate the entity on wake.
    setResidency(agentId, { residency: { enabled: false } });
    const result = await driver.handler({ entity, inbox: [] });
    expect(result).toMatchObject({ done: true });
  });
});
