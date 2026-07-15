import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore } from '@agentis/app';
import type { AgentisToolContext, WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerAppDoctorTools } from '../../src/services/agentisToolHandlers/appDoctor.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

describe('agentis.app.doctor', () => {
  it('is read-only, workspace-scoped, and returns structured remediation', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Doctor fixture' }).id;
    const graph: WorkflowGraph = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] };
    ctx.db.insert(schema.workflows).values({
      id: 'wf-1', workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      appId, title: 'Missing trigger', graph, settings: {},
    }).run();
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerAppDoctorTools(registry, { db: ctx.db } as ToolHandlerDeps);
    const toolContext: AgentisToolContext = { workspaceId: ctx.workspace.id, userId: ctx.user.id, caller: 'mcp' };
    const result = await registry.execute({ id: 'call', toolId: 'agentis.app.doctor', arguments: { appId } }, toolContext);

    if (!result.ok) throw new Error(result.errorMessage);
    expect(result.ok).toBe(true);
    const report = result.output as { health: string; findings: Array<{ code: string; remediation: { operation: string } }> };
    expect(report.health).toBe('broken');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ACTIVATION_NO_TRIGGER_NODE', remediation: expect.objectContaining({ operation: 'workflow.graph.patch' }) }),
    ]));
  });
});
