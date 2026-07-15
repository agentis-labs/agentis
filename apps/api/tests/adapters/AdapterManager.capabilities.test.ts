import { describe, expect, it } from 'vitest';
import type {
  AdapterCapabilities,
  AdapterHealthStatus,
  AgentAdapter,
  NormalizedAgentEvent,
  NormalizedTask,
} from '@agentis/core';
import { AgentisError } from '@agentis/core';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger({ level: 'error' });

function task(overrides: Partial<NormalizedTask> = {}): NormalizedTask {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    workflowId: 'workflow-1',
    nodeId: 'node-1',
    title: 'Inspect workspace',
    description: 'Inspect the workspace',
    inputData: {},
    scratchpadSnapshot: {},
    capabilityTags: [],
    timeoutMs: 60_000,
    ...overrides,
  };
}

class CapabilityAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  readonly dispatched: NormalizedTask[] = [];
  #handler: ((event: NormalizedAgentEvent) => void) | undefined;

  constructor(private readonly declared: AdapterCapabilities) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  capabilities(): AdapterCapabilities { return this.declared; }
  async dispatchTask(value: NormalizedTask): Promise<void> { this.dispatched.push(value); }
  async cancelTask(): Promise<void> {}
  onEvent(handler: (event: NormalizedAgentEvent) => void): void { this.#handler = handler; }
  complete(value: NormalizedTask): void {
    this.#handler?.({
      eventType: 'task.completed',
      agentId: 'agent-1',
      taskId: value.taskId,
      runId: value.runId,
      workflowId: value.workflowId,
      output: {},
      timestamp: new Date().toISOString(),
    });
  }
}

const terminalOnly: AdapterCapabilities = {
  interactiveChat: false,
  toolCalling: false,
  toolForwarding: 'none',
  affordances: { terminal: true },
};

describe('AdapterManager runtime capability boundary', () => {
  it('rejects an incompatible task before acquiring a process slot or invoking the adapter', async () => {
    const manager = new AdapterManager(logger, undefined, 1);
    const adapter = new CapabilityAdapter(terminalOnly);
    manager.register('agent-1', adapter);

    const dispatch = manager.dispatchTask(task({
      runtimeRequirements: {
        allOf: ['execution.browser'],
        reason: 'Must interact with a rendered page',
      },
    }), 'agent-1');

    const error = await dispatch.catch((caught) => caught) as AgentisError;
    expect(error).toBeInstanceOf(AgentisError);
    expect(error.code).toBe('ADAPTER_CAPABILITY_MISMATCH');
    expect(error.message).toContain('missing execution.browser');
    expect(error.remediation).toContain('compatible agent/runtime');
    expect(error.details).toMatchObject({
      agentId: 'agent-1',
      adapterType: 'http',
      taskId: 'task-1',
      phase: 'pre_dispatch',
      dispatchAttempted: false,
      manifest: { schemaVersion: 1, adapterType: 'http' },
      compatibility: { compatible: false, missing: ['execution.browser'] },
    });
    expect(adapter.dispatched).toHaveLength(0);
    expect(manager.processConcurrency).toMatchObject({ active: 0, waiting: 0 });
  });

  it('preserves backward compatibility when a task declares no runtime requirements', async () => {
    const manager = new AdapterManager(logger, undefined, 1);
    const adapter = new CapabilityAdapter(terminalOnly);
    manager.register('agent-1', adapter);
    const value = task();

    await manager.dispatchTask(value, 'agent-1');

    expect(adapter.dispatched).toEqual([value]);
    expect(manager.capabilityManifest('agent-1')).toMatchObject({
      schemaVersion: 1,
      adapterType: 'http',
    });
    expect(manager.compatibility('agent-1', { allOf: ['execution.terminal'] })).toMatchObject({ compatible: true });
    adapter.complete(value);
    expect(manager.processConcurrency.active).toBe(0);
  });

  it('accepts explicit namespaced adapter capabilities', async () => {
    const manager = new AdapterManager(logger, undefined, 1);
    const adapter = new CapabilityAdapter({
      ...terminalOnly,
      capabilityManifest: [{ id: 'vendor.video-render', available: true, source: 'advertised', version: '2' }],
    });
    manager.register('agent-1', adapter);
    const value = task({ runtimeRequirements: { allOf: ['vendor.video-render'] } });

    await manager.dispatchTask(value, 'agent-1');

    expect(adapter.dispatched).toHaveLength(1);
    adapter.complete(value);
  });

  it('enforces requirements independently across a heterogeneous adapter fleet', async () => {
    const manager = new AdapterManager(logger, undefined, 2);
    const terminal = new CapabilityAdapter(terminalOnly);
    const browser = new CapabilityAdapter({
      interactiveChat: true,
      toolCalling: false,
      toolForwarding: 'none',
      affordances: { browser: true },
    });
    manager.register('terminal-agent', terminal);
    manager.register('browser-agent', browser);
    const requirement = {
      allOf: ['execution.browser' as const],
      reason: 'Rendered-page inspection',
    };

    const rejected = await manager.dispatchTask(task({ runtimeRequirements: requirement }), 'terminal-agent')
      .catch((caught) => caught) as AgentisError;
    expect(rejected.code).toBe('ADAPTER_CAPABILITY_MISMATCH');
    expect(terminal.dispatched).toHaveLength(0);

    const accepted = task({ taskId: 'task-browser', runtimeRequirements: requirement });
    await manager.dispatchTask(accepted, 'browser-agent');
    expect(browser.dispatched).toEqual([accepted]);
    expect(manager.compatibility('terminal-agent', requirement)).toMatchObject({ compatible: false });
    expect(manager.compatibility('browser-agent', requirement)).toMatchObject({ compatible: true });
    browser.complete(accepted);
  });
});
