import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { createWorkflowFromDescription, registerBuildTools } from '../../src/services/agentisToolHandlers/build.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { hashWorkflowGraph } from '../../src/services/graphHash.js';
import {
  applyLegacyWorkflowPatchDraft,
  applyWorkflowGraphOperations,
  WorkflowGraphMutationError,
} from '../../src/services/workflow/workflowGraphMutation.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

function graph(): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'transform', type: 'transform', title: 'Transform', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ value: input.value })', timeoutMs: 5000 } },
      { id: 'return', type: 'return_output', title: 'Return', position: { x: 400, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'transform' },
      { id: 'e2', source: 'transform', target: 'return' },
    ],
  } as WorkflowGraph;
}

describe('workflow graph mutation primitive', () => {
  it('deep-merges a node field while preserving identity, type, position, and unrelated config', () => {
    const base = graph();
    const result = applyWorkflowGraphOperations(base, [{
      op: 'patch_node', nodeId: 'transform', patch: { title: 'Revised', config: { expression: '({ value: String(input.value) })' } },
    }]);
    const node = result.graph.nodes.find((entry) => entry.id === 'transform')!;
    expect(node).toMatchObject({
      id: 'transform', type: 'transform', title: 'Revised', position: { x: 200, y: 0 },
      config: { kind: 'transform', expression: '({ value: String(input.value) })', timeoutMs: 5000 },
    });
    expect(base.nodes.find((entry) => entry.id === 'transform')?.title).toBe('Transform');
    expect(result.diff.nodes.updated).toEqual([{ id: 'transform', paths: ['config.expression', 'title'] }]);
  });

  it('makes legacy updateNodes a true partial merge instead of a whole-node replacement', () => {
    const revised = applyLegacyWorkflowPatchDraft(graph(), { updateNodes: [{ id: 'transform', title: 'Partial' }] });
    expect(revised.nodes.find((node) => node.id === 'transform')).toMatchObject({
      id: 'transform', type: 'transform', title: 'Partial', position: { x: 200, y: 0 },
      config: { kind: 'transform', timeoutMs: 5000 },
    });
  });

  it('removes connected edges and rejects identity changes', () => {
    const removed = applyWorkflowGraphOperations(graph(), [{ op: 'remove_node', nodeId: 'transform' }]);
    expect(removed.graph.edges).toEqual([]);
    expect(removed.diff.nodes.removed).toEqual(['transform']);
    expect(() => applyWorkflowGraphOperations(graph(), [{ op: 'patch_node', nodeId: 'transform', patch: { id: 'other' } }]))
      .toThrow(WorkflowGraphMutationError);
  });
});

describe('stored workflow graph tools', () => {
  let ctx: TestContext;
  let registry: AgentisToolRegistry;

  beforeEach(async () => {
    ctx = await createTestContext();
    const ledger = new LedgerService(ctx.db, ctx.bus);
    const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
    const activity = new ActivityFeedService(ctx.db, ctx.bus);
    const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
    const adapters = new AdapterManager(ctx.logger);
    const engine = new WorkflowEngine({
      db: ctx.db, bus: ctx.bus, logger: ctx.logger, ledger, scratchpad, activity, approvals,
      skills: {} as ExtensionRuntime, adapters,
    });
    registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBuildTools(registry, {
      db: ctx.db, logger: ctx.logger, bus: ctx.bus, engine, adapters,
      ledger, scratchpad, approvals, activity, replay: {} as ToolHandlerDeps['replay'],
    } as ToolHandlerDeps);
  });

  afterEach(() => ctx.close());

  const toolContext = () => ({
    workspaceId: ctx.workspace.id, userId: ctx.user.id, ambientId: ctx.ambient.id, caller: 'chat' as const,
  });

  function seed(): string {
    const id = `wf-${Date.now()}`;
    const value = graph();
    ctx.db.insert(schema.workflows).values({
      id, workspaceId: ctx.workspace.id, userId: ctx.user.id, title: 'Mutable', description: 'safe mutation test',
      graph: value, contentHash: hashWorkflowGraph(value), settings: {},
    }).run();
    return id;
  }

  it('commits a field-level patch with a structured diff and rejects a stale base hash', async () => {
    const workflowId = seed();
    const baseHash = hashWorkflowGraph(graph());
    const changed = await registry.execute({
      id: 'patch', toolId: 'agentis.workflow.graph.patch', arguments: {
        workflowId, baseHash,
        operations: [{ op: 'patch_node', nodeId: 'transform', patch: { title: 'Changed safely' } }],
      },
    }, toolContext());
    expect(changed.ok).toBe(true);
    expect(changed.output).toMatchObject({
      committed: true, operation: 'patch',
      diff: { nodes: { updated: [{ id: 'transform', paths: ['title'] }] } },
      revision: { beforeHash: baseHash },
    });
    const saved = ctx.db.select().from(schema.workflows).all().find((row) => row.id === workflowId)!;
    expect(saved.contentHash).toBe(hashWorkflowGraph(saved.graph as WorkflowGraph));
    expect((saved.graph as WorkflowGraph).nodes.find((node) => node.id === 'transform')).toMatchObject({
      title: 'Changed safely', type: 'transform', config: { timeoutMs: 5000 },
    });

    const stale = await registry.execute({
      id: 'stale', toolId: 'agentis.workflow.graph.patch', arguments: {
        workflowId, baseHash,
        operations: [{ op: 'patch_node', nodeId: 'transform', patch: { title: 'Stale overwrite' } }],
      },
    }, toolContext());
    expect(stale.ok).toBe(false);
    expect(stale.errorCode).toBe('GRAPH_REVISION_CONFLICT');
    expect((ctx.db.select().from(schema.workflows).all().find((row) => row.id === workflowId)!.graph as WorkflowGraph)
      .nodes.find((node) => node.id === 'transform')?.title).toBe('Changed safely');
  });

  it('previews a validated mutation without writing', async () => {
    const workflowId = seed();
    const preview = await registry.execute({
      id: 'preview', toolId: 'agentis.workflow.graph.patch', arguments: {
        workflowId, dryRun: true,
        operations: [{ op: 'patch_node', nodeId: 'transform', patch: { title: 'Preview only' } }],
      },
    }, toolContext());
    expect(preview.ok).toBe(true);
    expect(preview.output).toMatchObject({ committed: false, preview: true });
    const stored = ctx.db.select().from(schema.workflows).all().find((row) => row.id === workflowId)!;
    expect((stored.graph as WorkflowGraph).nodes.find((node) => node.id === 'transform')?.title).toBe('Transform');
  });

  it('persists bounded revision snapshots and performs conflict-safe reversible rollback', async () => {
    const workflowId = seed();
    const originalHash = hashWorkflowGraph(graph());
    const changed = await registry.execute({
      id: 'change-before-rollback', toolId: 'agentis.workflow.graph.patch', arguments: {
        workflowId, baseHash: originalHash,
        operations: [{ op: 'patch_node', nodeId: 'transform', patch: { title: 'Revision two' } }],
      },
    }, toolContext());
    expect(changed.ok).toBe(true);
    const changedHash = (changed.output as { revision: { afterHash: string } }).revision.afterHash;

    const listed = await registry.execute({
      id: 'list-revisions', toolId: 'agentis.workflow.graph.revisions', arguments: { workflowId },
    }, toolContext());
    expect(listed.ok).toBe(true);
    expect(listed.output).toMatchObject({
      current: { hash: changedHash },
      revisions: [{ hash: originalHash, replacedByHash: changedHash, operation: 'patch' }],
    });
    expect(JSON.stringify(listed.output)).not.toContain('"graph"');

    const preview = await registry.execute({
      id: 'rollback-preview', toolId: 'agentis.workflow.graph.rollback', arguments: {
        workflowId, targetHash: originalHash, baseHash: changedHash,
      },
    }, toolContext());
    expect(preview.ok).toBe(true);
    expect(preview.output).toMatchObject({ committed: false, preview: true, operation: 'rollback' });
    expect((ctx.db.select().from(schema.workflows).all().find((row) => row.id === workflowId)!.graph as WorkflowGraph)
      .nodes.find((node) => node.id === 'transform')?.title).toBe('Revision two');

    const stale = await registry.execute({
      id: 'rollback-stale', toolId: 'agentis.workflow.graph.rollback', arguments: {
        workflowId, targetHash: originalHash, baseHash: 'stale', confirm: true,
      },
    }, toolContext());
    expect(stale.ok).toBe(false);
    expect(stale.errorCode).toBe('GRAPH_REVISION_CONFLICT');

    const restored = await registry.execute({
      id: 'rollback-commit', toolId: 'agentis.workflow.graph.rollback', arguments: {
        workflowId, targetHash: originalHash, baseHash: changedHash, confirm: true,
      },
    }, toolContext());
    expect(restored.ok).toBe(true);
    expect(restored.output).toMatchObject({ committed: true, operation: 'rollback', revision: { afterHash: originalHash } });
    const saved = ctx.db.select().from(schema.workflows).all().find((row) => row.id === workflowId)!;
    expect((saved.graph as WorkflowGraph).nodes.find((node) => node.id === 'transform')?.title).toBe('Transform');
    const history = ((saved.settings as Record<string, unknown>).workflowGraphRevisionHistory as Array<Record<string, unknown>>);
    expect(history.some((revision) => revision.hash === changedHash && revision.operation === 'rollback')).toBe(true);
  });

  it('never corrupts a working graph across repeated approval-bypass repair attempts', async () => {
    const workflowId = seed();
    const originalHash = hashWorkflowGraph(graph());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rejected = await registry.execute({
        id: `adversarial-${attempt}`, toolId: 'agentis.workflow.graph.patch', arguments: {
          workflowId,
          baseHash: originalHash,
          confirmIntentChange: true,
          operations: [{
            op: 'patch_node', nodeId: 'transform',
            patch: { config: { expression: '({ approved: input.approved || true })' } },
          }],
        },
      }, toolContext());
      expect(rejected.ok).toBe(false);
      expect(rejected.errorCode).toBe('WORKFLOW_DRAFT_INVALID');
    }
    const saved = ctx.db.select().from(schema.workflows).all().find((row) => row.id === workflowId)!;
    expect(hashWorkflowGraph(saved.graph as WorkflowGraph)).toBe(originalHash);
    expect((saved.settings as Record<string, unknown>).workflowGraphRevisionHistory).toBeUndefined();
    expect((saved.graph as WorkflowGraph).nodes.find((node) => node.id === 'transform')?.config)
      .toMatchObject({ expression: '({ value: input.value })', timeoutMs: 5000 });
  });

  it('builds a new workflow directly into a requested existing App', async () => {
    const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Composite App' });
    const result = await createWorkflowFromDescription(
      { db: ctx.db, logger: ctx.logger, bus: ctx.bus } as ToolHandlerDeps,
      {
        workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id, appId: app.id,
        description: 'transform a value and return it', graphDraft: graph(), stream: false,
      },
    );
    expect(result.appId).toBe(app.id);
    const saved = ctx.db.select().from(schema.workflows).all().find((row) => row.id === result.workflowId)!;
    expect(saved.appId).toBe(app.id);
    expect(ctx.db.select().from(schema.apps).all()).toHaveLength(1);
  });
});
