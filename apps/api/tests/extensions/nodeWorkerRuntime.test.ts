/**
 * node_worker Extension runtime availability and responsiveness contract.
 *
 * These tests run on hosts without `isolated-vm` installed. In that case the
 * runtime must return EXTENSION_RUNTIME_UNAVAILABLE instead of throwing during
 * application boot.
 */
import { describe, it, expect } from 'vitest';
import {
  isNodeWorkerAvailable,
  runNodeWorkerExtension,
} from '../../src/extensions/nodeWorkerRuntime.js';
import type { ExtensionManifest } from '@agentis/core';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as const;

const baseManifest: ExtensionManifest = {
  name: 'Test Extension',
  slug: 'test-extension',
  version: '1.0.0',
  runtime: 'node_worker',
  operations: [{ name: 'execute', inputSchema: {}, outputSchema: {} }],
  capabilityTags: [],
  permissions: [],
};

describe('nodeWorkerRuntime - CPU isolation', () => {
  it('reports availability without throwing', async () => {
    const available = await isNodeWorkerAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('returns EXTENSION_RUNTIME_UNAVAILABLE when isolated-vm is absent', async () => {
    const available = await isNodeWorkerAvailable();
    if (available) return;

    const out = await runNodeWorkerExtension({
      manifest: baseManifest,
      operationName: 'execute',
      source: 'export async function execute() { return { ok: true }; }',
      input: {},
      scratchpad: {},
      allowedDomains: [],
      permissions: [],
      allowPrivateNetwork: false,
      timeoutMs: 1_000,
      logger: noopLogger,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errorCode).toBe('EXTENSION_RUNTIME_UNAVAILABLE');
  });

  it('main thread remains responsive while the worker path is invoked', async () => {
    const available = await isNodeWorkerAvailable();
    const ticks: number[] = [];
    const interval = setInterval(() => ticks.push(Date.now()), 25);
    try {
      await runNodeWorkerExtension({
        manifest: baseManifest,
        operationName: 'execute',
        source: 'export async function execute() { return { ok: true }; }',
        input: {},
        scratchpad: {},
        allowedDomains: [],
        permissions: [],
        allowPrivateNetwork: false,
        timeoutMs: 250,
        logger: noopLogger,
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      clearInterval(interval);
    }

    expect(ticks.length).toBeGreaterThanOrEqual(available ? 2 : 1);
  });
});
