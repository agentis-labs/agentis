import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore } from '@agentis/app';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { compileAppReadiness } from '../../src/services/app/appCompiler.js';
import { graphContentHash } from '../../src/services/workflow/workflowCompass.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

const graph: WorkflowGraph = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  outputContract: { fields: [{ key: 'ok', type: 'boolean', required: true }] },
  nodes: [
    { id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
    { id: 'output', type: 'return_output', title: 'Result', position: { x: 300, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
  ],
  edges: [{ id: 'edge', source: 'trigger', target: 'output' }],
};

function app() {
  return new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Compiler fixture' });
}

function insertWorkflow(appId: string, settings: Record<string, unknown> = {}, id = 'wf-1') {
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    appId, title: id, graph, settings,
  }).run();
}

function provenSettings() {
  const hash = graphContentHash(graph);
  return {
    spec: {
      version: 1,
      objective: 'Return an acknowledged result',
      acceptance: [{ id: 'ok', claim: 'result is acknowledged', verify: 'expr', expr: 'output.ok == true' }],
      reworkBudget: 1,
      createdAt: new Date().toISOString(),
      reconciledHash: hash,
    },
    workflowTests: [
      { id: 'happy', name: 'happy', kind: 'happy', inputs: {}, assertions: [], origin: 'authored' },
      { id: 'edge', name: 'edge', kind: 'edge', inputs: {}, assertions: [], origin: 'authored' },
    ],
    buildLoop: {
      dryRun: { at: new Date().toISOString(), graphHash: hash, ok: true, issueCount: 0 },
      suite: { at: new Date().toISOString(), graphHash: hash, ok: true, total: 2, passed: 2 },
    },
  };
}

describe('compileAppReadiness', () => {
  it('blocks predictable work before a costly debug run and returns ordered calls', () => {
    const fixture = app();
    insertWorkflow(fixture.id);

    const report = compileAppReadiness(ctx.db, ctx.workspace.id, fixture.id, 'debug');

    expect(report.ready).toBe(false);
    expect(report.executableReady).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'spec:wf-1', status: 'block' }),
      expect.objectContaining({ id: 'dry-run:wf-1', status: 'block' }),
      expect.objectContaining({ id: 'suite:wf-1', status: 'block' }),
    ]));
    expect(report.next.map((step) => step.tool)).toEqual(expect.arrayContaining([
      'agentis.workflow.scope', 'agentis.workflow.dry_run', 'agentis.workflow.test',
    ]));
  });

  it('separates debug readiness from production proof', () => {
    const fixture = app();
    insertWorkflow(fixture.id, provenSettings());

    const debug = compileAppReadiness(ctx.db, ctx.workspace.id, fixture.id, 'debug');
    const production = compileAppReadiness(ctx.db, ctx.workspace.id, fixture.id, 'production');

    expect(debug.ready).toBe(true);
    expect(debug.structuralReady).toBe(true);
    expect(production.ready).toBe(false);
    expect(production.readyForExecution).toBe(true);
    expect(production.executionBlockerCount).toBe(0);
    expect(production.evidencePendingCount).toBe(1);
    expect(production.checks).toContainEqual(expect.objectContaining({ id: 'debug-proof:wf-1', status: 'block', blocksExecution: false }));
    expect(production.next).toContainEqual(expect.objectContaining({ tool: 'agentis.workflow.run', args: { workflowId: 'wf-1', debugRun: true } }));
  });

  it('blocks guessed acceptance paths that do not exist in the terminal output contract', () => {
    const fixture = app();
    const settings = provenSettings();
    (settings.spec.acceptance[0] as { expr: string }).expr = 'output.value.ok == true';
    insertWorkflow(fixture.id, settings);

    const report = compileAppReadiness(ctx.db, ctx.workspace.id, fixture.id, 'debug');

    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: 'output-contract:wf-1',
      status: 'block',
      evidence: expect.objectContaining({ missingTopLevelPaths: ['value'] }),
    }));
  });

  it('detects business-stage labels that are not real conversation enrollment', () => {
    const fixture = app();
    insertWorkflow(fixture.id, provenSettings());
    ctx.db.insert(schema.appCollections).values([
      { id: 'scripts', appId: fixture.id, workspaceId: ctx.workspace.id, name: 'conversation_script', schemaJson: { fields: [{ key: 'key', type: 'string', required: true }] } },
      { id: 'contacts', appId: fixture.id, workspaceId: ctx.workspace.id, name: 'runtime_contacts', schemaJson: { fields: [{ key: 'address', type: 'string' }, { key: 'stage', type: 'string' }] } },
      { id: 'leads', appId: fixture.id, workspaceId: ctx.workspace.id, name: 'business_records', schemaJson: { fields: [{ key: 'stage', type: 'string' }] } },
    ]).run();
    ctx.db.insert(schema.appRecords).values([
      {
        id: 'script', collectionId: 'scripts', appId: fixture.id, workspaceId: ctx.workspace.id,
        dataJson: { key: 'script', script: { version: 1, contactCollection: 'runtime_contacts', initialStage: 'awaiting_reply', stages: [
          { id: 'awaiting_reply', onReply: { kind: 'goto', stage: 'done' } },
          { id: 'done', terminal: true },
        ] } },
      },
      { id: 'lead', collectionId: 'leads', appId: fixture.id, workspaceId: ctx.workspace.id, dataJson: { stage: 'awaiting_reply', name: 'Example' } },
    ]).run();

    const report = compileAppReadiness(ctx.db, ctx.workspace.id, fixture.id, 'debug');

    expect(report.structuralReady).toBe(false);
    expect(report.executableReady).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'conversation-stranded-producer-state:runtime_contacts', status: 'block' }),
      expect.objectContaining({ id: 'conversation-no-enrollment:runtime_contacts', status: 'block' }),
    ]));
  });

  it('rejects mixing completion dependencies with conversation-owned activation', () => {
    const fixture = app();
    insertWorkflow(fixture.id, provenSettings(), 'wf-root');
    insertWorkflow(fixture.id, { ...provenSettings(), appBinding: { dependsOn: ['wf-root'], operatorEntrypoint: false } }, 'wf-event');
    ctx.db.insert(schema.appCollections).values([
      { id: 'scripts', appId: fixture.id, workspaceId: ctx.workspace.id, name: 'conversation_script', schemaJson: { fields: [{ key: 'key', type: 'string' }] } },
      { id: 'contacts', appId: fixture.id, workspaceId: ctx.workspace.id, name: 'runtime_contacts', schemaJson: { fields: [{ key: 'address', type: 'string' }, { key: 'stage', type: 'string' }] } },
    ]).run();
    ctx.db.insert(schema.appRecords).values([
      {
        id: 'script', collectionId: 'scripts', appId: fixture.id, workspaceId: ctx.workspace.id,
        dataJson: { key: 'script', script: { version: 1, contactCollection: 'runtime_contacts', initialStage: 'fulfil', stages: [
          { id: 'fulfil', entry: { kind: 'run_workflow', workflowId: 'wf-event', inputsFrom: {} }, onComplete: { stage: 'done' } },
          { id: 'done', terminal: true },
        ] } },
      },
      { id: 'contact', collectionId: 'contacts', appId: fixture.id, workspaceId: ctx.workspace.id, dataJson: { address: 'peer-1', connectionId: 'connection-1', stage: 'fulfil' } },
    ]).run();

    const report = compileAppReadiness(ctx.db, ctx.workspace.id, fixture.id, 'debug');

    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'conversation-mixed-activation:wf-event', status: 'block' }));
  });

  it('does not let one manually enrolled row hide a producer that never enrolls future contacts', () => {
    const fixture = app();
    insertWorkflow(fixture.id, provenSettings());
    const producerGraph: WorkflowGraph = {
      ...graph,
      nodes: [
        graph.nodes[0]!,
        {
          id: 'write-business-stage', type: 'data_mutate', title: 'Write waiting state', position: { x: 160, y: 0 },
          config: { kind: 'data_mutate', operation: 'upsert', collection: 'business_records', match: { id: '{{input.id}}' }, record: { id: '{{input.id}}', stage: 'awaiting_reply' } },
        },
        graph.nodes[1]!,
      ],
      edges: [
        { id: 'to-write', source: 'trigger', target: 'write-business-stage' },
        { id: 'to-output', source: 'write-business-stage', target: 'output' },
      ],
    };
    ctx.db.update(schema.workflows).set({ graph: producerGraph }).where(eq(schema.workflows.id, 'wf-1')).run();
    ctx.db.insert(schema.appCollections).values([
      { id: 'scripts', appId: fixture.id, workspaceId: ctx.workspace.id, name: 'conversation_script', schemaJson: { fields: [{ key: 'key', type: 'string' }] } },
      { id: 'contacts', appId: fixture.id, workspaceId: ctx.workspace.id, name: 'runtime_contacts', schemaJson: { fields: [{ key: 'address', type: 'string' }, { key: 'connectionId', type: 'string' }, { key: 'stage', type: 'string' }] } },
      { id: 'business', appId: fixture.id, workspaceId: ctx.workspace.id, name: 'business_records', schemaJson: { fields: [{ key: 'stage', type: 'string' }] } },
    ]).run();
    ctx.db.insert(schema.appRecords).values([
      { id: 'script', collectionId: 'scripts', appId: fixture.id, workspaceId: ctx.workspace.id, dataJson: { key: 'script', script: { version: 1, contactCollection: 'runtime_contacts', initialStage: 'awaiting_reply', stages: [{ id: 'awaiting_reply', onReply: { kind: 'goto', stage: 'done' } }, { id: 'done', terminal: true }] } } },
      { id: 'contact', collectionId: 'contacts', appId: fixture.id, workspaceId: ctx.workspace.id, dataJson: { address: 'peer-1', connectionId: 'connection-1', stage: 'awaiting_reply' } },
    ]).run();

    const report = compileAppReadiness(ctx.db, ctx.workspace.id, fixture.id, 'debug');

    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'conversation-producer-not-enrolling:runtime_contacts', status: 'block' }));
  });

  it('surfaces duplicate logical WhatsApp connections for one sender identity', () => {
    const fixture = app();
    insertWorkflow(fixture.id, provenSettings());
    ctx.db.insert(schema.channelConnections).values([
      {
        id: 'wa-a', workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
        appId: fixture.id, kind: 'whatsapp', name: 'Primary', tokenEncrypted: 'encrypted', status: 'active',
        settings: { selfId: '5511999999999:21@s.whatsapp.net', mode: 'qr_local' },
      },
      {
        id: 'wa-b', workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
        kind: 'whatsapp', name: 'Stale duplicate', tokenEncrypted: 'encrypted', status: 'error',
        settings: { selfId: '5511999999999:18@s.whatsapp.net', mode: 'qr_local' },
      },
    ]).run();

    const report = compileAppReadiness(ctx.db, ctx.workspace.id, fixture.id, 'debug');

    expect(report.checks).toContainEqual(expect.objectContaining({
      id: 'channel-duplicate-identity:5511999999999',
      status: 'warn',
    }));
  });
});
