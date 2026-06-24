import { describe, expect, it } from 'vitest';
import {
  affordanceLabel,
  agentMatchSummary,
  agentRequirementMatches,
  agentSatisfiesRequirements,
  configuredAffordances,
  describeAgentRequirements,
  hasAgentRequirements,
  normalizeAgentRequirements,
  potentialAffordances,
  requiredAffordanceKeys,
} from '../src/halAffordances.js';

describe('HAL affordances', () => {
  it('labels browser as native browser for operator-facing surfaces', () => {
    expect(affordanceLabel('browser')).toBe('Native browser');
    expect(affordanceLabel('computerUse')).toBe('Computer use');
  });

  it('normalizes requirements to known true affordances only', () => {
    expect(normalizeAgentRequirements({
      browser: true,
      terminal: false,
      fileSystem: 1,
      nativeMcp: true,
      unknown: true,
    })).toEqual({ browser: true, nativeMcp: true });
  });

  it('keeps stable required-key ordering', () => {
    const normalized = normalizeAgentRequirements({ nativeMcp: true, browser: true, terminal: true });
    expect(requiredAffordanceKeys(normalized)).toEqual(['browser', 'terminal', 'nativeMcp']);
    expect(describeAgentRequirements(normalized)).toBe('Native browser, Terminal, Native MCP');
    expect(hasAgentRequirements(normalized)).toBe(true);
  });

  it('matches agents by adapter-advertised affordances only', () => {
    const requirements = normalizeAgentRequirements({ browser: true, terminal: true });
    const match = agentMatchSummary({
      id: 'agent-1',
      name: 'Terminal runtime',
      status: 'online',
      adapterCapabilities: { affordances: { terminal: true } },
    }, requirements);

    expect(match.satisfied).toBe(false);
    expect(match.provided).toEqual(['Terminal']);
    expect(match.missing).toEqual(['Native browser']);
    expect(agentSatisfiesRequirements({ affordances: { browser: true, terminal: true } }, requirements)).toBe(true);
  });
});

describe('HAL supply view (configured / potential affordances)', () => {
  it('reflects Codex native-browser opt-in from config', () => {
    expect(configuredAffordances('codex', null)).toEqual({ fileSystem: true, terminal: true });
    expect(configuredAffordances('codex', { browser: true })).toEqual({
      fileSystem: true, terminal: true, browser: true, computerUse: true,
    });
  });

  it('always advertises OpenClaw browser/computer-use', () => {
    expect(configuredAffordances('openclaw', null)).toEqual({ browser: true, computerUse: true, terminal: true });
  });

  it('exposes Codex native browser as a latent (enablable) power but not for fixed runtimes', () => {
    expect(potentialAffordances('codex').browser).toBe(true);
    expect(potentialAffordances('claude_code').browser).toBeUndefined();
    expect(potentialAffordances('cursor').browser).toBeUndefined();
    expect(potentialAffordances('http')).toEqual({});
  });
});

describe('HAL requirement match states', () => {
  const requirements = normalizeAgentRequirements({ browser: true });

  it('ranks ready > offline_capable > enablable > incapable and classifies each', () => {
    const matches = agentRequirementMatches([
      // incapable: Claude can never do native browser
      { id: 'claude', name: 'Claude', status: 'online', adapterType: 'claude_code' },
      // enablable: Codex without the browser opt-in
      { id: 'codex', name: 'Codex', status: 'online', adapterType: 'codex' },
      // offline_capable: OpenClaw configured for browser but not connected
      { id: 'openclaw', name: 'OpenClaw', status: 'offline', adapterType: 'openclaw' },
      // ready: connected and live-advertising browser
      { id: 'live', name: 'Live', status: 'online', adapterType: 'openclaw', adapterCapabilities: { affordances: { browser: true } } },
    ], requirements);

    expect(matches.map((m) => [m.id, m.state])).toEqual([
      ['live', 'ready'],
      ['openclaw', 'offline_capable'],
      ['codex', 'enablable'],
      ['claude', 'incapable'],
    ]);
    const codex = matches.find((m) => m.id === 'codex')!;
    expect(codex.enablable).toEqual(['Native browser']);
    expect(codex.satisfied).toBe(false);
  });
});
