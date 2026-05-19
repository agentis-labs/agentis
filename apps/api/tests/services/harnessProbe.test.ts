import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectHarnesses } from '../../src/services/harnessProbe.js';
import { resolveCommandPath, resolveSpawnTarget } from '../../src/services/pathExpander.js';

describe('runtime command resolution', () => {
  it.runIf(process.platform === 'win32')('detects and launches Windows .cmd runtime shims', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentis-runtime-'));
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

      const detections = await detectHarnesses(env);
      const claude = detections.find((entry) => entry.adapterType === 'claude_code');
      expect(claude).toMatchObject({
        status: 'found',
      });
      expect(claude?.binaryPath?.toLowerCase()).toBe(shim.toLowerCase());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});