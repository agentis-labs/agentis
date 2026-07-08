/**
 * Engine integration tests for the WORKFLOW-UPDATE utility/data node kinds:
 * code, spreadsheet, stop_error, and the deterministic pure kinds — exercised
 * through the engine's `testNode()` dry-run path (the same path the canvas
 * "test node" button uses).
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
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
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
  });
}

function persist(node: WorkflowNode): string {
  const workflowId = randomUUID();
  const graph: WorkflowGraph = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node], edges: [] };
  ctx.db.insert(schema.workflows).values({
    id: workflowId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'Utility nodes',
    graph,
    settings: {},
  }).run();
  return workflowId;
}

async function run(node: WorkflowNode, inputs: Record<string, unknown>) {
  const workflowId = persist(node);
  return makeEngine().testNode({
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    workflowId,
    nodeId: node.id,
    inputs,
  });
}

function node(id: string, config: WorkflowNode['config']): WorkflowNode {
  return { id, type: config.kind, title: id, position: { x: 0, y: 0 }, config };
}

describe('code node', () => {
  it('runs JavaScript and returns the result', async () => {
    const result = await run(
      node('c', { kind: 'code', language: 'javascript', code: 'return { doubled: input.n * 2 };', inputKeys: ['n'] }),
      { n: 21 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toMatchObject({ doubled: 42 });
  });

  it('wraps a scalar result under outputKey', async () => {
    const result = await run(
      node('c', { kind: 'code', language: 'javascript', code: 'input.a + input.b', inputKeys: ['a', 'b'], outputKey: 'sum' }),
      { a: 2, b: 3 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.sum).toBe(5);
  });
});

describe('spreadsheet node', () => {
  it('parses CSV into row objects', async () => {
    const result = await run(
      node('s', { kind: 'spreadsheet', operation: 'parse', format: 'csv', inputPath: 'csv', hasHeaders: true }),
      { csv: 'name,age\nAlice,30\nBob,25' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.rows).toEqual([{ name: 'Alice', age: '30' }, { name: 'Bob', age: '25' }]);
  });

  it('builds CSV from rows', async () => {
    const result = await run(
      node('s', { kind: 'spreadsheet', operation: 'build', format: 'csv', inputPath: 'rows', hasHeaders: true }),
      { rows: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.content).toBe('a,b\n1,x\n2,y');
  });

  it('round-trips XLSX (build then parse)', async () => {
    const built = await run(
      node('s', { kind: 'spreadsheet', operation: 'build', format: 'xlsx', inputPath: 'rows', hasHeaders: true, outputKey: 'x' }),
      { rows: [{ name: 'Alice', city: 'NYC' }] },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const parsed = await run(
      node('s2', { kind: 'spreadsheet', operation: 'parse', format: 'xlsx', inputPath: 'x', hasHeaders: true }),
      { x: built.output.x },
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.output.rows).toEqual([{ name: 'Alice', city: 'NYC' }]);
  });
});

describe('stop_error node', () => {
  it('fails the node with the custom message', async () => {
    const result = await run(node('e', { kind: 'stop_error', errorMessage: 'halt now' }), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('halt now');
      expect(result.code).toBe('WORKFLOW_STOPPED');
    }
  });
});

describe('pure utility kinds via the engine', () => {
  it('datetime resolves through the handler registry', async () => {
    const result = await run(
      node('d', { kind: 'datetime', operation: 'format', inputPath: 'd', outputFormat: 'date' }),
      { d: '2026-03-04T00:00:00Z' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.datetime).toBe('2026-03-04');
  });

  it('crypto_util hashes through the engine', async () => {
    const result = await run(
      node('h', { kind: 'crypto_util', operation: 'hash', inputPath: 'v' }),
      { v: 'hello' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.crypto).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});
