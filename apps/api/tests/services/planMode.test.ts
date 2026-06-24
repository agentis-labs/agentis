import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';

describe('Plan mode', () => {
  it('blocks mutating registry tools before their handler can run', async () => {
    const handler = vi.fn(() => ({ created: true }));
    const registry = new AgentisToolRegistry({ logger: createLogger({ level: 'error' }) });
    registry.register({
      id: 'agentis.test.create',
      family: 'build',
      description: 'Create a test resource',
      inputSchema: { type: 'object' },
      mutating: true,
    }, handler);

    const result = await registry.execute({
      id: 'call-1',
      toolId: 'agentis.test.create',
      arguments: {},
    }, {
      workspaceId: 'workspace-1',
      userId: 'user-1',
      caller: 'chat',
      executionMode: 'plan',
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('PLAN_MODE_MUTATION_BLOCKED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('allows inspection tools in Plan mode', async () => {
    const registry = new AgentisToolRegistry({ logger: createLogger({ level: 'error' }) });
    registry.register({
      id: 'agentis.test.inspect',
      family: 'inspect',
      description: 'Inspect a test resource',
      inputSchema: { type: 'object' },
      mutating: false,
    }, () => ({ found: true }));

    const result = await registry.execute({
      id: 'call-2',
      toolId: 'agentis.test.inspect',
      arguments: {},
    }, {
      workspaceId: 'workspace-1',
      userId: 'user-1',
      caller: 'chat',
      executionMode: 'plan',
    });

    expect(result.ok).toBe(true);
  });
});
