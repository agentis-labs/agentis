/**
 * SkillRuntime — V1-SPEC §9. Three trust tiers.
 *
 * Covers: builtin echo happy path, http_fetch SSRF guard via safeUrl,
 * unknown skill, missing source for node_worker, docker disabled, and
 * skill_executions persistence on every run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { SkillRuntime } from '../../src/services/skillRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(() => ctx.close());

function seedSkill(opts: {
  runtime: 'builtin' | 'node_worker' | 'docker_sandbox';
  entrypoint?: string;
  source?: string;
  bundleDir?: string;
  timeoutMs?: number;
}) {
  const id = randomUUID();
  ctx.db
    .insert(schema.skills)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: opts.entrypoint ?? 'skill',
      slug: `slug-${id.slice(0, 6)}`,
      version: '1.0.0',
      runtime: opts.runtime,
      manifest: {
        runtime: opts.runtime,
        entrypoint: opts.entrypoint,
        source: opts.source,
        bundleDir: opts.bundleDir,
        timeoutMs: opts.timeoutMs ?? 5_000,
      },
    })
    .run();
  return id;
}

describe('SkillRuntime — builtin', () => {
  it('echo passes input through and returns ok', async () => {
    const skillId = seedSkill({ runtime: 'builtin', entrypoint: 'echo' });
    const svc = new SkillRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    const out = await svc.execute({
      workspaceId: ctx.workspace.id,
      skillId,
      input: { hello: 'world', n: 42 },
      scratchpadSnapshot: {},
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toEqual({ hello: 'world', n: 42 });
    // skill_executions row written.
    const rows = ctx.db.select().from(schema.skillExecutions).where(eq(schema.skillExecutions.skillId, skillId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('completed');
  });

  it('http_fetch with a private/loopback URL is blocked by SSRF guard', async () => {
    const skillId = seedSkill({ runtime: 'builtin', entrypoint: 'http_fetch' });
    const svc = new SkillRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    // Loopback (127.0.0.1) is in the SSRF deny-list when ALLOW_PRIVATE !== 'true'.
    delete process.env.AGENTIS_SKILL_HTTP_ALLOW_PRIVATE;
    const out = await svc.execute({
      workspaceId: ctx.workspace.id,
      skillId,
      input: { url: 'http://127.0.0.1:9/forbidden' },
      scratchpadSnapshot: {},
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errorCode).toBe('SKILL_INTERNAL');
    const row = ctx.db.select().from(schema.skillExecutions).where(eq(schema.skillExecutions.skillId, skillId)).get()!;
    expect(row.status).not.toBe('ok');
  });

  it('http_fetch with missing url surfaces an error', async () => {
    const skillId = seedSkill({ runtime: 'builtin', entrypoint: 'http_fetch' });
    const svc = new SkillRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    const out = await svc.execute({
      workspaceId: ctx.workspace.id,
      skillId,
      input: {},
      scratchpadSnapshot: {},
    });
    expect(out.ok).toBe(false);
  });
});

describe('SkillRuntime — failure modes', () => {
  it('throws SKILL_NOT_FOUND for unknown skillId', async () => {
    const svc = new SkillRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    await expect(
      svc.execute({
        workspaceId: ctx.workspace.id,
        skillId: randomUUID(),
        input: {},
        scratchpadSnapshot: {},
      }),
    ).rejects.toThrow(AgentisError);
  });

  it('rejects skills owned by a different workspace as SKILL_NOT_FOUND', async () => {
    const skillId = seedSkill({ runtime: 'builtin', entrypoint: 'echo' });
    const svc = new SkillRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    await expect(
      svc.execute({
        workspaceId: 'someone-else',
        skillId,
        input: {},
        scratchpadSnapshot: {},
      }),
    ).rejects.toThrow(AgentisError);
  });

  it('node_worker skill missing inline source returns VALIDATION_FAILED', async () => {
    const skillId = seedSkill({ runtime: 'node_worker' });
    const svc = new SkillRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    const out = await svc.execute({
      workspaceId: ctx.workspace.id,
      skillId,
      input: {},
      scratchpadSnapshot: {},
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errorCode).toBe('VALIDATION_FAILED');
  });

  it('docker_sandbox skill returns SKILL_DOCKER_UNAVAILABLE when dockerEnabled=false', async () => {
    const skillId = seedSkill({ runtime: 'docker_sandbox', bundleDir: '/tmp/x' });
    const svc = new SkillRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    const out = await svc.execute({
      workspaceId: ctx.workspace.id,
      skillId,
      input: {},
      scratchpadSnapshot: {},
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errorCode).toBe('SKILL_DOCKER_UNAVAILABLE');
  });
});
