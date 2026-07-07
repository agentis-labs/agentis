/**
 * Connector tools — the agent-facing analog of `agentis.mcp.*`, but for the
 * built-in integration catalog (Vercel, Supabase, GitHub, Notion, Stripe, …).
 *
 * WHY: an agent inside a task could already reach mounted MCP servers
 * (`agentis.mcp.call`) but had NO way to invoke a first-party connector — its
 * only route was to add an `integration` node to the graph and run it. That is
 * exactly the gap behind "the agent can't deploy": Vercel's *MCP* deploy tool is
 * advisory (assumes a local project + CLI), while the real deploy is the Vercel
 * REST connector (`vercel.create_deployment`, inline files, no git). These tools
 * let the agent call that connector directly, mid-task.
 *
 * Secrets stay in the vault — the engine resolves the workspace-bound credential
 * by service; the agent passes only operation params, never a token.
 */

import { AgentisError } from '@agentis/core';
import { connectorCatalog } from '@agentis/integrations';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerIntegrationTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.integration.list',
        family: 'inspect',
        description: 'List the built-in integration connectors that run out of the box (Vercel, Supabase, GitHub, Notion, Stripe, …) with their operations. Pass a service + operation to agentis.integration.call. Deploying a generated site = vercel.create_deployment (uploads inline files, returns a live URL — unlike the Vercel MCP deploy tool, which only advises the CLI).',
        inputSchema: {
          type: 'object',
          properties: {
            service: { type: 'string', description: 'Optional — filter to one service (e.g. "vercel") to see just its operations.' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args) => {
        const filter = typeof args.service === 'string' ? args.service.trim().toLowerCase() : '';
        const runnable = connectorCatalog().filter((c) => c.readiness === 'runnable' && (!filter || c.service === filter));
        return {
          count: runnable.length,
          integrations: runnable.map((c) => ({ service: c.service, name: c.name, category: c.category, description: c.description, operations: c.operations })),
          note: 'Call agentis.integration.call with { integration, operation, params }. Credentials are resolved from the workspace vault by service — never pass secrets.',
        };
      },
    },
    {
      definition: {
        id: 'agentis.integration.call',
        family: 'run',
        description: 'Invoke a built-in connector operation directly (from agentis.integration.list). The workspace-bound credential is resolved from the vault automatically — pass only operation params, never a token. Example: { integration: "vercel", operation: "create_deployment", params: { name: "my-store", files: { "index.html": "<html>…" } } } → returns the live deployment url.',
        inputSchema: {
          type: 'object',
          properties: {
            integration: { type: 'string', description: 'Service id, e.g. "vercel" or "supabase".' },
            operation: { type: 'string', description: 'Operation id, e.g. "create_deployment".' },
            params: { type: 'object', description: 'Operation parameters (the request payload). No credentials.' },
            credentialId: { type: 'string', description: 'Optional — a specific vault credential id; defaults to the workspace-bound credential for the service.' },
          },
          required: ['integration', 'operation'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const integration = typeof args.integration === 'string' ? args.integration.trim() : '';
        const operation = typeof args.operation === 'string' ? args.operation.trim() : '';
        if (!integration) throw new AgentisError('VALIDATION_FAILED', 'integration is required');
        if (!operation) throw new AgentisError('VALIDATION_FAILED', 'operation is required');
        const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params)
          ? (args.params as Record<string, unknown>)
          : {};
        const credentialId = typeof args.credentialId === 'string' && args.credentialId.trim() ? args.credentialId.trim() : undefined;
        try {
          const result = await deps.engine.runIntegrationOperation(
            ctx.workspaceId,
            integration,
            operation,
            params,
            credentialId ? { credentialId } : undefined,
          );
          return { ok: true, integration, operation, result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, integration, operation, error: message };
        }
      },
    },
  ]);
}
