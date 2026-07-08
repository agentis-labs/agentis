/**
 * AgentSessionRuntime — bridged MCP tool parity (Phase 2 for sessions).
 *
 * A persistent session must get the same external MCP reach as the in-process
 * loop: bridged `mcp__*` tools are offered in the catalog handed to the model,
 * and a call to one routes to AgentToolRuntime.executeBridged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatToolCall, SessionAdapter, SessionStepResult, ToolDefinition } from '@agentis/core';
import { WorkspaceVolumeService } from '../../src/services/workspace/workspaceVolume.js';
import { AgentToolRuntime } from '../../src/services/agent/agentToolRuntime.js';
import { AgentSessionService } from '../../src/services/agent/agentSession.js';
import { AgentSessionRuntime, type SessionRunContext } from '../../src/services/agent/agentSessionRuntime.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import type { McpToolBridge } from '../../src/services/mcp/mcpToolBridge.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let dataDir: string;

beforeEach(async () => {
  // FKs off: the session row references synthetic agent/run ids we don't seed.
  ctx = await createTestContext({ foreignKeysOff: true });
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-sess-bridge-'));
});

afterEach(async () => {
  ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Adapter that captures the offered tools and replays a scripted set of steps. */
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

describe('AgentSessionRuntime — bridged MCP tools', () => {
  it('offers bridged tools in the catalog and routes a call to executeBridged', async () => {
    const bridgeCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const fakeBridge = {
      async listTools() {
        return [{ id: 'mcp__computer_use__screenshot', serverId: 'builtin:computer-use', serverName: 'computer-use', toolName: 'screenshot', description: 'Capture the screen', provides: 'computerUse' as const }];
      },
      async call(_ws: string, tool: string, args: Record<string, unknown>) {
        bridgeCalls.push({ tool, args });
        return { ok: true, result: { ref: 'artifact:123' } };
      },
    } as unknown as McpToolBridge;

    const agentTools = new AgentToolRuntime({ volume: new WorkspaceVolumeService(dataDir), mcpBridge: fakeBridge });
    const sessions = new AgentSessionService(ctx.db, ctx.logger);

    const seenTools: ToolDefinition[][] = [];
    const adapter = scriptedAdapter(
      [
        { toolCalls: [{ id: 'c1', name: 'mcp__computer_use__screenshot', arguments: { display: 0 } }] },
        { text: 'captured the screen' },
      ],
      seenTools,
    );

    const runtime = new AgentSessionRuntime({ sessions, adapter, scratchpad: new ScratchpadService(ctx.bus, ctx.logger), bus: ctx.bus, logger: ctx.logger, agentTools });

    const session = sessions.create({
      agentId: randomUUID(),
      workspaceId: ctx.workspace.id,
      runId: randomUUID(),
      nodeId: 'node-1',
      taskBlock: 'screenshot the desktop',
    });
    const runCtx: SessionRunContext = {
      workspaceId: ctx.workspace.id,
      runId: randomUUID(),
      nodeId: 'node-1',
      agentId: session.agentId,
      workflowId: randomUUID(),
      role: 'specialist',
    };

    const outcome = await runtime.advance(session.id, runCtx);

    // The model was offered the bridged tool in its catalog.
    expect(seenTools[0]!.some((t) => t.name === 'mcp__computer_use__screenshot')).toBe(true);
    // The bridged call was routed to executeBridged with unwrapped args.
    expect(bridgeCalls).toEqual([{ tool: 'mcp__computer_use__screenshot', args: { display: 0 } }]);
    expect(outcome.kind).toBe('completed');
  });
});
