/**
 * `docker_sandbox` extension runtime - Docker container with hard resource caps.
 *
 * Registry-installed extensions use this tier by default. Containers run read-only,
 * without host network access, docker socket access, privileged mode, or host
 * namespaces. A future egress proxy can selectively re-enable network access.
 */

import { CONSTANTS, AgentisError } from '@agentis/core';
import type { ExtensionExecutionOutcome, ExtensionManifest } from '@agentis/core';
import type { Logger } from '../logger.js';

interface DockerodeLike {
  ping(): Promise<unknown>;
  createContainer(opts: Record<string, unknown>): Promise<{
    start(): Promise<unknown>;
    wait(): Promise<{ StatusCode: number }>;
    logs(opts: { stdout: boolean; stderr: boolean }): Promise<NodeJS.ReadableStream | Buffer>;
    remove(opts: { force: boolean }): Promise<unknown>;
  }>;
}

let cached:
  | { kind: 'available'; docker: DockerodeLike }
  | { kind: 'unavailable'; reason: string }
  | undefined;

async function loadDocker(): Promise<Exclude<typeof cached, undefined>> {
  if (cached) return cached;
  try {
    const mod = (await import('dockerode' as string)) as { default: new () => DockerodeLike };
    const docker = new mod.default();
    await docker.ping();
    cached = { kind: 'available', docker };
  } catch (err) {
    cached = {
      kind: 'unavailable',
      reason: `Docker is not reachable (${(err as Error).message}). docker_sandbox extensions require a running Docker daemon.`,
    };
  }
  return cached;
}

export async function isDockerSandboxAvailable(): Promise<boolean> {
  const r = await loadDocker();
  return r.kind === 'available';
}

export async function runDockerSandboxExtension(args: {
  manifest: ExtensionManifest;
  operationName: string;
  bundleDir: string;
  input: Record<string, unknown>;
  scratchpad: Record<string, unknown>;
  allowedDomains: string[];
  timeoutMs: number;
  logger: Logger;
}): Promise<ExtensionExecutionOutcome> {
  void args.logger;
  const start = Date.now();
  const loaded = await loadDocker();
  if (loaded.kind === 'unavailable') {
    return {
      ok: false,
      errorCode: 'EXTENSION_DOCKER_UNAVAILABLE',
      message: loaded.reason,
      durationMs: Date.now() - start,
      operationName: args.operationName,
    };
  }

  const docker = loaded.docker;
  const memoryBytes = CONSTANTS.EXTENSION_DOCKER_MEMORY_MB * 1024 * 1024;
  const cpuQuota = Math.floor(CONSTANTS.EXTENSION_DOCKER_CPU_QUOTA * 100_000);
  const tmpBytes = CONSTANTS.EXTENSION_DOCKER_TMP_MAX_MB * 1024 * 1024;

  let container: Awaited<ReturnType<DockerodeLike['createContainer']>> | undefined;
  try {
    container = await docker.createContainer({
      Image: 'node:20-alpine',
      Cmd: ['node', '/extension/index.js'],
      Env: [
        `AGENTIS_EXTENSION_INPUT=${JSON.stringify(args.input)}`,
        `AGENTIS_EXTENSION_SCRATCHPAD=${JSON.stringify(args.scratchpad)}`,
        `AGENTIS_EXTENSION_ALLOWED_DOMAINS=${args.allowedDomains.join(',')}`,
        `AGENTIS_EXTENSION_MANIFEST=${JSON.stringify(args.manifest)}`,
        `AGENTIS_EXTENSION_OPERATION=${args.operationName}`,
      ],
      HostConfig: {
        Binds: [`${args.bundleDir}:/extension:ro`],
        ReadonlyRootfs: true,
        AutoRemove: false,
        NetworkMode: 'none',
        Memory: memoryBytes,
        MemorySwap: memoryBytes,
        CpuPeriod: 100_000,
        CpuQuota: cpuQuota,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Tmpfs: { '/tmp': `rw,size=${tmpBytes},mode=1777` },
        PidsLimit: 256,
      },
    });
    await container.start();
    const waitTimeout = setTimeout(() => {
      void container?.remove({ force: true }).catch(() => {});
    }, args.timeoutMs + 2_000).unref?.();
    const exit = await Promise.race([
      container.wait(),
      new Promise<{ StatusCode: number; timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ StatusCode: 137, timedOut: true }), args.timeoutMs).unref?.(),
      ),
    ]);
    if (waitTimeout) clearTimeout(waitTimeout);
    const logs = await container.logs({ stdout: true, stderr: true });
    const text = Buffer.isBuffer(logs) ? logs.toString('utf8') : await streamToString(logs);
    if ('timedOut' in exit && exit.timedOut) {
      return {
        ok: false,
        errorCode: 'EXTENSION_TIMEOUT',
        message: `Docker extension timed out after ${args.timeoutMs}ms`,
        durationMs: Date.now() - start,
        operationName: args.operationName,
      };
    }
    if (exit.StatusCode !== 0) {
      return {
        ok: false,
        errorCode: 'EXTENSION_INTERNAL',
        message: `Container exited ${exit.StatusCode}: ${text.slice(0, 4096)}`,
        durationMs: Date.now() - start,
        operationName: args.operationName,
      };
    }
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    const lastLine = lines[lines.length - 1] ?? '{}';
    let output: Record<string, unknown>;
    try {
      output = JSON.parse(lastLine) as Record<string, unknown>;
    } catch {
      output = { stdout: text };
    }
    return { ok: true, output, durationMs: Date.now() - start, operationName: args.operationName };
  } catch (err) {
    if (err instanceof AgentisError) throw err;
    return {
      ok: false,
      errorCode: 'EXTENSION_INTERNAL',
      message: (err as Error).message,
      durationMs: Date.now() - start,
      operationName: args.operationName,
    };
  } finally {
    if (container) await container.remove({ force: true }).catch(() => {});
  }
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8');
}
