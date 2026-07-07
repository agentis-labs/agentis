import { spawn } from 'node:child_process';
import type { AdapterHealthStatus } from '@agentis/core';
import type { Logger } from '../logger.js';
import { resolveSpawnCwd, resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';

export interface CliRuntimeProbeResult {
  health: AdapterHealthStatus;
  version: string | null;
}

export async function probeCliRuntime(input: {
  binary: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  logger: Logger;
  logTag: string;
  timeoutMs?: number;
}): Promise<CliRuntimeProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  timeout.unref?.();
  try {
    const env = withExpandedPath({ ...process.env, ...(input.env ?? {}) });
    // A version/health probe doesn't need the agent's real workdir — just a dir
    // that EXISTS, so a vanished cwd can't make a present binary throw ENOENT.
    const cwd = resolveSpawnCwd(input.cwd);
    const target = resolveSpawnTarget(input.binary, input.args ?? ['--version'], cwd ?? process.cwd(), env);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn(target.command, target.args, {
        cwd,
        env,
        windowsHide: true,
        signal: controller.signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (chunk) => {
        stdout = `${stdout}${String(chunk)}`.slice(-4096);
      });
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-4096);
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        resolve({ code, stdout, stderr });
      });
    });
    const detail = firstLine(result.stdout) ?? firstLine(result.stderr);
    if (result.code !== 0) {
      return {
        health: {
          isHealthy: false,
          error: detail ?? `${input.binary} exited ${result.code}`,
          latencyMs: Date.now() - startedAt,
          checkedAt: new Date().toISOString(),
        },
        version: null,
      };
    }
    return {
      health: {
        isHealthy: true,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
      },
      version: detail,
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    const message = timedOut
      ? `${input.binary} probe timed out`
      : (error as Error).message;
    input.logger.debug?.(`${input.logTag}.probe_failed`, { err: message });
    return {
      health: {
        isHealthy: false,
        error: message,
        // A timeout is ambiguous (binary spawned, just slow) — flag it so the
        // caller can treat it as "unknown" rather than a definitive "down". A real
        // spawn error (ENOENT etc.) is NOT flagged and stays a hard failure.
        ...(timedOut ? { timedOut: true } : {}),
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
      },
      version: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function firstLine(value: string): string | null {
  const line = value.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line || null;
}
