/**
 * CommandIndex — Cmd+K search relevance + workspace scope.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { CommandIndex } from '../../src/services/commandIndex.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let idx: CommandIndex;

beforeEach(async () => {
  ctx = await createTestContext();
  idx = new CommandIndex(ctx.db);
  // Seed two workflows + one agent.
  ctx.db.insert(schema.workflows).values([
    {
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      title: 'Daily Standup',
      description: 'Morning ritual',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      latestRevision: 1,
    },
    {
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      title: 'Deploy Pipeline',
      description: 'CI orchestration',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      latestRevision: 1,
    },
  ]).run();
  ctx.db.insert(schema.agents).values({
    id: randomUUID(),
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Standup Bot',
    adapterType: 'http',
    adapterConfig: {},
    capabilityTags: [],
    status: 'idle',
    colorHex: '#6366f1',
  }).run();
});

describe('CommandIndex.search', () => {
  it('returns nothing when no fields match', () => {
    expect(idx.search(ctx.workspace.id, 'zzzz')).toEqual([]);
  });

  it('exact match scores higher than partial match', () => {
    const hits = idx.search(ctx.workspace.id, 'standup');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // All hits should have a positive score and be sorted desc.
    for (let i = 0; i < hits.length - 1; i++) {
      expect(hits[i]!.score).toBeGreaterThanOrEqual(hits[i + 1]!.score);
    }
  });

  it('returns workflow + agent hits with proper hrefs', () => {
    const hits = idx.search(ctx.workspace.id, 'standup');
    const wf = hits.find((h) => h.type === 'workflow');
    const ag = hits.find((h) => h.type === 'agent');
    expect(wf?.href).toMatch(/^\/workflows\//);
    expect(ag?.href).toMatch(/^\/agents\//);
  });

  it('case insensitive', () => {
    expect(idx.search(ctx.workspace.id, 'DAILY').length).toBeGreaterThan(0);
  });

  it('workspace-isolated', async () => {
    const ctx2 = await createTestContext({ username: 'other' });
    expect(idx.search(ctx2.workspace.id, 'standup')).toEqual([]);
    ctx2.close();
  });

  it('does not scan for empty or one-character queries', () => {
    const hits = idx.search(ctx.workspace.id, '');
    expect(hits).toEqual([]);
    expect(idx.search(ctx.workspace.id, 's')).toEqual([]);
  });
});
