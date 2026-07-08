/**
 * Observability must never drop a telemetry event because the entity it
 * describes isn't persisted yet. A `workflow.build.phase` event fires WHILE a
 * workflow is being built — its workflowId has no row until the build commits —
 * and the FK on observability_events.workflow_id used to abort the insert
 * ("FOREIGN KEY constraint failed"), silently losing every build-phase event.
 * The record path now nulls out any dangling reference and still records.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { ObservabilityService } from '../../src/services/observability.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let service: ObservabilityService;

beforeEach(async () => {
  ctx = await createTestContext();
  service = new ObservabilityService(ctx.db, ctx.bus, ctx.logger);
});

afterEach(() => {
  ctx.close();
});

describe('ObservabilityService FK resilience', () => {
  it('records an event whose workflowId is not yet persisted (nulls the ref, no throw)', () => {
    const ghostWorkflowId = randomUUID();
    expect(() =>
      service.record({
        workspaceId: ctx.workspace.id,
        kind: 'workflow',
        status: 'info',
        title: 'Drafting the workflow graph',
        sourceEvent: 'workflow.build.phase',
        workflowId: ghostWorkflowId, // no such row yet — mid-build
      }),
    ).not.toThrow();

    const persisted = ctx.db
      .select()
      .from(schema.observabilityEvents)
      .where(eq(schema.observabilityEvents.sourceEvent, 'workflow.build.phase'))
      .all();
    expect(persisted).toHaveLength(1);
    // The dangling reference was nulled — the event survives, linkage is best-effort.
    expect(persisted[0]!.workflowId).toBeNull();
    expect(persisted[0]!.title).toBe('Drafting the workflow graph');
  });

  it('keeps a workflowId that DOES exist', () => {
    const workflowId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'Real workflow',
      graph: { nodes: [], edges: [] },
    } as typeof schema.workflows.$inferInsert).run();

    service.record({
      workspaceId: ctx.workspace.id,
      kind: 'workflow',
      status: 'success',
      title: 'Workflow ready',
      sourceEvent: 'workflow.build.complete',
      workflowId,
    });

    const row = ctx.db
      .select()
      .from(schema.observabilityEvents)
      .where(eq(schema.observabilityEvents.sourceEvent, 'workflow.build.complete'))
      .get();
    expect(row?.workflowId).toBe(workflowId);
  });
});
