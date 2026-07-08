import { describe, expect, it } from 'vitest';
import { defaultModelFor, listRuntimeModels } from '../../src/services/runtime/runtimeModels.js';

describe('runtimeModels', () => {
  it('uses a balanced Claude Code fallback default', () => {
    expect(defaultModelFor('claude_code')).toBe('claude-sonnet-5');
  });

  it('recommends Sonnet before Opus for Claude Code catalogs', async () => {
    const catalog = await listRuntimeModels('claude_code');
    const sonnet = catalog.models.find((model) => model.id === 'claude-sonnet-5');
    const opus = catalog.models.find((model) => model.id === 'claude-opus-4-8');

    expect(catalog.defaultModel).toBe('claude-sonnet-5');
    expect(sonnet?.recommended).toBe(true);
    expect(sonnet?.tier).toBe('balanced');
    expect(opus?.recommended).not.toBe(true);
    expect(opus?.tier).toBe('flagship');
  });
});
