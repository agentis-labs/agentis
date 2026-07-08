/**
 * WorkflowEngine — `mcp` node (masterplan 2.3).
 *
 * A workflow can call a registered MCP server's tool through the bridge. Success
 * → tool result as output; an MCP error → the node fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine, type McpBridgePort } from '../../src/engine/WorkflowEngine.js';
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

async function runMcp(bridge: McpBridgePort): Promise<{ status: string; output: Record<string, unknown> }> {
  const graph = {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 't', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'M', type: 'mcp', title: 'mcp', position: { x: 1, y: 0 }, config: { kind: 'mcp', toolId: 'github__create_issue', arguments: { title: 'Bug' }, outputKey: 'result' } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'M' }],
  } as unknown as WorkflowGraph;
  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'mcp-wf', graph, settings: {} }).run();
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();

  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    mcpBridge: bridge,
  });
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  const status = await new Promise<string>((resolve) => {
    const off = ctx.bus.subscribe((m) => {
      if (m.room !== `run:${runId}`) return;
      if (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) { off(); resolve('COMPLETED'); }
      else if (m.envelope.event === REALTIME_EVENTS.RUN_FAILED) { off(); resolve('FAILED'); }
    });
    void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
  });
  const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  const state = run.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown> }> };
  return { status: run.status ?? status, output: state.nodeStates.M?.outputData ?? {} };
}

describe('WorkflowEngine — mcp node', () => {
  it('calls the bridged MCP tool and stores its result', async () => {
    const calls: Array<{ toolId: string; args: Record<string, unknown> }> = [];
    const bridge: McpBridgePort = {
      async call(_ws, toolId, args) { calls.push({ toolId, args }); return { ok: true, result: { issueUrl: 'https://x/1' } }; },
    };
    const { status, output } = await runMcp(bridge);
    expect(status).toBe('COMPLETED');
    expect(output).toEqual({ result: { issueUrl: 'https://x/1' } });
    expect(calls).toEqual([{ toolId: 'github__create_issue', args: { title: 'Bug' } }]);
  });

  it('fails the node when the MCP tool returns an error', async () => {
    const bridge: McpBridgePort = {
      async call() { return { ok: false, error: 'rate limited' }; },
    };
    const { status } = await runMcp(bridge);
    expect(status).toBe('FAILED');
  });
});
