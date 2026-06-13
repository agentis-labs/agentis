import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { HashingEmbeddingProvider } from '../../src/services/embeddingProvider.js';
import { PersonalBrainService } from '../../src/services/personalBrain.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let brain: PersonalBrainService;

beforeEach(async () => {
  ctx = await createTestContext();
  brain = new PersonalBrainService(ctx.db, new HashingEmbeddingProvider());
});

afterEach(() => ctx.close());

function seedAgent(): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Trusted analyst',
    adapterType: 'http',
    capabilityTags: [],
    config: {},
    status: 'online',
  }).run();
  return id;
}

describe('PersonalBrainService', () => {
  it('retrieves user-owned notes and withholds them until an agent is granted access', async () => {
    const agentId = seedAgent();
    await brain.create(ctx.user.id, { title: 'Preference', content: 'Always include rollback steps in release recommendations.' });

    expect((await brain.search(ctx.user.id, 'rollback release'))[0]!.content).toContain('rollback');
    expect(await brain.contextForAgent(ctx.user.id, agentId, 'rollback release')).toBe('');

    brain.grant(ctx.user.id, agentId);
    expect(await brain.contextForAgent(ctx.user.id, agentId, 'rollback release')).toContain('<personal_brain>');

    brain.revoke(ctx.user.id, agentId);
    expect(await brain.contextForAgent(ctx.user.id, agentId, 'rollback release')).toBe('');
  });

  it('projects private notes into a personal brain map', async () => {
    await brain.create(ctx.user.id, { title: 'Preference', content: 'Always include rollback steps in release recommendations.' });
    await brain.create(ctx.user.id, { title: 'Decision', content: 'Release recommendations must include rollback validation.' });

    const graph = brain.graph(ctx.user.id);

    expect(graph.meta.scopeId).toBe(ctx.user.id);
    expect(graph.meta.atomCount).toBe(2);
    expect(graph.nodes.map((node) => node.label)).toContain('Preference');
    expect(graph.links.some((link) => link.target === 'core')).toBe(true);
  });

  it('returns full private note detail for a selected map node', async () => {
    const note = await brain.create(ctx.user.id, { title: 'Preference', content: 'Always include a complete rollback checklist in every release recommendation.' });

    const detail = brain.detail(ctx.user.id, `memory:${note.id}`);

    expect(detail?.content).toContain('complete rollback checklist');
    expect(detail?.provenance).toMatchObject({ createdBy: 'You', source: 'Personal note' });
    expect(detail?.links).toHaveLength(1);
  });
});
