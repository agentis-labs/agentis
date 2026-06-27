import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { V1HarnessAdapterType, HarnessDetectionResult } from './harnessProbe.js';
import { detectHarnesses } from './harnessProbe.js';
import { resolveSpawnTarget, withExpandedPath } from './pathExpander.js';

const execFileAsync = promisify(execFile);

export interface HarnessInstallOption {
  adapterType: V1HarnessAdapterType;
  canAutoInstall: boolean;
  installCommand?: string;
  manualUrl?: string;
  manualInstructions?: string;
}

export interface HarnessInstallResult {
  ok: boolean;
  binaryPath?: string;
  detectedVersion?: string;
  detectedModel?: string;
}

export const HARNESS_INSTALL_OPTIONS: HarnessInstallOption[] = [
  {
    adapterType: 'claude_code',
    canAutoInstall: true,
    installCommand: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    adapterType: 'codex',
    canAutoInstall: true,
    installCommand: 'npm install -g @openai/codex',
  },
  {
    adapterType: 'gemini',
    canAutoInstall: true,
    installCommand: 'npm install -g @google/gemini-cli',
  },
  {
    adapterType: 'hermes_agent',
    canAutoInstall: false,
    manualInstructions: 'Install the Hermes Agent CLI, then return and re-run detection.',
  },
  {
    adapterType: 'cursor',
    canAutoInstall: false,
    manualUrl: 'https://www.cursor.com/',
    manualInstructions: 'Install Cursor and enable the Cursor Agent CLI before commissioning.',
  },
  {
    adapterType: 'openclaw',
    canAutoInstall: false,
    manualInstructions: 'OpenClaw does not install a local binary here. Configure a gateway in Settings > Gateways.',
  },
  {
    adapterType: 'http',
    canAutoInstall: false,
    manualInstructions: 'Configure an HTTP agent endpoint with a base URL and dispatch path.',
  },
];

const AUTO_INSTALL_PLAN: Record<Extract<V1HarnessAdapterType, 'claude_code' | 'codex' | 'gemini'>, {
  label: string;
  packageName: string;
}> = {
  claude_code: {
    label: 'Claude Code',
    packageName: '@anthropic-ai/claude-code',
  },
  codex: {
    label: 'Codex',
    packageName: '@openai/codex',
  },
  gemini: {
    label: 'Gemini CLI',
    packageName: '@google/gemini-cli',
  },
};

export function listHarnessInstallOptions(): HarnessInstallOption[] {
  return HARNESS_INSTALL_OPTIONS;
}

export function getHarnessInstallOption(adapterType: V1HarnessAdapterType): HarnessInstallOption {
  return HARNESS_INSTALL_OPTIONS.find((option) => option.adapterType === adapterType) ?? {
    adapterType,
    canAutoInstall: false,
    manualInstructions: 'No install option is available for this harness.',
  };
}

export function isAutoInstallableAdapter(adapterType: V1HarnessAdapterType): adapterType is Extract<V1HarnessAdapterType, 'claude_code' | 'codex' | 'gemini'> {
  return adapterType === 'claude_code' || adapterType === 'codex' || adapterType === 'gemini';
}

export async function installHarness(opts: {
  adapterType: Extract<V1HarnessAdapterType, 'claude_code' | 'codex' | 'gemini'>;
  env?: NodeJS.ProcessEnv;
  onStep: (step: { index: number; label: string; status: 'running' | 'done' | 'error'; detail?: string }) => Promise<void> | void;
  onLog?: (line: string) => Promise<void> | void;
}): Promise<HarnessInstallResult> {
  const plan = AUTO_INSTALL_PLAN[opts.adapterType];
  const env = withExpandedPath(opts.env ?? process.env);

  await runCheck({
    index: 0,
    label: 'Check Node.js version',
    env,
    onStep: opts.onStep,
    command: 'node',
    args: ['--version'],
  });

  await runCheck({
    index: 1,
    label: 'Check npm version',
    env,
    onStep: opts.onStep,
    command: 'npm',
    args: ['--version'],
  });

  await opts.onStep({ index: 2, label: `npm install -g ${plan.packageName}`, status: 'running' });
  await spawnInstall({
    env,
    command: 'npm',
    args: ['install', '-g', plan.packageName],
    onLog: opts.onLog,
  });
  await opts.onStep({ index: 2, label: `npm install -g ${plan.packageName}`, status: 'done' });

  await opts.onStep({ index: 3, label: `Verify ${plan.label} on PATH`, status: 'running' });
  const detection = await redetect(opts.adapterType, env);
  if (!detection || detection.status !== 'found') {
    await opts.onStep({ index: 3, label: `Verify ${plan.label} on PATH`, status: 'error', detail: detection?.detail ?? `${plan.label} was not detected after install.` });
    throw new Error(detection?.detail ?? `${plan.label} was not detected after install.`);
  }
  await opts.onStep({ index: 3, label: `Verify ${plan.label} on PATH`, status: 'done', detail: detection.binaryPath ?? detection.detail });

  return {
    ok: true,
    binaryPath: detection.binaryPath,
    detectedVersion: detection.detectedVersion,
    detectedModel: detection.detectedModel,
  };
}

async function runCheck(opts: {
  index: number;
  label: string;
  env: NodeJS.ProcessEnv;
  onStep: (step: { index: number; label: string; status: 'running' | 'done' | 'error'; detail?: string }) => Promise<void> | void;
  command: string;
  args: string[];
}) {
  await opts.onStep({ index: opts.index, label: opts.label, status: 'running' });
  try {
    const target = resolveSpawnTarget(opts.command, opts.args, process.cwd(), opts.env);
    const { stdout, stderr } = await execFileAsync(target.command, target.args, { env: opts.env, timeout: 5000, windowsHide: true });
    const detail = firstLine(stdout || stderr);
    await opts.onStep({ index: opts.index, label: opts.label, status: 'done', detail });
  } catch (error) {
    const detail = firstLine((error as { stdout?: string; stderr?: string; message?: string }).stdout
      || (error as { stdout?: string; stderr?: string; message?: string }).stderr
      || (error as { stdout?: string; stderr?: string; message?: string }).message);
    await opts.onStep({ index: opts.index, label: opts.label, status: 'error', detail });
    throw new Error(detail ?? `${opts.command} check failed.`);
  }
}

async function spawnInstall(opts: {
  env: NodeJS.ProcessEnv;
  command: string;
  args: string[];
  onLog?: (line: string) => Promise<void> | void;
}) {
  await new Promise<void>((resolve, reject) => {
    const target = resolveSpawnTarget(opts.command, opts.args, process.cwd(), opts.env);
    const child = spawn(target.command, target.args, {
      env: opts.env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const flush = async (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
        await opts.onLog?.(line.slice(0, 500));
      }
    };

    child.stdout.on('data', (chunk) => { void flush(chunk); });
    child.stderr.on('data', (chunk) => { void flush(chunk); });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`install process exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function redetect(adapterType: V1HarnessAdapterType, env: NodeJS.ProcessEnv): Promise<HarnessDetectionResult | undefined> {
  const detections = await detectHarnesses(env);
  return detections.find((entry) => entry.adapterType === adapterType);
}

function firstLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 240);
}
