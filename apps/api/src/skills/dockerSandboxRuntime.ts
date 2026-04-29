/**
 * `docker_sandbox` skill runtime — Docker container with hard resource caps.
 *
 * Registry-installed skills are pinned to this tier and cannot be downgraded by
 * the operator. Container constraints (V1-SPEC §9.2):
 *  - read-only root + tmpfs `/tmp` capped at SKILL_DOCKER_TMP_MAX_MB
 *  - memory cap SKILL_DOCKER_MEMORY_MB
 *  - cpu quota SKILL_DOCKER_CPU_QUOTA
 *  - egress filtered to manifest `allowedDomains` via in-container HTTP
 *    proxy environment variable; no raw socket access outside the allowlist
 *  - no docker socket mount, no --privileged, no host pid/net namespace
 *
 * Like `node_worker`, dockerode is loaded dynamically. Hosts without Docker
 * (or without the operator opting in via AGENTIS_SKILL_DOCKER=true) get a
 * clean SKILL_DOCKER_UNAVAILABLE instead of a hard failure.
 */

import { CONSTANTS, AgentisError } from '@agentis/core';
import type { SkillManifest, SkillExecutionOutcome } from '@agentis/core';
import type { Logger } from '../logger.js';

interface DockerodeLike {
  ping(): Promise<unknown>;
  // The shape we use is small enough to keep the surface narrow without
  // pulling the dockerode types into the build graph.
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

async function loadDocker(): Promise<typeof cached extends infer T ? Exclude<T, undefined> : never> {
  if (cached) return cached as Exclude<typeof cached, undefined>;
  try {
    const mod = (await import('dockerode' as string)) as { default: new () => DockerodeLike };
    const docker = new mod.default();
    await docker.ping();
    cached = { kind: 'available', docker };
  } catch (err) {
    cached = {
      kind: 'unavailable',
      reason: `Docker is not reachable (${(err as Error).message}). Registry-installed skills require a running Docker daemon.`,
    };
  }
  return cached as Exclude<typeof cached, undefined>;
}

export async function isDockerSandboxAvailable(): Promise<boolean> {
  const r = await loadDocker();
  return r.kind === 'available';
}

export async function runDockerSandboxSkill(args: {
  manifest: SkillManifest;
  /** Local path to the unpacked skill bundle. The bundle's entrypoint is run inside the container. */
  bundleDir: string;
  input: Record<string, unknown>;
  scratchpad: Record<string, unknown>;
  allowedDomains: string[];
  timeoutMs: number;
  logger: Logger;
}): Promise<SkillExecutionOutcome> {
  const start = Date.now();
  const loaded = await loadDocker();
  if (loaded.kind === 'unavailable') {
    return {
      ok: false,
      errorCode: 'SKILL_DOCKER_UNAVAILABLE',
      message: loaded.reason,
      durationMs: Date.now() - start,
    };
  }
  const docker = loaded.docker;
  const memoryBytes = CONSTANTS.SKILL_DOCKER_MEMORY_MB * 1024 * 1024;
  const cpuQuota = Math.floor(CONSTANTS.SKILL_DOCKER_CPU_QUOTA * 100_000); // period 100_000
  const tmpBytes = CONSTANTS.SKILL_DOCKER_TMP_MAX_MB * 1024 * 1024;

  let container: Awaited<ReturnType<DockerodeLike['createContainer']>> | undefined;
  try {
    container = await docker.createContainer({
      Image: 'node:20-alpine',
      Cmd: ['node', '/skill/index.js'],
      Env: [
        `AGENTIS_SKILL_INPUT=${JSON.stringify(args.input)}`,
        `AGENTIS_SKILL_SCRATCHPAD=${JSON.stringify(args.scratchpad)}`,
        `AGENTIS_SKILL_ALLOWED_DOMAINS=${args.allowedDomains.join(',')}`,
      ],
      HostConfig: {
        Binds: [`${args.bundleDir}:/skill:ro`],
        ReadonlyRootfs: true,
        AutoRemove: false, // we remove explicitly so we can capture logs first
        NetworkMode: 'bridge',
        Memory: memoryBytes,
        MemorySwap: memoryBytes, // disable swap
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
        errorCode: 'SKILL_TIMEOUT',
        message: `Docker skill timed out after ${args.timeoutMs}ms`,
        durationMs: Date.now() - start,
      };
    }
    if (exit.StatusCode !== 0) {
      return {
        ok: false,
        errorCode: 'SKILL_INTERNAL',
        message: `Container exited ${exit.StatusCode}: ${text.slice(0, 4096)}`,
        durationMs: Date.now() - start,
      };
    }
    // Skills write their output JSON to stdout's last line.
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    const lastLine = lines[lines.length - 1] ?? '{}';
    let output: Record<string, unknown>;
    try {
      output = JSON.parse(lastLine) as Record<string, unknown>;
    } catch {
      output = { stdout: text };
    }
    return { ok: true, output, durationMs: Date.now() - start };
  } catch (err) {
    if (err instanceof AgentisError) throw err;
    return {
      ok: false,
      errorCode: 'SKILL_INTERNAL',
      message: (err as Error).message,
      durationMs: Date.now() - start,
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
