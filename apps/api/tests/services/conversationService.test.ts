/**
 * ConversationService — integration over the REAL App datastore (GAP B1/B3).
 * The pure transitions are covered in conversationRuntime.test.ts; here we prove
 * the wiring: collections auto-create, the script + contacts persist and reload,
 * a run_workflow stage inserts a real run row, and the run-complete hook resolves
 * the App from the workflow and wakes the right contact.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import type { WorkflowGraph } from '@agentis/core';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ConversationService } from '../../src/services/conversation/conversationService.js';

const SCRIPT = {
  contactCollection: 'contacts',
  locale: 'pt', // this test App speaks Brazilian Portuguese; the platform assumes none
  initialStage: 'greet',
  stages: [
    { id: 'greet', entry: { kind: 'send_deterministic', template: 'Oi, {greeting}' }, onReply: { kind: 'goto', stage: 'pitch' } },
    {
      id: 'pitch',
      entry: { kind: 'send_agent', brief: 'pitch' },
      onReply: { kind: 'classify', brief: 'interested?', labels: ['positive', 'negative'], branches: { positive: 'build', negative: 'closed' } },
    },
    { id: 'build', entry: { kind: 'run_workflow', workflowId: 'WF', inputsFrom: {} }, onComplete: { stage: 'deliver' } },
    { id: 'deliver', entry: { kind: 'send_agent', brief: 'deliver' }, terminal: true },
    { id: 'closed', terminal: true },
  ],
};

const MANUAL_GRAPH: WorkflowGraph = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [{ id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } }],
  edges: [],
};

describe('ConversationService (integration)', () => {
  let ctx: TestContext;
  let appId: string;
  let wfId: string;
  let sends: Array<{ connectionId: string; chatId: string; body: string; attachments?: unknown }>;
  let service: ConversationService;

  beforeEach(async () => {
    ctx = await createTestContext();
    appId = randomUUID();
    wfId = 'WF';
    ctx.db.insert(schema.apps).values({ id: appId, workspaceId: ctx.workspace.id, slug: 'sales', name: 'Sales Desk', createdBy: ctx.user.id }).run();
    // A minimal App-owned workflow so the run_workflow stage can start a real run.
    ctx.db.insert(schema.workflows).values({
      id: wfId, workspaceId: ctx.workspace.id, userId: ctx.user.id, appId, title: 'Build Store', graph: MANUAL_GRAPH, settings: {},
    }).run();

    sends = [];
    service = new ConversationService({
      db: ctx.db,
      bus: ctx.bus,
      engine: { startRun: async () => ({ runId: 'ignored' }) }, // the service inserts the run row itself
      channels: {
        deliverToConnection: async (a) => { sends.push(a); },
        resolveDestination: ({ to }) => ({ chatId: to ?? null, source: 'explicit' as const }),
      },
      resolveCompleter: () => ({
        completeStructured: async ({ system }: { system: string }) =>
          (/classif/i.test(system) ? { label: 'positive' } : { message: 'mensagem' }) as never,
      }),
      logger: ctx.logger,
    });
  });
  afterEach(() => ctx.close());

  const context = () => ({ workspaceId: ctx.workspace.id, appId, userId: ctx.user.id, ambientId: ctx.ambient.id });

  it('define auto-creates the collections and persists the script (reload roundtrip)', () => {
    const r = service.define({ workspaceId: ctx.workspace.id, appId }, SCRIPT);
    expect(r).toMatchObject({ ok: true, stages: 5, contactCollection: 'contacts' });
    // Re-defining is idempotent (collections already exist).
    expect(() => service.define({ workspaceId: ctx.workspace.id, appId }, SCRIPT)).not.toThrow();
  });

  it('drives the whole funnel through the real datastore: greet → pitch → build → deliver(stop)', async () => {
    service.define({ workspaceId: ctx.workspace.id, appId }, SCRIPT);

    // Enroll → deterministic greeting (time-of-day, so assert the shape), persisted at stage greet.
    await service.enroll(context(), '+5511988', 'conn1');
    expect(sends.at(-1)?.chatId).toBe('+5511988');
    expect(sends.at(-1)?.body).toMatch(/^Oi, (bom dia|boa tarde|boa noite)$/);

    // Reply → agent-composed pitch (the contact reloaded from the datastore).
    let r = await service.handleInbound({ ...context(), address: '+5511988', text: 'oi' });
    expect(r).toMatchObject({ handled: true, stage: 'pitch', sent: true });
    expect(sends.at(-1)?.body).toBe('mensagem');

    // Positive reply → classify → run_workflow: a REAL run row is inserted and awaited.
    r = await service.handleInbound({ ...context(), address: '+5511988', text: 'quero!' });
    expect(r).toMatchObject({ handled: true, stage: 'build', action: 'run_workflow' });
    const runRow = ctx.db.select().from(schema.workflowRuns).all()[0]!;
    expect(runRow.workflowId).toBe(wfId);
    const before = sends.length;

    // The build completing (via the workflow → App derivation) wakes the contact.
    await service.onRunComplete({ runId: runRow.id, status: 'COMPLETED', workflowId: wfId, workspaceId: ctx.workspace.id });
    expect(sends.length).toBe(before + 1); // deliver sent
    expect(sends.at(-1)?.body).toBe('mensagem');

    // Contact landed in the terminal stage — a further reply stays silent.
    const after = sends.length;
    const last = await service.handleInbound({ ...context(), address: '+5511988', text: 'obrigado' });
    expect(last).toMatchObject({ handled: true, reason: 'stopped' });
    expect(sends.length).toBe(after);
  });

  it('an inbound to an App with no script is not handled (a normal agent turn proceeds)', async () => {
    const r = await service.handleInbound({ ...context(), address: '+55x', text: 'oi' });
    expect(r.handled).toBe(false);
  });
});

describe('ConversationService — Brain memory wiring', () => {
  let ctx: TestContext;
  let appId: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    appId = randomUUID();
    ctx.db.insert(schema.apps).values({ id: appId, workspaceId: ctx.workspace.id, slug: 'sales', name: 'Sales Desk', createdBy: ctx.user.id }).run();
  });
  afterEach(() => ctx.close());

  const context = () => ({ workspaceId: ctx.workspace.id, appId, userId: ctx.user.id, ambientId: ctx.ambient.id });

  it('calls buildDispatchContext scoped to the App and folds the block into the composed prompt', async () => {
    const calls: Array<{ workspaceId: string; scopeId?: string | null; taskDescription: string }> = [];
    const capturedUsers: string[] = [];
    const service = new ConversationService({
      db: ctx.db,
      bus: ctx.bus,
      engine: { startRun: async () => ({ runId: 'ignored' }) },
      channels: {
        deliverToConnection: async () => {},
        resolveDestination: ({ to }) => ({ chatId: to ?? null, source: 'explicit' as const }),
      },
      resolveCompleter: () => ({
        completeStructured: async ({ system, user }: { system: string; user: string }) => {
          capturedUsers.push(user);
          return (/classif/i.test(system) ? { label: 'positive' } : { message: 'mensagem' }) as never;
        },
      }),
      sharedIntelligence: {
        buildDispatchContext: async (args) => {
          calls.push({ workspaceId: args.workspaceId, scopeId: args.scopeId, taskDescription: args.taskDescription });
          return { block: 'Remember: this store prefers weekend delivery.', atomIds: ['x'], relevantCount: 1 };
        },
      },
      logger: ctx.logger,
    });
    service.define({ workspaceId: ctx.workspace.id, appId }, SCRIPT);
    await service.enroll(context(), '+5511988', 'conn1');
    await service.handleInbound({ ...context(), address: '+5511988', text: 'oi' }); // → pitch (send_agent)

    expect(calls).toEqual([{ workspaceId: ctx.workspace.id, scopeId: appId, taskDescription: 'pitch' }]);
    expect(capturedUsers.some((u) => u.includes('Brain memory:') && u.includes('weekend delivery'))).toBe(true);
  });

  it('a rejected buildDispatchContext degrades to no memory block instead of failing the send', async () => {
    const capturedUsers: string[] = [];
    const service = new ConversationService({
      db: ctx.db,
      bus: ctx.bus,
      engine: { startRun: async () => ({ runId: 'ignored' }) },
      channels: {
        deliverToConnection: async () => {},
        resolveDestination: ({ to }) => ({ chatId: to ?? null, source: 'explicit' as const }),
      },
      resolveCompleter: () => ({
        completeStructured: async ({ system, user }: { system: string; user: string }) => {
          capturedUsers.push(user);
          return (/classif/i.test(system) ? { label: 'positive' } : { message: 'mensagem' }) as never;
        },
      }),
      sharedIntelligence: {
        buildDispatchContext: async () => { throw new Error('brain boom'); },
      },
      logger: ctx.logger,
    });
    service.define({ workspaceId: ctx.workspace.id, appId }, SCRIPT);
    await service.enroll(context(), '+5511988', 'conn1');
    const r = await service.handleInbound({ ...context(), address: '+5511988', text: 'oi' });
    expect(r).toMatchObject({ handled: true, stage: 'pitch', sent: true });
    expect(capturedUsers.every((u) => !u.includes('Brain memory:'))).toBe(true);
  });
});
