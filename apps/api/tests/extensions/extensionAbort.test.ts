/**
 * Run-scoped cancellation for extensions: an aborted run settles the
 * extension execution with an honest EXTENSION_ABORTED outcome instead of
 * running (or waiting on) the sandbox.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ExtensionManifest } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

function seedExtension(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const manifest: ExtensionManifest = {
    name: 'Aborted Ext',
    slug: 'aborted-ext',
    version: '1.0.0',
    runtime: 'node_worker',
    source: 'async function execute(inputs, ctx) { return { done: true }; }',
    operations: [{ name: 'execute', inputSchema: {}, outputSchema: {} }],
    capabilityTags: [],
    permissions: [],
  };
  ctx.db.insert(schema.extensions).values({
    id, workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id, packageId: null,
    name: manifest.name, slug: manifest.slug, version: manifest.version,
    runtime: manifest.runtime, manifest, createdAt: now, updatedAt: now,
  }).run();
  return id;
}

describe('ExtensionRuntime — run-scoped cancellation', () => {
  it('an already-aborted signal settles with EXTENSION_ABORTED without running the sandbox', async () => {
    const extensionId = seedExtension();
    const runtime = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    const controller = new AbortController();
    controller.abort();

    const outcome = await runtime.execute({
      workspaceId: ctx.workspace.id,
      extensionId,
      operationName: 'execute',
      input: {},
      scratchpadSnapshot: {},
      signal: controller.signal,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe('EXTENSION_ABORTED');
      expect(outcome.message).toMatch(/cancelled/i);
    }
  });

  it('no signal → unchanged behavior (executes or fails on runtime availability, never ABORTED)', async () => {
    const extensionId = seedExtension();
    const runtime = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false });
    const outcome = await runtime.execute({
      workspaceId: ctx.workspace.id,
      extensionId,
      operationName: 'execute',
      input: {},
      scratchpadSnapshot: {},
    });
    if (!outcome.ok) {
      expect(outcome.errorCode).not.toBe('EXTENSION_ABORTED');
    } else {
      expect(outcome.output).toEqual({ done: true });
    }
  });
});
