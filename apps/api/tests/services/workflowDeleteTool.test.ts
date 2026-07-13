/**
 * agentis.workflow.delete — confirm-gated permanent deletion of a workflow and
 * its run history. Closes the "no workflow-delete operation" gap the agent hit
 * (it could delete an App but never a bare/superseded workflow).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { WorkflowGraph, AgentisToolContext } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerBuildTools } from '../../src/services/agentisToolHandlers/build.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: AgentisToolRegistry;

beforeEach(async () => {
  ctx = await createTestContext();
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const activity = new ActivityFeedService(ctx.db, ctx.bus);
  const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  const adapters = new AdapterManager(ctx.logger);
  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger, ledger, scratchpad, activity, approvals,
    skills: {} as unknown as ExtensionRuntime, adapters,
  });
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  registerBuildTools(registry, {
    db: ctx.db, logger: ctx.logger, bus: ctx.bus, engine, adapters, ledger, scratchpad, approvals, activity,
    replay: {} as ToolHandlerDeps['replay'],
  } as ToolHandlerDeps);
});
afterEach(() => ctx.close());

function toolCtx(): AgentisToolContext {
  return { workspaceId: ctx.workspace.id, userId: ctx.user.id, caller: 'mcp' };
}

const GRAPH: WorkflowGraph = {
  version: 1, viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [{ id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } }],
  edges: [],
};

function seedWorkflow(title: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title, description: title, graph: GRAPH, settings: {},
  }).run();
  return id;
}

function seedTerminalRun(workflowId: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflowRuns).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id,
    status: 'COMPLETED', runState: {},
  }).run();
  return id;
}

const exists = (workflowId: string) =>
  Boolean(ctx.db.select({ id: schema.workflows.id }).from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get());
const runCount = (workflowId: string) =>
  ctx.db.select({ id: schema.workflowRuns.id }).from(schema.workflowRuns).where(eq(schema.workflowRuns.workflowId, workflowId)).all().length;

describe('agentis.workflow.delete', () => {
  it('previews without deleting, then permanently deletes on confirm — cascading runs', async () => {
    const wid = seedWorkflow('Superseded');
    seedTerminalRun(wid);
    seedTerminalRun(wid);
    expect(runCount(wid)).toBe(2);

    // Preview — nothing removed.
    const preview = await registry.execute({ id: '', toolId: 'agentis.workflow.delete', arguments: { workflowId: wid } }, toolCtx());
    expect(preview.output).toMatchObject({ deleted: false, preview: true });
    expect((preview.output as { willRemove: string }).willRemove).toMatch(/2 run/);
    expect(exists(wid)).toBe(true);

    // Confirm — gone, and its runs cascade-deleted.
    const del = await registry.execute({ id: '', toolId: 'agentis.workflow.delete', arguments: { workflowId: wid, confirm: true } }, toolCtx());
    expect((del.output as { deleted: boolean }).deleted).toBe(true);
    expect(exists(wid)).toBe(false);
    expect(runCount(wid)).toBe(0);
  });

  it('errors on an unknown workflow id', async () => {
    const res = await registry.execute({ id: '', toolId: 'agentis.workflow.delete', arguments: { workflowId: 'nope', confirm: true } }, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toMatch(/not found/i);
  });
});
