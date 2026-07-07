/**
 * PAVED-ROAD P3 — in-run loop parity: a session agent gets dry_run_workflow +
 * check_run in its control catalog, and calls route through the late-bound
 * platform-tool bridge to the SAME registry handlers chat/MCP use.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ChatToolCall, SessionAdapter, SessionStepResult, ToolDefinition } from '@agentis/core';
import { AgentSessionService } from '../../src/services/agentSession.js';
import { AgentSessionRuntime, type SessionRunContext } from '../../src/services/agentSessionRuntime.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  // FKs off: the session row references synthetic agent/run ids we don't seed.
  ctx = await createTestContext({ foreignKeysOff: true });
});

afterEach(() => ctx.close());

function scriptedAdapter(steps: Array<{ text?: string; toolCalls?: ChatToolCall[] }>, seenTools: ToolDefinition[][]): SessionAdapter {
  let i = 0;
  return {
    id: 'stub-session',
    async executeStep(input): Promise<SessionStepResult> {
      seenTools.push(input.tools);
      const step = steps[Math.min(i, steps.length - 1)] ?? {};
      i += 1;
      const toolCalls = step.toolCalls ?? [];
      return { text: step.text ?? '', toolCalls, finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop' };
    },
  };
}

function makeRunCtx(agentId: string): SessionRunContext {
  return {
    workspaceId: ctx.workspace.id,
    runId: randomUUID(),
    nodeId: 'node-1',
    agentId,
    workflowId: randomUUID(),
    role: 'specialist',
  };
}

describe('AgentSessionRuntime — Paved Road loop tools', () => {
  it('offers dry_run_workflow + check_run and routes them through the platform bridge', async () => {
    const platformCalls: Array<{ toolId: string; args: Record<string, unknown> }> = [];
    const sessions = new AgentSessionService(ctx.db, ctx.logger);
    const seenTools: ToolDefinition[][] = [];
    const adapter = scriptedAdapter(
      [
        { toolCalls: [{ id: 'c1', name: 'dry_run_workflow', arguments: { workflow_id: 'wf-42', inputs: { name: 'x' } } }] },
        { toolCalls: [{ id: 'c2', name: 'check_run', arguments: { run_id: 'run-7' } }] },
        { text: 'verified' },
      ],
      seenTools,
    );
    const runtime = new AgentSessionRuntime({
      sessions,
      adapter,
      scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
      bus: ctx.bus,
      logger: ctx.logger,
      platformTool: async (toolId, args) => {
        platformCalls.push({ toolId, args });
        return { ok: true, output: { ok: true, stage: 'dry_run_green' } };
      },
    });

    const session = sessions.create({
      agentId: randomUUID(),
      workspaceId: ctx.workspace.id,
      runId: randomUUID(),
      nodeId: 'node-1',
      taskBlock: 'build and verify a sub-workflow',
    });
    const outcome = await runtime.advance(session.id, makeRunCtx(session.agentId));

    // The control catalog offers the loop tools.
    const offered = seenTools[0]!.map((t) => t.name);
    expect(offered).toContain('dry_run_workflow');
    expect(offered).toContain('check_run');
    // Calls route to the SAME registry tool ids the chat/MCP surfaces use,
    // with snake_case args normalized.
    expect(platformCalls).toEqual([
      { toolId: 'agentis.workflow.dry_run', args: { workflowId: 'wf-42', inputs: { name: 'x' } } },
      { toolId: 'agentis.run.status', args: { runId: 'run-7' } },
    ]);
    expect(outcome.kind).toBe('completed');
  });

  it('degrades honestly when the bridge is not wired', async () => {
    const sessions = new AgentSessionService(ctx.db, ctx.logger);
    const seenTools: ToolDefinition[][] = [];
    const adapter = scriptedAdapter(
      [
        { toolCalls: [{ id: 'c1', name: 'dry_run_workflow', arguments: { workflow_id: 'wf-42' } }] },
        { text: 'done' },
      ],
      seenTools,
    );
    const runtime = new AgentSessionRuntime({
      sessions,
      adapter,
      scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
      bus: ctx.bus,
      logger: ctx.logger,
      // no platformTool
    });
    const session = sessions.create({
      agentId: randomUUID(),
      workspaceId: ctx.workspace.id,
      runId: randomUUID(),
      nodeId: 'node-1',
      taskBlock: 'try to dry-run',
    });
    // Must not throw — the tool observation is an honest "unavailable".
    const outcome = await runtime.advance(session.id, makeRunCtx(session.agentId));
    expect(outcome.kind).toBe('completed');
  });
});
