import { detectHarnesses, type HarnessDetectionResult, type V1HarnessAdapterType } from './harnessProbe.js';

const CLI_DEFAULT_COMMAND: Partial<Record<V1HarnessAdapterType, string>> = {
  claude_code: 'claude',
  codex: 'codex',
  cursor: 'agent',
  hermes_agent: 'hermes',
  gemini: 'gemini',
  antigravity: 'agy',
};

export interface HarnessConfigRepairResult {
  config: Record<string, unknown>;
  changed: boolean;
  detection?: HarnessDetectionResult;
}

export function isCliHarnessAdapter(adapterType: V1HarnessAdapterType): adapterType is Extract<V1HarnessAdapterType, 'claude_code' | 'codex' | 'cursor' | 'hermes_agent' | 'gemini' | 'antigravity'> {
  return adapterType === 'claude_code' || adapterType === 'codex' || adapterType === 'cursor' || adapterType === 'hermes_agent' || adapterType === 'gemini' || adapterType === 'antigravity';
}

export function cliCommandFromConfig(config: Record<string, unknown>, fallback?: string): string | null {
  return stringOf(config.command) ?? stringOf(config.binaryPath) ?? fallback ?? null;
}

export async function repairCliHarnessConfig(
  adapterType: V1HarnessAdapterType,
  config: Record<string, unknown>,
  detections?: HarnessDetectionResult[],
): Promise<HarnessConfigRepairResult> {
  if (!isCliHarnessAdapter(adapterType)) return { config, changed: false };

  const allDetections = detections ?? await detectHarnesses();
  const detection = allDetections.find((entry) => entry.adapterType === adapterType);
  if (detection?.status !== 'found') return { config, changed: false, detection };

  const stableCommand = stringOf(detection.config?.command)
    ?? stringOf(detection.config?.binaryPath)
    ?? CLI_DEFAULT_COMMAND[adapterType];
  if (!stableCommand) return { config, changed: false, detection };

  const currentCommand = cliCommandFromConfig(config);
  const shouldRepair = !currentCommand
    || currentCommand === detection.binaryPath
    || isManagedVersionedRuntimePath(adapterType, currentCommand)
    || (
      adapterType === 'claude_code'
      && currentCommand === CLI_DEFAULT_COMMAND.claude_code
      && stableCommand !== CLI_DEFAULT_COMMAND.claude_code
    );

  if (!shouldRepair) return { config, changed: false, detection };

  return {
    config: {
      ...config,
      command: stableCommand,
      binaryPath: stableCommand,
      detectedBinaryPath: detection.binaryPath,
    },
    changed: true,
    detection,
  };
}

function isManagedVersionedRuntimePath(adapterType: V1HarnessAdapterType, value: string): boolean {
  if (isVersionedWindowsAppsPath(value)) return true;
  if (adapterType === 'claude_code') return isVersionedClaudeCodePath(value);
  return false;
}

function isVersionedWindowsAppsPath(value: string): boolean {
  return /\\WindowsApps\\[^\\]+_\d+\.\d+\.\d+\.\d+_/i.test(value);
}

function isVersionedClaudeCodePath(value: string): boolean {
  return /[\\/]Claude[\\/]claude-code[\\/]\d+(?:\.\d+)+[\\/]claude(?:\.exe)?$/i.test(value);
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
