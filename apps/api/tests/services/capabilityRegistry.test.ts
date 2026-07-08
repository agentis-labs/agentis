import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilityInvocationRecord } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import {
  appCapabilityId,
  CapabilityRegistry,
  nativeCapabilityId,
  pluginCapabilityId,
} from '../../src/services/capability/capabilityRegistry.js';
import { AppDatastore, AppStore, AppSurfaceStore } from '@agentis/app';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let invocations: CapabilityInvocationRecord[];

beforeEach(async () => {
  ctx = await createTestContext();
  invocations = [];
});

afterEach(() => ctx.close());

function invokeCtx(overrides: Partial<Parameters<CapabilityRegistry['invoke']>[2]> = {}) {
  return {
    workspaceId: ctx.workspace.id,
    actingSeatId: ctx.user.id,
    callerAgentId: 'agent-1',
    ...overrides,
  };
}

describe('CapabilityRegistry', () => {
  it('lists and invokes native capabilities through the shared tool registry', async () => {
    const native = new AgentisToolRegistry({ logger: ctx.logger });
    native.register(
      {
        id: 'agentis.echo',
        family: 'inspect',
        description: 'Echo input',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
        mutating: false,
      },
      (args) => ({ echoed: args.message }),
    );

    const registry = new CapabilityRegistry({
      db: ctx.db,
      logger: ctx.logger,
      nativeTools: native,
      recordInvocation: (record) => invocations.push(record),
    });

    expect(registry.list({ source: 'native' }).map((cap) => cap.id)).toContain(nativeCapabilityId('agentis.echo'));
    await expect(registry.invoke(nativeCapabilityId('agentis.echo'), {}, invokeCtx())).rejects.toThrow(/missing required argument/);

    const output = await registry.invoke(nativeCapabilityId('agentis.echo'), { message: 'hello' }, invokeCtx());
    expect(output).toEqual({ echoed: 'hello' });
    expect(invocations.at(-1)).toMatchObject({ capabilityId: nativeCapabilityId('agentis.echo'), ok: true });
  });

  it('registers plugin capabilities behind the same invoke and ledger chokepoint', async () => {
    const registry = new CapabilityRegistry({
      db: ctx.db,
      logger: ctx.logger,
      recordInvocation: (record) => invocations.push(record),
    });
    registry.register(
      {
        id: pluginCapabilityId('agentmail', 'send'),
        name: 'send',
        description: 'Send mail through AgentMail',
        inputSchema: { type: 'object', required: ['to'] },
        source: { kind: 'plugin', service: 'agentmail' },
        scopes: ['mail.send'],
        tags: ['mail'],
        mutating: true,
      },
      (input) => ({ queued: true, to: input.to }),
    );

    const output = await registry.invoke(pluginCapabilityId('agentmail', 'send'), { to: 'friend@example.com' }, invokeCtx());
    expect(output).toEqual({ queued: true, to: 'friend@example.com' });
    expect(registry.resolve('mail').map((cap) => cap.id)).toContain(pluginCapabilityId('agentmail', 'send'));
    expect(invocations.at(-1)).toMatchObject({ capabilityId: pluginCapabilityId('agentmail', 'send'), ok: true });
  });

  it("projects an App action so another agent can call it as a capability", async () => {
    const store = new AppStore(ctx.db);
    const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Helpdesk' }).id;
    const data = new AppDatastore(ctx.db);
    data.defineCollection(ctx.workspace.id, appId, {
      name: 'tickets',
      schema: { fields: [{ key: 'subject', type: 'string', required: true }] },
    });
    new AppSurfaceStore({ db: ctx.db }).setActions(ctx.workspace.id, appId, 'home', [
      {
        name: 'create_ticket',
        kind: 'data',
        target: 'tickets.insert',
        inputSchema: { type: 'object', required: ['subject'] },
      },
    ]);

    const registry = new CapabilityRegistry({
      db: ctx.db,
      logger: ctx.logger,
      recordInvocation: (record) => invocations.push(record),
    });
    const projected = registry.registerAppCapabilities({ workspaceId: ctx.workspace.id, appId });
    expect(projected.map((cap) => cap.id)).toContain(appCapabilityId(appId, 'create_ticket'));

    const output = await registry.invoke(
      appCapabilityId(appId, 'create_ticket'),
      { subject: 'Cannot log in' },
      invokeCtx({ callerAgentId: 'agent-caller' }),
    );

    expect(output).toMatchObject({ appId, name: 'tickets', data: { subject: 'Cannot log in' } });
    expect(data.query(ctx.workspace.id, appId, 'tickets', { limit: 50 }).rows).toHaveLength(1);
    expect(invocations.at(-1)).toMatchObject({
      capabilityId: appCapabilityId(appId, 'create_ticket'),
      source: { kind: 'app', appId },
      callerAgentId: 'agent-caller',
      ok: true,
    });
  });
});
