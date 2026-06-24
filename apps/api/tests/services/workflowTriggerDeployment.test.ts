import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { TriggerRuntime } from '../../src/engine/TriggerRuntime.js';
import { WorkflowTriggerDeploymentService } from '../../src/services/workflowTriggerDeployment.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let activate: ReturnType<typeof vi.fn>;
let deactivate: ReturnType<typeof vi.fn>;
let service: WorkflowTriggerDeploymentService;

beforeEach(async () => {
  ctx = await createTestContext();
  activate = vi.fn(async (trigger: { triggerId: string }) => {
    ctx.db.update(schema.triggers).set({ status: 'active' }).where(eq(schema.triggers.id, trigger.triggerId)).run();
  });
  deactivate = vi.fn(async (triggerId: string) => {
    ctx.db.update(schema.triggers).set({ status: 'paused' }).where(eq(schema.triggers.id, triggerId)).run();
  });
  service = new WorkflowTriggerDeploymentService(ctx.db, {
    activate,
    deactivate,
    listeners: { health: vi.fn(() => ({ connected: true, eventCount: 0, fireCount: 0 })) },
  } as unknown as TriggerRuntime);
});

afterEach(() => ctx.close());

function seedWorkflow(graph: WorkflowGraph): string {
  const id = crypto.randomUUID();
  ctx.db.insert(schema.workflows).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'Automation',
    graph,
    settings: {},
  }).run();
  return id;
}

function graphWithTrigger(config: WorkflowGraph['nodes'][number]['config']): WorkflowGraph {
  return {
    version: 1,
    nodes: [{
      id: 'trigger',
      type: 'trigger',
      title: 'Trigger',
      position: { x: 0, y: 0 },
      config,
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

describe('WorkflowTriggerDeploymentService', () => {
  it('activates a cron node through the existing trigger runtime and links the graph', async () => {
    const workflowId = seedWorkflow(graphWithTrigger({
      kind: 'trigger',
      triggerType: 'cron',
      schedule: '*/5 * * * *',
      timezone: 'UTC',
    }));

    const deployment = await service.activate({
      workspaceId: ctx.workspace.id,
      workflowId,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
    });

    expect(deployment).toMatchObject({
      triggerType: 'cron',
      status: 'active',
      config: { expression: '*/5 * * * *', timezone: 'UTC' },
    });
    expect(activate).toHaveBeenCalledOnce();
    const workflow = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get()!;
    const trigger = (workflow.graph as WorkflowGraph).nodes[0]!.config;
    expect(trigger).toMatchObject({ triggerId: deployment.triggerId, schedule: '*/5 * * * *' });
  });

  it('activates an extension-backed persistent listener and exposes health', async () => {
    const extensionId = crypto.randomUUID();
    ctx.db.insert(schema.extensions).values({
      id: extensionId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      packageId: null,
      name: 'AI Website Watcher',
      slug: 'ai-website-watcher',
      version: '1.0.0',
      runtime: 'node_worker',
      manifest: {
        name: 'AI Website Watcher',
        slug: 'ai-website-watcher',
        version: '1.0.0',
        runtime: 'node_worker',
        source: 'export async function watch() {}',
        permissions: ['listener', 'listener.emit'],
        operations: [{
          name: 'watch',
          inputSchema: {},
          outputSchema: {},
          isListenerSource: true,
        }],
        capabilityTags: ['monitoring'],
      },
    }).run();
    const workflowId = seedWorkflow(graphWithTrigger({
      kind: 'trigger',
      triggerType: 'persistent_listener',
      listenerConfig: {
        source: {
          kind: 'extension',
          extensionId,
          operationName: 'watch',
          pollIntervalMs: 30_000,
        },
      },
    }));

    const deployment = await service.activate({
      workspaceId: ctx.workspace.id,
      workflowId,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
    });

    expect(deployment).toMatchObject({
      triggerType: 'persistent_listener',
      status: 'active',
      health: { connected: true },
      config: {
        source: { kind: 'extension', extensionId, operationName: 'watch' },
        predicate: { kind: 'always' },
        firePolicy: { mode: 'immediate' },
      },
    });
  });

  it('returns a webhook secret only when the endpoint is first created', async () => {
    const workflowId = seedWorkflow(graphWithTrigger({
      kind: 'trigger',
      triggerType: 'webhook',
    }));
    const args = {
      workspaceId: ctx.workspace.id,
      workflowId,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
    };

    const first = await service.activate(args);
    const second = await service.activate(args);

    expect(first.webhookSecret).toBeTruthy();
    expect(first.webhookUrl).toContain(first.triggerId);
    expect(second.webhookSecret).toBeUndefined();
    expect(second.triggerId).toBe(first.triggerId);
  });

  it('activates a manual workflow without invoking trigger runtime', async () => {
    const workflowId = seedWorkflow(graphWithTrigger({
      kind: 'trigger',
      triggerType: 'manual',
    }));

    const deployment = await service.activate({
      workspaceId: ctx.workspace.id,
      workflowId,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
    });

    expect(deployment).toMatchObject({
      triggerType: 'manual',
      status: 'active',
      config: {},
    });
    expect(activate).not.toHaveBeenCalled();
    const row = ctx.db.select().from(schema.triggers).where(eq(schema.triggers.workflowId, workflowId)).get();
    expect(row).toMatchObject({ triggerType: 'manual', status: 'active' });
  });
});
