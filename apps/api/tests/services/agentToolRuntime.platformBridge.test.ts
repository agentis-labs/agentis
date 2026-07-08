/**
 * AGENT-WORKFLOW-CAPABILITY-10X E2 — the in-engine agent loop is a full Agentis
 * citizen: platform (`agentis.*`) tools are offered alongside the AgentTool enum
 * and MCP-bridged tools, and `executeBridged` routes a platform id to the platform
 * bridge WITH the agent's run context (so channels/app/data tools resolve their App
 * + actor), while everything else still goes to the MCP bridge.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceVolumeService } from '../../src/services/workspace/workspaceVolume.js';
import { AgentToolRuntime, type PlatformToolCallContext } from '../../src/services/agent/agentToolRuntime.js';
import type { McpToolBridge } from '../../src/services/mcp/mcpToolBridge.js';

const WS = 'ws-e2';
let dataDir: string;
let volume: WorkspaceVolumeService;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-e2-'));
  volume = new WorkspaceVolumeService(dataDir);
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('AgentToolRuntime — platform tool bridge (E2)', () => {
  it('lists platform tools, routes them with run context, and sends mcp ids to the mcp bridge', async () => {
    const platformCalls: Array<{ id: string; ctx: PlatformToolCallContext }> = [];
    const mcpCalls: string[] = [];

    const runtime = new AgentToolRuntime({
      volume,
      resolveAppIdForWorkflow: (_ws, wf) => (wf === 'wf-1' ? 'app-1' : undefined),
      platformTools: {
        list: () => [{ id: 'agentis.channel.send', description: 'message a human (args: to, text)' }],
        has: (id) => id === 'agentis.channel.send',
        execute: async (id, _args, ctx) => {
          platformCalls.push({ id, ctx });
          return { ok: true, result: { sent: true } };
        },
      },
      mcpBridge: {
        listTools: async () => [],
        call: async (_ws: string, id: string) => {
          mcpCalls.push(id);
          return { ok: true, result: { mcp: id } };
        },
      } as unknown as McpToolBridge,
    });

    // The integration catalog is offered to the loop.
    expect(runtime.listPlatformTools().map((t) => t.id)).toContain('agentis.channel.send');

    // A platform id resolves the App (from the workflow) + actor and routes to the bridge.
    const platform = await runtime.executeBridged(
      WS,
      'agentis.channel.send',
      { to: '+1', text: 'hi' },
      { workflowId: 'wf-1', runId: 'run-1', agentId: 'a-1', userId: 'u-1', artifactPolicy: { saveScreenshots: true } },
    );
    expect(platform.ok).toBe(true);
    expect(platformCalls).toHaveLength(1);
    expect(platformCalls[0]!.ctx).toMatchObject({
      workspaceId: WS,
      workflowId: 'wf-1',
      runId: 'run-1',
      agentId: 'a-1',
      userId: 'u-1',
      appId: 'app-1',
      artifactPolicy: { saveScreenshots: true },
    });

    // A non-platform (mcp__*) id still goes to the MCP bridge.
    const mcp = await runtime.executeBridged(WS, 'mcp__server__tool', { x: 1 });
    expect(mcp.ok).toBe(true);
    expect(mcpCalls).toEqual(['mcp__server__tool']);
    expect(platformCalls).toHaveLength(1); // unchanged — not routed to the platform bridge
  });
});
