/**
 * ConnectionGrantService — per-agent scoped authority over connections
 * (Agent-Native Platform Plan §3.3). Proves: ungoverned connections stay open
 * (back-compat), the owner is implicitly authorized, grants gate by scope +
 * expiry, and the request→grant negotiation on-ramp works.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { ConnectionGrantService } from '../../src/services/connectionGrants.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function seedAgent(name = 'Agent'): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({ id, workspaceId: ctx.workspace.id, userId: ctx.user.id, name, adapterType: 'http' }).run();
  return id;
}

function seedChannel(ownerAgentId: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.channelConnections).values({
    id, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId: ownerAgentId,
    kind: 'whatsapp', name: 'Line', tokenEncrypted: 'x',
  }).run();
  return id;
}

describe('ConnectionGrantService', () => {
  it('leaves an ungoverned connection open (back-compat)', () => {
    const svc = new ConnectionGrantService(ctx.db);
    const owner = seedAgent('Owner');
    const stranger = seedAgent('Stranger');
    const conn = seedChannel(owner);
    // No grants exist → any agent may use it, exactly as before this feature.
    expect(svc.authorize({ workspaceId: ctx.workspace.id, connectionId: conn, agentId: stranger }).ok).toBe(true);
  });

  it('always authorizes the connection owner, even once grants exist', () => {
    const svc = new ConnectionGrantService(ctx.db);
    const owner = seedAgent('Owner');
    const other = seedAgent('Other');
    const conn = seedChannel(owner);
    svc.grant({ workspaceId: ctx.workspace.id, connectionKind: 'channel', connectionId: conn, agentId: other, scope: 'send' });
    // Owner never needs an explicit grant.
    expect(svc.authorize({ workspaceId: ctx.workspace.id, connectionId: conn, agentId: owner }).ok).toBe(true);
  });

  it('default-denies an ungranted agent once any grant governs the connection', () => {
    const svc = new ConnectionGrantService(ctx.db);
    const owner = seedAgent('Owner');
    const granted = seedAgent('Granted');
    const stranger = seedAgent('Stranger');
    const conn = seedChannel(owner);
    svc.grant({ workspaceId: ctx.workspace.id, connectionKind: 'channel', connectionId: conn, agentId: granted, scope: 'send' });
    expect(svc.authorize({ workspaceId: ctx.workspace.id, connectionId: conn, agentId: granted }).ok).toBe(true);
    const denied = svc.authorize({ workspaceId: ctx.workspace.id, connectionId: conn, agentId: stranger });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain('lacks');
  });

  it('respects scope order (read does not satisfy send) and expiry', () => {
    const svc = new ConnectionGrantService(ctx.db);
    const owner = seedAgent('Owner');
    const reader = seedAgent('Reader');
    const expiring = seedAgent('Expiring');
    const conn = seedChannel(owner);
    svc.grant({ workspaceId: ctx.workspace.id, connectionKind: 'channel', connectionId: conn, agentId: reader, scope: 'read' });
    svc.grant({ workspaceId: ctx.workspace.id, connectionKind: 'channel', connectionId: conn, agentId: expiring, scope: 'manage', expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(svc.authorize({ workspaceId: ctx.workspace.id, connectionId: conn, agentId: reader, required: 'send' }).ok).toBe(false);
    expect(svc.authorize({ workspaceId: ctx.workspace.id, connectionId: conn, agentId: reader, required: 'read' }).ok).toBe(true);
    expect(svc.authorize({ workspaceId: ctx.workspace.id, connectionId: conn, agentId: expiring, required: 'send' }).ok).toBe(false); // expired
  });

  it('global enforcement hardens even an ungoverned connection', () => {
    const svc = new ConnectionGrantService(ctx.db, true);
    const owner = seedAgent('Owner');
    const stranger = seedAgent('Stranger');
    const conn = seedChannel(owner);
    expect(svc.authorize({ workspaceId: ctx.workspace.id, connectionId: conn, agentId: owner }).ok).toBe(true); // owner still ok
    expect(svc.authorize({ workspaceId: ctx.workspace.id, connectionId: conn, agentId: stranger }).ok).toBe(false); // no grant → denied
  });

  it('request creates a pending row that grant approves', () => {
    const svc = new ConnectionGrantService(ctx.db);
    const owner = seedAgent('Owner');
    const asker = seedAgent('Asker');
    const conn = seedChannel(owner);
    const req = svc.request({ workspaceId: ctx.workspace.id, connectionKind: 'channel', connectionId: conn, agentId: asker, scope: 'send', note: 'need to run outreach' });
    expect(req.status).toBe('requested');
    expect(svc.listRequests(ctx.workspace.id)).toHaveLength(1);
    // A requested (not active) grant does NOT authorize yet.
    expect(svc.authorize({ workspaceId: ctx.workspace.id, connectionId: conn, agentId: asker }).ok).toBe(false);
    // Operator approves — same (connection, agent) row flips to active.
    svc.grant({ workspaceId: ctx.workspace.id, connectionKind: 'channel', connectionId: conn, agentId: asker, scope: 'send', grantedBy: ctx.user.id });
    expect(svc.authorize({ workspaceId: ctx.workspace.id, connectionId: conn, agentId: asker }).ok).toBe(true);
    expect(svc.listRequests(ctx.workspace.id)).toHaveLength(0);
  });
});
