/**
 * AppGoalService — read/write an App's durable, cross-run **Goal** (Evolution
 * Loop north-star). The Goal is the reserved long-term tier: an App states what
 * it is trying to achieve over time (+ an optional metric to optimize), and that
 * Goal steers the competing Strategies the loop measures and evolves.
 *
 * Storage: the Goal rides in the App manifest (`AppIdentity.goal`) — portable,
 * versioned with the App, no migration. On change, the Goal is ALSO mirrored as
 * a governing App-Brain atom (scope = appId, system_write, high importance) so
 * every run in the App's scope recalls the Goal as constitutional context —
 * reusing the existing dispatch-recall path rather than bespoke prompt plumbing.
 */

import type { AppGoal } from '@agentis/core';
import { buildAppStores } from '@agentis/app';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../../event-bus.js';
import type { Logger } from '../../logger.js';
import type { SharedIntelligenceService } from '../sharedIntelligence.js';

export interface AppGoalServiceDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
  /** Mirrors the Goal into the App Brain so runs recall it. */
  shared: Pick<SharedIntelligenceService, 'commitDurableAtom'>;
  logger: Logger;
}

/** Render a Goal as the constitutional text injected into every App-scoped run. */
export function goalToText(goal: AppGoal): string {
  const north = goal.northStar
    ? ` North-star metric: ${goal.northStar.direction} "${goal.northStar.metric}"${goal.northStar.target != null ? ` (target ${goal.northStar.target})` : ''}.`
    : '';
  return `This App's Goal (its durable north-star across runs): ${goal.statement.trim()}${north} Pursue and evolve strategies toward this Goal; report progress against it.`;
}

export class AppGoalService {
  constructor(private readonly deps: AppGoalServiceDeps) {}

  #stores() {
    return buildAppStores({ db: this.deps.db, bus: this.deps.bus });
  }

  /** The App's current Goal, or null if none is set. Throws if the App is missing. */
  get(workspaceId: string, appId: string): AppGoal | null {
    const app = this.#stores().store.get(workspaceId, appId); // 404s if missing
    return app.manifest.goal ?? null;
  }

  /**
   * Set/replace the App's Goal. Persists to the manifest and, when the statement
   * or metric actually changed, mirrors a fresh governing atom into the App Brain
   * so the change is recalled (unchanged goals only bump the timestamp — no atom
   * churn).
   */
  async set(workspaceId: string, appId: string, goal: AppGoal, actorAgentId?: string | null): Promise<AppGoal> {
    const stores = this.#stores();
    const current = stores.store.get(workspaceId, appId).manifest.goal ?? null;
    const next: AppGoal = {
      statement: goal.statement.trim(),
      ...(goal.northStar ? { northStar: goal.northStar } : {}),
      updatedAt: new Date().toISOString(),
    };
    stores.store.update(workspaceId, appId, { manifest: { goal: next } });

    const changed = !current
      || current.statement.trim() !== next.statement
      || JSON.stringify(current.northStar ?? null) !== JSON.stringify(next.northStar ?? null);
    if (changed) {
      try {
        await this.deps.shared.commitDurableAtom({
          workspaceId,
          scopeId: appId, // App Brain scope — recalled by every run the App owns
          agentId: actorAgentId ?? null,
          title: `App Goal — ${next.statement.slice(0, 80)}`,
          content: goalToText(next),
          type: 'decision',
          source: 'system_write', // constitutional: always injected, never auto-archived
          tags: ['goal', 'charter', 'app_goal'],
          importance: 1,
          confidence: 1,
          metadata: { kind: 'app_goal', appId, goal: next },
        });
      } catch (err) {
        this.deps.logger.warn('app.goal.mirror_failed', { appId, err: (err as Error).message });
      }
    }
    return next;
  }
}
