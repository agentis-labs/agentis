/**
 * ConversationSummaryService — long-horizon per-conversation memory (G4).
 * Covers: deterministic fallback, model path, throttling, window no-op, injection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import {
  ConversationSummaryService,
  CONVERSATION_SUMMARY_RESUMMARIZE_EVERY,
  type SummaryMessage,
} from '../../src/services/conversationSummaryService.js';
import type { StructuredCompleter } from '../../src/services/structuredCompleter.js';

function seedConversation(ctx: TestContext): string {
  const agentId = randomUUID();
  ctx.db.insert(schema.agents).values({
    id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name: 'A', adapterType: 'http',
  }).run();
  const convId = randomUUID();
  ctx.db.insert(schema.conversations).values({
    id: convId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
  }).run();
  return convId;
}

function thread(n: number): SummaryMessage[] {
  const out: SummaryMessage[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ role: 'user', content: `customer line ${i}` });
    out.push({ role: 'assistant', content: `agent line ${i}` });
  }
  return out;
}

describe('ConversationSummaryService', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('no-op when the whole thread fits inside the window', async () => {
    const svc = new ConversationSummaryService({ db: ctx.db, logger: ctx.logger });
    const convId = seedConversation(ctx);
    const row = await svc.maybeUpdate({
      conversationId: convId, workspaceId: ctx.workspace.id, messages: thread(5), windowSize: 20,
    });
    expect(row).toBeNull();
    expect(svc.current(convId)).toBeNull();
    expect(svc.injectionBlock(convId)).toBeNull();
  });

  it('deterministic fallback folds out-of-window turns and injects a block', async () => {
    const svc = new ConversationSummaryService({ db: ctx.db, logger: ctx.logger });
    const convId = seedConversation(ctx);
    // 60 messages, window 20 → 40 out of window. No completer → deterministic.
    const row = await svc.maybeUpdate({
      conversationId: convId, workspaceId: ctx.workspace.id, messages: thread(30), windowSize: 20,
    });
    expect(row?.source).toBe('deterministic');
    expect(row?.coveredCount).toBe(40);
    const block = svc.injectionBlock(convId);
    expect(block).toMatch(/CONVERSATION MEMORY/);
    expect(block).toMatch(/beyond the recent window/);
  });

  it('uses the model when a structured completer returns a summary', async () => {
    const svc = new ConversationSummaryService({ db: ctx.db, logger: ctx.logger });
    const convId = seedConversation(ctx);
    const completer: StructuredCompleter = {
      label: 'fake',
      lastError: null,
      async completeStructured() { return { summary: 'Contact wants a 7500 budget; deal pending.' } as never; },
    };
    const row = await svc.maybeUpdate({
      conversationId: convId, workspaceId: ctx.workspace.id, messages: thread(30), windowSize: 20, completer,
    });
    expect(row?.source).toBe('model');
    expect(row?.summary).toContain('7500');
  });

  it('falls back to deterministic when the model returns nothing', async () => {
    const svc = new ConversationSummaryService({ db: ctx.db, logger: ctx.logger });
    const convId = seedConversation(ctx);
    const completer: StructuredCompleter = {
      label: 'empty', lastError: 'no content',
      async completeStructured() { return null; },
    };
    const row = await svc.maybeUpdate({
      conversationId: convId, workspaceId: ctx.workspace.id, messages: thread(30), windowSize: 20, completer,
    });
    expect(row?.source).toBe('deterministic');
  });

  it('throttles re-summarization until enough new out-of-window turns accrue', async () => {
    const svc = new ConversationSummaryService({ db: ctx.db, logger: ctx.logger });
    const convId = seedConversation(ctx);
    const flat = (n: number): SummaryMessage[] =>
      Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `line ${i}` }));
    const WINDOW = 20;
    // First pass: 42 messages → 22 out of window.
    const first = await svc.maybeUpdate({
      conversationId: convId, workspaceId: ctx.workspace.id, messages: flat(42), windowSize: WINDOW,
    });
    expect(first?.coveredCount).toBe(22);
    // Add fewer than RESUMMARIZE_EVERY new out-of-window turns → no re-summarize.
    const justUnder = WINDOW + 22 + (CONVERSATION_SUMMARY_RESUMMARIZE_EVERY - 1);
    const second = await svc.maybeUpdate({
      conversationId: convId, workspaceId: ctx.workspace.id, messages: flat(justUnder), windowSize: WINDOW,
    });
    expect(second?.coveredCount).toBe(22); // unchanged — throttled
    // Cross the threshold → re-summarize, coveredCount advances.
    const third = await svc.maybeUpdate({
      conversationId: convId, workspaceId: ctx.workspace.id, messages: flat(80), windowSize: WINDOW,
    });
    expect(third?.coveredCount).toBe(60);
  });
});
