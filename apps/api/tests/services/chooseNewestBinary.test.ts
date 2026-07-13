/**
 * chooseNewestBinary / parseBinaryVersion — pick the newest install of a
 * version-sensitive CLI among PATH candidates.
 *
 * Motivating bug: the Codex Desktop app bundles a stale `codex.exe` that a
 * `windowsPreferredCandidates` entry prepends ahead of the user's up-to-date
 * npm-global `codex`, so the new GPT-5.6 model tier 400s ("requires a newer
 * version of Codex") only because Agentis ran the older binary. The resolver
 * must select the newest WORKING binary regardless of PATH order, and skip a
 * candidate whose version can't be read (a broken Store/WindowsApps shim).
 */
import { describe, it, expect } from 'vitest';
import { chooseNewestBinary, parseBinaryVersion } from '../../src/services/pathExpander.js';

describe('parseBinaryVersion', () => {
  it('extracts the dotted numeric version from real --version output', () => {
    expect(parseBinaryVersion('codex-cli 0.144.1')).toBe('0.144.1');
    expect(parseBinaryVersion('0.130.0-alpha.5')).toBe('0.130.0');
    expect(parseBinaryVersion('claude 2.1.100 (build abc)')).toBe('2.1.100');
  });

  it('returns null when there is no version-shaped token', () => {
    expect(parseBinaryVersion('command not found')).toBeNull();
    expect(parseBinaryVersion('')).toBeNull();
  });
});

describe('chooseNewestBinary', () => {
  const versions: Record<string, string | null> = {
    '/local/OpenAI/Codex/bin/codex.exe': '0.130.0', // stale Desktop bundle, prepended first
    '/roaming/npm/codex.cmd': '0.144.1', // user's up-to-date npm global
  };
  const versionOf = (p: string) => versions[p] ?? null;

  it('picks the newest install even when a stale one is earlier on PATH', () => {
    const chosen = chooseNewestBinary(
      ['/local/OpenAI/Codex/bin/codex.exe', '/roaming/npm/codex.cmd'],
      versionOf,
    );
    expect(chosen).toBe('/roaming/npm/codex.cmd');
  });

  it('compares versions numerically, not lexically (0.144.1 > 0.99.9)', () => {
    const chosen = chooseNewestBinary(
      ['/a/codex', '/b/codex'],
      (p) => (p === '/a/codex' ? '0.99.9' : '0.144.1'),
    );
    expect(chosen).toBe('/b/codex');
  });

  it('never probes for a single candidate (fast path)', () => {
    let probed = 0;
    const chosen = chooseNewestBinary(['/only/codex'], () => { probed += 1; return '9.9.9'; });
    expect(chosen).toBe('/only/codex');
    expect(probed).toBe(0);
  });

  it('skips a candidate whose version is indeterminate (broken shim), keeping a working one', () => {
    const chosen = chooseNewestBinary(
      ['/windowsapps/codex.exe', '/roaming/npm/codex.cmd'],
      (p) => (p === '/roaming/npm/codex.cmd' ? '0.144.1' : null),
    );
    expect(chosen).toBe('/roaming/npm/codex.cmd');
  });

  it('falls back to the first candidate (PATH order) when no version is knowable', () => {
    const chosen = chooseNewestBinary(['/first/codex', '/second/codex'], () => null);
    expect(chosen).toBe('/first/codex');
  });

  it('dedupes repeated candidate paths', () => {
    const chosen = chooseNewestBinary(['/a/codex', '/a/codex'], () => '1.0.0');
    expect(chosen).toBe('/a/codex');
  });

  it('returns null for an empty candidate list', () => {
    expect(chooseNewestBinary([], () => '1.0.0')).toBeNull();
  });
});
