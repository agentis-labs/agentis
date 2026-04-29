/**
 * Universal audit middleware tests (D38).
 *
 * Covers the contract:
 *   - successful POST/PATCH/DELETE on /v1/* writes one activity_events row
 *   - GET requests do not record
 *   - 4xx/5xx responses do not record
 *   - SKIP_PATHS (registry, auth, _test, webhooks) bypass the middleware
 *   - the entityType is derived from the path prefix and the entityId from
 *     the trailing UUID segment when present
 *   - terminal verbs (run, cancel, sync, …) are surfaced as the action
 *   - middleware failures never break the request
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { auditLog } from '../../src/middleware/auditLog.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { errorHandler } from '../../src/middleware/error.js';
import { requireAuth } from '../../src/middleware/auth.js';
import { requireWorkspace } from '../../src/middleware/workspace.js';

describe('auditLog middleware', () => {
  let ctx: TestContext;
  let activity: ActivityFeedService;

  beforeEach(async () => {
    ctx = await createTestContext();
    activity = new ActivityFeedService(ctx.db, ctx.bus);
  });

  afterEach(() => {
    ctx.close();
  });

  function buildApp(handlerSetup: (app: Hono) => void): Hono {
    const app = new Hono();
    app.onError(errorHandler(ctx.logger));
    app.use('/v1/*', auditLog({ activity, logger: ctx.logger }));
    app.use(
      '/v1/*',
      requireAuth({ db: ctx.db, auth: ctx.auth }),
      requireWorkspace({ db: ctx.db }),
    );
    handlerSetup(app);
    return app;
  }

  function activityRows() {
    return ctx.db.select().from(schema.activityEvents).all();
  }

  it('records one row for a successful POST under a known prefix', async () => {
    const app = buildApp((a) => {
      a.post('/v1/workflows', (c) => c.json({ ok: true }, 201));
    });

    const res = await app.request('/v1/workflows', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    const rows = activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'workflow.create',
      actorType: 'user',
      actorId: ctx.user.id,
      entityType: 'workflow',
      entityId: 'workflows',
      userId: ctx.user.id,
      workspaceId: ctx.workspace.id,
    });
    expect(rows[0]!.summary).toContain('operator create workflow');
  });

  it('extracts the trailing UUID as the entityId', async () => {
    const wfId = '11111111-2222-3333-4444-555555555555';
    const app = buildApp((a) => {
      a.patch('/v1/workflows/:id', (c) => c.json({ ok: true }));
    });

    const res = await app.request(`/v1/workflows/${wfId}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: '{}',
    });

    expect(res.status).toBe(200);
    const rows = activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityType).toBe('workflow');
    expect(rows[0]!.entityId).toBe(wfId);
    expect(rows[0]!.eventType).toBe('workflow.update');
  });

  it('promotes terminal verbs (run/cancel/sync) into the action', async () => {
    const wfId = '22222222-2222-3333-4444-555555555555';
    const app = buildApp((a) => {
      a.post('/v1/workflows/:id/run', (c) => c.json({ runId: 'r1' }, 202));
    });

    const res = await app.request(`/v1/workflows/${wfId}/run`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: '{}',
    });

    expect(res.status).toBe(202);
    const rows = activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe('workflow.run');
    expect(rows[0]!.entityId).toBe(wfId);
  });

  it('does not record GET requests', async () => {
    const app = buildApp((a) => {
      a.get('/v1/workflows', (c) => c.json({ workflows: [] }));
    });

    const res = await app.request('/v1/workflows', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    expect(activityRows()).toHaveLength(0);
  });

  it('does not record failed (4xx) responses', async () => {
    const app = buildApp((a) => {
      a.post('/v1/workflows', (c) => c.json({ error: { code: 'X' } }, 422));
    });

    const res = await app.request('/v1/workflows', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: '{}',
    });

    expect(res.status).toBe(422);
    expect(activityRows()).toHaveLength(0);
  });

  it('does not record 5xx responses', async () => {
    const app = buildApp((a) => {
      a.post('/v1/workflows', () => {
        throw new Error('boom');
      });
    });

    const res = await app.request('/v1/workflows', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: '{}',
    });

    expect(res.status).toBe(500);
    expect(activityRows()).toHaveLength(0);
  });

  it('skips paths under /v1/skills/registry (already records its own activity)', async () => {
    const app = buildApp((a) => {
      a.post('/v1/skills/registry/install/:slug', (c) => c.json({ ok: true }, 201));
    });

    const res = await app.request('/v1/skills/registry/install/abc', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: '{}',
    });

    expect(res.status).toBe(201);
    expect(activityRows()).toHaveLength(0);
  });

  it('skips when handler sets c.set("audit.skip", true)', async () => {
    const app = buildApp((a) => {
      a.post('/v1/workflows', (c) => {
        c.set('audit.skip' as never, true as never);
        return c.json({ ok: true }, 201);
      });
    });

    const res = await app.request('/v1/workflows', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: '{}',
    });

    expect(res.status).toBe(201);
    expect(activityRows()).toHaveLength(0);
  });

  it('does not record when there is no workspace context (unauth path)', async () => {
    // Build an app without requireAuth/requireWorkspace so c.get('workspace') is undefined.
    const app = new Hono();
    app.onError(errorHandler(ctx.logger));
    app.use('/v1/*', auditLog({ activity, logger: ctx.logger }));
    app.post('/v1/workflows', (c) => c.json({ ok: true }, 201));

    const res = await app.request('/v1/workflows', {
      method: 'POST',
      body: '{}',
    });

    expect(res.status).toBe(201);
    expect(activityRows()).toHaveLength(0);
  });

  it('does not record for unknown /v1 prefixes', async () => {
    const app = buildApp((a) => {
      a.post('/v1/unknown-resource', (c) => c.json({ ok: true }, 201));
    });

    const res = await app.request('/v1/unknown-resource', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: '{}',
    });

    expect(res.status).toBe(201);
    expect(activityRows()).toHaveLength(0);
  });

  it('logs and swallows errors from the activity service', async () => {
    const recordSpy = vi.spyOn(activity, 'record').mockImplementation(() => {
      throw new Error('db dead');
    });
    const warnSpy = vi.spyOn(ctx.logger, 'warn');

    const app = buildApp((a) => {
      a.post('/v1/workflows', (c) => c.json({ ok: true }, 201));
    });

    const res = await app.request('/v1/workflows', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: '{}',
    });

    expect(res.status).toBe(201);
    expect(recordSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith('audit.middleware_failed', expect.objectContaining({ err: 'db dead' }));
  });

  it('persists method, path, status in metadata', async () => {
    const app = buildApp((a) => {
      a.delete('/v1/credentials/:id', (c) => c.json({ ok: true }));
    });

    const res = await app.request('/v1/credentials/cred-123', {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });

    expect(res.status).toBe(200);
    const rows = ctx.db
      .select()
      .from(schema.activityEvents)
      .where(eq(schema.activityEvents.eventType, 'credential.delete'))
      .all();
    expect(rows).toHaveLength(1);
    const meta = rows[0]!.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({
      method: 'DELETE',
      path: '/v1/credentials/cred-123',
      status: 200,
    });
  });
});
