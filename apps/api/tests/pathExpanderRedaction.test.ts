/**
 * Env redaction — Agentis-internal secrets must never be inherited by a spawned
 * child process (agent CLIs run with their approval gates bypassed, so a leaked
 * process.env is a direct credential-exfiltration path). withExpandedPath is the
 * single chokepoint every adapter/harness spawn funnels through.
 */
import { describe, expect, it } from 'vitest';
import { isSensitiveEnvKey, redactSensitiveEnv, withExpandedPath } from '../src/services/pathExpander.js';

describe('redactSensitiveEnv', () => {
  it('strips Agentis-internal secrets and OAuth client creds', () => {
    const env = {
      PATH: '/usr/bin',
      AGENTIS_CREDENTIAL_KEY: 'vault-master-key',
      AGENTIS_JWT_PRIVATE_KEY: 'jwt-priv',
      AGENTIS_ORCHESTRATOR_API_KEY: 'sk-orch',
      AGENTIS_SEED_PASSWORD: 'hunter2',
      AGENTIS_DATABASE_URL: 'postgres://u:p@h/db',
      WORKFLOW_SYNTHESIS_API_KEY: 'sk-synth',
      OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
      OAUTH_GITHUB_CLIENT_ID: 'gh-id',
    };
    const out = redactSensitiveEnv(env);
    for (const k of Object.keys(env)) {
      if (k === 'PATH') continue;
      expect(out[k], `${k} should be stripped`).toBeUndefined();
    }
    expect(out.PATH).toBe('/usr/bin');
  });

  it('preserves generic provider keys an agent legitimately needs', () => {
    const env = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-oai',
      GH_TOKEN: 'gh',
      OPENCLAW_GATEWAY_TOKEN: 'oc',
      HOME: '/home/dev',
    };
    const out = redactSensitiveEnv(env);
    expect(out.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(out.OPENAI_API_KEY).toBe('sk-oai');
    expect(out.GH_TOKEN).toBe('gh');
    expect(out.OPENCLAW_GATEWAY_TOKEN).toBe('oc');
    expect(out.HOME).toBe('/home/dev');
  });

  it('classifies keys by shape', () => {
    expect(isSensitiveEnvKey('AGENTIS_ORCHESTRATOR_API_KEY')).toBe(true);
    expect(isSensitiveEnvKey('AGENTIS_CREDENTIAL_KEY')).toBe(true);
    expect(isSensitiveEnvKey('OAUTH_SLACK_CLIENT_SECRET')).toBe(true);
    expect(isSensitiveEnvKey('ANTHROPIC_API_KEY')).toBe(false);
    expect(isSensitiveEnvKey('PATH')).toBe(false);
    expect(isSensitiveEnvKey('AGENTIS_DATA_DIR')).toBe(false); // not secret-shaped
  });
});

describe('withExpandedPath', () => {
  it('redacts secrets while still expanding PATH', () => {
    const out = withExpandedPath({
      PATH: '/usr/bin',
      AGENTIS_CREDENTIAL_KEY: 'vault-master-key',
      ANTHROPIC_API_KEY: 'sk-ant',
    });
    expect(out.AGENTIS_CREDENTIAL_KEY).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(out.PATH).toContain('/usr/bin');
  });
});
