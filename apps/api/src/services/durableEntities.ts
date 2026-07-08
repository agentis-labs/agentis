/**
 * DurableEntityService — the Durable Entity spine (Agent-Native Platform Plan §3.0).
 *
 * One keyed, restart-durable, single-writer-per-key record with a typed inbox and a
 * wake clock. This is the industry-convergent shape (Restate Virtual Objects /
 * Cloudflare Durable Objects / Temporal entity workflows) rebuilt on SQLite: the
 * "agent" and the "per-subject actor" are the same primitive at different `kind`.
 *
 * Correctness notes (R1 traps):
 *  - SQLite is single-writer for the FILE, NOT per entity. A `lease` (leaseOwner +
 *    leaseExpiresAt) is therefore MANDATORY so a cron tick and a webhook-driven wake
 *    can't both mutate the same entity. `claimDue` CAS-claims under the lease.
 *  - Out-of-order / multi-day is free: each entity has its own inbox, and replies
 *    route to the right entity by a unique correlation token — never by arrival order.
 *  - Run-state stays separate from entity-state (a run is the transient thing a wake
 *    spawns) — this service never touches workflow_runs.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, isNotNull, lt, lte, or } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';

export type EntityState = Record<string, unknown>;
export type Correlation = { kind: string; id: string };

export interface UpsertEntityInput {
  workspaceId: string;
  kind: string;
  key: string;
  appId?: string | null;
  /** Merged into the existing state (shallow). */
  state?: EntityState;
  nextWakeAt?: string | null;
  awaitingCorrelation?: Correlation | null;
}

export type EntityRow = typeof schema.durableEntities.$inferSelect;
export type InboxRow = typeof schema.entityInbox.$inferSelect;

export interface ClaimedEntity {
  entity: EntityRow;
  inbox: InboxRow[];
}

export interface ReleaseInput {
  /** New timer wake (undefined = leave as-is; null = clear). */
  nextWakeAt?: string | null;
  /** Inbox rows to mark consumed. */
  consumeInboxIds?: string[];
  /** Merge into state. */
  state?: EntityState;
  /** New correlation token (undefined = leave; null = clear). */
  awaitingCorrelation?: Correlation | null;
  /** Terminal — the entity stops being woken. */
  done?: boolean;
}

export class DurableEntityService {
  constructor(private readonly db: AgentisSqliteDb) {}

  /** Find-or-create by (workspace, kind, key); merges state + applies provided fields. Idempotent. */
  upsert(input: UpsertEntityInput): EntityRow {
    const now = new Date().toISOString();
    const existing = this.getByKey(input.workspaceId, input.kind, input.key);
    if (existing) {
      const mergedState = input.state
        ? { ...(existing.stateJson as EntityState), ...input.state }
        : undefined;
      this.db.update(schema.durableEntities).set({
        ...(input.appId !== undefined ? { appId: input.appId } : {}),
        ...(mergedState ? { stateJson: mergedState } : {}),
        ...(input.nextWakeAt !== undefined ? { nextWakeAt: input.nextWakeAt } : {}),
        ...(input.awaitingCorrelation !== undefined ? { awaitingCorrelationJson: input.awaitingCorrelation } : {}),
        updatedAt: now,
      }).where(eq(schema.durableEntities.id, existing.id)).run();
      return this.get(existing.id)!;
    }
    const id = randomUUID();
    this.db.insert(schema.durableEntities).values({
      id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      key: input.key,
      appId: input.appId ?? null,
      status: 'active',
      stateJson: (input.state ?? {}) as EntityState,
      nextWakeAt: input.nextWakeAt ?? null,
      awaitingCorrelationJson: input.awaitingCorrelation ?? null,
      leaseOwner: null,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.get(id)!;
  }

  get(id: string): EntityRow | null {
    return this.db.select().from(schema.durableEntities).where(eq(schema.durableEntities.id, id)).get() ?? null;
  }

  getByKey(workspaceId: string, kind: string, key: string): EntityRow | null {
    return this.db.select().from(schema.durableEntities)
      .where(and(
        eq(schema.durableEntities.workspaceId, workspaceId),
        eq(schema.durableEntities.kind, kind),
        eq(schema.durableEntities.key, key),
      )).get() ?? null;
  }

  /** All entities of a kind in a workspace (for subject lists / mission-control). */
  listByKind(workspaceId: string, kind: string, limit = 200): EntityRow[] {
    return this.db.select().from(schema.durableEntities)
      .where(and(eq(schema.durableEntities.workspaceId, workspaceId), eq(schema.durableEntities.kind, kind)))
      .limit(limit).all();
  }

  /** Append an external event to an entity's inbox. Wakes it on the next sweep. */
  post(entityId: string, eventType: string, payload?: unknown): string {
    const id = randomUUID();
    this.db.insert(schema.entityInbox).values({
      id, entityId, eventType,
      payloadJson: (payload ?? null) as unknown,
      receivedAt: new Date().toISOString(),
      consumedAt: null,
    }).run();
    return id;
  }

  /**
   * Route an inbound event to the entity awaiting this correlation token (the
   * out-of-order, multi-day reply path). Returns the entity id, or null if none awaits.
   */
  postByCorrelation(workspaceId: string, correlation: Correlation, eventType: string, payload?: unknown): string | null {
    const candidates = this.db.select().from(schema.durableEntities)
      .where(and(
        eq(schema.durableEntities.workspaceId, workspaceId),
        eq(schema.durableEntities.status, 'active'),
        isNotNull(schema.durableEntities.awaitingCorrelationJson),
      )).all();
    const match = candidates.find((e) => {
      const c = e.awaitingCorrelationJson as Correlation | null;
      return c && c.kind === correlation.kind && c.id === correlation.id;
    });
    if (!match) return null;
    this.post(match.id, eventType, payload);
    return match.id;
  }

  /**
   * Claim due entities under a lease. Due = active, lease free/expired, AND
   * (timer elapsed OR unconsumed inbox). Only claims the given `kinds` (so the
   * dispatcher never claims an entity it has no handler for). Each claim is a CAS
   * UPDATE — two concurrent sweeps can't both win the same entity.
   */
  claimDue(opts: { now?: string; leaseOwner: string; leaseMs: number; limit?: number; kinds?: string[] }): ClaimedEntity[] {
    const nowIso = opts.now ?? new Date().toISOString();
    const limit = opts.limit ?? 25;
    const leaseFree = or(isNull(schema.durableEntities.leaseExpiresAt), lt(schema.durableEntities.leaseExpiresAt, nowIso));
    const kindFilter = opts.kinds && opts.kinds.length > 0 ? inArray(schema.durableEntities.kind, opts.kinds) : undefined;

    const timerDue = this.db.select({ id: schema.durableEntities.id }).from(schema.durableEntities)
      .where(and(
        eq(schema.durableEntities.status, 'active'),
        leaseFree,
        isNotNull(schema.durableEntities.nextWakeAt),
        lte(schema.durableEntities.nextWakeAt, nowIso),
        ...(kindFilter ? [kindFilter] : []),
      )).limit(limit * 2).all();

    const inboxDue = this.db.select({ id: schema.durableEntities.id }).from(schema.durableEntities)
      .innerJoin(schema.entityInbox, eq(schema.entityInbox.entityId, schema.durableEntities.id))
      .where(and(
        eq(schema.durableEntities.status, 'active'),
        leaseFree,
        isNull(schema.entityInbox.consumedAt),
        ...(kindFilter ? [kindFilter] : []),
      )).limit(limit * 2).all();

    const ids = [...new Set([...timerDue, ...inboxDue].map((r) => r.id))].slice(0, limit);
    const leaseUntil = new Date(Date.parse(nowIso) + opts.leaseMs).toISOString();
    const claimed: ClaimedEntity[] = [];
    for (const id of ids) {
      const res = this.db.update(schema.durableEntities)
        .set({ leaseOwner: opts.leaseOwner, leaseExpiresAt: leaseUntil })
        .where(and(
          eq(schema.durableEntities.id, id),
          eq(schema.durableEntities.status, 'active'),
          or(isNull(schema.durableEntities.leaseExpiresAt), lt(schema.durableEntities.leaseExpiresAt, nowIso)),
        )).run();
      if (res.changes > 0) {
        const entity = this.get(id)!;
        const inbox = this.db.select().from(schema.entityInbox)
          .where(and(eq(schema.entityInbox.entityId, id), isNull(schema.entityInbox.consumedAt))).all();
        claimed.push({ entity, inbox });
      }
    }
    return claimed;
  }

  /** Finish a wake: consume inbox, advance the clock, merge state, release the lease. */
  release(id: string, input: ReleaseInput = {}): void {
    const now = new Date().toISOString();
    if (input.consumeInboxIds && input.consumeInboxIds.length > 0) {
      this.db.update(schema.entityInbox).set({ consumedAt: now })
        .where(and(inArray(schema.entityInbox.id, input.consumeInboxIds), isNull(schema.entityInbox.consumedAt))).run();
    }
    const current = this.get(id);
    const mergedState = input.state && current
      ? { ...(current.stateJson as EntityState), ...input.state }
      : undefined;
    this.db.update(schema.durableEntities).set({
      leaseOwner: null,
      leaseExpiresAt: null,
      ...(mergedState ? { stateJson: mergedState } : {}),
      ...(input.nextWakeAt !== undefined ? { nextWakeAt: input.nextWakeAt } : {}),
      ...(input.awaitingCorrelation !== undefined ? { awaitingCorrelationJson: input.awaitingCorrelation } : {}),
      ...(input.done ? { status: 'done', nextWakeAt: null } : {}),
      updatedAt: now,
    }).where(eq(schema.durableEntities.id, id)).run();
  }

  /** Re-activate a terminated entity and (re)arm its wake — e.g. residency re-enabled. */
  setActive(id: string, nextWakeAt: string | null): void {
    this.db.update(schema.durableEntities)
      .set({ status: 'active', nextWakeAt, leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() })
      .where(eq(schema.durableEntities.id, id)).run();
  }

  /** Unconsumed inbox for an entity (diagnostics / tests). */
  pendingInbox(entityId: string): InboxRow[] {
    return this.db.select().from(schema.entityInbox)
      .where(and(eq(schema.entityInbox.entityId, entityId), isNull(schema.entityInbox.consumedAt))).all();
  }
}

export interface EntityWakeContext { entity: EntityRow; inbox: InboxRow[]; }
export interface EntityWakeResult {
  nextWakeAt?: string | null;
  /** Inbox rows to mark consumed. Defaults to everything handed to the handler. */
  consumeInboxIds?: string[];
  state?: EntityState;
  awaitingCorrelation?: Correlation | null;
  done?: boolean;
}
export type EntityHandler = (ctx: EntityWakeContext) => Promise<EntityWakeResult | void> | EntityWakeResult | void;

/**
 * DurableEntityDispatcher — the ONE loop that drives the spine (§3.0). On each tick
 * it claims due entities (of kinds it has a handler for) under a lease, runs the
 * handler, and releases with the handler's outcome (advance clock, consume inbox,
 * merge state, or terminate). A handler error releases WITHOUT consuming, so the
 * event is retried next sweep. This is the single wake mechanism the four legacy
 * schedulers fold into over time — a Subject and a resident Agent are just `kind`s
 * registered here.
 */
export class DurableEntityDispatcher {
  readonly #handlers = new Map<string, EntityHandler>();
  readonly #reconcilers: Array<() => void | Promise<void>> = [];
  readonly #owner = `disp-${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly service: DurableEntityService,
    private readonly opts: { leaseMs?: number; limit?: number; logger?: Logger } = {},
  ) {}

  registerHandler(kind: string, handler: EntityHandler): void {
    this.#handlers.set(kind, handler);
  }

  /**
   * A reconciler runs at the START of every tick, before claiming — it keeps the
   * entity set in sync with the world (e.g. "every resident agent has an `agent`
   * entity"). This is how a legacy sweep folds INTO the one dispatcher instead of
   * running as its own scheduler.
   */
  registerReconciler(fn: () => void | Promise<void>): void {
    this.#reconcilers.push(fn);
  }

  hasHandlers(): boolean {
    return this.#handlers.size > 0;
  }

  /** One sweep: reconcile, then claim + drive due entities. Returns how many were handled. */
  async tick(now?: string): Promise<number> {
    for (const r of this.#reconcilers) {
      try { await r(); } catch (err) { this.opts.logger?.warn?.('durable_entity.reconcile_failed', { err: (err as Error).message }); }
    }
    const kinds = [...this.#handlers.keys()];
    if (kinds.length === 0) return 0; // nothing to drive yet — safe no-op
    const claimed = this.service.claimDue({
      ...(now ? { now } : {}),
      leaseOwner: this.#owner,
      leaseMs: this.opts.leaseMs ?? 60_000,
      limit: this.opts.limit ?? 25,
      kinds,
    });
    let handled = 0;
    for (const c of claimed) {
      const handler = this.#handlers.get(c.entity.kind);
      if (!handler) { this.service.release(c.entity.id); continue; }
      try {
        const result = (await handler({ entity: c.entity, inbox: c.inbox })) ?? {};
        this.service.release(c.entity.id, {
          nextWakeAt: result.nextWakeAt,
          consumeInboxIds: result.consumeInboxIds ?? c.inbox.map((i) => i.id),
          state: result.state,
          awaitingCorrelation: result.awaitingCorrelation,
          done: result.done,
        });
        handled += 1;
      } catch (err) {
        this.opts.logger?.warn?.('durable_entity.handler_failed', { entityId: c.entity.id, kind: c.entity.kind, err: (err as Error).message });
        this.service.release(c.entity.id); // clears lease; inbox NOT consumed → retried
      }
    }
    return handled;
  }
}
