/**
 * Listener Runtime — unit + bus-integration tests.
 *
 * Covers the dependency-free core: path extraction, predicate evaluation, the
 * five fire policies, durable cursor, and end-to-end coordination through a
 * bus-backed source (agent_event) that needs no network or native deps.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REALTIME_EVENTS, REALTIME_ROOMS, type ListenerConfig } from '@agentis/core';
import { createInProcessEventBus } from '../../src/event-bus.js';
import { createLogger } from '../../src/logger.js';
import { getPath, evalJmesLite, isTruthy } from '../../src/engine/listener/jsonpath.js';
import { PredicateEvaluator, evalJsonPath } from '../../src/engine/listener/predicate.js';
import { FirePolicyController } from '../../src/engine/listener/firePolicy.js';
import { ListenerCursor } from '../../src/engine/listener/cursor.js';
import { ListenerHealthStore } from '../../src/engine/listener/health.js';
import { ListenerRuntime } from '../../src/engine/ListenerRuntime.js';
import type { WorkflowStoreService } from '../../src/services/workflowStore.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { ActiveTrigger } from '../../src/engine/ActiveWorkflowRegistry.js';

const logger = createLogger({ level: 'error' });

describe('jsonpath-lite', () => {
  const doc = { event: { type: 'push', items: [{ id: 1 }, { id: 2 }] }, n: 5 };
  it('reads dotted + bracket paths', () => {
    expect(getPath(doc, '$.event.type')).toBe('push');
    expect(getPath(doc, 'event.items[1].id')).toBe(2);
    expect(getPath(doc, 'missing.key')).toBeUndefined();
  });
  it('jmespath-lite filter projection', () => {
    const out = evalJmesLite({ items: [{ t: 'a' }, { t: 'b' }] }, "items[?t == 'b']");
    expect(out).toEqual([{ t: 'b' }]);
  });
  it('truthiness', () => {
    expect(isTruthy([])).toBe(false);
    expect(isTruthy([1])).toBe(true);
    expect(isTruthy('')).toBe(false);
    expect(isTruthy(0)).toBe(false);
  });
});

describe('predicate', () => {
  it('jsonpath operators', () => {
    const e = { type: 'push', count: 7 };
    expect(evalJsonPath({ kind: 'jsonpath', expression: 'type', operator: 'eq', expected: 'push' }, e).matched).toBe(true);
    expect(evalJsonPath({ kind: 'jsonpath', expression: 'count', operator: 'gt', expected: 3 }, e).matched).toBe(true);
    expect(evalJsonPath({ kind: 'jsonpath', expression: 'missing', operator: 'exists' }, e).matched).toBe(false);
    expect(evalJsonPath({ kind: 'jsonpath', expression: 'type', operator: 'neq', expected: 'pull' }, e).matched).toBe(true);
  });

  it('always passes; agent fails closed without a judge', async () => {
    const ev = new PredicateEvaluator({ workspaceId: 'w', logger });
    expect((await ev.evaluate({ kind: 'always' }, {})).matched).toBe(true);
    const agent = await ev.evaluate({ kind: 'agent', agentId: 'a', prompt: 'p' }, { x: 1 });
    expect(agent.matched).toBe(false);
  });
});

describe('fire policy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('immediate fires every event', () => {
    const fired: number[] = [];
    const c = new FirePolicyController({ mode: 'immediate' }, { onFire: (ev) => fired.push(ev.length), onSuppress: () => {} });
    c.submit({ a: 1 }, 'e1');
    c.submit({ a: 2 }, 'e2');
    expect(fired).toEqual([1, 1]);
  });

  it('leading_edge fires once then suppresses during cooldown', () => {
    const fired: string[] = [];
    const suppressed: string[] = [];
    const c = new FirePolicyController({ mode: 'leading_edge', cooldownMs: 1000 }, {
      onFire: (_e, id) => fired.push(id),
      onSuppress: (id) => suppressed.push(id),
    });
    c.submit({}, 'e1');
    c.submit({}, 'e2');
    c.submit({}, 'e3');
    expect(fired).toEqual(['e1']);
    expect(suppressed).toEqual(['e2', 'e3']);
    vi.advanceTimersByTime(1001);
    c.submit({}, 'e4');
    expect(fired).toEqual(['e1', 'e4']);
  });

  it('debounce fires only the last event after quiet window', () => {
    const fired: string[] = [];
    const c = new FirePolicyController({ mode: 'debounce', windowMs: 500 }, { onFire: (_e, id) => fired.push(id), onSuppress: () => {} });
    c.submit({}, 'e1');
    vi.advanceTimersByTime(200);
    c.submit({}, 'e2');
    vi.advanceTimersByTime(200);
    c.submit({}, 'e3');
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(fired).toEqual(['e3']);
  });

  it('batch fires when size reached, coalescing by key', () => {
    const fired: number[] = [];
    const c = new FirePolicyController({ mode: 'batch', size: 3, maxWaitMs: 10_000, coalesceKey: 'id' }, {
      onFire: (ev) => fired.push(ev.length),
      onSuppress: () => {},
    });
    c.submit({ id: 'a' }, 'e1');
    c.submit({ id: 'b' }, 'e2');
    c.submit({ id: 'a' }, 'e3'); // coalesces with e1 → still 2 distinct
    expect(fired).toEqual([]);
    c.submit({ id: 'c' }, 'e4'); // now 3 distinct → flush
    expect(fired).toEqual([3]);
  });

  it('throttle fires leading then trailing newest', () => {
    const fired: string[] = [];
    const c = new FirePolicyController({ mode: 'throttle', windowMs: 1000 }, { onFire: (_e, id) => fired.push(id), onSuppress: () => {} });
    c.submit({}, 'e1'); // leading fire
    c.submit({}, 'e2'); // held
    c.submit({}, 'e3'); // replaces held
    expect(fired).toEqual(['e1']);
    vi.advanceTimersByTime(1001);
    expect(fired).toEqual(['e1', 'e3']);
  });
});

describe('cursor', () => {
  it('reads initial value then advances from event path', () => {
    const mem = new Map<string, unknown>();
    const store = {
      get: (_ws: string, _wf: string, key: string) => mem.get(key),
      set: (_ws: string, _wf: string, key: string, value: unknown) => {
        mem.set(key, value);
        return {} as never;
      },
    } as unknown as WorkflowStoreService;
    const cursor = new ListenerCursor(store, {
      workspaceId: 'w',
      workflowId: 'wf',
      triggerId: 't1',
      config: { scratchpadKey: 'since', extractPath: 'updatedAt', initialValue: '2020-01-01' },
    });
    expect(cursor.read()).toBe('2020-01-01');
    cursor.advanceFrom({ updatedAt: '2026-05-29' });
    expect(cursor.read()).toBe('2026-05-29');
  });
});

describe('ListenerRuntime — bus integration', () => {
  const trigger: ActiveTrigger = {
    triggerId: 't-agent',
    workflowId: 'wf-1',
    workspaceId: 'ws-1',
    ambientId: null,
    userId: 'u-1',
    triggerType: 'persistent_listener',
    config: {} as Record<string, unknown>,
  };

  it('drives source → predicate → fire and updates health', async () => {
    const bus = createInProcessEventBus();
    const health = new ListenerHealthStore();
    const fire = vi.fn(async () => ({ runId: 'run-123' }));
    const runtime = new ListenerRuntime({
      db: {} as AgentisSqliteDb,
      logger,
      bus,
      workflowStore: {} as WorkflowStoreService,
      health,
      fire,
      allowPrivateNetwork: false,
    });

    const config: ListenerConfig = {
      source: { kind: 'agent_event', agentId: 'agent-9', eventTypes: [REALTIME_EVENTS.AGENT_TASK_COMPLETED] },
      predicate: { kind: 'jsonpath', expression: 'ok', operator: 'eq', expected: true },
      firePolicy: { mode: 'immediate' },
    };
    await runtime.activate({ ...trigger, config: config as unknown as Record<string, unknown> });

    // Non-matching event (ok=false) → no fire, recorded as skip.
    bus.publish(REALTIME_ROOMS.agent('agent-9'), REALTIME_EVENTS.AGENT_TASK_COMPLETED, { ok: false });
    // Matching event → fire.
    bus.publish(REALTIME_ROOMS.agent('agent-9'), REALTIME_EVENTS.AGENT_TASK_COMPLETED, { ok: true });
    // Different agent room → ignored entirely.
    bus.publish(REALTIME_ROOMS.agent('other'), REALTIME_EVENTS.AGENT_TASK_COMPLETED, { ok: true });

    await vi.waitFor(() => expect(fire).toHaveBeenCalledTimes(1));
    const h = health.get('t-agent')!;
    expect(h.eventCount).toBe(2);
    expect(h.fireCount).toBe(1);
    expect(h.skipCount).toBe(1);

    await runtime.deactivate('t-agent');
  });

  it('error_trigger (workflow_event "*") fires on any workspace failure but skips its own', async () => {
    const bus = createInProcessEventBus();
    const health = new ListenerHealthStore();
    const fired: Array<Record<string, unknown>> = [];
    const fire = vi.fn(async (args: { payload: Record<string, unknown> }) => {
      fired.push(args.payload);
      return { runId: `run-${fired.length}` };
    });
    const runtime = new ListenerRuntime({
      db: {} as AgentisSqliteDb,
      logger,
      bus,
      workflowStore: {} as WorkflowStoreService,
      health,
      fire: fire as never,
      allowPrivateNetwork: false,
    });

    // This error-handler workflow is `wf-handler`, watching ANY workflow failure.
    const errorTrigger: ActiveTrigger = {
      triggerId: 't-error',
      workflowId: 'wf-handler',
      workspaceId: 'ws-1',
      ambientId: null,
      userId: 'u-1',
      triggerType: 'persistent_listener',
      config: {
        source: { kind: 'workflow_event', workflowId: '*', onStatus: ['FAILED', 'CANCELLED'] },
        firePolicy: { mode: 'immediate' },
      } as unknown as Record<string, unknown>,
    };
    await runtime.activate(errorTrigger);

    // A different workflow in the same workspace FAILS → error_trigger fires.
    bus.publish(REALTIME_ROOMS.workspace('ws-1'), REALTIME_EVENTS.RUN_FAILED, { runId: 'r1', status: 'FAILED', workflowId: 'wf-other', workspaceId: 'ws-1' });
    // A failure in a DIFFERENT workspace → ignored.
    bus.publish(REALTIME_ROOMS.workspace('ws-2'), REALTIME_EVENTS.RUN_FAILED, { runId: 'r2', status: 'FAILED', workflowId: 'wf-x', workspaceId: 'ws-2' });
    // The error-handler's OWN failure → skipped (loop guard).
    bus.publish(REALTIME_ROOMS.workspace('ws-1'), REALTIME_EVENTS.RUN_FAILED, { runId: 'r3', status: 'FAILED', workflowId: 'wf-handler', workspaceId: 'ws-1' });

    await vi.waitFor(() => expect(fire).toHaveBeenCalledTimes(1));
    expect(fired[0]).toMatchObject({ workflowId: 'wf-other', status: 'FAILED' });

    await runtime.deactivate('t-error');
  });

  it('surfaces asynchronous extension-source failures in listener health', async () => {
    const bus = createInProcessEventBus();
    const health = new ListenerHealthStore();
    const extensionRuntime = {
      executeListenerSource: vi.fn(async () => {
        throw new Error('extension poll failed');
      }),
    } as unknown as ExtensionRuntime;
    const runtime = new ListenerRuntime({
      db: {} as AgentisSqliteDb,
      logger,
      bus,
      workflowStore: {} as WorkflowStoreService,
      health,
      extensionRuntime,
      fire: vi.fn(async () => ({ runId: 'unused' })),
      allowPrivateNetwork: false,
    });
    const config: ListenerConfig = {
      source: {
        kind: 'extension',
        extensionId: 'ext-1',
        operationName: 'watch',
        pollIntervalMs: 60_000,
      },
      predicate: { kind: 'always' },
      firePolicy: { mode: 'immediate' },
    };

    await runtime.activate({
      ...trigger,
      triggerId: 't-extension',
      config: config as unknown as Record<string, unknown>,
    });

    await vi.waitFor(() => {
      expect(health.get('t-extension')).toMatchObject({
        connected: false,
        status: 'error',
        errorCount: 1,
        lastError: 'extension poll failed',
      });
    });

    await runtime.deactivate('t-extension');
  });
});
