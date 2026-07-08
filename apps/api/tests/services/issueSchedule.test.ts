/**
 * Scheduled backlog — IssueService.sweepDue dispatches issues whose
 * scheduledFor has arrived to their assigned agent, and reschedules recurring
 * ones. The agent dispatch reuses the AdapterManager (no workflow row needed).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { IssueService, nextCronOccurrence } from '../../src/services/issues.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });

function seedAgent(): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Scout',
    role: 'worker',
    status: 'available',
    adapterType: 'mock',
    capabilityTags: [],
  } as typeof schema.agents.$inferInsert).run();
  return id;
}

function makeService(dispatchTask: ReturnType<typeof vi.fn>) {
  const adapters = {
    get: () => ({ adapter: {} }),
    dispatchTask,
  } as unknown as ConstructorParameters<typeof IssueService>[0]['adapters'];
  return new IssueService({
    db: ctx.db,
    bus: ctx.bus,
    engine: {} as never,
    ledger: {} as never,
    conversations: {} as never,
    adapters,
    logger: { warn() {}, info() {}, error() {}, debug() {} } as never,
  });
}

describe('IssueService.sweepDue', () => {
  it('dispatches a due agent-assigned issue and clears its schedule', async () => {
    const dispatchTask = vi.fn().mockResolvedValue(undefined);
    const issues = makeService(dispatchTask);
    const agentId = seedAgent();
    const past = new Date(Date.now() - 60_000).toISOString();
    const issue = issues.create({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      title: 'Morning digest',
      assigneeAgentId: agentId,
      status: 'todo',
      scheduledFor: past,
    });

    const fired = await issues.sweepDue(new Date());
    expect(fired).toBe(1);
    expect(dispatchTask).toHaveBeenCalledTimes(1);
    const after = issues.get(ctx.workspace.id, issue.id);
    expect(after?.scheduledFor).toBeNull();
    // One-shot agent task → moves to history (done) so it doesn't linger.
    expect(after?.status).toBe('done');
  });

  it('reschedules a recurring issue to the next cron occurrence', async () => {
    const issues = makeService(vi.fn().mockResolvedValue(undefined));
    const agentId = seedAgent();
    const past = new Date(Date.now() - 60_000).toISOString();
    const issue = issues.create({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      title: 'Hourly check',
      assigneeAgentId: agentId,
      status: 'todo',
      scheduledFor: past,
      recurrenceCron: '0 * * * *',
    });

    await issues.sweepDue(new Date());
    const after = issues.get(ctx.workspace.id, issue.id);
    expect(after?.scheduledFor).toBeTruthy();
    expect(new Date(after!.scheduledFor!).getTime()).toBeGreaterThan(Date.now());
    // Recurring tasks return to todo for the next run, not done.
    expect(after?.status).toBe('todo');
  });

  it('does not fire issues whose schedule is still in the future', async () => {
    const dispatchTask = vi.fn();
    const issues = makeService(dispatchTask);
    const agentId = seedAgent();
    issues.create({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      title: 'Later',
      assigneeAgentId: agentId,
      status: 'todo',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(await issues.sweepDue(new Date())).toBe(0);
    expect(dispatchTask).not.toHaveBeenCalled();
  });
});

describe('nextCronOccurrence', () => {
  it('computes the next daily 9am occurrence', () => {
    const from = new Date('2026-06-24T10:00:00.000Z');
    const next = nextCronOccurrence('0 9 * * *', from);
    expect(next).toBe('2026-06-25T09:00:00.000Z');
  });

  it('computes the next hourly occurrence', () => {
    const from = new Date('2026-06-24T10:15:00.000Z');
    expect(nextCronOccurrence('0 * * * *', from)).toBe('2026-06-24T11:00:00.000Z');
  });

  it('returns null for an unparseable expression', () => {
    expect(nextCronOccurrence('not a cron', new Date())).toBeNull();
  });
});
