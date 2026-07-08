/**
 * CodeModeService — code-mode as the primary build interface (§3.7 / H3). Proves the
 * agent can compose in code against the `agentis.*` SDK: real control flow, captured
 * logs, a per-call audit, directive tool errors, and hard resource governors (call
 * budget + wall-clock timeout) with NO ambient Node globals leaking into the sandbox.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentisError } from '@agentis/core';
import type { AgentisToolContext } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { CodeModeService } from '../../src/services/codeMode.js';
import { ExperimentService } from '../../src/services/experiments.js';
import { registerExperimentTools } from '../../src/services/agentisToolHandlers/experimentTools.js';
import { registerOrientTools } from '../../src/services/agentisToolHandlers/orient.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function toolCtx(): AgentisToolContext {
  return { workspaceId: ctx.workspace.id, userId: ctx.user.id, caller: 'mcp' };
}

function registryWithTestTools() {
  const r = new AgentisToolRegistry({ logger: ctx.logger });
  r.registerMany([
    {
      definition: { id: 'agentis.test.echo', family: 'inspect', mcpExposed: true, mutating: false, description: 'echo', inputSchema: { type: 'object', properties: { value: {} } } },
      handler: (args) => ({ echoed: args.value }),
    },
    {
      definition: { id: 'agentis.test.fail', family: 'run', mcpExposed: true, mutating: true, description: 'always fails', inputSchema: { type: 'object', properties: {} } },
      handler: () => { throw new AgentisError('VALIDATION_FAILED', 'boom', { remediation: 'pass a real value' }); },
    },
  ]);
  return r;
}

describe('CodeModeService', () => {
  it('runs a single call and returns its output', async () => {
    const svc = new CodeModeService(registryWithTestTools());
    const res = await svc.execute({ code: 'return await agentis.test.echo({ value: 42 });', ctx: toolCtx() });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ echoed: 42 });
    expect(res.calls).toEqual([{ tool: 'agentis.test.echo', ok: true }]);
  });

  it('composes with real control flow (loops) — the whole point', async () => {
    const svc = new CodeModeService(registryWithTestTools());
    const res = await svc.execute({
      code: 'let sum = 0; for (let i = 0; i < 4; i++) { const r = await agentis.test.echo({ value: i }); sum += r.echoed; } return sum;',
      ctx: toolCtx(),
    });
    expect(res.result).toBe(6); // 0+1+2+3
    expect(res.calls).toHaveLength(4);
  });

  it('captures console output', async () => {
    const svc = new CodeModeService(registryWithTestTools());
    const res = await svc.execute({ code: 'console.log("hi", { a: 1 }); return 1;', ctx: toolCtx() });
    expect(res.logs).toContain('hi {"a":1}');
  });

  it('a failed tool call throws inside code with its code + remediation (catchable)', async () => {
    const svc = new CodeModeService(registryWithTestTools());
    const caught = await svc.execute({ code: 'try { await agentis.test.fail({}); } catch (e) { return "handled: " + e.message; }', ctx: toolCtx() });
    expect(caught.ok).toBe(true);
    expect(String(caught.result)).toContain('handled');

    const uncaught = await svc.execute({ code: 'await agentis.test.fail({}); return "never";', ctx: toolCtx() });
    expect(uncaught.ok).toBe(false);
    expect(uncaught.error?.code).toBe('VALIDATION_FAILED');
    expect(uncaught.error?.tool).toBe('agentis.test.fail');
    expect(uncaught.error?.remediation).toBe('pass a real value');
  });

  it('enforces the tool-call budget', async () => {
    const svc = new CodeModeService(registryWithTestTools());
    const res = await svc.execute({ code: 'for (let i = 0; i < 10; i++) await agentis.test.echo({ value: i }); return "done";', ctx: toolCtx(), maxCalls: 3 });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('CODE_MODE_LIMIT');
    expect(res.calls.length).toBeLessThanOrEqual(3);
  });

  it('enforces a wall-clock timeout on a synchronous infinite loop', async () => {
    const svc = new CodeModeService(registryWithTestTools());
    const res = await svc.execute({ code: 'while (true) {}', ctx: toolCtx(), timeoutMs: 400 });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('CODE_MODE_LIMIT');
  });

  it('exposes no ambient Node globals in the sandbox', async () => {
    const svc = new CodeModeService(registryWithTestTools());
    const res = await svc.execute({ code: 'return [typeof process, typeof require, typeof fetch, typeof global].join(",");', ctx: toolCtx() });
    expect(res.result).toBe('undefined,undefined,undefined,undefined');
  });

  it('describeApi lists the callable surface grouped by namespace', () => {
    const svc = new CodeModeService(registryWithTestTools());
    const api = svc.describeApi();
    expect(api.count).toBe(2);
    expect(api.groups['agentis.test']?.map((t) => t.call).sort()).toEqual(['agentis.test.echo(args)', 'agentis.test.fail(args)']);
  });

  it('e2e: builds an entire experiment against the REAL Agentis SDK in one code block', async () => {
    // A registry with real Agentis tool families + their deps.
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    const deps = { db: ctx.db, experiments: new ExperimentService(ctx.db) } as ToolHandlerDeps;
    registerOrientTools(registry, deps);
    registerExperimentTools(registry, deps);
    const svc = new CodeModeService(registry);

    const res = await svc.execute({
      ctx: toolCtx(),
      code: [
        'const me = await agentis.orient();',
        'await agentis.experiment.define({ key: "first_message", variants: ["A", "B"] });',
        'const chosen = {};',
        'for (const s of ["lead-1","lead-2","lead-3","lead-4"]) {',
        '  chosen[s] = (await agentis.experiment.assign({ key: "first_message", subjectKey: s })).variant;',
        '  await agentis.experiment.record({ key: "first_message", subjectKey: s, outcome: chosen[s] === "A" ? "won" : "lost" });',
        '}',
        'const results = await agentis.experiment.results({ key: "first_message" });',
        'return { apps: me.inventory.counts.apps, arms: results.variants.length, assigned: Object.values(chosen).length };',
      ].join('\n'),
    });

    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ apps: 0, arms: 2, assigned: 4 });
    // orient(1) + define(1) + 4×(assign+record)=8 + results(1) = 11 real tool calls, all in ONE execution.
    expect(res.calls.length).toBe(11);
    expect(res.calls.every((c) => c.ok)).toBe(true);
  });
});
