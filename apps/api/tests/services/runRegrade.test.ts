import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentisToolContext } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { registerRunTools } from '../../src/services/agentisToolHandlers/run.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

describe('agentis.run.regrade', () => {
  it('regrades persisted evidence through the engine without starting or replaying a run', async () => {
    const calls: Array<{ workspaceId: string; runId: string }> = [];
    let starts = 0;
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerRunTools(registry, {
      db: ctx.db,
      logger: ctx.logger,
      bus: ctx.bus,
      engine: {
        regradeCompletedRun: async (args: { workspaceId: string; runId: string }) => {
          calls.push(args);
          return {
            runId: args.runId,
            workflowId: 'workflow-1',
            previousOutcome: 'failed_checks' as const,
            verdict: {
              outcome: 'accomplished' as const,
              at: new Date().toISOString(),
              graphHash: 'graph-1',
              checks: [],
              deficiencies: [],
              sufficiency: { typedEmptyFills: [], stubSuspects: [], floorViolations: [] },
            },
            terminalOutputPaths: ['output.result.status'],
          };
        },
        startRun: async () => { starts += 1; throw new Error('must not start'); },
      } as unknown as ToolHandlerDeps['engine'],
      adapters: {} as ToolHandlerDeps['adapters'],
      ledger: { listForRun: async () => [] } as unknown as ToolHandlerDeps['ledger'],
      scratchpad: {} as ToolHandlerDeps['scratchpad'],
      approvals: { list: () => [] } as unknown as ToolHandlerDeps['approvals'],
      activity: {} as ToolHandlerDeps['activity'],
      replay: { prepare: () => { throw new Error('must not replay'); } } as unknown as ToolHandlerDeps['replay'],
    });
    const toolContext: AgentisToolContext = {
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      caller: 'chat',
    };

    const result = await registry.execute({
      id: 'regrade-1',
      toolId: 'agentis.run.regrade',
      arguments: { runId: 'run-1' },
    }, toolContext);

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ workspaceId: ctx.workspace.id, runId: 'run-1' }]);
    expect(starts).toBe(0);
    expect(result.output).toMatchObject({
      accomplished: true,
      executionReplayed: false,
      outwardSideEffectsRepeated: false,
    });
  });
});
