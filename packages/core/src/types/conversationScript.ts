/**
 * Conversation Script — the declarative per-contact state machine (GAP-ANALYSIS
 * B1/B3, the "await-reply" keystone).
 *
 * A workflow DAG runs once, front-to-back. A *conversation* does not: it rests
 * between messages, resumes when the contact replies (days later, across
 * restarts), branches on what they said, may kick off a heavy workflow and wake
 * again when it finishes, and eventually stops. That shape is not a graph — it is
 * a small state machine keyed to one contact.
 *
 * This module is the pure, engine-agnostic *shape* of that machine. The runtime
 * (`apps/api/src/services/conversationRuntime.ts`) interprets it: it performs a
 * stage's `entry` action on ENTER, rests on `onReply`/`onComplete`, and persists
 * each contact's position to an App datastore collection. Deterministic stages
 * cost zero LLM tokens; only `send_agent`/`classify` call a (small) model.
 */

import { z } from 'zod';

// ── Stage entry — performed when a contact ENTERS a stage ────────────────────

export const conversationEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('send_deterministic'),
    /**
     * Template text sent verbatim — ZERO LLM tokens. Interpolates `{greeting}`
     * (a localized time-of-day greeting from the contact's local time + the
     * script/contact `locale`, default English) and `{contact.<field>}` /
     * `{facts.<field>}` from the contact record.
     */
    template: z.string().min(1),
  }),
  z.object({
    kind: z.literal('send_agent'),
    /** Instruction for a SMALL model to compose one human message (uses facts + last reply). */
    brief: z.string().min(1),
    /** Optional explicit agent id; otherwise the App owner / a small routed model. */
    agentId: z.string().optional(),
    /** Contact-record fields whose values are artifact/url refs to attach (e.g. a pre-made image). */
    attachFrom: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.literal('run_workflow'),
    /** The heavy workflow to trigger (any App workflow — a build, a fulfilment, a report…). The stage rests until it completes. */
    workflowId: z.string().min(1),
    /** Map contact-record fields into the workflow inputs: `{ inputKey: contactField }`. */
    inputsFrom: z.record(z.string(), z.string()).default({}),
  }),
  /** No entry action — a pure rest/branch point. */
  z.object({ kind: z.literal('none') }),
]);
export type ConversationEntry = z.infer<typeof conversationEntrySchema>;

// ── Reply handling — what the NEXT inbound message does while resting ─────────

export const conversationOnReplySchema = z.discriminatedUnion('kind', [
  /** Unconditionally advance to `stage` on the next reply. */
  z.object({ kind: z.literal('goto'), stage: z.string().min(1) }),
  /** Classify the reply with a small model, then branch by label. */
  z.object({
    kind: z.literal('classify'),
    brief: z.string().min(1),
    labels: z.array(z.string().min(1)).min(2),
    /** label → next stage id. A label with no branch (or an unknown label) rests in place. */
    branches: z.record(z.string(), z.string()),
    agentId: z.string().optional(),
  }),
]);
export type ConversationOnReply = z.infer<typeof conversationOnReplySchema>;

// ── Stage ─────────────────────────────────────────────────────────────────────

export const conversationStageSchema = z.object({
  id: z.string().min(1),
  
  label: z.string().optional(),
  /** Performed on ENTER. Absent = `{ kind: 'none' }`. */
  entry: conversationEntrySchema.optional(),
  /** How the next inbound reply advances. Absent (and not terminal) = rest, ignore replies. */
  onReply: conversationOnReplySchema.optional(),
  /** For a `run_workflow` entry: where to go when that run COMPLETES. */
  onComplete: z.object({ stage: z.string().min(1) }).optional(),
  
  terminal: z.boolean().optional(),
  /**
   * On a terminal stage, the outcome this represents — deposits a graded lesson
   * into the App's Brain (won/lost/abandoned) so the App's agent learns over time.
   * Applies to any relationship App (support, booking, sales, collections…), not
   * one use case. Absent = no lesson recorded for this terminal.
   */
  outcome: z.enum(['won', 'lost', 'abandoned']).optional(),
});
export type ConversationStage = z.infer<typeof conversationStageSchema>;

// ── Script ──────────────────────────────────────────────────────────────────

export const conversationScriptSchema = z
  .object({
    version: z.literal(1).default(1),
    /** Datastore collection holding one {@link ConversationContactState} per contact. */
    contactCollection: z.string().min(1).default('contacts'),
    /**
     * Default language for `{greeting}` and (as a hint) agent-composed messages —
     * any BCP-47 code (`en`, `pt`, `es`, `fr`, …). Default English. A contact can
     * override via `facts.locale`. The App decides its own language; nothing here
     * assumes one.
     */
    locale: z.string().optional(),
    /** Stage a freshly-enrolled contact enters first (usually the outbound greeting). */
    initialStage: z.string().min(1),
    stages: z.array(conversationStageSchema).min(1),
  })
  .superRefine((script, ctx) => {
    const ids = new Set(script.stages.map((s) => s.id));
    const bad = (stage: string, path: (string | number)[]) => {
      if (!ids.has(stage)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown stage id "${stage}"`, path });
      }
    };
    // Every referenced stage id must resolve — a dangling transition is a dead campaign.
    if (!ids.has(script.initialStage)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `initialStage "${script.initialStage}" is not a stage`, path: ['initialStage'] });
    }
    if (ids.size !== script.stages.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stage ids must be unique', path: ['stages'] });
    }
    script.stages.forEach((stage, i) => {
      if (stage.onReply?.kind === 'goto') bad(stage.onReply.stage, ['stages', i, 'onReply', 'stage']);
      if (stage.onReply?.kind === 'classify') {
        for (const [label, next] of Object.entries(stage.onReply.branches)) bad(next, ['stages', i, 'onReply', 'branches', label]);
      }
      if (stage.onComplete) bad(stage.onComplete.stage, ['stages', i, 'onComplete', 'stage']);
    });
  });
export type ConversationScript = z.infer<typeof conversationScriptSchema>;

// ── Per-contact runtime state (persisted in `contactCollection`) ──────────────

/**
 * One contact's position in the script, stored as a datastore record and keyed by
 * `address`. The pipeline surface reads `stage`/`status`; the runtime reads
 * `connectionId` to reply and `awaitingRunId` to match a completing workflow.
 */
export interface ConversationContactState {
  /** Channel address to reply through (WhatsApp phone/JID, Telegram chat id, …). */
  address: string;
  /** Current stage id. */
  stage: string;
  /**
   * `scheduled` = enrolled but the first touch is deferred until {@link scheduledAt};
   * `active` = advancing; `blocked` = entry side effect lacks proof; `stopped` = terminal.
   */
  status: 'scheduled' | 'active' | 'blocked' | 'stopped';
  /**
   * When the deferred first touch becomes due (ISO-8601). Only meaningful while
   * `status === 'scheduled'`; the sweep clears it on entry. A scheduled contact
   * costs nothing while it waits — it is a datastore row, not a timer.
   */
  scheduledAt?: string | null;
  /** Durable reason an entry action could not be proven; retry uses the same idempotency key. */
  blocker?: { code: string; message: string; at: string };
  /** Channel connection this contact is reached on. */
  connectionId?: string;
  /** Gathered personalization facts (e.g. instagram handle, brand notes). */
  facts?: Record<string, unknown>;
  /** Rolling transcript the small model composes against. */
  history?: Array<{ at: string; role: 'in' | 'out'; text: string }>;
  /** Set while a `run_workflow` stage is pending; matched by the run-complete hook. */
  awaitingRunId?: string | null;
  updatedAt?: string;
}

/** Stable label for a stage (its `label`, else its `id`). */
export function conversationStageLabel(stage: ConversationStage): string {
  return stage.label?.trim() || stage.id;
}



