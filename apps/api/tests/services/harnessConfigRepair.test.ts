import { describe, expect, it } from 'vitest';
import type { HarnessDetectionResult } from '../../src/services/harnessProbe.js';
import { repairCliHarnessConfig } from '../../src/services/harnessConfigRepair.js';

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
});
