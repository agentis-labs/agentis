/**
 * /v1/agents — route unit tests (GET surface).
 *
 * The mutation surface (POST/PATCH/DELETE/terminal/cancel-task) is built
 * by buildAgentMutationRoutes and exercised by D30 e2e specs; these unit
 * tests focus on the spec-required GET endpoints.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildAgentRoutes } from '../../src/routes/agents.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { ConversationStore } from '../../src/services/conversationStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let adapters: AdapterManager;
let conversations: ConversationStore;

beforeEach(async () => {
  ctx = await createTestContext();
  adapters = new AdapterManager(ctx.logger);
  conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/agents',
      app: buildAgentRoutes({
        db: ctx.db,
        auth: ctx.auth,
        vault: ctx.vault,
        adapters,
        logger: ctx.logger,
        conversations,
      }),
    },
  ]);
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
      name: 'Test Agent',
      adapterType: 'http',
      capabilityTags: [],
      config: {},
      status: 'offline',
    })
    .run();
  return id;
}

describe('GET /v1/agents', () => {
  it('returns the workspace agents', async () => {
    seedAgent();
    const res = await app().request('/v1/agents', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: unknown[] };
    expect(body.agents).toHaveLength(1);
  });

  it('returns an empty list when none exist', async () => {
    const res = await app().request('/v1/agents', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: unknown[] };
    expect(body.agents).toEqual([]);
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/agents');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/agents/:id', () => {
  it('returns the agent', async () => {
    const id = seedAgent();
    const res = await app().request(`/v1/agents/${id}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { id: string } };
    expect(body.agent.id).toBe(id);
  });

  it('returns 404 RESOURCE_NOT_FOUND for unknown id', async () => {
    const res = await app().request(`/v1/agents/${randomUUID()}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});
