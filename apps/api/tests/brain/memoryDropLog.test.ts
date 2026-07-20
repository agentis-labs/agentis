/**
 * §B7 — memory that never formed must leave a trace with its reason.
 *
 * Before this, ~40 drop sites returned null/continue with no log, no event and
 * no user signal, so an empty canvas was indistinguishable from an agent that
 * had learned nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { MemoryDropLog } from '../../src/services/brain/memoryDropLog.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

const events = () => ctx.db.select().from(schema.brainQualityEvents).all()
  .filter((row) => row.eventType === 'memory_dropped');

describe('MemoryDropLog', () => {
  it('records the gate and the text so the loss is explainable', () => {
    new MemoryDropLog(ctx.db, ctx.logger).record({
      workspaceId: ctx.workspace.id,
      gate: 'below_score',
      text: 'The staging cluster runs an older Postgres than prod',
      detail: 'no candidate cleared extraction',
    });

    const [row] = events();
    expect(row).toBeDefined();
    const meta = row!.metadata as { gate: string; text: string; detail: string };
    expect(meta.gate).toBe('below_score');
    expect(meta.text).toMatch(/older Postgres/);
    expect(meta.detail).toBe('no candidate cleared extraction');
  });

  it('never persists text that was dropped for looking sensitive', () => {
    // Storing the secret in order to explain why the secret wasn't stored
    // would defeat the gate entirely.
    new MemoryDropLog(ctx.db, ctx.logger).record({
      workspaceId: ctx.workspace.id,
      gate: 'sensitive',
      text: 'my password is hunter2',
    });

    const meta = events()[0]!.metadata as { text: string | null };
    expect(meta.text).toBeNull();
  });

  it('samples repeats instead of flooding on a busy channel', () => {
    const log = new MemoryDropLog(ctx.db, ctx.logger);
    for (let i = 0; i < 200; i += 1) {
      log.record({ workspaceId: ctx.workspace.id, gate: 'question', text: `q ${i}` });
    }
    // Bounded rows, but the true total is still reported.
    expect(events().length).toBeLessThanOrEqual(25);
    expect(log.counts().question).toBe(200);
  });

  it('counts every gate it saw', () => {
    const log = new MemoryDropLog(ctx.db, ctx.logger);
    log.record({ workspaceId: ctx.workspace.id, gate: 'task_command', text: 'send the report' });
    log.record({ workspaceId: ctx.workspace.id, gate: 'task_command', text: 'deploy staging' });
    log.record({ workspaceId: ctx.workspace.id, gate: 'rejectable', text: 'https://example.com' });

    expect(log.counts()).toEqual({ task_command: 2, rejectable: 1 });
  });

  it('never throws out of the write path it is observing', () => {
    const broken = { insert: () => { throw new Error('db gone'); } } as never;
    expect(() => new MemoryDropLog(broken, ctx.logger).record({
      workspaceId: ctx.workspace.id,
      gate: 'empty',
    })).not.toThrow();
  });
});
