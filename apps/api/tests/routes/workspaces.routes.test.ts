/**
 * /v1/workspaces — list, create, get, ambients sub-resource.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildWorkspaceRoutes } from '../../src/routes/workspaces.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/workspaces',
      app: buildWorkspaceRoutes({ db: ctx.db, auth: ctx.auth, bus: ctx.bus }),
    },
  ]);
}

describe('/v1/workspaces', () => {
  it('GET / lists workspaces owned by the user', async () => {
    const res = await app().request('/v1/workspaces', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ id: string }> };
    expect(body.workspaces.length).toBe(1);
    expect(body.workspaces[0]?.id).toBe(ctx.workspace.id);
  });

  it('GET / requires authentication', async () => {
    const res = await app().request('/v1/workspaces');
    expect(res.status).toBe(401);
  });

  it('POST / creates a new workspace and returns 201', async () => {
    const res = await app().request('/v1/workspaces', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'Side Project', slug: 'side' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: { id: string; name: string } };
    expect(body.workspace.name).toBe('Side Project');
  });

  it('POST / rejects invalid payload (missing name)', async () => {
    const res = await app().request('/v1/workspaces', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ slug: 'x' }),
    });
    expect(res.status).toBe(422);
  });

  it('GET /:id returns the workspace + ambients', async () => {
    const res = await app().request(`/v1/workspaces/${ctx.workspace.id}`, {
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspace: { id: string };
      ambients: Array<{ id: string }>;
    };
    expect(body.workspace.id).toBe(ctx.workspace.id);
    expect(body.ambients.length).toBe(1);
    expect(body.ambients[0]?.id).toBe(ctx.ambient.id);
  });

  it('GET /:id returns 404 for an unknown workspace id', async () => {
    const res = await app().request('/v1/workspaces/00000000-0000-0000-0000-000000000000', {
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(404);
  });

  it('PATCH /:id updates the workspace name, description, and image URL', async () => {
    const res = await app().request(`/v1/workspaces/${ctx.workspace.id}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'New Name',
        description: 'New Description',
        imageDataUrl: 'data:image/png;base64,1234',
      }),
    });
    expect(res.status).toBe(200);
    
    // Verify changes by calling GET
    const getRes = await app().request(`/v1/workspaces/${ctx.workspace.id}`, {
      headers: ctx.authHeaders,
    });
    const body = (await getRes.json()) as { workspace: { name: string; description: string; imageUrl: string } };
    expect(body.workspace.name).toBe('New Name');
    expect(body.workspace.description).toBe('New Description');
    expect(body.workspace.imageUrl).toBe('data:image/png;base64,1234');
  });

  it('DELETE /:id deletes the workspace', async () => {
    const res = await app().request(`/v1/workspaces/${ctx.workspace.id}`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);

    // Verify deletion by calling GET
    const getRes = await app().request(`/v1/workspaces/${ctx.workspace.id}`, {
      headers: ctx.authHeaders,
    });
    expect(getRes.status).toBe(404);
  });
});
