/**
 * /v1/credentials — route unit tests.
 *
 * Reads must NEVER expose plaintext encryptedValue. Writes encrypt at the
 * boundary via CredentialVault.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildCredentialRoutes } from '../../src/routes/credentials.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/credentials',
      app: buildCredentialRoutes({ db: ctx.db, auth: ctx.auth, vault: ctx.vault }),
    },
  ]);
}

describe('POST /v1/credentials', () => {
  it('creates a credential and never returns plaintext', async () => {
    const res = await app().request('/v1/credentials', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'My Token',
        credentialType: 'http_adapter_secret',
        value: 'super-secret-value',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('super-secret-value');
  });

  it('returns 422 on missing required fields', async () => {
    const res = await app().request('/v1/credentials', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/credentials', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/credentials', () => {
  it('lists credentials without leaking plaintext or encryptedValue', async () => {
    ctx.db
      .insert(schema.credentials)
      .values({
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        name: 'Pre-seeded',
        credentialType: 'token',
        encryptedValue: ctx.vault.encrypt('plaintext-here'),
      })
      .run();
    const res = await app().request('/v1/credentials', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('plaintext-here');
    expect(text).not.toContain('encryptedValue');
  });
});

describe('PATCH /v1/credentials/:id', () => {
  it('returns 404 RESOURCE_NOT_FOUND for unknown id', async () => {
    const res = await app().request(`/v1/credentials/${randomUUID()}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'New' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('DELETE /v1/credentials/:id', () => {
  it('returns 404 for unknown id', async () => {
    const res = await app().request(`/v1/credentials/${randomUUID()}`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(404);
  });
});
