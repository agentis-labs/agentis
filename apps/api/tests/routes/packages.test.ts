import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { buildPackageRoutes } from '../../src/routes/packages.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

function app() {
  return ctx.buildApp([
    { path: '/v1/packages', app: buildPackageRoutes({ db: ctx.db, auth: ctx.auth, bus: ctx.bus }) },
  ]);
}

function seedWorkflow() {
  const id = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'Nightly Review',
      description: 'Review the day and prepare a short brief.',
      graph: {
        version: 1,
        nodes: [
          {
            id: 'manual',
            type: 'trigger',
            title: 'Manual',
            position: { x: 0, y: 0 },
            config: { kind: 'trigger', triggerType: 'manual' },
          },
        ],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      settings: { status: 'draft' },
      maxConcurrentRuns: 1,
      concurrencyOverflow: 'queue',
    })
    .run();
  return id;
}

function seedKnowledgeBase() {
  const now = new Date().toISOString();
  const knowledgeBaseId = randomUUID();
  const documentId = randomUUID();
  ctx.db
    .insert(schema.knowledgeBases)
    .values({
      id: knowledgeBaseId,
      workspaceId: ctx.workspace.id,
      name: 'Support Playbooks',
      description: 'Reusable support procedures.',
      embeddingModel: 'lexical-v1',
      embeddingDimension: 0,
      chunkingConfig: { maxTokens: 240, overlapTokens: 40 },
      createdAt: now,
      updatedAt: now,
    })
    .run();
  ctx.db
    .insert(schema.kbDocuments)
    .values({
      id: documentId,
      knowledgeBaseId,
      workspaceId: ctx.workspace.id,
      name: 'refunds.md',
      mimeType: 'text/markdown',
      status: 'ready',
      tokenCount: 8,
      error: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  ctx.db
    .insert(schema.kbChunks)
    .values({
      id: randomUUID(),
      documentId,
      knowledgeBaseId,
      workspaceId: ctx.workspace.id,
      chunkIndex: 0,
      content: 'Refund requests require order verification and manager approval.',
      metadata: { source: 'refunds.md' },
      tokenCount: 8,
      createdAt: now,
    })
    .run();
  return knowledgeBaseId;
}

function seedAgent() {
  const id = randomUUID();
  ctx.db
    .insert(schema.agents)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Agent Smith',
      adapterType: 'claude_code',
      role: 'worker',
      status: 'offline',
      colorHex: '#000000',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  return id;
}

describe('/v1/packages packages', () => {
  it('packs a workflow, emits an event, and can use the package', async () => {
    const workflowId = seedWorkflow();
    const capture = ctx.captureBus();
    try {
      const pack = await app().request(`/v1/packages/pack/workflow/${workflowId}`, {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({ tags: ['ops'] }),
      });
      expect(pack.status).toBe(201);
      const packed = (await pack.json()) as { package: { id: string; kind: string; checksum: string } };
      expect(packed.package.kind).toBe('workflow');
      expect(packed.package.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(capture.events).toContainEqual(expect.objectContaining({
        room: REALTIME_ROOMS.workspace(ctx.workspace.id),
        envelope: expect.objectContaining({
          event: REALTIME_EVENTS.PACKAGE_INSTALLED,
          payload: expect.objectContaining({ packageId: packed.package.id, kind: 'workflow' }),
        }),
      }));

      const use = await app().request(`/v1/packages/${packed.package.id}/use`, {
        method: 'POST',
        headers: ctx.authHeaders,
      });
      expect(use.status).toBe(201);
      const used = (await use.json()) as { kind: string; resourceId: string; path: string };
      expect(used.kind).toBe('workflow');
      expect(used.path).toBe(`/workflows/${used.resourceId}`);

      const workflows = ctx.db
        .select()
        .from(schema.workflows)
        .where(eq(schema.workflows.workspaceId, ctx.workspace.id))
        .all();
      expect(workflows).toHaveLength(2);
    } finally {
      capture.stop();
    }
  });

  it('exports a manifest and rejects tampered imports', async () => {
    const workflowId = seedWorkflow();
    const pack = await app().request(`/v1/packages/pack/workflow/${workflowId}`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({}),
    });
    const packed = (await pack.json()) as { package: { id: string } };

    const exported = await app().request(`/v1/packages/${packed.package.id}/export`, {
      headers: ctx.authHeaders,
    });
    expect(exported.status).toBe(200);
    const envelope = (await exported.json()) as {
      packageManifest: {
        checksum: string;
        contents: { kind: 'workflow'; workflow: { title: string } };
      };
    };
    expect(envelope.packageManifest.checksum).toMatch(/^[a-f0-9]{64}$/);

    envelope.packageManifest.contents.workflow.title = 'Changed after export';
    const imported = await app().request('/v1/packages/import', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(envelope),
    });
    expect(imported.status).toBe(422);
    const body = (await imported.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PACKAGE_CHECKSUM_MISMATCH');
  });

  it('packs an agent, exports it, and can import and use the agent package', async () => {
    const agentId = seedAgent();
    const pack = await app().request(`/v1/packages/pack/agent/${agentId}`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({}),
    });
    expect(pack.status).toBe(201);
    const packed = (await pack.json()) as { package: { id: string; kind: string; checksum: string } };
    expect(packed.package.kind).toBe('agent');

    const exported = await app().request(`/v1/packages/${packed.package.id}/export`, {
      headers: ctx.authHeaders,
    });
    expect(exported.status).toBe(200);
    const envelope = (await exported.json()) as {
      packageManifest: {
        checksum: string;
        contents: { kind: 'agent'; agent: { name: string; role: string } };
      };
    };
    expect(envelope.packageManifest.contents.agent.name).toBe('Agent Smith');
    expect(envelope.packageManifest.contents.agent.role).toBe('worker');

    const imported = await app().request('/v1/packages/import', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(envelope),
    });
    expect(imported.status).toBe(201);
    const importedBody = (await imported.json()) as { agentId: string; packageId: string };
    expect(importedBody.agentId).toBeDefined();

    const agent = ctx.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, importedBody.agentId))
      .get();
    expect(agent).toBeDefined();
    expect(agent?.name).toBe('Agent Smith');
    expect(agent?.role).toBe('worker');
  });
});
