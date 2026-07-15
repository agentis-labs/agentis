import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import type { AgentisToolContext, WorkflowGraph } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerOrchestrationRuleTools } from '../../src/services/agentisToolHandlers/orchestrationRules.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

const GRAPH: WorkflowGraph = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [{ id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } }],
  edges: [],
};

function toolContext(): AgentisToolContext {
  return { workspaceId: ctx.workspace.id, userId: ctx.user.id, caller: 'mcp' };
}

function registry(): AgentisToolRegistry {
  const result = new AgentisToolRegistry({ logger: ctx.logger });
  registerOrchestrationRuleTools(result, { db: ctx.db } as ToolHandlerDeps);
  return result;
}

function workflow(appId: string, title: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id,
    appId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title,
    description: title,
    graph: GRAPH,
    settings: {},
  }).run();
  return id;
}

describe('agentis.workflow.rule', () => {
  it('persists a business-success event rule and lists it by App', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Rules' }).id;
    const source = workflow(appId, 'Source');
    const target = workflow(appId, 'Target');
    const tools = registry();
    const created = await tools.execute({ id: '', toolId: 'agentis.workflow.rule', arguments: {
      action: 'upsert', appId, sourceWorkflowId: source, targetWorkflowId: target,
      eventType: 'run.accomplished', inputMapping: { upstreamRunId: 'run.id' },
    } }, toolContext());
    expect(created.ok).toBe(true);
    expect(created.output).toMatchObject({ persisted: true, semantic: 'business_success' });

    const listed = await tools.execute({ id: '', toolId: 'agentis.workflow.rule', arguments: { action: 'list', appId } }, toolContext());
    expect(listed.output).toMatchObject({ count: 1, rules: [{ sourceWorkflowId: source, targetWorkflowId: target, eventType: 'run.accomplished' }] });
  });

  it('labels run.completed as execution-only rather than verified success', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Completion' }).id;
    const result = await registry().execute({ id: '', toolId: 'agentis.workflow.rule', arguments: {
      action: 'upsert', appId, sourceWorkflowId: workflow(appId, 'A'), targetWorkflowId: workflow(appId, 'B'), eventType: 'run.completed',
    } }, toolContext());
    expect(result.output).toMatchObject({ semantic: 'execution_completion_only' });
    expect((result.output as { warning: string }).warning).toMatch(/does not prove/i);
  });

  it('rejects unsafe self-triggering enqueue loops', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Loop' }).id;
    const same = workflow(appId, 'Same');
    const result = await registry().execute({ id: '', toolId: 'agentis.workflow.rule', arguments: {
      action: 'upsert', appId, sourceWorkflowId: same, targetWorkflowId: same, eventType: 'run.accomplished',
    } }, toolContext());
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/self-triggering/i);
  });
});
