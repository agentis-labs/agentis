import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore, AppTestHarness } from '@agentis/app';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

describe('AppTestHarness', () => {
  it('runs a manifest through a declared data action and rolls all rows back', () => {
    const before = new AppStore(ctx.db).list(ctx.workspace.id).length;
    const result = new AppTestHarness(ctx.db).runIsolated(ctx.workspace.id, ctx.user.id, {
      manifest: {
        manifestVersion: 1,
        agentisVersion: '1.0.0',
        identity: { slug: 'test-desk', name: 'Test Desk', version: '0.1.0' },
        policy: { audience: [], shareable: false, customCode: 'disabled', grants: [] },
        workflows: [],
        collections: [{
          name: 'tickets',
          schema: { fields: [{ key: 'subject', type: 'string', required: true, indexed: true }] },
          seed: [],
        }],
        surfaces: [{
          name: 'home',
          kind: 'page',
          view: {
            type: 'Form',
            fields: [{ key: 'subject', label: 'Subject', type: 'text', required: true }],
            submit: { action: 'createTicket' },
          },
          actions: [{ name: 'createTicket', kind: 'data', target: 'tickets.insert' }],
          shareable: false,
        }],
        agents: [],
        capabilities: [],
        requiredPlugins: [],
        dependencies: [],
        migrations: [],
        source: null,
      },
      actions: [{ surface: 'home', name: 'createTicket', args: { record: { subject: 'Printer down' } } }],
      assertions: [{ collection: 'tickets', count: 1, includes: { subject: 'Printer down' } }],
    });

    expect(result.surfaces).toEqual(['home']);
    expect(result.assertions).toEqual([{ collection: 'tickets', count: 1 }]);
    expect(new AppStore(ctx.db).list(ctx.workspace.id)).toHaveLength(before);
  });
});
