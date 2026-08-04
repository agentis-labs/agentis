import { describe, expect, it } from 'vitest';
import { configToRuntimeConfig, DEFAULT_RUNTIME_CONFIG, runtimeConfigToAdapterConfig } from '../../src/components/agents/RuntimePicker';

describe('RuntimePicker profile v2', () => {
  it('round-trips an explicit native Codex authority envelope', () => {
    const config = {
      ...DEFAULT_RUNTIME_CONFIG,
      codexCwd: 'C:/repo',
      codexBrowser: 'true',
      runtimeMode: 'native',
      runtimePermissionProfile: 'workspace_write',
      runtimeProfileName: 'work',
      runtimeInheritUserConfig: 'true',
      runtimeInheritProjectInstructions: 'true',
      runtimeSessionPolicy: 'persistent',
    };
    const stored = runtimeConfigToAdapterConfig('codex', config);
    expect(stored.runtimeProfile).toEqual(expect.objectContaining({
      version: 2,
      mode: 'native',
      projectRoot: 'C:/repo',
      profileName: 'work',
      permissionProfile: 'workspace_write',
      browser: 'enabled',
    }));
    const roundTrip = configToRuntimeConfig('codex', stored);
    expect(roundTrip).toMatchObject({ runtimeMode: 'native', runtimePermissionProfile: 'workspace_write', runtimeProfileName: 'work' });
  });
});
