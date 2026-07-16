import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore } from '@agentis/app';
import type { AgentisToolContext, WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerRunTools } from '../../src/services/agentisToolHandlers/run.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

describe('workflow run App compile admission', () => {
  it('blocks a paid debug run before execution when its App has deterministic proof gaps', async () => {
    const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Compile gate' });
    const workflowId = randomUUID();
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'result', type: 'return_output', title: 'Result', position: { x: 200, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
      ],
      edges: [{ id: 'edge', source: 'trigger', target: 'result' }],
    };
    ctx.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      appId: app.id,
      title: 'Uncompiled',
      graph,
      settings: {},
    }).run();
    let starts = 0;
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerRunTools(registry, {
      db: ctx.db,
      logger: ctx.logger,
      bus: ctx.bus,
      engine: { startRun: async () => { starts += 1; throw new Error('must not execute'); } } as unknown as ToolHandlerDeps['engine'],
      adapters: {} as ToolHandlerDeps['adapters'],
      ledger: { listForRun: async () => [] } as unknown as ToolHandlerDeps['ledger'],
      scratchpad: {} as ToolHandlerDeps['scratchpad'],
      approvals: { list: () => [] } as unknown as ToolHandlerDeps['approvals'],
      activity: {} as ToolHandlerDeps['activity'],
      replay: {} as ToolHandlerDeps['replay'],
    });
    const toolContext: AgentisToolContext = {
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      caller: 'chat',
    };

    const result = await registry.execute({
      id: 'run-blocked',
      toolId: 'agentis.workflow.run',
      arguments: { workflowId, debugRun: true },
    }, toolContext);

    expect(result.ok).toBe(false);
    expect(starts).toBe(0);
    expect(result.errorMessage).toContain('APP_COMPILE_BLOCKED');
  });
});
