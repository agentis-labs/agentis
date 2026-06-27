import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectHarnesses, testHarnessConfig } from '../../src/services/harnessProbe.js';
import { resolveCommandPath, resolveSpawnTarget } from '../../src/services/pathExpander.js';

describe('runtime command resolution', () => {
  it.runIf(process.platform === 'win32')('detects and launches Windows .cmd runtime shims', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentis runtime '));
    try {
      const shim = join(dir, 'claude.cmd');
      writeFileSync(shim, '@echo off\r\necho Claude Code 1.2.3\r\n', 'utf8');
      const env = {
        ...process.env,
        PATH: dir,
        Path: dir,
        PATHEXT: '.CMD;.EXE;.BAT;.COM',
      } satisfies NodeJS.ProcessEnv;

      expect(resolveCommandPath('claude', dir, env)?.toLowerCase()).toBe(shim.toLowerCase());
      const target = resolveSpawnTarget('claude', ['--version'], dir, env);
      expect(target.command.toLowerCase()).toContain('cmd.exe');
      expect(target.args.join(' ').toLowerCase()).toContain('claude.cmd');
      expect(execFileSync(target.command, target.args, { encoding: 'utf8', env }).trim()).toBe('Claude Code 1.2.3');

      const detections = await detectHarnesses(env);
      const claude = detections.find((entry) => entry.adapterType === 'claude_code');
      expect(claude).toMatchObject({
        status: 'found',
      });
      expect(claude?.binaryPath?.toLowerCase()).toBe(shim.toLowerCase());
      expect(claude?.config?.command).toBe('claude');
      expect(claude?.config?.binaryPath).toBe('claude');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enumerates the Antigravity CLI harness in detection results', async () => {
    const detections = await detectHarnesses(process.env);
    const agy = detections.find((entry) => entry.adapterType === 'antigravity');
    expect(agy).toBeDefined();
    expect(agy?.harness).toBe('Antigravity CLI');
    expect(agy?.installCommand).toContain('antigravity.google');
  });

  it('warns that Antigravity is not signed in when no antigravity-cli home exists', async () => {
    const env = { ...process.env, ANTIGRAVITY_HOME: join(tmpdir(), 'agentis-no-agy-' + Date.now()) };
    const result = await testHarnessConfig('antigravity', { binaryPath: 'agy' }, { env });
    const auth = result.checks.find((check) => check.code === 'auth');
    expect(auth?.level).toBe('warn');
    expect(`${auth?.hint ?? ''}`).toContain('agy');
  });

  it('reports Antigravity as authenticated when a signed-in home exists', async () => {
    const agyHome = mkdtempSync(join(tmpdir(), 'agentis-agy-'));
    try {
      writeFileSync(join(agyHome, 'oauth_creds.json'), '{"token":"x"}', 'utf8');
      const env = { ...process.env, ANTIGRAVITY_HOME: agyHome };
      const result = await testHarnessConfig('antigravity', { binaryPath: 'agy' }, { env });
      const auth = result.checks.find((check) => check.code === 'auth');
      expect(auth?.level).toBe('info');
      expect(auth?.message).toContain('Antigravity');
    } finally {
      rmSync(agyHome, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')('prefers the stable Codex Desktop CLI over versioned WindowsApps paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentis codex path '));
    try {
      const localAppData = join(root, 'Local');
      const stable = join(localAppData, 'OpenAI', 'Codex', 'bin');
      const windowsApps = join(root, 'WindowsApps', 'OpenAI.Codex_26.519.2081.0_x64__2p2nqsd0c76g0', 'app', 'resources');
      const stableShim = join(stable, 'codex.cmd');
      mkdirSync(stable, { recursive: true });
      mkdirSync(windowsApps, { recursive: true });
      writeFileSync(stableShim, '@echo off\r\necho codex-cli 1.2.3\r\n', 'utf8');
      writeFileSync(join(windowsApps, 'codex.cmd'), '@echo off\r\necho inaccessible\r\n', 'utf8');
      const env = {
        ...process.env,
        LOCALAPPDATA: localAppData,
        PATH: windowsApps,
        Path: windowsApps,
        PATHEXT: '.CMD;.EXE;.BAT;.COM',
      } satisfies NodeJS.ProcessEnv;

      expect(resolveCommandPath('codex', root, env)?.toLowerCase()).toBe(stableShim.toLowerCase());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
