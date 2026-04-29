/**
 * /v1/gateways — route unit tests (GET surface).
 *
 * Mutation surface (pair / patch / sync / delete) lives in
 * gatewayMutations.ts and is exercised by D30 e2e specs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildGatewayRoutes } from '../../src/routes/gateways.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/gateways',
      app: buildGatewayRoutes({ db: ctx.db, auth: ctx.auth, vault: ctx.vault }),
    },
  ]);
}

function seedGateway() {
  const id = randomUUID();
  ctx.db
    .insert(schema.openclawGateways)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Test GW',
      gatewayUrl: 'http://gw.example.com',
      status: 'connected',
      healthSnapshot: {},
    })
    .run();
  return id;
}

describe('GET /v1/gateways', () => {
  it('returns workspace gateways', async () => {
    seedGateway();
    const res = await app().request('/v1/gateways', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gateways: unknown[] };
    expect(body.gateways).toHaveLength(1);
  });

  it('returns an empty list when none exist', async () => {
    const res = await app().request('/v1/gateways', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gateways: unknown[] };
    expect(body.gateways).toEqual([]);
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/gateways');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/gateways/:id', () => {
  it('returns the gateway', async () => {
    const id = seedGateway();
    const res = await app().request(`/v1/gateways/${id}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gateway: { id: string } };
    expect(body.gateway.id).toBe(id);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app().request(`/v1/gateways/${randomUUID()}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});
