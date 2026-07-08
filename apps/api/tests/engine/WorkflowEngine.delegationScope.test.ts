/**
 * Scoped delegation grants (UNIVERSAL-HARNESS §8). A parent that delegates with
 * `allowed_tools` hands the sub-agent a least-privilege scope; the delegate may
 * only invoke those tools (plus session-local/read-only exempt ones), and the
 * scope can only narrow on re-delegation — never widen.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type ChatMessage, type ChatToolCall, type SessionAdapter, type SessionStepResult, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { WorkspaceVolumeService } from '../../src/services/workspace/workspaceVolume.js';
import { AgentToolRuntime } from '../../src/services/agent/agentToolRuntime.js';
import { SpecialistAgentService } from '../../src/services/specialist/specialistAgents.js';
import { AgentSessionService } from '../../src/services/agent/agentSession.js';
import { AgentSessionRuntime, attenuateGrant, isToolPermitted, isPathPermitted } from '../../src/services/agent/agentSessionRuntime.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

// ── Pure-logic invariants ────────────────────────────────────────────────────

describe('attenuateGrant', () => {
  it('inherits the parent scope when the child requests none', () => {
    expect(attenuateGrant({ allowedTools: ['a', 'b'], depth: 1 }, undefined, 2)).toEqual({ allowedTools: ['a', 'b'], depth: 2 });
  });
  it('narrows tools to the requested subset', () => {
    expect(attenuateGrant({ allowedTools: ['a', 'b'], depth: 1 }, { tools: ['b'] }, 2)).toEqual({ allowedTools: ['b'], depth: 2 });
  });
  it('cannot widen past the parent (intersection only)', () => {
    expect(attenuateGrant({ allowedTools: ['a'], depth: 1 }, { tools: ['a', 'b', 'c'] }, 2)).toEqual({ allowedTools: ['a'], depth: 2 });
  });
  it('applies the requested scope when the parent is unrestricted', () => {
    expect(attenuateGrant(undefined, { tools: ['x'] }, 1)).toEqual({ allowedTools: ['x'], depth: 1 });
  });
  it('narrows paths and takes the min token budget', () => {
    expect(attenuateGrant({ allowedPaths: ['src/'], maxTokens: 1000, depth: 1 }, { paths: ['src/app/'], maxTokens: 5000 }, 2))
      .toEqual({ allowedPaths: ['src/app/'], maxTokens: 1000, depth: 2 });
  });
  it('stays unrestricted when neither side scopes', () => {
    expect(attenuateGrant(undefined, undefined, 1)).toBeUndefined();
  });
});

describe('isToolPermitted', () => {
  it('permits everything without a grant', () => {
    expect(isToolPermitted('broadcast', undefined)).toBe(true);
  });
  it('permits allowlisted + exempt tools, denies the rest', () => {
    const grant = { allowedTools: ['knowledge_search'], depth: 1 };
    expect(isToolPermitted('knowledge_search', grant)).toBe(true);
    expect(isToolPermitted('memory_update', grant)).toBe(true); // exempt (session-local)
    expect(isToolPermitted('complete_task', grant)).toBe(true);  // exempt (terminal)
    expect(isToolPermitted('scratchpad_write', grant)).toBe(false);
    expect(isToolPermitted('delegate_task', grant)).toBe(false);
  });
});

describe('isPathPermitted', () => {
  it('permits everything without a path scope', () => {
    expect(isPathPermitted('anything/x.ts', undefined)).toBe(true);
    expect(isPathPermitted('anything/x.ts', { depth: 1 })).toBe(true);
  });
  it('permits paths under an allowed prefix, denies the rest', () => {
    const grant = { allowedPaths: ['src/'], depth: 1 };
    expect(isPathPermitted('src/app/main.ts', grant)).toBe(true);
    expect(isPathPermitted('src', grant)).toBe(true);
    expect(isPathPermitted('secrets/.env', grant)).toBe(false);
  });
});

// ── End-to-end enforcement through the engine ─────────────────────────────────

type ScriptStep = { text?: string; toolCalls?: ChatToolCall[] };

function scriptedAdapter(steps: ScriptStep[], seenMessages?: ChatMessage[][]): SessionAdapter {
  let i = 0;
  return {
    id: 'stub-session',
    async executeStep(input): Promise<SessionStepResult> {
      seenMessages?.push(input.messages);
      const step = steps[Math.min(i, steps.length - 1)] ?? {};
      i += 1;
      const toolCalls = step.toolCalls ?? [];
      return { text: step.text ?? '', toolCalls, finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop' };
    },
  };
}

function call(name: string, args: Record<string, unknown>): ChatToolCall {
  return { id: randomUUID(), name, arguments: args };
}

let ctx: TestContext;
let dataDir: string;
let scratchpad: ScratchpadService;

function buildEngine(adapter: SessionAdapter): WorkflowEngine {
  const volume = new WorkspaceVolumeService(dataDir);
  const agentTools = new AgentToolRuntime({ volume });
  scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const sessions = new AgentSessionService(ctx.db, ctx.logger);
  const sessionRuntime = new AgentSessionRuntime({ sessions, adapter, scratchpad, bus: ctx.bus, logger: ctx.logger, agentTools });
  return new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad,
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    specialists: new SpecialistAgentService(ctx.db),
    agentTools,
    skills: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    sessions,
    sessionRuntime,
  });
}

function sessionGraph(): WorkflowGraph {
  return {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'S', type: 'agent_session', title: 'Session', position: { x: 200, y: 0 }, config: { kind: 'agent_session', agentRole: 'coder', prompt: 'Do the task.', inputKeys: [], outputKeys: [], capabilityTags: [] } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'S' }],
  } as WorkflowGraph;
}

function runGraph(engine: WorkflowEngine): Promise<string> {
  const graph = sessionGraph();
  const wfId = randomUUID();
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'session', graph, settings: {} }).run();
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: initialState }).run();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room !== `run:${runId}`) return;
      if (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED) {
        clearTimeout(timer); off(); resolve(runId);
      }
    });
    void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
  });
}

beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-deleg-scope-'));
});
afterEach(async () => {
  ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('WorkflowEngine — delegation scope enforcement', () => {
  it('denies a scoped delegate a tool outside its grant, while the unrestricted parent is unaffected', async () => {
    // Parent (unrestricted): writes a scratchpad key, then delegates with a
    // tool allowlist that excludes scratchpad_write. The delegate tries to write
    // anyway (denied) and completes. Parent completes.
    const seenMessages: ChatMessage[][] = [];
    const engine = buildEngine(scriptedAdapter([
      { toolCalls: [
        call('scratchpad_write', { key: 'parent', value: 'ok' }),
        // create_if_missing: built-in specialists were retired, so the delegate
        // role is authored on-demand (open vocabulary) rather than pre-resolved.
        call('delegate_task', { role: 'researcher', task: 'look something up', allowed_tools: ['knowledge_search'], create_if_missing: true }),
      ] },
      { toolCalls: [call('scratchpad_write', { key: 'child', value: 'leak' })] }, // delegate — DENIED
      { toolCalls: [call('complete_task', { output: { result: 'child done' } })] },
      { toolCalls: [call('complete_task', { output: { result: 'parent done' } })] },
    ], seenMessages));

    const runId = await runGraph(engine);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');

    // The unrestricted parent's write landed; the scoped delegate's did not.
    expect(scratchpad.read(runId, 'parent')).toBe('ok');
    expect(scratchpad.read(runId, 'child') ?? null).toBeNull();

    const delegatedSystem = String(
      seenMessages
        .find((messages) => String(messages[0]?.content ?? '').includes('role: researcher'))?.[0]?.content ?? '',
    );
    expect(delegatedSystem.match(/<agentis_identity/g)).toHaveLength(1);
    expect(delegatedSystem).toContain('role: researcher');
    expect(delegatedSystem).toContain('instructions:\nlook something up');
    expect(delegatedSystem).not.toContain('You are the Agentis platform orchestrator');
  });
});
