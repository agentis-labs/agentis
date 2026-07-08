import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { buildAgentRoutes } from '../../src/routes/agents.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { RuntimeSessionStore } from '../../src/services/runtime/runtimeSessionStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let adapters: AdapterManager;
let home: string;
let agentId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  adapters = new AdapterManager(ctx.logger);
  home = mkdtempSync(join(tmpdir(), 'agentis-runtime-route-'));
  writeFileSync(join(home, 'SOUL.md'), '# Hermes identity', 'utf8');
  writeFileSync(join(home, 'config.yaml'), 'model:\n  default: native/model\n', 'utf8');
  writeFileSync(join(home, '.env'), 'TOKEN=never-return-this\n', 'utf8');
  mkdirSync(join(home, 'skills', 'native'), { recursive: true });
  writeFileSync(join(home, 'skills', 'native', 'SKILL.md'), '# Native skill', 'utf8');

  agentId = randomUUID();
  ctx.db.insert(schema.agents).values({
    id: agentId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Hermes Runtime',
    adapterType: 'hermes_agent',
    capabilityTags: [],
    config: { env: { HERMES_HOME: home } },
    status: 'offline',
  }).run();
});

afterEach(() => {
  ctx.close();
  rmSync(home, { recursive: true, force: true });
});

describe('agent runtime routes', () => {
  it('returns discovered runtime metadata and real profile resources', async () => {
    const runtimeResponse = await app().request(`/v1/agents/${agentId}/runtime`, {
      headers: ctx.authHeaders,
    });
    expect(runtimeResponse.status).toBe(200);
    const runtimeBody = await runtimeResponse.json() as {
      runtime: { currentModel: { value: string; source: string }; resourceCount: number };
    };
    expect(runtimeBody.runtime.currentModel).toEqual(expect.objectContaining({
      value: 'native/model',
      source: 'profile',
    }));
    expect(runtimeBody.runtime.resourceCount).toBeGreaterThanOrEqual(5);

    const resourcesResponse = await app().request(`/v1/agents/${agentId}/runtime/resources`, {
      headers: ctx.authHeaders,
    });
    const resourcesBody = await resourcesResponse.json() as {
      resources: Array<{ id: string; path?: string; kind: string }>;
    };
    expect(resourcesBody.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: join(home, 'SOUL.md'), kind: 'identity' }),
      expect.objectContaining({ path: join(home, 'skills', 'native', 'SKILL.md'), kind: 'skill' }),
      expect.objectContaining({ path: join(home, '.env'), kind: 'secret_reference' }),
    ]));
  });

  it('reads and writes native resources with conflict protection and secret redaction', async () => {
    const resourcesResponse = await app().request(`/v1/agents/${agentId}/runtime/resources`, {
      headers: ctx.authHeaders,
    });
    const resourcesBody = await resourcesResponse.json() as {
      resources: Array<{ id: string; path?: string; checksum?: string }>;
    };
    const soul = resourcesBody.resources.find((resource) => resource.path === join(home, 'SOUL.md'))!;
    const secret = resourcesBody.resources.find((resource) => resource.path === join(home, '.env'))!;

    const secretResponse = await app().request(
      `/v1/agents/${agentId}/runtime/resources/${encodeURIComponent(secret.id)}`,
      { headers: ctx.authHeaders },
    );
    expect(await secretResponse.json()).toEqual(expect.objectContaining({ content: '[redacted]' }));

    const updateResponse = await app().request(
      `/v1/agents/${agentId}/runtime/resources/${encodeURIComponent(soul.id)}`,
      {
        method: 'PUT',
        headers: ctx.authHeaders,
        body: JSON.stringify({ content: '# Updated from Agentis', expectedChecksum: soul.checksum }),
      },
    );
    expect(updateResponse.status).toBe(200);

    const conflictResponse = await app().request(
      `/v1/agents/${agentId}/runtime/resources/${encodeURIComponent(soul.id)}`,
      {
        method: 'PUT',
        headers: ctx.authHeaders,
        body: JSON.stringify({ content: '# Stale overwrite', expectedChecksum: soul.checksum }),
      },
    );
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toEqual({
      error: expect.objectContaining({ code: 'RESOURCE_CONFLICT' }),
    });
  });

  it('lists and closes persisted conversation-scoped runtime sessions', async () => {
    const conversationId = randomUUID();
    ctx.db.insert(schema.conversations).values({
      id: conversationId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      title: 'Native session',
    }).run();
    new RuntimeSessionStore(ctx.db).upsert({
      workspaceId: ctx.workspace.id,
      agentId,
      conversationId,
      sessionKey: conversationId,
      runtimeSessionId: 'hermes-session-1',
      selectedModel: 'native/model',
    });

    const listResponse = await app().request(`/v1/agents/${agentId}/runtime/sessions`, {
      headers: ctx.authHeaders,
    });
    const listBody = await listResponse.json() as { sessions: Array<{ sessionKey: string }> };
    expect(listBody.sessions).toEqual([
      expect.objectContaining({ sessionKey: conversationId, runtimeSessionId: 'hermes-session-1' }),
    ]);

    const closeResponse = await app().request(
      `/v1/agents/${agentId}/runtime/sessions/${encodeURIComponent(conversationId)}`,
      { method: 'DELETE', headers: ctx.authHeaders },
    );
    expect(closeResponse.status).toBe(204);
    expect(new RuntimeSessionStore(ctx.db).list(ctx.workspace.id, agentId)).toEqual([]);
  });
});

function app() {
  return ctx.buildApp([{
    path: '/v1/agents',
    app: buildAgentRoutes({
      db: ctx.db,
      auth: ctx.auth,
      vault: ctx.vault,
      adapters,
      logger: ctx.logger,
      conversations: new ConversationStore({ db: ctx.db, bus: ctx.bus }),
    }),
  }]);
}
