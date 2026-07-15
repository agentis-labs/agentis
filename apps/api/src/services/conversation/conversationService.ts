/**
 * ConversationService — the real-world wiring for the {@link ConversationRuntime}
 * (GAP B1/B3). It binds the pure state machine to the App datastore (per-contact
 * persistence), the channel bridge (deterministic sends), a small-model completer
 * (compose/classify), and the engine (run_workflow stages), and exposes the four
 * entry points the platform calls:
 *
 *   • `define`        — an agent/operator installs a script on an App.
 *   • `enroll`        — start a fresh contact (outbound first touch).
 *   • `handleInbound` — the channel dispatcher routes an inbound reply here first.
 *   • `onRunComplete` — the bus RUN_COMPLETED hook wakes a contact after its build.
 *
 * The script + contacts live in the App datastore (collections `conversation_script`
 * and the script's `contactCollection`), so the pipeline is render-ready for a
 * DataBoard and survives restarts with zero extra tables.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  conversationScriptSchema,
  type ConversationScript,
  type ConversationContactState,
  type WorkflowGraph,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { buildAppStores, type AppDatastore } from '@agentis/app';
import { buildInitialRunState } from '../../engine/initialRunState.js';
import type { WorkflowRunState } from '@agentis/core';
import type { ChannelBridge } from './channelBridge.js';
import type { StructuredCompleter } from '../structuredCompleter.js';
import type { AppLearningService } from '../app/appLearning.js';
import type { SharedIntelligenceService } from '../sharedIntelligence.js';
import { withBudget } from '../util/withBudget.js';
import { readWorkflowSpec } from '../workflow/workflowSpec.js';
import { evaluateRunOutcome } from '../workflow/runOutcome.js';
import {
  ConversationRuntime,
  type ConversationContext,
  type ConversationRuntimeDeps,
  type AdvanceResult,
} from './conversationRuntime.js';

/** Reserved datastore collection holding the App's single script record. */
const SCRIPT_COLLECTION = 'conversation_script';
const SCRIPT_KEY = 'script';

export interface ConversationServiceDeps {
  db: AgentisSqliteDb;
  bus: { publish(room: string, event: string, payload: Record<string, unknown>): void };
  engine: {
    startRun(args: {
      workspaceId: string;
      ambientId: string | null;
      workflowId: string;
      userId: string;
      triggerId: string | null;
      inputs: Record<string, unknown>;
      initialState: WorkflowRunState;
      graph: WorkflowGraph;
    }): Promise<{ runId: string }>;
  };
  channels: Pick<ChannelBridge, 'deliverToConnection' | 'resolveDestination'>;
  /** Resolve a small-model JSON completer for compose/classify stages. */
  resolveCompleter: (workspaceId: string, task: string) => StructuredCompleter | undefined;
  /** App Brain learning — a terminal stage's deal outcome deposits a graded lesson. */
  learning?: Pick<AppLearningService, 'recordConversationOutcome'>;
  /** Relevance-based Brain recall for `send_agent` compose calls, scoped to the App. */
  sharedIntelligence?: Pick<SharedIntelligenceService, 'buildDispatchContext'>;
  logger?: { warn(msg: string, meta?: unknown): void; info?(msg: string, meta?: unknown): void };
}

/** Per-compose time budget (ms) for the Brain recall — a slow/failed lookup
 * degrades to no memory block rather than stalling a scripted send. */
const BRAIN_CONTEXT_BUDGET_MS = 1200;

/** Inbound payload from the channel dispatcher (a subset of ChannelTurnInput). */
export interface ConversationInbound {
  workspaceId: string;
  appId?: string | null;
  userId: string;
  ambientId: string | null;
  /** Channel address of the sender (WhatsApp phone/JID, …). */
  address: string;
  text: string;
}

export class ConversationService {
  private readonly data: AppDatastore;
  private readonly runtime: ConversationRuntime;

  constructor(private readonly deps: ConversationServiceDeps) {
    // Pass the bus so contact writes emit DATA_CHANGED — the operator watching the
    // App's Data page sees each contact advance through the pipeline live.
    this.data = buildAppStores({ db: deps.db, bus: deps.bus }).data;
    const runtimeDeps: ConversationRuntimeDeps = {
      loadScript: (ctx) => this.#loadScript(ctx),
      contacts: {
        get: (ctx, script, address) => this.#getContact(ctx, script, address),
        save: (ctx, script, state) => this.#saveContact(ctx, script, state),
        findByAwaitingRun: (ctx, script, runId) => this.#findByAwaitingRun(ctx, script, runId),
      },
      send: (args) => this.#send(args),
      completeJson: (args) => this.#completeJson(args),
      startRun: (args) => this.#startWorkflow(args),
      ...(deps.sharedIntelligence
        ? { buildBrainContext: (ctx, taskDescription) => this.#buildBrainContext(ctx, taskDescription) }
        : {}),
      ...(deps.learning
        ? {
            recordOutcome: (a) =>
              deps.learning!
                .recordConversationOutcome({ workspaceId: a.ctx.workspaceId, appId: a.ctx.appId, address: a.address, outcome: a.outcome, summary: a.summary })
                .then(() => undefined),
          }
        : {}),
      now: () => new Date(),
      ...(deps.logger ? { logger: deps.logger } : {}),
    };
    this.runtime = new ConversationRuntime(runtimeDeps);
  }

  // ── Entry points ──────────────────────────────────────────────────────────

  /** Install (or replace) the App's conversation script; auto-creates its collections. */
  define(ctx: ConversationContext, scriptInput: unknown): { ok: true; stages: number; contactCollection: string } {
    const script = conversationScriptSchema.parse(scriptInput);
    this.#ensureCollections(ctx, script);
    this.data.upsert(ctx.workspaceId, ctx.appId, SCRIPT_COLLECTION, { key: SCRIPT_KEY }, { key: SCRIPT_KEY, script });
    return { ok: true, stages: script.stages.length, contactCollection: script.contactCollection };
  }

  /** Start a fresh contact at the script's initial stage (the outbound first touch). */
  enroll(ctx: ConversationContext, address: string, connectionId: string, facts?: Record<string, unknown>): Promise<AdvanceResult> {
    return this.runtime.enroll(ctx, address, connectionId, facts);
  }

  /**
   * The channel dispatcher's first stop for an inbound message. Returns
   * `{ handled:true }` when a script owns this contact (the dispatcher must NOT run
   * a normal agent turn); `{ handled:false }` otherwise (fall through to the agent).
   */
  async handleInbound(input: ConversationInbound): Promise<AdvanceResult> {
    if (!input.appId) return { handled: false, reason: 'no_app' };
    const ctx: ConversationContext = { workspaceId: input.workspaceId, appId: input.appId, userId: input.userId, ambientId: input.ambientId };
    try {
      return await this.runtime.onInbound(ctx, input.address, input.text);
    } catch (err) {
      this.deps.logger?.warn('conversation.inbound_failed', { appId: input.appId, err: (err as Error).message });
      return { handled: false, reason: 'error' };
    }
  }

  /** Bus RUN_COMPLETED/RUN_FAILED hook: wake the contact whose build just finished. */
  async onRunComplete(payload: { runId: string; status: string; workflowId?: string; workspaceId: string }): Promise<void> {
    if (!payload.workflowId) return;
    const wf = this.deps.db
      .select({ appId: schema.workflows.appId, settings: schema.workflows.settings })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, payload.workflowId))
      .get();
    if (!wf?.appId) return; // not an App workflow → not a conversation build
    const run = this.deps.db
      .select({ userId: schema.workflowRuns.userId, ambientId: schema.workflowRuns.ambientId, runState: schema.workflowRuns.runState })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, payload.runId))
      .get();
    const ctx: ConversationContext = {
      workspaceId: payload.workspaceId,
      appId: wf.appId,
      ...(run?.userId ? { userId: run.userId } : {}),
      ambientId: run?.ambientId ?? null,
    };
    try {
      const outcome = evaluateRunOutcome({
        status: payload.status,
        runState: run?.runState,
        hasDefinitionOfDone: Boolean(readWorkflowSpec(wf.settings)),
      });
      await this.runtime.onWorkflowComplete(ctx, payload.runId, payload.status, outcome);
    } catch (err) {
      this.deps.logger?.warn('conversation.run_complete_failed', { runId: payload.runId, err: (err as Error).message });
    }
  }

  // ── Runtime dep implementations ─────────────────────────────────────────────

  #loadScript(ctx: ConversationContext): ConversationScript | null {
    try {
      const rows = this.data.query(ctx.workspaceId, ctx.appId, SCRIPT_COLLECTION, { filter: { key: SCRIPT_KEY }, limit: 1 }).rows;
      const raw = rows[0]?.data?.script;
      if (!raw) return null;
      const parsed = conversationScriptSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null; // collection not defined yet → this App has no script
    }
  }

  #getContact(ctx: ConversationContext, script: ConversationScript, address: string): ConversationContactState | null {
    try {
      const rows = this.data.query(ctx.workspaceId, ctx.appId, script.contactCollection, { filter: { address }, limit: 1 }).rows;
      return rows[0] ? (rows[0].data as unknown as ConversationContactState) : null;
    } catch {
      return null;
    }
  }

  #saveContact(ctx: ConversationContext, script: ConversationScript, state: ConversationContactState): void {
    // upsert merges by address, so the full state overwrites (incl. clearing awaitingRunId to null).
    this.data.upsert(ctx.workspaceId, ctx.appId, script.contactCollection, { address: state.address }, { ...state });
  }

  #findByAwaitingRun(ctx: ConversationContext, script: ConversationScript, runId: string): ConversationContactState | null {
    try {
      const rows = this.data.query(ctx.workspaceId, ctx.appId, script.contactCollection, { filter: { awaitingRunId: runId }, limit: 1 }).rows;
      return rows[0] ? (rows[0].data as unknown as ConversationContactState) : null;
    } catch {
      return null;
    }
  }

  async #send(args: { ctx: ConversationContext; connectionId: string; address: string; body: string; attachments?: Array<{ url?: string; artifactId?: string }> }): Promise<void> {
    const dest = this.deps.channels.resolveDestination({ connectionId: args.connectionId, to: args.address });
    const chatId = dest.chatId ?? args.address;
    await this.deps.channels.deliverToConnection({
      connectionId: args.connectionId,
      chatId,
      body: args.body,
      ...(args.attachments && args.attachments.length ? { attachments: args.attachments } : {}),
    });
  }

  async #buildBrainContext(ctx: ConversationContext, taskDescription: string): Promise<string | null> {
    const brain = this.deps.sharedIntelligence;
    if (!brain) return null;
    return withBudget(async () => {
      try {
        const result = await brain.buildDispatchContext({
          workspaceId: ctx.workspaceId,
          scopeId: ctx.appId,
          taskDescription,
          limit: 6,
          surface: 'chat',
        });
        return result.block || null;
      } catch (err) {
        this.deps.logger?.warn('conversation.brain_context.failed', { appId: ctx.appId, err: (err as Error).message });
        return null;
      }
    }, BRAIN_CONTEXT_BUDGET_MS, null, () => this.deps.logger?.warn?.('conversation.brain_context.budget_exceeded', { appId: ctx.appId }));
  }

  async #completeJson<T extends Record<string, unknown>>(args: { ctx: ConversationContext; system: string; user: string }): Promise<T | null> {
    const completer = this.deps.resolveCompleter(args.ctx.workspaceId, 'conversation');
    if (!completer) {
      this.deps.logger?.warn('conversation.no_completer', { appId: args.ctx.appId });
      return null;
    }
    return completer.completeStructured<T>({ system: args.system, user: args.user, workspaceId: args.ctx.workspaceId, maxTokens: 600 });
  }

  async #startWorkflow(args: { ctx: ConversationContext; workflowId: string; inputs: Record<string, unknown>; contactAddress: string }): Promise<{ runId: string }> {
    const wf = this.deps.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, args.workflowId), eq(schema.workflows.workspaceId, args.ctx.workspaceId)))
      .get();
    if (!wf) throw new Error(`conversation run_workflow: workflow ${args.workflowId} not found`);
    const userId = args.ctx.userId ?? wf.userId;
    const graph = wf.graph as WorkflowGraph;
    const runId = randomUUID();
    const initialState = buildInitialRunState({ runId, workflowId: wf.id, graph, inputs: args.inputs });
    this.deps.db
      .insert(schema.workflowRuns)
      .values({
        id: runId,
        workspaceId: args.ctx.workspaceId,
        ambientId: args.ctx.ambientId ?? null,
        workflowId: wf.id,
        userId,
        status: 'CREATED',
        runState: initialState,
        triggerId: null,
      })
      .run();
    this.deps.bus.publish(REALTIME_ROOMS.workspace(args.ctx.workspaceId), REALTIME_EVENTS.RUN_CREATED, {
      runId,
      workflowId: wf.id,
      ambientId: args.ctx.ambientId ?? null,
    });
    await this.deps.engine.startRun({
      workspaceId: args.ctx.workspaceId,
      ambientId: args.ctx.ambientId ?? null,
      workflowId: wf.id,
      userId,
      triggerId: null,
      inputs: args.inputs,
      initialState,
      graph,
    });
    return { runId };
  }

  #ensureCollections(ctx: ConversationContext, script: ConversationScript): void {
    const existing = new Set(this.data.listCollections(ctx.workspaceId, ctx.appId).map((c) => c.name));
    if (!existing.has(SCRIPT_COLLECTION)) {
      this.data.defineCollection(ctx.workspaceId, ctx.appId, {
        name: SCRIPT_COLLECTION,
        schema: { fields: [{ key: 'key', type: 'string', required: true, indexed: true }] },
      });
    }
    if (!existing.has(script.contactCollection)) {
      this.data.defineCollection(ctx.workspaceId, ctx.appId, {
        name: script.contactCollection,
        schema: {
          // Typed + indexed for the pipeline surface; connectionId/awaitingRunId/facts/
          // history pass through untyped (non-strict) so nulls/objects store cleanly.
          fields: [
            { key: 'address', type: 'string', required: true, indexed: true },
            { key: 'stage', type: 'string', required: false, indexed: true },
            { key: 'status', type: 'string', required: false, indexed: true },
          ],
        },
      });
    }
  }
}
