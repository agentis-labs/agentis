import { describe, expect, it, vi } from 'vitest';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { ConversationTurnLeaseRegistry } from '../../src/services/conversation/conversationTurnLease.js';
import { createLogger } from '../../src/logger.js';

describe('ConversationTurnLeaseRegistry', () => {
  it('supersedes prior generations and never lets stale completion revoke the new turn', () => {
    const leases = new ConversationTurnLeaseRegistry();
    const first = leases.issue('ws', 'conv');
    const firstSignal = leases.assertActive('ws', 'conv', first);
    const second = leases.issue('ws', 'conv');
    expect(firstSignal.aborted).toBe(true);
    expect(() => leases.assertActive('ws', 'conv', first)).toThrow(/not executed/i);
    leases.complete('ws', 'conv', first);
    const secondSignal = leases.assertActive('ws', 'conv', second);
    expect(leases.revoke('ws', 'conv')).toBe(true);
    expect(secondSignal.aborted).toBe(true);
  });

  it('blocks an in-process handler before invocation when the caller signal is aborted', async () => {
    const registry = new AgentisToolRegistry({ logger: createLogger({ level: 'error' }) });
    const handler = vi.fn(() => ({ mutated: true }));
    registry.register({
      id: 'test.mutate', family: 'build', description: 'test', inputSchema: { type: 'object' }, mutating: true,
    }, handler);
    const controller = new AbortController();
    controller.abort();
    const result = await registry.execute(
      { id: 'call', toolId: 'test.mutate', arguments: {} },
      { workspaceId: 'ws', userId: 'user', caller: 'chat', signal: controller.signal },
    );
    expect(result).toMatchObject({ ok: false, errorCode: 'TURN_CANCELLED' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('records unlimited-capability compact experience and coalesces unchanged reads', () => {
    const leases = new ConversationTurnLeaseRegistry();
    const token = leases.issue('ws', 'conv');
    const first = leases.recordToolResult({
      workspaceId: 'ws', conversationId: 'conv', token,
      name: 'agentis.app.compile', toolArgs: { appId: 'app-1' },
      result: { counts: { block: 4 } }, ok: true, mutating: false, durationMs: 12,
    });
    const repeated = leases.recordToolResult({
      workspaceId: 'ws', conversationId: 'conv', token,
      name: 'agentis.app.compile', toolArgs: { appId: 'app-1' },
      result: { counts: { block: 4 } }, ok: true, mutating: false, durationMs: 8,
    });
    leases.recordToolResult({
      workspaceId: 'ws', conversationId: 'conv', token,
      name: 'agentis.data.batch', toolArgs: { operations: [{ operation: 'update' }] },
      result: { ok: true }, ok: true, mutating: true, durationMs: 4,
    });
    const afterMutation = leases.recordToolResult({
      workspaceId: 'ws', conversationId: 'conv', token,
      name: 'agentis.app.compile', toolArgs: { appId: 'app-1' },
      result: { counts: { block: 2 } }, ok: true, mutating: false, durationMs: 7,
    });
    leases.recordRecalledAtoms('ws', 'conv', token, ['mem-1', 'mem-1', 'mem-2']);

    expect(first.repeated).toBe(false);
    expect(repeated).toMatchObject({ repeated: true, observationIndex: 1 });
    expect(afterMutation.repeated).toBe(false);
    const experience = leases.experience('ws', 'conv', token);
    expect(experience.toolCalls).toBe(4);
    expect(experience.observations).toHaveLength(3);
    expect(experience.observations[0]).toMatchObject({ repeats: 2, durationMs: 20 });
    expect(experience.recalledAtomIds).toEqual(['mem-1', 'mem-2']);
    expect(experience.efficiency).toMatchObject({
      uniqueObservations: 3,
      coalescedReads: 1,
      mutatingCalls: 1,
      repeatedResultChars: expect.any(Number),
    });
    expect(experience.efficiency.repeatedResultChars).toBeGreaterThan(0);
  });
});
