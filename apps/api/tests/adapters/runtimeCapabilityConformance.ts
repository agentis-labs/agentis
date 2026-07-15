import {
  BUILTIN_RUNTIME_CAPABILITIES,
  evaluateRuntimeCompatibility,
  runtimeCapabilityManifest,
  type AgentAdapter,
  type RuntimeCapabilityId,
} from '@agentis/core';
import { expect } from 'vitest';

export interface AdapterCapabilityExpectation {
  available: RuntimeCapabilityId[];
  additionalAvailable?: RuntimeCapabilityId[];
  unavailableProbe?: RuntimeCapabilityId;
}

/** Reusable contract assertions for built-in and third-party Agentis adapters. */
export function expectAdapterCapabilityConformance(
  adapter: AgentAdapter,
  expectation: AdapterCapabilityExpectation,
): void {
  const manifest = runtimeCapabilityManifest(adapter.adapterType, adapter.capabilities?.());
  const builtins = manifest.capabilities.filter((item) =>
    (BUILTIN_RUNTIME_CAPABILITIES as readonly string[]).includes(item.id));

  expect(manifest.schemaVersion).toBe(1);
  expect(builtins).toHaveLength(BUILTIN_RUNTIME_CAPABILITIES.length);
  expect(builtins.every((item) => item.source === 'advertised')).toBe(true);
  expect(builtins.every((item) => item.version === '1')).toBe(true);

  const actualAvailable = builtins
    .filter((item) => item.available)
    .map((item) => item.id)
    .sort();
  expect(actualAvailable).toEqual([...expectation.available].sort());

  for (const id of expectation.additionalAvailable ?? []) {
    expect(manifest.capabilities).toContainEqual(expect.objectContaining({
      id,
      available: true,
      source: 'advertised',
    }));
  }

  expect(evaluateRuntimeCompatibility(manifest, {
    allOf: [...expectation.available, ...(expectation.additionalAvailable ?? [])],
  })).toMatchObject({ compatible: true, missing: [] });

  const unavailableProbe = expectation.unavailableProbe
    ?? BUILTIN_RUNTIME_CAPABILITIES.find((id) => !expectation.available.includes(id));
  if (unavailableProbe) {
    expect(evaluateRuntimeCompatibility(manifest, {
      allOf: [unavailableProbe],
    })).toMatchObject({ compatible: false, missing: [unavailableProbe] });
  }
}
