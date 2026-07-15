import { describe, expect, it } from 'vitest';
import {
  evaluateRuntimeCompatibility,
  runtimeCapabilityManifest,
  runtimeRequirementsFromAgentRequirements,
} from '../src/runtimeCapabilities.js';

describe('runtime capability contract', () => {
  it('projects legacy adapter affordances into a versioned manifest', () => {
    const manifest = runtimeCapabilityManifest('example', {
      interactiveChat: true,
      toolCalling: false,
      toolForwarding: 'none',
      affordances: { fileSystem: true, terminal: true },
      execution: { longRunning: true },
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'execution.file-system', available: true, source: 'legacy_projection' }),
      expect.objectContaining({ id: 'execution.terminal', available: true, source: 'legacy_projection' }),
      expect.objectContaining({ id: 'execution.browser', available: false, source: 'legacy_projection' }),
    ]));
  });

  it('lets adapters advertise namespaced capabilities and override legacy projections', () => {
    const manifest = runtimeCapabilityManifest('example', {
      interactiveChat: false,
      toolCalling: false,
      toolForwarding: 'none',
      affordances: { terminal: true },
      capabilityManifest: [
        { id: 'execution.terminal', available: false, source: 'advertised', description: 'Disabled by policy' },
        { id: 'vendor.video-render', available: true, source: 'advertised', version: '2' },
      ],
    });

    expect(manifest.capabilities.find((item) => item.id === 'execution.terminal')).toMatchObject({
      available: false,
      source: 'advertised',
    });
    expect(manifest.capabilities.find((item) => item.id === 'vendor.video-render')).toMatchObject({
      available: true,
      version: '2',
    });
  });

  it('evaluates all-of and any-of requirements without silently accepting unknown powers', () => {
    const manifest = runtimeCapabilityManifest('example', {
      interactiveChat: false,
      toolCalling: false,
      toolForwarding: 'none',
      affordances: { fileSystem: true },
      capabilityManifest: [{ id: 'vendor.search', available: true, source: 'advertised' }],
    });
    const result = evaluateRuntimeCompatibility(manifest, {
      allOf: ['execution.file-system', 'vendor.missing'],
      anyOf: [['execution.browser', 'vendor.search'], ['execution.terminal', 'vendor.shell']],
      reason: 'inspect and transform a workspace',
    });

    expect(result.compatible).toBe(false);
    expect(result.missing).toEqual(['vendor.missing']);
    expect(result.unsatisfiedAnyOf).toEqual([['execution.terminal', 'vendor.shell']]);
    expect(result.reason).toBe('inspect and transform a workspace');
  });

  it('bridges existing workflow affordance requirements', () => {
    expect(runtimeRequirementsFromAgentRequirements(
      { browser: true, terminal: true, fileSystem: false },
      'workflow requirement',
    )).toEqual({
      allOf: ['execution.browser', 'execution.terminal'],
      reason: 'workflow requirement',
    });
    expect(runtimeRequirementsFromAgentRequirements({})).toBeUndefined();
  });
});
