/**
 * ExtensionRuntime - deterministic Extension execution.
 *
 * Covers builtin execution, operation lookup, workspace scoping, validation
 * failures, Docker disabled behavior, and execution ledger persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(() => ctx.close());

function seedExtension(opts: {
  runtime: 'builtin' | 'node_worker' | 'docker_sandbox';
  entrypoint?: string;
  source?: string;
  bundleDir?: string;
  timeoutMs?: number;
  operations?: Array<{ name: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> }>;
}) {
  const id = randomUUID();
  const slug = `slug-${id.slice(0, 6)}`;
  const operations = opts.operations ?? [{ name: 'execute', inputSchema: {}, outputSchema: {} }];
  ctx.db
    .insert(schema.extensions)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      packageId: null,
      name: opts.entrypoint ?? 'extension',
      slug,
      version: '1.0.0',
      runtime: opts.runtime,
      manifest: {
        name: opts.entrypoint ?? 'extension',
        slug,
        version: '1.0.0',
        runtime: opts.runtime,
        entrypoint: opts.entrypoint,
        source: opts.source,
        bundleDir: opts.bundleDir,
        timeoutMs: opts.timeoutMs ?? 5_000,
        operations,
        capabilityTags: [],
        permissions: [],
      },
    })
    .run();
  return id;
}

describe('ExtensionRuntime - builtin', () => {
  it('echo passes input through and records execution', async () => {
    const extensionId = seedExtension({ runtime: 'builtin', entrypoint: 'echo' });
    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    const out = await svc.execute({
      workspaceId: ctx.workspace.id,
      extensionId,
      operationName: 'execute',
      input: { hello: 'world', n: 42 },
      scratchpadSnapshot: {},
    });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.output).toEqual({ hello: 'world', n: 42 });
      expect(out.operationName).toBe('execute');
    }

    const rows = ctx.db
      .select()
      .from(schema.extensionExecutions)
      .where(eq(schema.extensionExecutions.extensionId, extensionId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('completed');
    expect(rows[0]!.operationName).toBe('execute');
  });

  it('http_fetch with a private URL is blocked by the SSRF guard', async () => {
    const extensionId = seedExtension({ runtime: 'builtin', entrypoint: 'http_fetch' });
    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    delete process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE;

    const out = await svc.execute({
      workspaceId: ctx.workspace.id,
      extensionId,
      operationName: 'execute',
      input: { url: 'http://127.0.0.1:9/forbidden' },
      scratchpadSnapshot: {},
    });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errorCode).toBe('EXTENSION_INTERNAL');

    const row = ctx.db
      .select()
      .from(schema.extensionExecutions)
      .where(eq(schema.extensionExecutions.extensionId, extensionId))
      .get()!;
    expect(row.status).toBe('failed');
  });

  it('http_fetch with missing url surfaces an error', async () => {
    const extensionId = seedExtension({ runtime: 'builtin', entrypoint: 'http_fetch' });
    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    const out = await svc.execute({
      workspaceId: ctx.workspace.id,
      extensionId,
      operationName: 'execute',
      input: {},
      scratchpadSnapshot: {},
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errorCode).toBe('EXTENSION_INTERNAL');
  });
});

describe('ExtensionRuntime - failure modes', () => {
  it('throws EXTENSION_NOT_FOUND for an unknown extensionId', async () => {
    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    await expect(
      svc.execute({
        workspaceId: ctx.workspace.id,
        extensionId: randomUUID(),
        operationName: 'execute',
        input: {},
        scratchpadSnapshot: {},
      }),
    ).rejects.toMatchObject({ code: 'EXTENSION_NOT_FOUND' });
  });

  it('rejects extensions owned by a different workspace', async () => {
    const extensionId = seedExtension({ runtime: 'builtin', entrypoint: 'echo' });
    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    await expect(
      svc.execute({
        workspaceId: 'someone-else',
        extensionId,
        operationName: 'execute',
        input: {},
        scratchpadSnapshot: {},
      }),
    ).rejects.toThrow(AgentisError);
  });

  it('rejects unknown operations before dispatch', async () => {
    const extensionId = seedExtension({ runtime: 'builtin', entrypoint: 'echo' });
    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    await expect(
      svc.execute({
        workspaceId: ctx.workspace.id,
        extensionId,
        operationName: 'missing_operation',
        input: {},
        scratchpadSnapshot: {},
      }),
    ).rejects.toMatchObject({ code: 'EXTENSION_OPERATION_NOT_FOUND' });
  });

  it('node_worker without inline source returns VALIDATION_FAILED', async () => {
    const extensionId = seedExtension({ runtime: 'node_worker' });
    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    const out = await svc.execute({
      workspaceId: ctx.workspace.id,
      extensionId,
      operationName: 'execute',
      input: {},
      scratchpadSnapshot: {},
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errorCode).toBe('VALIDATION_FAILED');
  });

  it('docker_sandbox returns EXTENSION_DOCKER_UNAVAILABLE when dockerEnabled=false', async () => {
    const extensionId = seedExtension({ runtime: 'docker_sandbox', bundleDir: '/tmp/x' });
    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    const out = await svc.execute({
      workspaceId: ctx.workspace.id,
      extensionId,
      operationName: 'execute',
      input: {},
      scratchpadSnapshot: {},
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errorCode).toBe('EXTENSION_DOCKER_UNAVAILABLE');
  });
});
