import { describe, expect, it } from 'vitest';
import { defaultModelFor, listRuntimeModels } from '../../src/services/runtime/runtimeModels.js';

describe('runtimeModels', () => {
  it('uses a balanced Claude Code fallback default', () => {
    expect(defaultModelFor('claude_code')).toBe('claude-sonnet-5');
  });

  it('keeps the current Claude family in strongest-to-fastest order', async () => {
    const catalog = await listRuntimeModels('claude_code');
    const ids = catalog.models.map((model) => model.id);
    const sonnet = catalog.models.find((model) => model.id === 'claude-sonnet-5');
    const opus = catalog.models.find((model) => model.id === 'claude-opus-5');

    expect(catalog.defaultModel).toBe('claude-sonnet-5');
    expect(ids.slice(0, 4)).toEqual(['claude-fable', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
    expect(ids).not.toContain('claude-sonnet-4-6');
    expect(ids).not.toContain('claude-opus-4-7');
    expect(sonnet?.tier).toBe('balanced');
    expect(opus?.recommended).not.toBe(true);
    expect(opus?.tier).toBe('flagship');
  });

  it('keeps Codex models stable in power order regardless of selection', async () => {
    const catalog = await listRuntimeModels('codex');
    expect(catalog.models.slice(0, 7).map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
    ]);
    expect(catalog.models.map((model) => model.id)).not.toContain('gpt-5.2');
  });

  it('lists each Antigravity model family once', async () => {
    const catalog = await listRuntimeModels('antigravity');

    expect(catalog.models.map((model) => model.label)).toEqual([
      'Gemini 3.6 Flash',
      'Gemini 3.5 Flash',
      'Gemini 3.1 Pro',
      'Claude Sonnet 4.6',
      'Claude Opus 4.6',
      'GPT-OSS 120B',
    ]);
  });
});
