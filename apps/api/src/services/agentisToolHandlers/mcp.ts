/**
 * MCP bridge tools for the chat orchestrator + MCP surface (Agent-capabilities
 * 10x, Phase 2/4). Lets the chat agent — the one that also holds
 * agentis.channel.send and agentis.browser.* — discover and call any MCP tool
 * the workspace has mounted (computer-use, browser, operator-registered
 * servers), giving it the same external reach as a native harness session.
 */

import { AgentisError } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerMcpBridgeTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.mcp.list',
        family: 'inspect',
        description: 'List the external MCP tools available in this workspace (computer-use, browser, and any operator-mounted MCP servers). Returns namespaced tool ids to pass to agentis.mcp.call.',
        inputSchema: { type: 'object', properties: {} },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (_args, ctx) => {
        if (!deps.mcpBridge) return { count: 0, tools: [], note: 'No MCP bridge configured.' };
        const tools = await deps.mcpBridge.listTools(ctx.workspaceId);
        return {
          count: tools.length,
          tools: tools.map((t) => ({ id: t.id, server: t.serverName, description: t.description, provides: t.provides ?? null })),
        };
      },
    },
    {
      definition: {
        id: 'agentis.mcp.call',
        family: 'run',
        description: 'Invoke an external MCP tool by its namespaced id (from agentis.mcp.list). Use this to control the desktop (computer-use), drive a browser, or call any mounted MCP server tool.',
        inputSchema: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Namespaced tool id, e.g. mcp__computer_use__screenshot.' },
            arguments: { type: 'object', description: 'Arguments object passed to the MCP tool.' },
          },
          required: ['tool'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.mcpBridge) throw new AgentisError('VALIDATION_FAILED', 'No MCP bridge is configured for this workspace');
        const tool = typeof args.tool === 'string' ? args.tool.trim() : '';
        if (!tool) throw new AgentisError('VALIDATION_FAILED', 'tool is required');
        const toolArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
          ? args.arguments as Record<string, unknown>
          : {};
        const res = await deps.mcpBridge.call(ctx.workspaceId, tool, toolArgs);
        return res.ok ? { ok: true, tool, result: res.result } : { ok: false, tool, error: res.error };
      },
    },
  ]);
}
