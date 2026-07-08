/**
 * ActiveWorkflowRegistry — V1-SPEC §7.1.
 *
 * Tracks which workflows have an active trigger attached and exposes
 * lifecycle methods to activate/deactivate/reload/list. On boot we
 * rehydrate from the `triggers` table; on every trigger CRUD operation the
 * caller hits this registry to keep the runtime in sync.
 *
 * The registry doesn't fire workflows itself — TriggerRuntime owns the
 * cron + webhook + persistent_listener machinery. The registry is the
 * authoritative "is this trigger live" flag the runtime consults.
 */

import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';

export interface ActiveTrigger {
  triggerId: string;
  workflowId: string;
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  triggerType:
    | 'manual'
    | 'cron'
    | 'webhook'
    | 'persistent_listener'
    | 'data_event'
    | 'workflow_completed';
  config: Record<string, unknown>;
}

export class ActiveWorkflowRegistry {
  readonly #active = new Map<string, ActiveTrigger>();
  /** triggerId → cleanup fn (cron stop, listener close). */
  readonly #cleanup = new Map<string, () => Promise<void>>();

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {}

  list(): ActiveTrigger[] {
    return Array.from(this.#active.values());
  }

  get(triggerId: string): ActiveTrigger | undefined {
    return this.#active.get(triggerId);
  }

  /** Mark a trigger active and remember a cleanup hook. */
  activate(trigger: ActiveTrigger, cleanup: () => Promise<void>): void {
    this.#active.set(trigger.triggerId, trigger);
    this.#cleanup.set(trigger.triggerId, cleanup);
    this.db
      .update(schema.triggers)
      .set({ status: 'active', updatedAt: new Date().toISOString() })
      .where(eq(schema.triggers.id, trigger.triggerId))
      .run();
  }

  async deactivate(triggerId: string): Promise<void> {
    const c = this.#cleanup.get(triggerId);
    if (c) {
      try {
        await c();
      } catch (err) {
        this.logger.warn('trigger.deactivate_cleanup_failed', { triggerId, err: (err as Error).message });
      }
    }
    this.#cleanup.delete(triggerId);
    this.#active.delete(triggerId);
    this.db
      .update(schema.triggers)
      .set({ status: 'paused', updatedAt: new Date().toISOString() })
      .where(eq(schema.triggers.id, triggerId))
      .run();
  }

  /** Load all `status='active'` triggers from DB. Caller wires them through TriggerRuntime. */
  loadActiveFromDb(): ActiveTrigger[] {
    const rows = this.db
      .select()
      .from(schema.triggers)
      .where(eq(schema.triggers.status, 'active'))
      .all();
    return rows.map((r) => ({
      triggerId: r.id,
      workflowId: r.workflowId,
      workspaceId: r.workspaceId,
      ambientId: r.ambientId,
      userId: r.userId,
      triggerType: r.triggerType as ActiveTrigger['triggerType'],
      config: (r.config ?? {}) as Record<string, unknown>,
    }));
  }

  async shutdown(): Promise<void> {
    for (const triggerId of Array.from(this.#cleanup.keys())) {
      await this.deactivate(triggerId);
    }
  }
}
