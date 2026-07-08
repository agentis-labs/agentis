import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildActivityRoutes } from '../../src/routes/activity.js';
import { buildApprovalRoutes } from '../../src/routes/approvals.js';
import { buildDashboardRoutes } from '../../src/routes/dashboard.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

describe('workspace overview routes', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(() => ctx.close());

  it('serves dashboard, activity, and approvals endpoints expected by the web workspace snapshot', async () => {
    const activity = new ActivityFeedService(ctx.db, ctx.bus);
    const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
    const app = ctx.buildApp([
      { path: '/v1/dashboard', app: buildDashboardRoutes({ db: ctx.db, auth: ctx.auth }) },
      { path: '/v1/activity', app: buildActivityRoutes({ db: ctx.db, auth: ctx.auth, activity }) },
      { path: '/v1/approvals', app: buildApprovalRoutes({ db: ctx.db, auth: ctx.auth, approvals }) },
    ]);

    const dashboard = await app.request('/v1/dashboard/fleet-overview', { headers: ctx.authHeaders });
    const feed = await app.request('/v1/activity?limit=1', { headers: ctx.authHeaders });
    const inbox = await app.request('/v1/approvals?status=pending', { headers: ctx.authHeaders });

    expect(dashboard.status).toBe(200);
    expect(feed.status).toBe(200);
    expect(inbox.status).toBe(200);
    await expect(dashboard.json()).resolves.toMatchObject({
      agents: expect.any(Object),
      approvals: expect.any(Object),
    });
    await expect(feed.json()).resolves.toMatchObject({ events: [] });
    await expect(inbox.json()).resolves.toMatchObject({ approvals: [] });
  });
});
