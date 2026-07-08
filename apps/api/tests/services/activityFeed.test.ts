/**
 * ActivityFeedService — record + list + bus emission.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let activity: ActivityFeedService;

beforeEach(async () => {
  ctx = await createTestContext();
  activity = new ActivityFeedService(ctx.db, ctx.bus);
});

describe('ActivityFeedService', () => {
  it('records an event row and emits ACTIVITY_CREATED on the workspace room', () => {
    const cap = ctx.captureBus();
    activity.record({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      eventType: 'workflow.run.completed',
      actorType: 'system',
      entityType: 'workflow_run',
      entityId: 'r1',
      summary: 'Run completed',
    });
    cap.stop();
    expect(cap.events.length).toBe(1);
    expect(cap.events[0]?.envelope.event).toBe('activity.created');
    expect(cap.events[0]?.room).toBe(`workspace:${ctx.workspace.id}`);
    const list = activity.list(ctx.workspace.id);
    expect(list.length).toBe(1);
    expect(list[0]?.summary).toBe('Run completed');
  });

  it('list returns items in newest-first order', async () => {
    activity.record({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      eventType: 'a.first',
      actorType: 'user',
      entityType: 'workflow',
      entityId: 'w1',
      summary: 'first',
    });
    await new Promise((r) => setTimeout(r, 5));
    activity.record({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      eventType: 'a.second',
      actorType: 'user',
      entityType: 'workflow',
      entityId: 'w1',
      summary: 'second',
    });
    const list = activity.list(ctx.workspace.id);
    expect(list[0]?.summary).toBe('second');
    expect(list[1]?.summary).toBe('first');
  });

  it('list caps at the supplied limit', () => {
    for (let i = 0; i < 10; i++) {
      activity.record({
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        eventType: 'tick',
        actorType: 'system',
        entityType: 'workflow',
        entityId: 'w1',
        summary: `tick ${i}`,
      });
    }
    expect(activity.list(ctx.workspace.id, 3).length).toBe(3);
  });

  it('list scope is workspace-isolated', async () => {
    const ctx2 = await createTestContext({ username: 'other' });
    activity.record({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      eventType: 'a',
      actorType: 'system',
      entityType: 'workflow',
      entityId: 'w1',
      summary: 'mine',
    });
    expect(activity.list(ctx2.workspace.id).length).toBe(0);
    ctx2.close();
  });
});
