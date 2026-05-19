import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerBuildTools } from '../../src/services/agentisToolHandlers/build.js';
import { PackagerService } from '../../src/services/packager.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  ctx.close();
});

function seedDraftApp() {
  const packager = new PackagerService({ db: ctx.db, bus: ctx.bus });
  const contents = {
    kind: 'agentis',
    agents: [],
    skills: [],
    workflows: [],
    integrations: [],
    credentialSlots: [],
    datasetSpecs: [],
    knowledgeSeeds: [],
    memorySeeds: [],
    evaluatorRubrics: [],
    evaluatorExampleSeeds: [],
    workflowBaselines: [],
    runtimeEpisodeSeeds: [],
    screenshotUrls: [],
    crossAppDependencies: [],
    category: 'Sales',
    description: '',
    summary: 'Draft SDR app',
    iconGlyph: 'SD',
    iconColor: '#34d399',
    creationMode: 'orchestrated_draft',
    surfaces: [{ type: 'thread' }],
    appGraphTemplate: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  } as const;

  const scope = { workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id };
  const pkg = packager.create(scope, { name: 'Draft SDR', version: '1.0.0', tags: ['orchestrated-draft'] }, 'agentis', contents);
  const used = packager.usePackage(scope, pkg.id);
  const app = ctx.db.select().from(schema.appInstances).where(eq(schema.appInstances.id, used.resourceId)).get();
  if (!app) throw new Error('failed to seed draft app');
  return app;
}

function buildRegistry() {
  const registry = new AgentisToolRegistry({ logger: ctx.logger });
  registerBuildTools(registry, {
    db: ctx.db,
    logger: ctx.logger,
    bus: ctx.bus,
  } as never);
  return registry;
}

describe('agentis.app.compose', () => {
  it('updates an existing draft app, creates collaborators, and publishes canvas refresh events', async () => {
    const draft = seedDraftApp();
    const capture = ctx.captureBus();
    const registry = buildRegistry();

    try {
      const result = await registry.execute(
        {
          id: 'compose-1',
          toolId: 'agentis.app.compose',
          arguments: {
            appId: draft.id,
            name: 'Zero-Inbox SDR Engine',
            goal: 'Monitor buying signals, research prospects, draft outreach, and log replies.',
            description: 'Autonomous SDR system with signal detection, outreach, and response handling.',
            surfaces: [{ type: 'thread' }, { type: 'dashboard', label: 'Pipeline' }],
            agents: [
              {
                name: 'Prospect Researcher',
                role: 'worker',
                capabilityTags: ['research', 'sales'],
              },
            ],
          },
        },
        {
          workspaceId: ctx.workspace.id,
          ambientId: ctx.ambient.id,
          userId: ctx.user.id,
          caller: 'chat',
          agentId: 'orchestrator',
          conversationId: 'conv-build',
        } as never,
      );

      if (!result.ok) throw new Error(`${result.errorCode}: ${result.errorMessage}`);
      const output = result.ok ? result.output as { entryWorkflowId: string; createdAgentIds: string[]; canvasPath: string } : null;
      expect(output?.entryWorkflowId).toBeTruthy();
      expect(output?.createdAgentIds).toHaveLength(1);
      expect(output?.canvasPath).toBe(`/apps/${draft.slug}?layer=canvas`);

      const updated = ctx.db.select().from(schema.appInstances).where(eq(schema.appInstances.id, draft.id)).get();
      expect(updated?.name).toBe('Zero-Inbox SDR Engine');
      expect(updated?.status).toBe('active');
      expect(updated?.entryWorkflowId).toBe(output?.entryWorkflowId);

      const contents = updated!.packageContents as Record<string, unknown>;
      expect(contents.description).toBe('Autonomous SDR system with signal detection, outreach, and response handling.');
      expect(contents.surfaces).toEqual([{ type: 'thread' }, { type: 'dashboard', label: 'Pipeline' }]);
      expect((contents.appGraphTemplate as { nodes: unknown[] }).nodes.length).toBeGreaterThan(0);

      const agent = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, output!.createdAgentIds[0]!)).get();
      expect(agent?.name).toBe('Prospect Researcher');
      expect((agent?.config as Record<string, unknown>).appId).toBe(draft.id);

      expect(capture.events).toContainEqual(expect.objectContaining({
        room: REALTIME_ROOMS.workspace(ctx.workspace.id),
        envelope: expect.objectContaining({
          event: REALTIME_EVENTS.APP_CANVAS_UPDATED,
          payload: expect.objectContaining({ appId: draft.id, slug: draft.slug }),
        }),
      }));
      expect(capture.events).toContainEqual(expect.objectContaining({
        room: REALTIME_ROOMS.app(draft.id),
        envelope: expect.objectContaining({
          event: REALTIME_EVENTS.APP_CANVAS_UPDATED,
          payload: expect.objectContaining({ appId: draft.id, slug: draft.slug }),
        }),
      }));
    } finally {
      capture.stop();
    }
  });
});
