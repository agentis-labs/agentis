/**
 * SubjectRuntime — the Subject primitive, running on the Durable Entity spine (§3.2).
 *
 * This is the GENERAL version of what `ConversationContactState`/`ConversationRuntime`
 * do narrowly: a per-subject actor with a declarative lifecycle that rests between
 * events and resumes when its subject acts — a reply that may arrive days later and
 * out of order, correlated back to the right subject by token, never by arrival order.
 * A subject is a `durable_entities` row of kind `subject`; this is the handler the
 * dispatcher runs for that kind. Side effects (a deterministic send, an agent turn)
 * are injected `SubjectActions`, so the runtime is the pure lifecycle driver and the
 * wiring decides how a send/agent-step actually happens.
 *
 * Stages (minimal, general — extend as real scripts demand):
 *   send  — deterministic, token-free message (the "no tokens" first touch) → next
 *   agent — hand off to a model to compose/decide (the personalized pitch, a classify) → next
 *   wait  — park until an inbound event arrives (the reply); store it in facts → next
 *   done  — terminal; the subject stops being woken
 */

import type { EntityWakeContext, EntityWakeResult, Correlation } from './durableEntities.js';

export type SubjectStage =
  | { action: 'send'; text: string; next: string }
  | { action: 'agent'; instruction: string; next: string }
  | { action: 'wait'; correlation?: Correlation; next: string }
  | { action: 'done' };

export interface SubjectScript {
  start: string;
  stages: Record<string, SubjectStage>;
}

export interface SubjectState {
  script: SubjectScript;
  stage: string;
  facts: Record<string, unknown>;
}

export interface SubjectActionArgs {
  entityId: string;
  workspaceId: string;
  appId: string | null;
  facts: Record<string, unknown>;
}

export interface SubjectActions {
  /** Deterministic, token-free send. Resolves the destination from the subject's facts. */
  send(args: SubjectActionArgs & { text: string }): Promise<void> | void;
  /** Hand the step to a model (compose a message, classify a reply, trigger a build). */
  runAgent(args: SubjectActionArgs & { instruction: string }): Promise<void> | void;
}

const MAX_STEPS_PER_WAKE = 50;

export class SubjectRuntime {
  constructor(private readonly actions: SubjectActions) {}

  /** The dispatcher handler for kind `subject`. Advances until it parks (wait) or terminates (done). */
  async handle(ctx: EntityWakeContext): Promise<EntityWakeResult> {
    const state = ctx.entity.stateJson as SubjectState;
    if (!state?.script?.stages) return { done: true }; // malformed → stop cleanly
    const facts = { ...(state.facts ?? {}) };
    const consumeInboxIds = ctx.inbox.map((e) => e.id);
    let stageName = state.stage || state.script.start;
    let unread = [...ctx.inbox];

    const base = { entityId: ctx.entity.id, workspaceId: ctx.entity.workspaceId, appId: ctx.entity.appId };

    for (let step = 0; step < MAX_STEPS_PER_WAKE; step++) {
      const stage = state.script.stages[stageName];
      if (!stage) return { state: { ...state, stage: stageName, facts }, consumeInboxIds, done: true };

      if (stage.action === 'done') {
        return { state: { ...state, stage: stageName, facts }, consumeInboxIds, done: true };
      }
      if (stage.action === 'send') {
        await this.actions.send({ ...base, facts, text: interpolate(stage.text, facts) });
        stageName = stage.next;
        continue;
      }
      if (stage.action === 'agent') {
        await this.actions.runAgent({ ...base, facts, instruction: interpolate(stage.instruction, facts) });
        stageName = stage.next;
        continue;
      }
      // wait
      if (unread.length > 0) {
        const last = unread[unread.length - 1]!;
        facts.lastReply = last.payloadJson ?? null;
        facts[`reply_at_${stageName}`] = last.payloadJson ?? null;
        unread = [];
        stageName = stage.next;
        continue;
      }
      // Park until an inbound event arrives — no timer wake; woken by inbox/correlation.
      // Derive a channel correlation from the subject's facts when the stage didn't
      // specify one, so an inbound reply on the subject's channel routes here for free.
      const correlation = stage.correlation ?? deriveChannelCorrelation(facts);
      return {
        state: { ...state, stage: stageName, facts },
        consumeInboxIds,
        nextWakeAt: null,
        ...(correlation ? { awaitingCorrelation: correlation } : {}),
      };
    }
    // guard tripped (script likely loops) — persist and stop being woken.
    return { state: { ...state, stage: stageName, facts }, consumeInboxIds, done: true };
  }
}

/** The correlation token a subject on a channel awaits — matched by the inbound router. */
export function channelCorrelationId(connectionId: string, address: string): string {
  return `channel:${connectionId}:${address}`;
}

/** Derive the channel correlation from a subject's facts (connectionId + to/chatId). */
function deriveChannelCorrelation(facts: Record<string, unknown>): Correlation | undefined {
  const connectionId = typeof facts.connectionId === 'string' ? facts.connectionId : null;
  const address = typeof facts.to === 'string' ? facts.to : (typeof facts.chatId === 'string' ? facts.chatId : null);
  if (!connectionId || !address) return undefined;
  return { kind: 'channel', id: channelCorrelationId(connectionId, address) };
}

/** Replace {{key}} tokens with the subject's facts (shallow, string coercion). */
function interpolate(text: string, facts: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = facts[key];
    return v == null ? '' : String(v);
  });
}
