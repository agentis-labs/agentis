/**
 * /v1/activity — recent activity feed read endpoint.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildActivityRoutes } from '../../src/routes/activity.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let activity: ActivityFeedService;

beforeEach(async () => {
  ctx = await createTestContext();
  activity = new ActivityFeedService(ctx.db, ctx.bus);
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/activity',
      app: buildActivityRoutes({ db: ctx.db, auth: ctx.auth, activity }),
    },
  ]);
}

describe('GET /v1/activity', () => {
  it('returns an empty list when nothing has happened', async () => {
    const res = await app().request('/v1/activity', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
  });

  it('returns recorded events newest-first', async () => {
    activity.record({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      eventType: 'a.first',
      actorType: 'system',
      entityType: 'workflow',
      entityId: 'w1',
      summary: 'first',
    });
    await new Promise((r) => setTimeout(r, 5));
    activity.record({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      eventType: 'a.second',
      actorType: 'system',
      entityType: 'workflow',
      entityId: 'w1',
      summary: 'second',
    });
    const res = await app().request('/v1/activity', { headers: ctx.authHeaders });
    const body = (await res.json()) as { events: Array<{ summary: string }> };
    expect(body.events[0]?.summary).toBe('second');
  });

  it('honors ?limit=1', async () => {
    for (let i = 0; i < 3; i++) {
      activity.record({
        workspaceId: ctx.workspace.id,
        ambientId: null,
        userId: ctx.user.id,
        eventType: 'tick',
        actorType: 'system',
        entityType: 'workflow',
        entityId: 'w1',
        summary: `tick ${i}`,
      });
    }
    const res = await app().request('/v1/activity?limit=1', { headers: ctx.authHeaders });
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events.length).toBe(1);
  });

  it('requires authentication', async () => {
    const res = await app().request('/v1/activity');
    expect(res.status).toBe(401);
  });
});
