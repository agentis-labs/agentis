/**
 * WorkflowEngine — human_input node.
 *
 * Pauses the run for a human to submit structured form values, which become the
 * node's output; reject fails the node. Resumes through the same approval path an
 * operator uses (ApprovalInboxService.resolve, now carrying `data`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

interface SubmitInfo { approvalId: string; form: unknown }

async function runHumanInput(opts: {
  outputKey?: string;
  onWaiting: (info: SubmitInfo, approvals: ApprovalInboxService) => Promise<void>;
}): Promise<{ status: string; output: Record<string, unknown> }> {
  const hi: Record<string, unknown> = {
    kind: 'human_input',
    prompt: 'Fill in the details',
    fields: [{ key: 'subject', type: 'text', required: true }, { key: 'sendDate', type: 'date' }],
  };
  if (opts.outputKey) hi.outputKey = opts.outputKey;
  const graph = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 't', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'H', type: 'human_input', title: 'collect', position: { x: 1, y: 0 }, config: hi },
      { id: 'O', type: 'return_output', title: 'o', position: { x: 2, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'H' }, { id: 'e2', source: 'H', target: 'O' }],
  } as unknown as WorkflowGraph;

  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'hi-wf', graph, settings: {} }).run();
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();

  const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals,
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
  });
  approvals.bindCheckpointHandler(async ({ runId: rid, approvalId, decision, data }) => {
    await engine.resolveApproval({ runId: rid, approvalId, decision, data });
  });

  const terminal = new Promise<string>((resolve) => {
    const off = ctx.bus.subscribe((m) => {
      if (m.room !== `run:${runId}`) return;
      if (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) { off(); resolve('COMPLETED'); }
      else if (m.envelope.event === REALTIME_EVENTS.RUN_FAILED) { off(); resolve('FAILED'); }
    });
  });

  // When the node pauses for input, run the submission.
  const offWaiting = ctx.bus.subscribe((m) => {
    if (m.room === `run:${runId}` && m.envelope.event === REALTIME_EVENTS.NODE_WAITING_FOR_INPUT) {
      const payload = m.envelope.payload as { reason?: string; approvalId?: string; form?: unknown };
      if (payload.reason === 'human_input' && payload.approvalId) {
        offWaiting();
        void opts.onWaiting({ approvalId: payload.approvalId, form: payload.form }, approvals);
      }
    }
  });

  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
  const status = await terminal;
  const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  const state = row.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown> }> };
  return { status: row.status ?? status, output: state.nodeStates.H?.outputData ?? {} };
}

describe('WorkflowEngine — human_input', () => {
  it('pauses, then completes with the submitted form values as output', async () => {
    let seenForm: unknown;
    const { status, output } = await runHumanInput({
      onWaiting: async ({ approvalId, form }, approvals) => {
        seenForm = form;
        await approvals.resolve({ workspaceId: ctx.workspace.id, approvalId, decision: 'approve', data: { subject: 'Launch', sendDate: '2026-07-01' } });
      },
    });
    expect(status).toBe('COMPLETED');
    expect(output).toMatchObject({ subject: 'Launch', sendDate: '2026-07-01' });
    // The pause event carried the form spec the UI needs to render.
    expect(seenForm).toMatchObject({ fields: expect.arrayContaining([expect.objectContaining({ key: 'subject' })]) });
  });

  it('wraps the submission under outputKey when set', async () => {
    const { status, output } = await runHumanInput({
      outputKey: 'form',
      onWaiting: async ({ approvalId }, approvals) => {
        await approvals.resolve({ workspaceId: ctx.workspace.id, approvalId, decision: 'approve', data: { subject: 'Hi' } });
      },
    });
    expect(status).toBe('COMPLETED');
    expect(output).toEqual({ form: { subject: 'Hi' } });
  });

  it('fails the node when the human rejects the form', async () => {
    const { status } = await runHumanInput({
      onWaiting: async ({ approvalId }, approvals) => {
        await approvals.resolve({ workspaceId: ctx.workspace.id, approvalId, decision: 'reject' });
      },
    });
    expect(status).toBe('FAILED');
  });
});
