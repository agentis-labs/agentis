/**
 * AGENT-WORKFLOW-CAPABILITY-10X E1 — a marker_protocol CLI harness (Codex /
 * Claude Code) bound to an agent_task runs through a REAL Agentis chat tool loop
 * (not awareness-only dispatch): it is offered the `agentis.*` integration catalog
 * (minus the recursion blocklist), reasons on its own runtime, and the node
 * completes with its final result.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type AgentAdapter, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function markerChatAdapter(seenTools: string[][], finalText: string): AgentAdapter {
  return {
    adapterType: 'claude_code',
    connect: async () => {},
    disconnect: async () => {},
    healthCheck: async () => ({ isHealthy: true, checkedAt: new Date().toISOString() }),
    capabilities: () => ({
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: 'marker_protocol',
      affordances: { fileSystem: true, terminal: true },
    }),
    dispatchTask: async () => {
      throw new Error('dispatch must not be used — E1 runs the chat loop');
    },
    cancelTask: async () => {},
    onEvent: () => {},
    chat: async function* (_messages, tools) {
      seenTools.push(tools.map((t) => t.name));
      yield { type: 'text', delta: finalText };
      yield { type: 'done', finishReason: 'stop' };
    },
  } as unknown as AgentAdapter;
}

function waitForRunStatus(runId: string, target: 'COMPLETED' | 'FAILED'): Promise<string | null> {
  return new Promise<string>((resolve, reject) => {
    const evt = target === 'COMPLETED' ? REALTIME_EVENTS.RUN_COMPLETED : REALTIME_EVENTS.RUN_FAILED;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${target}`)), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && m.envelope.event === evt) { clearTimeout(timer); off(); resolve(target); }
    });
  }).catch(() => null);
}

describe('WorkflowEngine — E1 harness chat tool loop', () => {
  it('runs a marker_protocol harness through a real Agentis tool loop, offers the catalog (minus blocklist), and completes the node', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Claude Coder', role: 'coder', adapterType: 'claude_code', capabilityTags: ['code'], config: {}, status: 'online',
    }).run();

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registry.register(
      { id: 'agentis.channel.send', family: 'app', description: 'message a human', inputSchema: { type: 'object', properties: { to: {}, text: {} } }, mutating: true, mcpExposed: true },
      async () => ({ ok: true }),
    );
    registry.register(
      { id: 'agentis.build_workflow', family: 'build', description: 'build a workflow', inputSchema: { type: 'object', properties: {} }, mutating: true, mcpExposed: true },
      async () => ({ ok: true }),
    );

    const seenTools: string[][] = [];
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, markerChatAdapter(seenTools, 'Found 3 fashion stores on Instagram. Done.'));

    const engine = new WorkflowEngine({
      db: ctx.db, bus: ctx.bus, logger: ctx.logger,
      ledger: new LedgerService(ctx.db, ctx.bus),
      scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
      activity: new ActivityFeedService(ctx.db, ctx.bus),
      approvals: new ApprovalInboxService(ctx.db, ctx.bus),
      extensions: {} as unknown as ExtensionRuntime,
      adapters,
      toolRegistry: registry,
    });

    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Scout', position: { x: 1, y: 0 }, config: { kind: 'agent_task', agentId, agentRole: 'coder', prompt: 'Find fashion stores on Instagram.', outputKeys: [] } },
      ],
      edges: [{ id: 'e', source: 'T', target: 'A' }],
    } as unknown as WorkflowGraph;

    const wfId = randomUUID();
    const runId = randomUUID();
    ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'harness-wf', graph, settings: {} }).run();
    ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();

    const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
    const done = Promise.race([waitForRunStatus(runId, 'COMPLETED'), waitForRunStatus(runId, 'FAILED')]);
    await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
    const status = (await done) ?? 'UNKNOWN';

    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(row.status ?? status).toBe('COMPLETED');
    const state = row.runState as { nodeStates?: Record<string, { outputData?: { output?: string } }> };
    expect(state.nodeStates?.A?.outputData?.output).toContain('Found 3 fashion stores');
    // The harness was offered the integration catalog, minus the recursion blocklist.
    expect(seenTools[0]).toContain('agentis.channel.send');
    expect(seenTools[0]).not.toContain('agentis.build_workflow');
  });
});
