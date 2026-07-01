/**
 * agentis.extension.test — run an installed extension operation with sample inputs
 * in the sandbox and return { ok, output, producedKeys }. This closes the build
 * loop for EXTENSIONS (the analogue of agentis.workflow.dry_run for graphs): an
 * agent can prove an extension_task node will emit what the next node reads BEFORE
 * wiring it in. Built on ExtensionRuntime from db+logger — no DI/bootstrap wiring.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceVolumeService } from '../../src/services/workspaceVolume.js';
import { ExtensionLibraryService } from '../../src/services/extensionLibrary.js';
import { registerCapabilityTools } from '../../src/services/agentisToolHandlers/capability.js';
import type { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

type Handler = (args: Record<string, unknown>, ctx: { workspaceId: string }) => Promise<unknown>;

let ctx: TestContext;
let dataDir: string;

beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-ext-test-'));
});
afterEach(async () => {
  ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Pull the extension.test tool's handler out of a minimal capturing registry. */
function extensionTestHandler(): Handler {
  const volume = new WorkspaceVolumeService(dataDir);
  const library = new ExtensionLibraryService(volume, ctx.db);
  const deps = { db: ctx.db, logger: ctx.logger, extensionLibrary: library } as unknown as ToolHandlerDeps;
  let captured: Handler | undefined;
  const registry = {
    register: (def: { id: string }, handler: Handler) => { if (def.id === 'agentis.extension.test') captured = handler; },
  } as unknown as AgentisToolRegistry;
  registerCapabilityTools(registry, deps);
  if (!captured) throw new Error('agentis.extension.test was not registered');
  return captured;
}

async function installScout(): Promise<string> {
  const volume = new WorkspaceVolumeService(dataDir);
  const library = new ExtensionLibraryService(volume, ctx.db);
  const created = await library.createNodeWorkerExtension(
    { workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id },
    {
      name: 'Store Scout',
      source: 'export async function scout(inputs, ctx) { return { candidates: inputs.seed ? [inputs.seed] : [], exhausted: false }; }',
      operations: [{ name: 'scout', inputSchema: {}, outputSchema: {} }],
    },
  );
  return created.id;
}

describe('agentis.extension.test tool', () => {
  it('runs an installed node_worker operation with sample inputs and returns its REAL output', async () => {
    const extensionId = await installScout();
    const handler = extensionTestHandler();
    const result = await handler(
      { extensionId, operationName: 'scout', input: { seed: 'lojazys' } },
      { workspaceId: ctx.workspace.id },
    ) as { ok: boolean; output?: Record<string, unknown>; producedKeys?: string[] };

    // The operation actually executed in the sandbox — its output is returned, so
    // the agent can see that `candidates` (what a downstream scorer reads) is real.
    expect(result.ok).toBe(true);
    expect(result.output?.candidates).toEqual(['lojazys']);
    expect(result.producedKeys).toContain('candidates');
  });

  it('surfaces a clear error for an operation the extension does not declare', async () => {
    const extensionId = await installScout();
    const handler = extensionTestHandler();
    await expect(
      handler({ extensionId, operationName: 'does-not-exist', input: {} }, { workspaceId: ctx.workspace.id }),
    ).rejects.toThrow(/operation/i);
  });
});
