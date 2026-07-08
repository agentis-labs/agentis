import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCapabilityRoutes } from '../../src/routes/capabilities.js';
import { appCapabilityId, CapabilityRegistry } from '../../src/services/capability/capabilityRegistry.js';
import { AppDatastore, AppStore, AppSurfaceStore } from '@agentis/app';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

describe('/v1/capabilities', () => {
  it('discovers and invokes an App action capability over HTTP', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Helpdesk' }).id;
    const data = new AppDatastore(ctx.db);
    data.defineCollection(ctx.workspace.id, appId, {
      name: 'tickets',
      schema: { fields: [{ key: 'subject', type: 'string', required: true }] },
    });
    new AppSurfaceStore({ db: ctx.db }).setActions(ctx.workspace.id, appId, 'home', [
      { name: 'create_ticket', kind: 'data', target: 'tickets.insert', inputSchema: { type: 'object', required: ['subject'] } },
    ]);

    const registry = new CapabilityRegistry({ db: ctx.db, logger: ctx.logger });
    const app = ctx.buildApp([
      { path: '/v1/capabilities', app: buildCapabilityRoutes({ db: ctx.db, auth: ctx.auth, capabilities: registry }) },
    ]);

    const listed = await app.request(`/v1/capabilities?appId=${appId}&source=app`, { headers: ctx.authHeaders });
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { data: { capabilities: Array<{ id: string }> } };
    expect(listBody.data.capabilities.map((cap) => cap.id)).toContain(appCapabilityId(appId, 'create_ticket'));

    const invoked = await app.request(`/v1/capabilities/${appCapabilityId(appId, 'create_ticket')}/invoke`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ input: { subject: 'Cannot log in' }, callerAgentId: 'agent-http' }),
    });
    expect(invoked.status).toBe(200);
    const invokeBody = await invoked.json() as { data: { data: { subject: string } } };
    expect(invokeBody.data.data.subject).toBe('Cannot log in');
    expect(data.query(ctx.workspace.id, appId, 'tickets', { limit: 50 }).rows).toHaveLength(1);
  });
});
