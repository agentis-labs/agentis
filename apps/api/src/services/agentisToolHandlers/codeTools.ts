/**
 * Code-mode tools (Agent-Native §3.7 / H3) — the primary build interface.
 *
 * `agentis.code.execute` runs agent-written async code against the whole `agentis.*`
 * SDK in one shot, so composition (loops, conditionals, find-or-create-then-wire)
 * happens in code instead of dozens of round-trips. `agentis.code.api` returns the
 * callable surface for discovery. The SDK is built from the SAME registry these tools
 * are registered into, resolved lazily at call time so every tool is present.
 */

import { AgentisError } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { CodeModeService } from '../codeMode.js';

const EXECUTE_DESCRIPTION = [
  'Run code against the Agentis SDK — the FASTEST way to build. Write an async body that calls tools as functions on the `agentis.*` object (they mirror the tool ids, e.g. `agentis.app.create({name})`, `agentis.subject.enroll({key, script})`, `agentis.experiment.assign({key, subjectKey})`). `await` each call, use normal loops/conditionals/try-catch, and `return` a value to hand back.',
  'Prefer this over many separate tool calls when you are wiring several things together. Call `agentis.orient()` first (or `agentis.code.api()` to list the callable surface). A failing tool call throws with its code + remediation, which you can catch. Example:',
  'const me = await agentis.orient(); if (!me.inventory.apps.length) { const app = await agentis.app.create({ name: "Sales" }); return app.appId; } return me.inventory.apps[0].appId;',
].join('\n');

export function registerCodeTools(registry: AgentisToolRegistry, _deps: ToolHandlerDeps): void {
  // Build the service over the registry these tools live in; the SDK surface is
  // resolved lazily per execution, so tools registered after this call are included.
  const svc = new CodeModeService(registry);

  registry.registerMany([
    {
      definition: {
        id: 'agentis.code.execute',
        family: 'build',
        mcpExposed: true,
        autoExecute: true,
        mutating: true,
        description: EXECUTE_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: { code: { type: 'string', description: 'Async JS body. Call agentis.* tools, await them, return a value.' } },
          required: ['code'],
        },
      },
      handler: async (args, ctx) => {
        const code = typeof args.code === 'string' ? args.code : '';
        if (!code.trim()) throw new AgentisError('VALIDATION_FAILED', 'code is required');
        const res = await svc.execute({ code, ctx });
        // Surface the outcome as structured data (not a throw) so the agent sees logs +
        // exactly which tool calls ran, even on failure — code-mode is a debugging loop.
        return {
          ok: res.ok,
          ...(res.ok ? { result: res.result } : { error: res.error }),
          calls: res.calls,
          ...(res.logs.length ? { logs: res.logs } : {}),
        };
      },
    },
    {
      definition: {
        id: 'agentis.code.api',
        family: 'inspect',
        mcpExposed: true,
        mutating: false,
        description: 'List the SDK surface available inside agentis.code.execute — every callable `agentis.*` function grouped by namespace, with its description and input shape. Use to discover what you can call in code.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: () => svc.describeApi(),
    },
  ]);
}
