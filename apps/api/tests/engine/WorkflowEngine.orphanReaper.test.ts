/**
 * reapOrphanedRuns — a run whose owning workflow no longer exists (deleted
 * workflow / app deletion that orphaned its workflows) can never resume or be
 * controlled. The reaper CANCELs exactly those, and NEVER touches a run whose
 * workflow is still live (a legitimately-parked run). (LIVING-INTERFACES-COCKPIT-10X §4.2.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;

beforeEach(async () => {
  // FK off: we intentionally seed a run pointing at a workflow row that does not exist.
  ctx = await createTestContext({ foreignKeysOff: true });
  engine = new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    skills: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
  });
});

afterEach(() => ctx.close());

function seedRun(workflowId: string, status: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflowRuns).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    status: status as never,
    runState: { status, activeExecutions: {} } as unknown as object,
  }).run();
  return id;
}

describe('reapOrphanedRuns', () => {
  it('CANCELs a non-terminal run whose owning workflow is gone', () => {
    const orphan = seedRun('does-not-exist', 'RUNNING');
    const capture = ctx.captureBus();

    const { reaped } = engine.reapOrphanedRuns();

    expect(reaped).toBe(1);
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, orphan)).get();
    expect(row?.status).toBe('CANCELLED');
    expect(row?.completedAt).toBeTruthy();
    expect(capture.events.some((e) => e.envelope.event === REALTIME_EVENTS.RUN_CANCELLED)).toBe(true);
    capture.stop();
  });

  it('NEVER touches a run whose workflow still exists (a legitimately-parked run)', () => {
    const wfId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      title: 'live', graph: { version: 1, nodes: [], edges: [] } as unknown as object, settings: {},
    }).run();
    const parked = seedRun(wfId, 'WAITING');

    const { reaped } = engine.reapOrphanedRuns();

    expect(reaped).toBe(0);
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, parked)).get();
    expect(row?.status).toBe('WAITING');
  });

  it('leaves terminal runs alone and is idempotent', () => {
    seedRun('does-not-exist', 'COMPLETED');
    const first = engine.reapOrphanedRuns();
    const second = engine.reapOrphanedRuns();
    expect(first.reaped).toBe(0); // COMPLETED is terminal → out of scope
    expect(second.reaped).toBe(0);
  });
});
