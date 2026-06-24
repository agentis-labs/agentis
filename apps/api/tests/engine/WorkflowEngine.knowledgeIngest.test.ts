/**
 * Engine integration tests for the `knowledge_ingest` node — the write-side twin
 * of `knowledge`. Both delegate to the same `KnowledgeBaseService`, so a document
 * ingested by a workflow must be retrievable by a `search()` afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { WorkflowGraph, WorkflowNode } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { KnowledgeBaseService } from '../../src/services/knowledgeBase.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let knowledgeBases: KnowledgeBaseService;
beforeEach(async () => {
  ctx = await createTestContext();
  knowledgeBases = new KnowledgeBaseService(ctx.db);
});
afterEach(() => { ctx.close(); });

function makeEngine(): WorkflowEngine {
  return new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    knowledgeBases,
  });
}

function node(id: string, config: WorkflowNode['config']): WorkflowNode {
  return { id, type: config.kind, title: id, position: { x: 0, y: 0 }, config };
}

async function run(n: WorkflowNode, inputs: Record<string, unknown>) {
  const workflowId = randomUUID();
  const graph: WorkflowGraph = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [n], edges: [] };
  ctx.db.insert(schema.workflows).values({
    id: workflowId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'Knowledge ingest',
    graph,
    settings: {},
  }).run();
  return makeEngine().testNode({
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    workflowId,
    nodeId: n.id,
    inputs,
  });
}

describe('knowledge_ingest node', () => {
  it('creates a base on demand and stores the document', async () => {
    const result = await run(
      node('k', { kind: 'knowledge_ingest', contentPath: 'body', documentName: 'Onboarding policy', mimeType: 'text/markdown' }),
      { body: 'New hires must complete the security training within the first week.' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.documentId).toBeTruthy();
    expect(result.output.name).toBe('Onboarding policy');
    expect(result.output.chunks).toBeGreaterThanOrEqual(1);

    // Symmetry: the ingested content is now retrievable via the read path.
    const baseId = result.output.knowledgeBaseId as string;
    const hits = await knowledgeBases.search({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: baseId,
      query: 'security training new hires',
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('targets an explicit knowledge base when provided', async () => {
    const base = knowledgeBases.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'Runbooks' });
    const result = await run(
      node('k', { kind: 'knowledge_ingest', knowledgeBaseId: base.id, content: 'Restart the worker pool if the queue depth exceeds 10k.' }),
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.knowledgeBaseId).toBe(base.id);
  });

  it('serializes a non-string input value to JSON before storing', async () => {
    const result = await run(
      node('k', { kind: 'knowledge_ingest', contentPath: 'record', documentName: 'Record' }),
      { record: { customer: 'Acme', tier: 'gold', mrr: 1200 } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.chunks).toBeGreaterThanOrEqual(1);
  });

  it('fails when there is no content to store', async () => {
    const result = await run(
      node('k', { kind: 'knowledge_ingest', contentPath: 'missing' }),
      { other: 'value' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('VALIDATION_FAILED');
  });
});
