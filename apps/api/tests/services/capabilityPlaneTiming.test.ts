/**
 * Capability plane — temporal self-model at DISCOVERY (ORCHESTRATOR-SUSPEND-10X
 * follow-up B). agentis.capability.load surfaces how long a workflow typically
 * takes, from its own finished-run history, on the specific hit the agent is
 * weighing — so it chooses (and plans the wait) with real numbers, not guesses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AgentisToolContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerCapabilityPlaneTools } from '../../src/services/agentisToolHandlers/capabilityPlane.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: AgentisToolRegistry;
let workflowRunArgs: Array<Record<string, unknown>>;

function toolCtx(): AgentisToolContext {
  return { workspaceId: ctx.workspace.id, caller: 'agent' } as unknown as AgentisToolContext;
}

function seedWorkflow(): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, userId: ctx.user.id, title: 'Nightly Report',
    graph: { nodes: [{ id: 'n1', type: 'agent_task', title: 'Step', config: { kind: 'agent_task' } }], edges: [] },
  }).run();
  return id;
}

function seedRun(workflowId: string, durationMs: number): void {
  const start = Date.parse('2026-06-29T10:00:00.000Z');
  ctx.db.insert(schema.workflowRuns).values({
    id: randomUUID(), workspaceId: ctx.workspace.id, workflowId, userId: ctx.user.id, status: 'COMPLETED',
    runState: { nodeStates: {} },
    startedAt: new Date(start).toISOString(),
    completedAt: new Date(start + durationMs).toISOString(),
  }).run();
}

beforeEach(async () => {
  ctx = await createTestContext();
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  workflowRunArgs = [];
  registry.register({
    id: 'agentis.workflow.run',
    family: 'run',
    description: 'fixture workflow runner',
    inputSchema: { type: 'object' },
    mutating: true,
  }, (args) => {
    workflowRunArgs.push(args);
    return { runId: 'run-fixture', ...args };
  });
  registerCapabilityPlaneTools(registry, { db: ctx.db, logger: ctx.logger } as unknown as ToolHandlerDeps);
});
afterEach(() => ctx.close());

describe('agentis.capability.load timing', () => {
  it('attaches typical duration to a workflow once it has enough finished runs', async () => {
    const wf = seedWorkflow();
    for (const d of [4_000, 6_000, 5_000]) seedRun(wf, d);

    const res = await registry.execute({ toolId: 'agentis.capability.load', arguments: { urn: `wf:${wf}` } }, toolCtx());
    expect(res.ok).toBe(true);
    const loaded = (res.output as { loaded: Array<{ kind: string; timing?: { typicalMs: number; summary: string } }> }).loaded;
    expect(loaded[0]!.kind).toBe('workflow');
    expect(loaded[0]!.timing).toBeDefined();
    expect(loaded[0]!.timing!.typicalMs).toBe(5_000);
    expect(loaded[0]!.timing!.summary).toContain('typically');
  });

  it('omits timing when there is not enough finished history', async () => {
    const wf = seedWorkflow();
    seedRun(wf, 5_000); // only one sample (< 3)

    const res = await registry.execute({ toolId: 'agentis.capability.load', arguments: { urn: `wf:${wf}` } }, toolCtx());
    const loaded = (res.output as { loaded: Array<{ timing?: unknown }> }).loaded;
    expect(loaded[0]!.timing).toBeUndefined();
  });

  it('forwards atomic waitMode and timeout through capability.invoke to workflow.run', async () => {
    const wf = seedWorkflow();
    const res = await registry.execute({
      toolId: 'agentis.capability.invoke',
      arguments: { urn: `wf:${wf}`, input: { report: 'weekly' }, waitMode: 'inline', timeoutMs: 42_000 },
    }, toolCtx());

    expect(res.ok).toBe(true);
    expect(workflowRunArgs).toHaveLength(1);
    expect(workflowRunArgs[0]).toMatchObject({
      workflowId: wf,
      inputs: { report: 'weekly' },
      waitMode: 'inline',
      timeoutMs: 42_000,
    });
  });
});
