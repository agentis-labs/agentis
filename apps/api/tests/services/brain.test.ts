/**
 * BrainService — composed workspace Brain overview (§G1–G11).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '@agentis/db/sqlite';
import { BrainService } from '../../src/services/brain.js';
import { AgentMemoryService } from '../../src/services/agentMemory.js';
import { KnowledgeBaseService } from '../../src/services/knowledgeBase.js';
import { WorkflowStoreService } from '../../src/services/workflowStore.js';
import { WorkspaceVolumeService } from '../../src/services/workspaceVolume.js';
import { WorkspaceIntelligenceService } from '../../src/services/workspaceIntelligence.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let dataDir: string;
let brain: BrainService;
let agentMemory: AgentMemoryService;
let knowledge: KnowledgeBaseService;
let workflowStore: WorkflowStoreService;
let intelligence: WorkspaceIntelligenceService;

beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = mkdtempSync(join(tmpdir(), 'brain-test-'));
  const volume = new WorkspaceVolumeService(dataDir);
  intelligence = new WorkspaceIntelligenceService(volume);
  knowledge = new KnowledgeBaseService(ctx.db);
  agentMemory = new AgentMemoryService(ctx.db);
  workflowStore = new WorkflowStoreService(ctx.db);
  brain = new BrainService({ db: ctx.db, intelligence, knowledgeBases: knowledge, agentMemory });
});

afterEach(() => {
  ctx.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function seedAgent(name = 'Researcher'): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name, adapterType: 'http', capabilityTags: [], config: {}, status: 'online', role: 'researcher',
  }).run();
  return id;
}

function seedWorkflow(title = 'Daily Digest'): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title, graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  }).run();
  return id;
}

describe('BrainService.overview', () => {
  it('reports a fully empty Brain with honest gaps', async () => {
    const ov = await brain.overview(ctx.workspace.id);
    expect(ov.stats.knowledgeBases).toBe(0);
    expect(ov.stats.chunks).toBe(0);
    expect(ov.stats.memoryEntries).toBe(0);
    expect(ov.gaps.map((g) => g.code)).toContain('no_knowledge_bases');
    expect(ov.gaps.map((g) => g.code)).toContain('blank_workspace_context');
    expect(ov.gaps.map((g) => g.code)).toContain('no_memory');
  });

  it('composes knowledge-base stats including indexed chunk counts', async () => {
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'Product Specs' });
    knowledge.addDocument({ workspaceId: ctx.workspace.id, knowledgeBaseId: kb.id, name: 'spec.md', content: 'The product supports SSO via SAML and OIDC. Billing is monthly.' });

    const ov = await brain.overview(ctx.workspace.id);
    expect(ov.stats.knowledgeBases).toBe(1);
    expect(ov.stats.documents).toBe(1);
    expect(ov.stats.chunks).toBeGreaterThan(0);
    const base = ov.knowledge.bases.find((b) => b.id === kb.id)!;
    expect(base.name).toBe('Product Specs');
    expect(base.chunkCount).toBeGreaterThan(0);
    expect(base.lastIndexedAt).not.toBeNull();
    // A populated KB must not raise the empty-KB gap.
    expect(ov.gaps.find((g) => g.code === 'empty_knowledge_base')).toBeUndefined();
  });

  it('raises the empty_knowledge_base gap for a base with no chunks', async () => {
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'Empty Base' });
    const ov = await brain.overview(ctx.workspace.id);
    const gap = ov.gaps.find((g) => g.code === 'empty_knowledge_base');
    expect(gap).toBeDefined();
    expect(gap!.refId).toBe(kb.id);
  });

  it('counts workspace memory entries and surfaces recent ones', async () => {
    await intelligence.appendMemory(ctx.workspace.id, 'Effective Patterns', 'Cache HN responses for 10 minutes to cut cost.');
    const ov = await brain.overview(ctx.workspace.id);
    expect(ov.stats.memoryEntries).toBeGreaterThan(0);
    expect(ov.context.memory.recent.some((m) => m.text.includes('Cache HN'))).toBe(true);
    expect(ov.gaps.find((g) => g.code === 'no_memory')).toBeUndefined();
  });

  it('aggregates workflow memory per workflow', async () => {
    const wfId = seedWorkflow('Daily Digest');
    workflowStore.set(ctx.workspace.id, wfId, 'lastCursor', '2026-05-24');
    workflowStore.set(ctx.workspace.id, wfId, 'seenIds', ['a', 'b']);

    const ov = await brain.overview(ctx.workspace.id);
    expect(ov.stats.workflowMemoryKeys).toBe(2);
    const row = ov.workflowMemory.workflows.find((w) => w.workflowId === wfId)!;
    expect(row.workflowTitle).toBe('Daily Digest');
    expect(row.keyCount).toBe(2);
  });

  it('treats agent memory as part of the Brain (no_memory clears once an agent remembers)', async () => {
    const agentId = seedAgent();
    agentMemory.append({ agentId, workspaceId: ctx.workspace.id, section: 'Findings', content: 'Competitor X shipped SSO in April.' });
    const ov = await brain.overview(ctx.workspace.id);
    expect(ov.gaps.find((g) => g.code === 'no_memory')).toBeUndefined();
  });
});
