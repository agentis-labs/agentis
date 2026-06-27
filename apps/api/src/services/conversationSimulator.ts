/**
 * ConversationSimulatorService — rehearse a multi-turn conversation against the
 * resident App agent before it talks to real money (LIVING-APPS-10X §7 · G8).
 *
 * You can already test workflows (`AppTestHarness`) and graphs (preflight), but
 * there was no way to drive the RESIDENT AGENT through a realistic customer
 * conversation and SCORE the result. This closes that gap:
 *
 *   1. A SYNTHETIC COUNTERPART (a "customer" persona) drives the agent. Its turns
 *      are either SCRIPTED (a fixed list, fully deterministic) or GENERATED from a
 *      persona prompt via the workspace `StructuredCompleter` (model-agnostic; falls
 *      back to scripted/no-op when no model is wired).
 *   2. Each customer turn runs the REAL resident-agent path —
 *      `ChatSessionExecutor.turn` — in a SANDBOXED conversation. The turn engine is
 *      driven directly and the agent's reply is captured from the delta stream;
 *      NOTHING is delivered to a real channel and the live thread is untouched
 *      (the synthetic `conversationId` is `sim-…`, never a stored thread).
 *   3. SCORING — a rubric over the transcript: did the agent hit the goal, stay
 *      grounded / non-fabricating, ask its required qualifying questions, and avoid
 *      every guardrail? Deterministic by construction (so it runs model-free in
 *      tests); a model-backed holistic pass layers on top when a completer is wired.
 *
 * ADDITIVE + NON-THROWING + MODEL-AGNOSTIC. A simulation never mutates real state
 * and never throws into the caller: a turn failure is captured as a transcript
 * entry with an `error`, and the run continues so the report is still useful.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AgentAdapter, ChatMessage, ChatTurnContext } from '@agentis/core';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { Logger } from '../logger.js';
import type { StructuredCompleter } from './structuredCompleter.js';
import { ChatSessionExecutor } from './chatSessionExecutor.js';

/** A guardrail the agent must NOT violate — matched against its replies. */
export interface SimulatorGuardrail {
  /** Stable id surfaced in the report (e.g. 'no_discounts'). */
  id: string;
  /** Human label ("never promise a discount"). */
  label: string;
  /**
   * Pattern that, when it MATCHES an agent reply, counts as a violation.
   * A string is compiled case-insensitively; a RegExp is used verbatim.
   */
  pattern: string | RegExp;
}

/** A required behaviour the agent SHOULD exhibit (e.g. "ask for budget"). */
export interface SimulatorExpectation {
  id: string;
  label: string;
  /** Matches against the agent's replies; satisfied when ANY reply matches. */
  pattern: string | RegExp;
}

export interface SimulatorScenario {
  /** Display name for the report. */
  name: string;
  persona: {
    /** "Maria, a price-sensitive first-time buyer". */
    name: string;
    /**
     * The persona's brief — its situation, goal, and tone. Used to GENERATE turns
     * when `customerTurns` is omitted (needs a completer), and surfaced in the report.
     */
    prompt: string;
  };
  /** What a SUCCESSFUL conversation achieves, in the customer's words. */
  goal: string;
  /**
   * Scripted customer messages, in order. When present the run is fully
   * deterministic (no model needed for the customer). The first entry opens the
   * conversation. When omitted, turns are generated from `persona.prompt`.
   */
  customerTurns?: string[];
  /** Cap on customer turns for a generated scenario (ignored when scripted). */
  maxTurns?: number;
  /** Substrings/patterns whose presence in ANY agent reply marks goal success. */
  goalSignals?: Array<string | RegExp>;
  guardrails?: SimulatorGuardrail[];
  expectations?: SimulatorExpectation[];
}

export interface SimulatedTurn {
  index: number;
  /** The synthetic customer's message for this turn. */
  customer: string;
  /** The resident agent's reply (empty on a turn that errored). */
  agent: string;
  /** Names of platform tools the agent invoked this turn (for grounding insight). */
  toolCalls: string[];
  /** Present when the turn engine failed; the run still continues. */
  error?: string;
}

export interface SimulatorScoreCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface SimulatorScore {
  /** 0..1 — fraction of rubric checks passed (goal + expectations + guardrails). */
  score: number;
  goalReached: boolean;
  guardrailViolations: Array<{ id: string; label: string; turnIndex: number; excerpt: string }>;
  missedExpectations: Array<{ id: string; label: string }>;
  checks: SimulatorScoreCheck[];
  /** Plain-language pointers at where the agent broke ("never asked for budget"). */
  findings: string[];
  /** Optional model-backed holistic verdict; null when no completer is wired. */
  judge: { score: number; verdict: string; reasoning: string } | null;
}

export interface SimulationResult {
  appId: string;
  agentId: string;
  scenario: { name: string; persona: string; goal: string };
  transcript: SimulatedTurn[];
  score: SimulatorScore;
  /** True when the customer turns were model-generated, false when scripted. */
  generated: boolean;
}

export interface ConversationSimulatorDeps {
  db: AgentisSqliteDb;
  adapters: AdapterManager;
  logger: Logger;
  /**
   * Resolve the workspace conversation runtime (the orchestrator model) as a
   * fallback adapter when the resident agent has no chat-capable adapter of its
   * own. Defaults to `ChatSessionExecutor.orchestratorAdapter`.
   */
  fallbackAdapter?: (workspaceId: string) => AgentAdapter | undefined;
  /**
   * The drive runner. Defaults to `ChatSessionExecutor.turn` — the REAL resident
   * agent path. Overridable in tests so the simulator runs model-free.
   */
  runTurn?: typeof ChatSessionExecutor.turn;
  /**
   * A model-agnostic completer for the synthetic customer + the holistic judge.
   * Resolved per (workspace, agent) so the persona uses whatever model is wired.
   * Omit → scripted-only customer + deterministic-only scoring.
   */
  completer?: (workspaceId: string, agentId: string) => StructuredCompleter | undefined;
}

export interface RunScenarioInput {
  workspaceId: string;
  userId: string;
  appId: string;
  scenario: SimulatorScenario;
  /** Override the resident agent (defaults to the App's owner agent). */
  agentId?: string;
  signal?: AbortSignal;
}

/** Hard ceiling on simulated turns regardless of scenario input. */
const MAX_SIMULATED_TURNS = 12;
const DEFAULT_GENERATED_TURNS = 6;

export class ConversationSimulatorService {
  constructor(private readonly deps: ConversationSimulatorDeps) {}

  /**
   * Run a scenario against the resident App agent and score the transcript.
   * Never throws — a resolution failure returns an empty-transcript result whose
   * findings explain why; a turn failure is captured inline and the run continues.
   */
  async runScenario(input: RunScenarioInput): Promise<SimulationResult> {
    const agentId = input.agentId ?? this.#residentAgent(input.appId);
    const scriptedTurns = (input.scenario.customerTurns ?? []).map((t) => t.trim()).filter(Boolean);
    const generated = scriptedTurns.length === 0;
    const completer = this.deps.completer?.(input.workspaceId, agentId);

    if (!agentId) {
      return this.#emptyResult(input, '', generated, [
        'No resident agent: this App has no owner agent and none was supplied, so there is nobody to rehearse against. Staff the App first.',
      ]);
    }
    const adapter = this.#resolveAdapter(agentId, input.workspaceId);
    if (!adapter) {
      return this.#emptyResult(input, agentId, generated, [
        'No chat-capable runtime: the resident agent has no interactive adapter and no orchestrator runtime is configured, so the turn could not run.',
      ]);
    }
    if (generated && !completer) {
      return this.#emptyResult(input, agentId, generated, [
        'No scripted customer turns and no model is wired to generate them — provide `customerTurns` or configure a conversation runtime.',
      ]);
    }

    const runTurn = this.deps.runTurn ?? ChatSessionExecutor.turn.bind(ChatSessionExecutor);
    const conversationId = `sim-${randomUUID()}`; // sandbox: never a stored thread
    const history: ChatMessage[] = [];
    const transcript: SimulatedTurn[] = [];

    const cap = generated
      ? Math.min(MAX_SIMULATED_TURNS, Math.max(1, input.scenario.maxTurns ?? DEFAULT_GENERATED_TURNS))
      : Math.min(MAX_SIMULATED_TURNS, scriptedTurns.length);

    for (let i = 0; i < cap; i += 1) {
      if (input.signal?.aborted) break;
      const customer = generated
        ? await this.#nextCustomerTurn(input.scenario, transcript, completer!, input.signal)
        : (scriptedTurns[i] as string);
      if (!customer) break; // a generated persona signalled it's done

      const ctx: ChatTurnContext = {
        workspaceId: input.workspaceId,
        agentId,
        userId: input.userId,
        conversationId,
        appId: input.appId,
        clientTurnId: `sim-turn-${i}`,
        executionMode: 'chat',
        permissionMode: 'auto', // a rehearsal auto-approves; we score the behaviour, not gates
        maxTurns: 6,
        viewport: null,
        ...(input.signal ? { signal: input.signal } : {}),
      };

      let reply = '';
      const toolCalls: string[] = [];
      let turnError: string | undefined;
      try {
        for await (const delta of runTurn(adapter, history.slice(), customer, ctx, {
          channelContext: { kind: 'simulator', from: input.scenario.persona.name, chatId: conversationId, threadId: null },
        })) {
          if (delta.type === 'text') reply += delta.delta;
          else if (delta.type === 'tool_call') toolCalls.push(delta.name);
          else if (delta.type === 'tool_result' && delta.error && !turnError) turnError = delta.error;
          else if (delta.type === 'done' && delta.finishReason === 'error' && !turnError) {
            turnError = 'the agent runtime returned an error';
          }
        }
      } catch (err) {
        turnError = (err as Error).message;
        this.deps.logger.warn('simulator.turn.failed', { appId: input.appId, agentId, turn: i, err: turnError });
      }

      reply = reply.trim();
      history.push({ role: 'user', content: customer });
      if (reply) history.push({ role: 'assistant', content: reply });
      transcript.push({
        index: i,
        customer,
        agent: reply,
        toolCalls,
        ...(turnError ? { error: turnError } : {}),
      });
    }

    const score = await this.#score(input.scenario, transcript, completer, input.signal);
    return {
      appId: input.appId,
      agentId,
      scenario: { name: input.scenario.name, persona: input.scenario.persona.name, goal: input.scenario.goal },
      transcript,
      score,
      generated,
    };
  }

  // ── Synthetic customer ──────────────────────────────────────

  /**
   * Generate the next customer message from the persona + the conversation so
   * far, via the completer. Returns '' when the persona considers the goal met or
   * the conversation stuck (so the run terminates early), or when generation
   * fails (degrade to ending the conversation rather than fabricating).
   */
  async #nextCustomerTurn(
    scenario: SimulatorScenario,
    transcript: SimulatedTurn[],
    completer: StructuredCompleter,
    signal?: AbortSignal,
  ): Promise<string> {
    const opening = transcript.length === 0;
    const system = [
      `You are role-playing a CUSTOMER talking to a business's agent. Stay fully in character.`,
      `Persona: ${scenario.persona.name}. ${scenario.persona.prompt}`,
      `Your goal in this conversation: ${scenario.goal}`,
      `Speak naturally as the customer — one short message at a time, like a real chat. Do NOT play the agent's part or narrate.`,
      `When your goal is clearly met, or the agent cannot help and the conversation has run its course, set "done": true and leave "message" empty.`,
    ].join('\n');
    const convo = transcript
      .map((t) => `Customer: ${t.customer}\nAgent: ${t.agent || '(no reply)'}`)
      .join('\n\n');
    const user = opening
      ? `Open the conversation with your first message. Respond as JSON: {"message": "<your opening message>", "done": false}.`
      : `Conversation so far:\n\n${convo}\n\nWrite your next message as the customer, or finish. Respond as JSON: {"message": "<next message or empty>", "done": <true|false>}.`;

    try {
      const out = await completer.completeStructured<{ message?: unknown; done?: unknown }>({
        system,
        user,
        maxTokens: 400,
        ...(signal ? { signal } : {}),
      });
      if (!out) return '';
      if (out.done === true) return '';
      const message = typeof out.message === 'string' ? out.message.trim() : '';
      return message;
    } catch {
      return '';
    }
  }

  // ── Scoring ─────────────────────────────────────────────────

  async #score(
    scenario: SimulatorScenario,
    transcript: SimulatedTurn[],
    completer: StructuredCompleter | undefined,
    signal?: AbortSignal,
  ): Promise<SimulatorScore> {
    const agentReplies = transcript.map((t) => ({ index: t.index, text: t.agent })).filter((r) => r.text.length > 0);
    const checks: SimulatorScoreCheck[] = [];
    const findings: string[] = [];

    // 1. Goal — any agent reply carries a goal signal.
    const goalSignals = scenario.goalSignals ?? [];
    const goalHit = goalSignals.length > 0
      ? agentReplies.find((r) => goalSignals.some((sig) => matches(sig, r.text)))
      : undefined;
    const goalReached = goalSignals.length > 0 ? Boolean(goalHit) : agentReplies.length > 0;
    checks.push({
      id: 'goal',
      label: `Reached the goal: ${scenario.goal}`,
      passed: goalReached,
      ...(goalHit ? { detail: `turn ${goalHit.index}` } : {}),
    });
    if (!goalReached) {
      findings.push(goalSignals.length > 0
        ? `Goal not reached — no reply matched a goal signal for "${scenario.goal}".`
        : `Goal could not be evaluated — the agent never produced a reply.`);
    }

    // 2. Expectations — required behaviours (e.g. "ask for budget").
    const missedExpectations: SimulatorScore['missedExpectations'] = [];
    for (const exp of scenario.expectations ?? []) {
      const met = agentReplies.some((r) => matches(exp.pattern, r.text));
      checks.push({ id: `expect:${exp.id}`, label: exp.label, passed: met });
      if (!met) {
        missedExpectations.push({ id: exp.id, label: exp.label });
        findings.push(`Missed expectation — ${exp.label}.`);
      }
    }

    // 3. Guardrails — a violation is any reply matching a forbidden pattern.
    const guardrailViolations: SimulatorScore['guardrailViolations'] = [];
    for (const rail of scenario.guardrails ?? []) {
      const hit = agentReplies.find((r) => matches(rail.pattern, r.text));
      const violated = Boolean(hit);
      checks.push({ id: `guardrail:${rail.id}`, label: `Respected: ${rail.label}`, passed: !violated });
      if (hit) {
        guardrailViolations.push({ id: rail.id, label: rail.label, turnIndex: hit.index, excerpt: excerpt(hit.text) });
        findings.push(`Guardrail violation — ${rail.label} (turn ${hit.index}).`);
      }
    }

    // 4. Coverage — flag a conversation that never got off the ground.
    if (agentReplies.length === 0) findings.push('The agent never replied — check the runtime and the App staffing.');
    const erroredTurns = transcript.filter((t) => t.error);
    if (erroredTurns.length > 0) {
      findings.push(`${erroredTurns.length} turn(s) errored in the runtime; the transcript is partial.`);
    }

    const passed = checks.filter((c) => c.passed).length;
    const score = checks.length === 0 ? (goalReached ? 1 : 0) : passed / checks.length;

    const judge = completer ? await this.#judge(scenario, transcript, completer, signal) : null;

    return { score: round(score), goalReached, guardrailViolations, missedExpectations, checks, findings, judge };
  }

  /** Optional model-backed holistic verdict. Non-throwing; null on any failure. */
  async #judge(
    scenario: SimulatorScenario,
    transcript: SimulatedTurn[],
    completer: StructuredCompleter,
    signal?: AbortSignal,
  ): Promise<SimulatorScore['judge']> {
    if (transcript.length === 0) return null;
    const convo = transcript.map((t) => `Customer: ${t.customer}\nAgent: ${t.agent || '(no reply)'}`).join('\n\n');
    const system = [
      `You are a strict conversation QA reviewer scoring a business agent's handling of a customer.`,
      `Judge ONLY against the goal and any guardrails. Penalize fabrication (promising things, inventing facts/discounts), failing to qualify, and missing the goal.`,
      `Reply as JSON: {"score": <0..1>, "verdict": "<one line>", "reasoning": "<2-3 sentences>"}.`,
    ].join('\n');
    const guardrails = (scenario.guardrails ?? []).map((g) => `- ${g.label}`).join('\n') || '(none specified)';
    const user = [
      `Goal: ${scenario.goal}`,
      `Guardrails the agent must respect:\n${guardrails}`,
      `Transcript:\n\n${convo}`,
    ].join('\n\n');
    try {
      const out = await completer.completeStructured<{ score?: unknown; verdict?: unknown; reasoning?: unknown }>({
        system,
        user,
        maxTokens: 500,
        ...(signal ? { signal } : {}),
      });
      if (!out) return null;
      const s = typeof out.score === 'number' ? Math.max(0, Math.min(1, out.score)) : 0;
      return {
        score: round(s),
        verdict: typeof out.verdict === 'string' ? out.verdict.trim() : '',
        reasoning: typeof out.reasoning === 'string' ? out.reasoning.trim() : '',
      };
    } catch {
      return null;
    }
  }

  // ── Resolution ──────────────────────────────────────────────

  /** The App's resident agent: its owner agent (Phase R staffing). */
  #residentAgent(appId: string): string {
    try {
      const row = this.deps.db
        .select({ ownerAgentId: schema.apps.ownerAgentId })
        .from(schema.apps)
        .where(eq(schema.apps.id, appId))
        .get();
      return row?.ownerAgentId ?? '';
    } catch {
      return '';
    }
  }

  /** Mirror the dispatcher: the agent's own chat adapter, else the orchestrator runtime. */
  #resolveAdapter(agentId: string, workspaceId: string): AgentAdapter | undefined {
    const own = this.deps.adapters.get(agentId)?.adapter;
    if (own?.chat && own.capabilities?.().interactiveChat !== false) return own;
    const fallback = this.deps.fallbackAdapter ?? ((ws: string) => ChatSessionExecutor.orchestratorAdapter(ws));
    const runtime = fallback(workspaceId);
    if (runtime?.chat) return runtime;
    return undefined;
  }

  #emptyResult(input: RunScenarioInput, agentId: string, generated: boolean, findings: string[]): SimulationResult {
    return {
      appId: input.appId,
      agentId,
      scenario: { name: input.scenario.name, persona: input.scenario.persona.name, goal: input.scenario.goal },
      transcript: [],
      score: {
        score: 0,
        goalReached: false,
        guardrailViolations: [],
        missedExpectations: (input.scenario.expectations ?? []).map((e) => ({ id: e.id, label: e.label })),
        checks: [],
        findings,
        judge: null,
      },
      generated,
    };
  }
}

function matches(pattern: string | RegExp, text: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(text);
  return text.toLowerCase().includes(pattern.toLowerCase());
}

function excerpt(text: string, max = 160): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
