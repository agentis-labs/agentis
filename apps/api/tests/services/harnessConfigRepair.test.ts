import { describe, expect, it } from 'vitest';
import type { HarnessDetectionResult } from '../../src/services/harness/harnessProbe.js';
import { repairCliHarnessConfig } from '../../src/services/harness/harnessConfigRepair.js';

const detectedBinaryPath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.519.2081.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.EXE';
const staleBinaryPath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.513.4821.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.EXE';

const codexDetection: HarnessDetectionResult = {
  adapterType: 'codex',
  harness: 'Codex',
  status: 'found',
  binaryPath: detectedBinaryPath,
  config: {
    command: 'codex',
    binaryPath: 'codex',
    detectedBinaryPath,
  },
};

const currentClaudePath = '~/AppData\\Roaming\\Claude\\claude-code\\2.1.189\\claude.exe';
const staleClaudePath = '~/AppData\\Roaming\\Claude\\claude-code\\2.1.177\\claude.exe';

const claudeDetection: HarnessDetectionResult = {
  adapterType: 'claude_code',
  harness: 'Claude Code',
  status: 'found',
  binaryPath: currentClaudePath,
  config: {
    command: currentClaudePath,
    binaryPath: currentClaudePath,
    detectedBinaryPath: currentClaudePath,
  },
};

describe('runtime config repair', () => {
  it('repairs stale versioned WindowsApps CLI paths to stable commands', async () => {
    const result = await repairCliHarnessConfig('codex', { binaryPath: staleBinaryPath }, [codexDetection]);

    expect(result.changed).toBe(true);
    expect(result.config).toMatchObject({
      command: 'codex',
      binaryPath: 'codex',
      detectedBinaryPath,
    });
  });

  it('preserves explicit custom commands', async () => {
    const result = await repairCliHarnessConfig('codex', { command: 'C:\\tools\\codex-wrapper.cmd' }, [codexDetection]);

    expect(result.changed).toBe(false);
    expect(result.config.command).toBe('C:\\tools\\codex-wrapper.cmd');
  });

  it('repairs stale Claude Code managed package paths to the detected current runtime', async () => {
    const result = await repairCliHarnessConfig('claude_code', { binaryPath: staleClaudePath }, [claudeDetection]);

    expect(result.changed).toBe(true);
    expect(result.config).toMatchObject({
      command: currentClaudePath,
      binaryPath: currentClaudePath,
      detectedBinaryPath: currentClaudePath,
    });
  });

  it('preserves custom Claude Code wrappers', async () => {
    const result = await repairCliHarnessConfig('claude_code', { command: 'C:\\tools\\claude-wrapper.cmd' }, [claudeDetection]);

    expect(result.changed).toBe(false);
    expect(result.config.command).toBe('C:\\tools\\claude-wrapper.cmd');
  });
});
