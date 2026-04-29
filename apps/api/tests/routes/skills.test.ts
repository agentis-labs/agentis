/**
 * /v1/skills — route unit tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildSkillRoutes } from '../../src/routes/skills.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

function app() {
  return ctx.buildApp([
    { path: '/v1/skills', app: buildSkillRoutes({ db: ctx.db, auth: ctx.auth }) },
  ]);
}

describe('GET /v1/skills', () => {
  it('returns workspace skills', async () => {
    ctx.db
      .insert(schema.skills)
      .values({
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        packageId: null,
        name: 'Echo',
        slug: 'echo',
        version: '1.0.0',
        runtime: 'node_worker',
        manifest: {},
      })
      .run();
    const res = await app().request('/v1/skills', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: unknown[] };
    expect(body.skills).toHaveLength(1);
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/skills');
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/skills/install-local', () => {
  it('installs a skill from a local manifest', async () => {
    const res = await app().request('/v1/skills/install-local', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        manifest: {
          name: 'My Skill',
          slug: 'my-skill',
          version: '0.1.0',
          runtime: 'node_worker',
          entrypoint: 'index.js',
          capabilityTags: ['utility'],
          inputSchema: {},
          outputSchema: {},
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { skill: { slug: string; runtime: string } };
    expect(body.skill.slug).toBe('my-skill');
    expect(body.skill.runtime).toBe('node_worker');
  });

  it('returns 422 on invalid runtime', async () => {
    const res = await app().request('/v1/skills/install-local', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        manifest: {
          name: 'X',
          slug: 'x',
          version: '0.1.0',
          runtime: 'wasm',
          entrypoint: 'index.js',
        },
      }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 on missing manifest', async () => {
    const res = await app().request('/v1/skills/install-local', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });
});
