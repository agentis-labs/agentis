/**
 * Focused unit test for `relaySelfHealChatDelta` — the relay that turns the
 * repair agent's OWN chat activity into a `WorkStep` the operator sees. It
 * used to check `delta.phase === 'error'`, which is only ever true for a
 * terminal turn-level failure (e.g. no chat adapter); a real failed TOOL call
 * mid-repair (phase:'tool', status:'error') fell through to 'thinking' and
 * was never surfaced as a failure. This locks in the fix: `status` decides.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatDelta } from '@agentis/core';
import { SelfHealController, type SelfHealHost } from '../../src/engine/selfHeal/selfHealController.js';

function makeController(emitWorkStep: ReturnType<typeof vi.fn>): SelfHealController {
  const host = { emitWorkStep } as unknown as SelfHealHost;
  return new SelfHealController(host);
}

const ctx = {} as Parameters<SelfHealController['relaySelfHealChatDelta']>[0];
const node = {} as Parameters<SelfHealController['relaySelfHealChatDelta']>[1];
const clip = (s: string, n: number) => s.slice(0, n);

describe('relaySelfHealChatDelta — activity phase mapping', () => {
  it('flags a real failed tool call (phase:tool, status:error) as fail', () => {
    const emitWorkStep = vi.fn();
    const controller = makeController(emitWorkStep);
    const delta: ChatDelta = {
      type: 'activity', id: 'a1', phase: 'tool', status: 'error',
      label: 'Failed agentis.build_workflow', detail: 'schema expects node "kind"',
    };
    controller.relaySelfHealChatDelta(ctx, node, 'agent-1', delta, clip);
    expect(emitWorkStep).toHaveBeenCalledWith(ctx, node, 'fail', expect.stringContaining('Failed agentis.build_workflow'));
  });

  it('does not flag a successful tool call as fail', () => {
    const emitWorkStep = vi.fn();
    const controller = makeController(emitWorkStep);
    const delta: ChatDelta = {
      type: 'activity', id: 'a2', phase: 'tool', status: 'success',
      label: 'Used agentis.workflow.patch',
    };
    controller.relaySelfHealChatDelta(ctx, node, 'agent-1', delta, clip);
    expect(emitWorkStep).toHaveBeenCalledWith(ctx, node, 'thinking', expect.stringContaining('Used agentis.workflow.patch'));
  });

  it('still flags a terminal turn-level error (phase:error) as fail', () => {
    const emitWorkStep = vi.fn();
    const controller = makeController(emitWorkStep);
    const delta: ChatDelta = {
      type: 'activity', id: 'a3', phase: 'error', status: 'error',
      label: 'Interactive chat unavailable',
    };
    controller.relaySelfHealChatDelta(ctx, node, 'agent-1', delta, clip);
    expect(emitWorkStep).toHaveBeenCalledWith(ctx, node, 'fail', expect.stringContaining('Interactive chat unavailable'));
  });

  it('maps a terminal complete phase to complete', () => {
    const emitWorkStep = vi.fn();
    const controller = makeController(emitWorkStep);
    const delta: ChatDelta = {
      type: 'activity', id: 'a4', phase: 'complete', status: 'success',
      label: 'Repair finished',
    };
    controller.relaySelfHealChatDelta(ctx, node, 'agent-1', delta, clip);
    expect(emitWorkStep).toHaveBeenCalledWith(ctx, node, 'complete', expect.stringContaining('Repair finished'));
  });
});
