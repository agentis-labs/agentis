/**
 * Codex service_tier self-heal (NATIVE-ADVANCEMENT Phase A follow-up).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexServiceTierArgs } from '../../src/adapters/codexServiceTier.js';

let home: string;

function writeConfig(contents: string) {
  writeFileSync(join(home, 'config.toml'), contents, 'utf-8');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('codexServiceTierArgs', () => {
  it('overrides an invalid service_tier ("default")', () => {
    writeConfig('model = "gpt-5.4-mini"\nservice_tier = "default"\n');
    expect(codexServiceTierArgs({ CODEX_HOME: home })).toEqual(['-c', 'service_tier="fast"']);
  });

  it('leaves a valid "flex" untouched', () => {
    writeConfig('service_tier = "flex"\n');
    expect(codexServiceTierArgs({ CODEX_HOME: home })).toEqual([]);
  });

  it('leaves a valid "fast" untouched', () => {
    writeConfig('service_tier = "fast"\n');
    expect(codexServiceTierArgs({ CODEX_HOME: home })).toEqual([]);
  });

  it('does nothing when service_tier is absent', () => {
    writeConfig('model = "gpt-5.4-mini"\n');
    expect(codexServiceTierArgs({ CODEX_HOME: home })).toEqual([]);
  });

  it('ignores a service_tier nested inside a [section] (top-level only)', () => {
    writeConfig('model = "x"\n\n[some_section]\nservice_tier = "default"\n');
    expect(codexServiceTierArgs({ CODEX_HOME: home })).toEqual([]);
  });

  it('returns [] when the config file is missing', () => {
    expect(codexServiceTierArgs({ CODEX_HOME: join(home, 'nope') })).toEqual([]);
  });

  it('handles unquoted values', () => {
    writeConfig('service_tier = priority\n');
    expect(codexServiceTierArgs({ CODEX_HOME: home })).toEqual(['-c', 'service_tier="fast"']);
  });
});
