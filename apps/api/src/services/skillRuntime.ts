/**
 * Skill runtime — three trust tiers.
 *
 * V1 ships with `builtin` fully implemented and `node_worker` /
 * `docker_sandbox` scaffolded but gated. The dashboard surfaces the runtime
 * tier on every skill row so the operator always knows the trust level.
 *
 * Trust rules (V1-SPEC §9):
 *  - builtin: in-process, fully trusted, ships with the agentis package.
 *  - node_worker: isolated-vm sandbox; lazy-loaded so absent native module
 *    on a host doesn't kill startup.
 *  - docker_sandbox: requires Docker daemon; registry-installed skills are pinned
 *    to this tier and cannot be downgraded by the operator.
 *
 * The builtin registry is closed: we only register the executors below.
 * Operator-installed builtin skills are not allowed; that is precisely the
 * trust property docker_sandbox exists to enforce.
 */

import { eq } from 'drizzle-orm';
import { CONSTANTS, AgentisError } from '@agentis/core';
import type { SkillManifest, SkillExecutionOutcome } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import { runBuiltin } from './builtinSkills.js';
import { runNodeWorkerSkill } from '../skills/nodeWorkerRuntime.js';
import { runDockerSandboxSkill } from '../skills/dockerSandboxRuntime.js';

export interface SkillExecuteArgs {
  workspaceId: string;
  skillId: string;
  runId?: string;
  taskId?: string;
  input: Record<string, unknown>;
  scratchpadSnapshot: Record<string, unknown>;
}

export class SkillRuntime {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
    private readonly options: { dockerEnabled: boolean },
  ) {}

  async execute(args: SkillExecuteArgs): Promise<SkillExecutionOutcome> {
    const skill = this.db
      .select()
      .from(schema.skills)
      .where(eq(schema.skills.id, args.skillId))
      .get();
    if (!skill || skill.workspaceId !== args.workspaceId) {
      throw new AgentisError('SKILL_NOT_FOUND', `Skill ${args.skillId} not found`);
    }
    const manifest = skill.manifest as SkillManifest;
    const startedAt = Date.now();
    const timeoutMs = clampTimeout(manifest.timeoutMs);

    let outcome: SkillExecutionOutcome;
    try {
      switch (manifest.runtime) {
        case 'builtin':
          outcome = await withTimeout(
            runBuiltin(manifest, args.input, args.scratchpadSnapshot),
            timeoutMs,
          );
          break;
        case 'node_worker': {
          const source =
            typeof manifest.source === 'string' ? manifest.source : '';
          if (!source) {
            outcome = {
              ok: false,
              errorCode: 'VALIDATION_FAILED',
              message: 'node_worker skill manifest is missing inline `source` field',
              durationMs: Date.now() - startedAt,
            };
            break;
          }
          outcome = await runNodeWorkerSkill({
            manifest,
            source,
            input: args.input,
            scratchpad: args.scratchpadSnapshot,
            allowedDomains: Array.isArray(manifest.allowedDomains) ? manifest.allowedDomains : [],
            allowPrivateNetwork:
              String(process.env.AGENTIS_SKILL_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
            timeoutMs,
            logger: this.logger,
          });
          break;
        }
        case 'docker_sandbox':
          if (!this.options.dockerEnabled) {
            outcome = {
              ok: false,
              errorCode: 'SKILL_DOCKER_UNAVAILABLE',
              message: 'Docker is not enabled on this host (set AGENTIS_SKILL_DOCKER=true)',
              durationMs: Date.now() - startedAt,
            };
          } else {
            const bundleDir = typeof manifest.bundleDir === 'string' ? manifest.bundleDir : '';
            if (!bundleDir) {
              outcome = {
                ok: false,
                errorCode: 'VALIDATION_FAILED',
                message: 'docker_sandbox skill manifest is missing `bundleDir`',
                durationMs: Date.now() - startedAt,
              };
              break;
            }
            outcome = await runDockerSandboxSkill({
              manifest,
              bundleDir,
              input: args.input,
              scratchpad: args.scratchpadSnapshot,
              allowedDomains: Array.isArray(manifest.allowedDomains) ? manifest.allowedDomains : [],
              timeoutMs,
              logger: this.logger,
            });
          }
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message === '__TIMEOUT__';
      outcome = {
        ok: false,
        errorCode: isTimeout ? 'SKILL_TIMEOUT' : 'SKILL_INTERNAL',
        message: isTimeout ? `Skill timed out after ${timeoutMs}ms` : message,
        durationMs: Date.now() - startedAt,
      };
    }

    // Persist execution row regardless of outcome.
    try {
      this.db
        .insert(schema.skillExecutions)
        .values({
          id: crypto.randomUUID(),
          workspaceId: args.workspaceId,
          skillId: args.skillId,
          runId: args.runId ?? null,
          taskId: args.taskId ?? null,
          status: outcome.ok ? 'completed' : 'failed',
          durationMs: outcome.durationMs,
          errorCode: outcome.ok ? null : outcome.errorCode,
          errorMessage: outcome.ok ? null : outcome.message,
          startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date().toISOString(),
        })
        .run();
    } catch (err) {
      this.logger.warn('skill.execution.persist_failed', {
        skillId: args.skillId,
        err: (err as Error).message,
      });
    }

    return outcome;
  }
}

function clampTimeout(requested?: number): number {
  const max = CONSTANTS.SKILL_EXECUTION_MAX_TIMEOUT_MS;
  if (!requested || requested <= 0) return CONSTANTS.SKILL_EXECUTION_TIMEOUT_MS;
  return Math.min(requested, max);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('__TIMEOUT__')), ms).unref?.(),
    ),
  ]);
}
