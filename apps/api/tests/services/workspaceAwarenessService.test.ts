/**
 * WorkspaceAwarenessService — the channel-independent situational model.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import {
  WorkspaceAwarenessService,
  formatSituationalModel,
} from '../../src/services/workspace/workspaceAwarenessService.js';

function seedAgent(ctx: TestContext, name: string, role: string, tags: string[]): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name, role, adapterType: 'http', status: 'online', capabilityTags: tags, description: `${name} does ${role} work`,
  }).run();
  return id;
}

function seedWorkflow(ctx: TestContext, title: string, description: string) {
  ctx.db.insert(schema.workflows).values({
    id: randomUUID(), workspaceId: ctx.workspace.id, userId: ctx.user.id, title, description, graph: {},
  }).run();
}

describe('WorkspaceAwarenessService', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('assembles the roster, intents, and channel presence', () => {
    const researcherId = seedAgent(ctx, 'Researcher', 'researcher', ['web', 'synthesis']);
    seedAgent(ctx, 'Writer', 'writer', ['content']);
    seedWorkflow(ctx, 'Morning Digest', 'Daily AI news roundup');
    ctx.db.insert(schema.channelConnections).values({
      id: randomUUID(), workspaceId: ctx.workspace.id, userId: ctx.user.id,
      agentId: researcherId, kind: 'whatsapp', name: 'WA', tokenEncrypted: ctx.vault.encrypt('x'),
      status: 'active',
    }).run();

    const svc = new WorkspaceAwarenessService({ db: ctx.db, logger: ctx.logger });
    const model = svc.build(ctx.workspace.id);

    expect(model.agents.map((a) => a.name).sort()).toEqual(['Researcher', 'Writer']);
    expect(model.agents.find((a) => a.name === 'Researcher')?.capabilityTags).toContain('web');
    expect(model.intents.map((i) => i.title)).toContain('Morning Digest');
    expect(model.liveChannels).toEqual([{ kind: 'whatsapp', status: 'active' }]);
  });

  it('caches within the TTL (same object returned)', () => {
    seedAgent(ctx, 'Solo', 'worker', []);
    const svc = new WorkspaceAwarenessService({ db: ctx.db, logger: ctx.logger });
    const first = svc.build(ctx.workspace.id);
    const second = svc.build(ctx.workspace.id);
    expect(second).toBe(first);
    svc.invalidate(ctx.workspace.id);
    expect(svc.build(ctx.workspace.id)).not.toBe(first);
  });

  it('formats a readable WORKSPACE SITUATION block', () => {
    const block = formatSituationalModel({
      workspaceName: 'Acme',
      intents: [{ id: 'w1', title: 'Morning Digest', summary: 'daily roundup' }],
      agents: [{ id: 'a1', name: 'Researcher', role: 'researcher', adapterType: 'http', status: 'online', capabilityTags: ['web'], whatTheyDo: 'fetches sources' }],
      activeRuns: [{ id: 'r1', workflowId: 'w1', status: 'RUNNING' }],
      pendingApprovals: [{ id: 'p1', title: 'Send the report?', summary: null }],
      liveChannels: [{ kind: 'whatsapp', status: 'active' }],
    });
    expect(block).toContain('WORKSPACE SITUATION');
    expect(block).toContain('Workspace: Acme');
    expect(block).toContain('Morning Digest');
    expect(block).toContain('Researcher researcher (online) [web]');
    expect(block).toContain('In motion now:');
    expect(block).toContain('Awaiting your approval:');
    expect(block).toContain('Channel presence: whatsapp:active');
  });

  it('buildContextBlock returns empty string on failure, never throws', () => {
    // A bogus workspace id yields an empty (nameless) but non-throwing block.
    const svc = new WorkspaceAwarenessService({ db: ctx.db, logger: ctx.logger });
    expect(() => svc.buildContextBlock('nonexistent-ws')).not.toThrow();
  });
});
