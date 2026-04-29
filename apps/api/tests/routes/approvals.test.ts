/**
 * /v1/approvals — route unit tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { buildApprovalRoutes } from '../../src/routes/approvals.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let approvals: ApprovalInboxService;

beforeEach(async () => {
  ctx = await createTestContext();
  approvals = new ApprovalInboxService(ctx.db, ctx.bus);
});

function app() {
  return ctx.buildApp([
    { path: '/v1/approvals', app: buildApprovalRoutes({ db: ctx.db, auth: ctx.auth, approvals }) },
  ]);
}

describe('GET /v1/approvals', () => {
  it('returns an empty list initially', async () => {
    const res = await app().request('/v1/approvals', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvals: unknown[] };
    expect(body.approvals).toEqual([]);
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/approvals');
    expect(res.status).toBe(401);
  });

  it('honors ?status=all', async () => {
    const res = await app().request('/v1/approvals?status=all', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/approvals/:id/resolve', () => {
  it('returns 422 VALIDATION_FAILED when decision is missing', async () => {
    const res = await app().request('/v1/approvals/some-id/resolve', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns 422 when decision is not approve|reject', async () => {
    const res = await app().request('/v1/approvals/some-id/resolve', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(res.status).toBe(422);
  });
});
