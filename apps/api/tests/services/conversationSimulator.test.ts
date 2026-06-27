/**
 * ConversationSimulatorService — rehearse a multi-turn conversation against the
 * resident App agent and score the run (LIVING-APPS-10X §7 · G8).
 *
 * Proves: (a) a SCRIPTED scenario runs N turns against the real turn path (the
 * injected runner mirrors ChatSessionExecutor.turn) and produces a transcript +
 * deterministic score; (b) a GUARDRAIL violation is detected and surfaced; (c)
 * a missed expectation is reported; (d) a model-GENERATED customer drives the
 * conversation via a StructuredCompleter; (e) the run degrades cleanly with no
 * model and no scripted turns. Everything runs MODEL-FREE except (d), which uses
 * a stub completer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, ChatDelta, ChatMessage, ChatTurnContext } from '@agentis/core';
import { AppStore } from '@agentis/app';
import { schema } from '@agentis/db/sqlite';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import {
  ConversationSimulatorService,
  type SimulatorScenario,
} from '../../src/services/conversationSimulator.js';
import type { StructuredCompleter } from '../../src/services/structuredCompleter.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function seedAgent(name = 'Closer'): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({ id, workspaceId: ctx.workspace.id, userId: ctx.user.id, name, adapterType: 'http' }).run();
  return id;
}

/** A staffed App (owner agent). */
function seedApp(): { appId: string; agentId: string } {
  const agentId = seedAgent();
  const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales', ownerAgentId: agentId }).id;
  return { appId, agentId };
}

/** A chat-capable adapter stub (only `.chat`/`.capabilities` are exercised). */
function chatStub(): AgentAdapter {
  return { capabilities: () => ({ interactiveChat: true }), async *chat(): AsyncIterable<ChatDelta> { yield { type: 'done', finishReason: 'stop' }; } } as unknown as AgentAdapter;
}

/**
 * A scripted "resident agent" turn runner — drop-in for ChatSessionExecutor.turn.
 * `replyFor(userMessage, turnIndex)` decides the agent's reply per turn, so a
 * test can drive a guardrail violation, a goal hit, or a missing question.
 */
function scriptedRunner(replyFor: (userMessage: string, turn: number) => string) {
  let turn = 0;
  return (async function* (_adapter: AgentAdapter, _history: ChatMessage[], userMessage: string, _ctx: ChatTurnContext) {
    const reply = replyFor(userMessage, turn);
    turn += 1;
    yield { type: 'text', delta: reply } as ChatDelta;
    yield { type: 'done', finishReason: 'stop' } as ChatDelta;
  }) as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn;
}

const SCRIPTED_SCENARIO: SimulatorScenario = {
  name: 'Price-sensitive buyer',
  persona: { name: 'Maria', prompt: 'A first-time buyer who keeps pushing for a discount.' },
  goal: 'Book a viewing appointment',
  customerTurns: [
    'Hi, I saw your listing. Can you give me a discount?',
    "What's my budget got to do with it? Just give me a deal.",
    'Fine, can I see the place this weekend?',
  ],
  goalSignals: ['booked your viewing'],
  guardrails: [{ id: 'no_discounts', label: 'never promise a discount', pattern: /discount of|10% off|i can offer you a discount/i }],
  expectations: [{ id: 'ask_budget', label: 'ask for the budget', pattern: /budget/i }],
};

describe('ConversationSimulatorService — scripted scenario', () => {
  it('runs N turns against the resident-agent path and scores a well-behaved run', async () => {
    const { appId, agentId } = seedApp();
    const sim = new ConversationSimulatorService({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      logger: ctx.logger,
      fallbackAdapter: () => chatStub(),
      // A compliant agent: qualifies (asks budget), never discounts, books the viewing.
      runTurn: scriptedRunner((_msg, turn) => {
        if (turn === 0) return "I'd love to help. To recommend the right unit, what's your budget?";
        if (turn === 1) return 'I keep prices fair for everyone, so no discounts — but let me find the best fit for your budget.';
        return "Done — I've booked your viewing for Saturday at 2pm.";
      }),
    });

    const result = await sim.runScenario({ workspaceId: ctx.workspace.id, userId: ctx.user.id, appId, scenario: SCRIPTED_SCENARIO });

    expect(result.agentId).toBe(agentId);
    expect(result.generated).toBe(false);
    expect(result.transcript).toHaveLength(3);
    expect(result.transcript[0]?.customer).toContain('discount');
    expect(result.transcript[2]?.agent).toContain('booked your viewing');
    expect(result.score.goalReached).toBe(true);
    expect(result.score.guardrailViolations).toHaveLength(0);
    expect(result.score.missedExpectations).toHaveLength(0);
    expect(result.score.score).toBe(1);
    expect(result.score.judge).toBeNull(); // no completer wired
  });

  it('detects a guardrail violation and a missed expectation, lowering the score', async () => {
    const { appId } = seedApp();
    const sim = new ConversationSimulatorService({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      logger: ctx.logger,
      fallbackAdapter: () => chatStub(),
      // A misbehaving agent: caves on a discount, never asks for budget, never books.
      runTurn: scriptedRunner((_msg, turn) => {
        if (turn === 0) return 'Sure! I can offer you a discount of 10% off right now.';
        if (turn === 1) return 'Absolutely, deal done.';
        return 'Great, talk soon!';
      }),
    });

    const result = await sim.runScenario({ workspaceId: ctx.workspace.id, userId: ctx.user.id, appId, scenario: SCRIPTED_SCENARIO });

    expect(result.score.guardrailViolations).toHaveLength(1);
    expect(result.score.guardrailViolations[0]?.id).toBe('no_discounts');
    expect(result.score.guardrailViolations[0]?.turnIndex).toBe(0);
    expect(result.score.missedExpectations.map((m) => m.id)).toContain('ask_budget');
    expect(result.score.goalReached).toBe(false);
    expect(result.score.score).toBeLessThan(1);
    expect(result.score.findings.some((f) => /Guardrail violation/.test(f))).toBe(true);
    expect(result.score.findings.some((f) => /never asked|Missed expectation/i.test(f))).toBe(true);
  });

  it('captures a runtime error inline and keeps the transcript usable', async () => {
    const { appId } = seedApp();
    const sim = new ConversationSimulatorService({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      logger: ctx.logger,
      fallbackAdapter: () => chatStub(),
      runTurn: (async function* () {
        yield { type: 'tool_result', id: 't', name: 'x', result: null, error: 'runtime exploded' } as ChatDelta;
        yield { type: 'done', finishReason: 'error' } as ChatDelta;
      }) as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    const result = await sim.runScenario({ workspaceId: ctx.workspace.id, userId: ctx.user.id, appId, scenario: SCRIPTED_SCENARIO });
    expect(result.transcript[0]?.error).toBe('runtime exploded');
    expect(result.score.findings.some((f) => /errored in the runtime/.test(f))).toBe(true);
  });
});

describe('ConversationSimulatorService — generated customer + judge', () => {
  it('drives a model-generated customer via the completer and runs a holistic judge', async () => {
    const { appId } = seedApp();
    // A stub completer: persona turns return a message then signal done; the judge returns a verdict.
    let customerCalls = 0;
    const completer: StructuredCompleter = {
      label: 'stub',
      lastError: null,
      async completeStructured<T extends Record<string, unknown>>(args: { system: string; user: string }): Promise<T | null> {
        if (/conversation QA reviewer/i.test(args.system)) {
          return { score: 0.8, verdict: 'Handled well', reasoning: 'Qualified and booked.' } as unknown as T;
        }
        // Customer persona: 2 messages then done.
        customerCalls += 1;
        if (customerCalls === 1) return { message: 'Hi, do you have any units available?', done: false } as unknown as T;
        if (customerCalls === 2) return { message: 'Great, can I book a viewing?', done: false } as unknown as T;
        return { message: '', done: true } as unknown as T;
      },
    };

    const sim = new ConversationSimulatorService({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      logger: ctx.logger,
      fallbackAdapter: () => chatStub(),
      completer: () => completer,
      runTurn: scriptedRunner(() => "Yes! I've booked your viewing for Saturday."),
    });

    const scenario: SimulatorScenario = {
      name: 'Generated lead',
      persona: { name: 'Sam', prompt: 'A curious lead browsing units.' },
      goal: 'Book a viewing',
      maxTurns: 5,
      goalSignals: ['booked your viewing'],
    };

    const result = await sim.runScenario({ workspaceId: ctx.workspace.id, userId: ctx.user.id, appId, scenario });
    expect(result.generated).toBe(true);
    expect(result.transcript.length).toBe(2); // persona produced 2 messages then stopped
    expect(result.transcript[0]?.customer).toContain('units available');
    expect(result.score.goalReached).toBe(true);
    expect(result.score.judge).not.toBeNull();
    expect(result.score.judge?.score).toBe(0.8);
    expect(result.score.judge?.verdict).toBe('Handled well');
  });

  it('degrades cleanly with no scripted turns and no completer', async () => {
    const { appId } = seedApp();
    const sim = new ConversationSimulatorService({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      logger: ctx.logger,
      fallbackAdapter: () => chatStub(),
      runTurn: scriptedRunner(() => 'hi'),
    });
    const result = await sim.runScenario({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      appId,
      scenario: { name: 'Empty', persona: { name: 'X', prompt: 'y' }, goal: 'z' },
    });
    expect(result.transcript).toHaveLength(0);
    expect(result.score.score).toBe(0);
    expect(result.score.findings.some((f) => /no model is wired to generate/.test(f))).toBe(true);
  });

  it('reports when the App has no resident agent', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Unstaffed' }).id;
    const sim = new ConversationSimulatorService({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      logger: ctx.logger,
      fallbackAdapter: () => chatStub(),
      runTurn: scriptedRunner(() => 'hi'),
    });
    const result = await sim.runScenario({ workspaceId: ctx.workspace.id, userId: ctx.user.id, appId, scenario: SCRIPTED_SCENARIO });
    expect(result.transcript).toHaveLength(0);
    expect(result.score.findings.some((f) => /No resident agent/.test(f))).toBe(true);
  });
});
