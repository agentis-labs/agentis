/**
 * DeploySupervisor — keeps `always_on` apps running (AGENTIS-PLATFORM-10X §Layer 5).
 *
 * Verifies the restart-policy decision matrix: `always` restarts whenever idle,
 * `on_failure` restarts only after a FAILED run, `never` never restarts, and an
 * app with an active run is left alone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { DeploySupervisor } from '../../src/services/deploySupervisor.js';
import type { TriggerRuntime } from '../../src/engine/TriggerRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

interface Started {
  workflowId: string;
}

function makeSupervisor() {
  const started: Started[] = [];
  const triggerRuntime = {
    startWorkflowRun: async (args: { workflowId: string }) => {
      started.push({ workflowId: args.workflowId });
      return { runId: randomUUID(), queued: false };
    },
  } as unknown as TriggerRuntime;
  const supervisor = new DeploySupervisor({ db: ctx.db, triggerRuntime, logger: ctx.logger });
  return { supervisor, started };
}

async function seedApp(opts: {
  restartPolicy?: 'always' | 'on_failure' | 'never';
  lastRunStatus?: 'COMPLETED' | 'FAILED' | 'RUNNING';
}): Promise<string> {
  const wfId = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({
      id: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'entry-wf',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      settings: {},
    })
    .run();
  const appId = randomUUID();
  ctx.db
    .insert(schema.appInstances)
    .values({
      id: appId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      slug: `app-${appId.slice(0, 8)}`,
      name: 'Always-on app',
      version: '1.0.0',
      status: 'active',
      entryWorkflowId: wfId,
      deployTarget: 'always_on',
      packageContents: opts.restartPolicy
        ? { deployConfig: { target: 'always_on', restartPolicy: opts.restartPolicy } }
        : {},
    })
    .run();
  if (opts.lastRunStatus) {
    ctx.db
      .insert(schema.workflowRuns)
      .values({
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        workflowId: wfId,
        userId: ctx.user.id,
        status: opts.lastRunStatus,
        runState: {},
      })
      .run();
  }
  return wfId;
}

describe('DeploySupervisor', () => {
  it('restarts an idle app under the `always` policy', async () => {
    ctx = await createTestContext();
    const wfId = await seedApp({ restartPolicy: 'always', lastRunStatus: 'COMPLETED' });
    const { supervisor, started } = makeSupervisor();
    await supervisor.tick();
    expect(started.map((s) => s.workflowId)).toContain(wfId);
  });

  it('does not restart a COMPLETED app under `on_failure`', async () => {
    ctx = await createTestContext();
    await seedApp({ restartPolicy: 'on_failure', lastRunStatus: 'COMPLETED' });
    const { supervisor, started } = makeSupervisor();
    await supervisor.tick();
    expect(started).toHaveLength(0);
  });

  it('restarts a FAILED app under `on_failure`', async () => {
    ctx = await createTestContext();
    const wfId = await seedApp({ restartPolicy: 'on_failure', lastRunStatus: 'FAILED' });
    const { supervisor, started } = makeSupervisor();
    await supervisor.tick();
    expect(started.map((s) => s.workflowId)).toContain(wfId);
  });

  it('never restarts under the `never` policy', async () => {
    ctx = await createTestContext();
    await seedApp({ restartPolicy: 'never', lastRunStatus: 'FAILED' });
    const { supervisor, started } = makeSupervisor();
    await supervisor.tick();
    expect(started).toHaveLength(0);
  });

  it('leaves an app with an active run alone', async () => {
    ctx = await createTestContext();
    await seedApp({ restartPolicy: 'always', lastRunStatus: 'RUNNING' });
    const { supervisor, started } = makeSupervisor();
    await supervisor.tick();
    expect(started).toHaveLength(0);
  });
});
