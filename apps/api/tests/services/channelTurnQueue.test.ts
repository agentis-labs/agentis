/**
 * ChannelTurnQueue — durable, restart-safe inbound channel turns (Living Apps
 * Phase 5 / G2).
 *
 * Proves the durable-queue core:
 *   - enqueue persists a pending row (and is idempotent on the inbound message id)
 *   - the worker drains a pending row, runs the turn exactly once, marks it done
 *   - a turn that crashes mid-flight (runner throws) is retried, not duplicated
 *   - a row left `processing` by a crash is reclaimed on startup (resume)
 *   - the dispatcher routes dispatch() → enqueue when a queue is wired
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentAdapter, ChatDelta } from '@agentis/core';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { ChannelTurnQueue, type ChannelTurnRunner } from '../../src/services/conversation/channelTurnQueue.js';
import { ChannelTurnDispatcher, type ChannelTurnInput } from '../../src/services/conversation/channelTurnDispatcher.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';

function seedAgent(ctx: TestContext): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Orchestrator',
    adapterType: 'http',
  }).run();
  return id;
}

function chatStub(reply: string): AgentAdapter {
  return {
    capabilities: () => ({ interactiveChat: true }),
    async *chat(): AsyncIterable<ChatDelta> {
      yield { type: 'text', delta: reply };
      yield { type: 'done', finishReason: 'stop' };
    },
  } as unknown as AgentAdapter;
}

describe('ChannelTurnQueue', () => {
  let ctx: TestContext;
  let conversations: ConversationStore;
  let agentId: string;
  let conversationId: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    agentId = seedAgent(ctx);
    conversationId = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    }).id;
  });
  afterEach(() => ctx.close());

  function input(overrides: Partial<ChannelTurnInput> = {}): ChannelTurnInput {
    return {
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      conversationId,
      connectionId: 'conn-1',
      kind: 'telegram',
      chatId: '999',
      text: 'hi',
      inboundMessageId: `msg-${randomUUID()}`,
      ...overrides,
    };
  }

  it('enqueue persists a pending row', () => {
    const queue = new ChannelTurnQueue({ db: ctx.db, logger: ctx.logger });
    const id = queue.enqueue(input());
    expect(id).toBeTruthy();
    const row = ctx.db.select().from(schema.channelTurnQueue).where(eq(schema.channelTurnQueue.id, id!)).get();
    expect(row?.status).toBe('pending');
    expect((row?.payload as { text?: string }).text).toBe('hi');
  });

  it('is idempotent on the inbound message id — a redelivered turn enqueues once', () => {
    const queue = new ChannelTurnQueue({ db: ctx.db, logger: ctx.logger });
    const msg = input();
    const first = queue.enqueue(msg);
    const second = queue.enqueue(msg); // same inboundMessageId
    expect(second).toBe(first);
    const count = ctx.db.select().from(schema.channelTurnQueue).all().length;
    expect(count).toBe(1);
  });

  it('the worker drains a pending row, runs the turn once, and marks it done', async () => {
    const runs: ChannelTurnInput[] = [];
    const runner: ChannelTurnRunner = {
      async runQueued(turn) { runs.push(turn); return { replied: true }; },
    };
    const queue = new ChannelTurnQueue({ db: ctx.db, logger: ctx.logger, runner });
    const id = queue.enqueue(input({ text: 'drain me' }))!;

    await queue.poll();

    expect(runs.length).toBe(1);
    expect(runs[0]?.text).toBe('drain me');
    expect(queue.getStatus(id)?.status).toBe('done');

    // A second poll never re-runs a done turn.
    await queue.poll();
    expect(runs.length).toBe(1);
  });

  it('a crashing turn is RETRIED, not duplicated, then parked failed', async () => {
    let attempts = 0;
    const runner: ChannelTurnRunner = {
      async runQueued() { attempts += 1; throw new Error('boom'); },
    };
    const queue = new ChannelTurnQueue({
      db: ctx.db,
      logger: ctx.logger,
      runner,
      maxAttempts: 2,
    });
    const id = queue.enqueue(input())!;

    // Attempt 1 fails → row goes back to pending with backoff in the future.
    await queue.poll();
    expect(attempts).toBe(1);
    let row = ctx.db.select().from(schema.channelTurnQueue).where(eq(schema.channelTurnQueue.id, id)).get();
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    // Backoff parks it in the future → an immediate poll does NOT re-run it.
    await queue.poll();
    expect(attempts).toBe(1);

    // Make it due again, poll → attempt 2 fails and (attempts >= maxAttempts) parks it failed.
    ctx.db.update(schema.channelTurnQueue)
      .set({ scheduledFor: new Date(Date.now() - 1000).toISOString() })
      .where(eq(schema.channelTurnQueue.id, id))
      .run();
    await queue.poll();
    expect(attempts).toBe(2);
    row = ctx.db.select().from(schema.channelTurnQueue).where(eq(schema.channelTurnQueue.id, id)).get();
    expect(row?.status).toBe('failed');
    expect(row?.failReason).toContain('boom');

    // Failed rows are terminal — never re-run.
    ctx.db.update(schema.channelTurnQueue)
      .set({ scheduledFor: new Date(Date.now() - 1000).toISOString() })
      .where(eq(schema.channelTurnQueue.id, id))
      .run();
    await queue.poll();
    expect(attempts).toBe(2);
  });

  it('resumes a turn left in-flight by a crash (expired lease → re-picked)', async () => {
    const runs: ChannelTurnInput[] = [];
    const runner: ChannelTurnRunner = {
      async runQueued(turn) { runs.push(turn); return { replied: true }; },
    };
    // Short lease so the simulated crash is "expired" immediately.
    const queue = new ChannelTurnQueue({ db: ctx.db, logger: ctx.logger, runner, leaseMs: 1 });
    const id = queue.enqueue(input({ text: 'crashed mid-turn' }))!;

    // Simulate a crash: the row was claimed (processing) but never finished, and
    // its lease is already in the past.
    ctx.db.update(schema.channelTurnQueue)
      .set({ status: 'processing', attempts: 1, leasedAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(schema.channelTurnQueue.id, id))
      .run();

    // A fresh worker's poll reclaims the expired lease and re-runs the turn.
    await queue.poll();
    expect(runs.length).toBe(1);
    expect(runs[0]?.text).toBe('crashed mid-turn');
    expect(queue.getStatus(id)?.status).toBe('done');
  });

  it('start() reclaims expired processing rows on boot and re-runs them (resume on startup)', async () => {
    const runs: ChannelTurnInput[] = [];
    const queue = new ChannelTurnQueue({
      db: ctx.db,
      logger: ctx.logger,
      runner: { async runQueued(turn) { runs.push(turn); return { replied: true }; } },
      leaseMs: 1,
    });
    const id = queue.enqueue(input({ text: 'left in-flight by a crash' }))!;
    // Simulate the prior process crashing mid-turn: row stuck `processing`, lease stale.
    ctx.db.update(schema.channelTurnQueue)
      .set({ status: 'processing', attempts: 1, leasedAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(schema.channelTurnQueue.id, id))
      .run();

    queue.start(); // reclaims the expired lease on boot, then drains
    try {
      // Give the immediate kick-drain a tick to reclaim + re-run the crashed turn.
      await new Promise((r) => setTimeout(r, 50));
      expect(runs.length).toBe(1);
      expect(runs[0]?.text).toBe('left in-flight by a crash');
      expect(queue.getStatus(id)?.status).toBe('done');
    } finally {
      queue.stop();
    }
  });

  it('dispatcher routes dispatch() → enqueue when a queue is wired (no inline run)', async () => {
    const enqueued: ChannelTurnInput[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async () => {},
      fallbackAdapter: () => chatStub('should-not-run-inline'),
    });
    dispatcher.setQueue({ enqueue: (turn) => { enqueued.push(turn); return 'q1'; } });

    const result = await dispatcher.dispatch(input({ text: 'durable please' }));
    expect(result).toEqual({ replied: false, reason: 'queued' });
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]?.text).toBe('durable please');

    // Nothing ran inline → no agent reply was persisted.
    const agentMsgs = conversations.messages(conversationId, 50).filter((m) => m.authorType === 'agent');
    expect(agentMsgs.length).toBe(0);
  });

  it('end-to-end: dispatcher enqueues, the worker drains and delivers exactly once', async () => {
    const delivered: Array<{ body: string }> = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (args) => { delivered.push({ body: args.body }); },
      fallbackAdapter: () => chatStub('Hello from the durable turn.'),
    });
    const queue = new ChannelTurnQueue({ db: ctx.db, logger: ctx.logger, runner: dispatcher });
    dispatcher.setQueue(queue);

    await dispatcher.dispatch(input({ text: 'e2e' }));
    // The turn is queued, not yet delivered.
    expect(delivered.length).toBe(0);

    await queue.poll();
    expect(delivered).toEqual([{ body: 'Hello from the durable turn.' }]);

    // Draining again never double-delivers.
    await queue.poll();
    expect(delivered.length).toBe(1);
  });
});
