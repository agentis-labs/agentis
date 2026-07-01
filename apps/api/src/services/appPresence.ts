/**
 * AppPresenceService — live co-presence over the existing realtime bus
 * (LIVING-APPS-10X §6 / G9). EPHEMERAL: presence lives only in memory + on the
 * realtime bus, never in the DB. It answers "who else is on this App / thread
 * right now?" so two operators can tell they overlap and the interface feels live.
 *
 * Model: each viewer heartbeats `join(appId, conversationId?)` while their console
 * is open. The service keeps one entry per (app, viewer) and re-broadcasts the
 * full roster (APP_PRESENCE_UPDATED) on every change to the App room + the
 * workspace room (same dual-publish pattern as DATA_CHANGED, so the web — which
 * subscribes to the workspace room — receives it). A background sweep expires
 * stale viewers (missed heartbeats) and re-broadcasts when the roster shrinks.
 *
 * Best-effort + non-throwing: presence failure must never affect message
 * delivery or rendering. Without a bus it degrades to a no-op roster.
 */

import { REALTIME_EVENTS, REALTIME_ROOMS, type AppPresenceUpdate, type AppPresenceViewer } from '@agentis/core';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';

interface PresenceEntry {
  userId: string;
  name: string;
  workspaceId: string;
  conversationId: string | null;
  lastSeen: number;
}

export interface PresenceHeartbeat {
  workspaceId: string;
  appId: string;
  userId: string;
  name: string;
  conversationId?: string | null;
}

/** A viewer is considered gone if it hasn't heartbeat within this window. */
export const PRESENCE_TTL_MS = 15_000;
/** How often the sweep runs to expire stale viewers. */
const PRESENCE_SWEEP_MS = 5_000;

export class AppPresenceService {
  // appId → (userId → entry). One entry per viewer per App.
  readonly #byApp = new Map<string, Map<string, PresenceEntry>>();
  #sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: { bus?: EventBus; logger?: Logger; now?: () => number },
  ) {}

  #now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Record/refresh a viewer's heartbeat on an App (and its open thread), then broadcast. */
  join(input: PresenceHeartbeat): AppPresenceViewer[] {
    try {
      let viewers = this.#byApp.get(input.appId);
      if (!viewers) {
        viewers = new Map();
        this.#byApp.set(input.appId, viewers);
      }
      viewers.set(input.userId, {
        userId: input.userId,
        name: input.name,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId ?? null,
        lastSeen: this.#now(),
      });
      return this.#broadcast(input.appId);
    } catch (err) {
      this.deps.logger?.warn('app.presence.join_failed', { appId: input.appId, err: (err as Error).message });
      return [];
    }
  }

  /** Drop a viewer from an App (explicit leave / unmount), then broadcast. */
  leave(appId: string, userId: string): AppPresenceViewer[] {
    try {
      const viewers = this.#byApp.get(appId);
      if (!viewers || !viewers.delete(userId)) return this.#roster(appId);
      if (viewers.size === 0) this.#byApp.delete(appId);
      return this.#broadcast(appId);
    } catch (err) {
      this.deps.logger?.warn('app.presence.leave_failed', { appId, err: (err as Error).message });
      return [];
    }
  }

  /** Current (non-expired) roster for an App — used by tests + the join response. */
  roster(appId: string): AppPresenceViewer[] {
    this.#expire(appId);
    return this.#roster(appId);
  }

  #roster(appId: string): AppPresenceViewer[] {
    const viewers = this.#byApp.get(appId);
    if (!viewers) return [];
    return [...viewers.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({
        userId: e.userId,
        name: e.name,
        conversationId: e.conversationId,
        at: new Date(e.lastSeen).toISOString(),
      }));
  }

  /** Drop viewers whose last heartbeat is older than the TTL. Returns true if any expired. */
  #expire(appId: string): boolean {
    const viewers = this.#byApp.get(appId);
    if (!viewers) return false;
    const cutoff = this.#now() - PRESENCE_TTL_MS;
    let changed = false;
    for (const [userId, entry] of viewers) {
      if (entry.lastSeen < cutoff) {
        viewers.delete(userId);
        changed = true;
      }
    }
    if (viewers.size === 0) this.#byApp.delete(appId);
    return changed;
  }

  #broadcast(appId: string): AppPresenceViewer[] {
    const roster = this.#roster(appId);
    if (this.deps.bus) {
      const payload: AppPresenceUpdate = { appId, viewers: roster };
      // Dual-publish so both an App-room and a workspace-room subscriber get it.
      this.deps.bus.publish(REALTIME_ROOMS.app(appId), REALTIME_EVENTS.APP_PRESENCE_UPDATED, payload);
      const ws = this.#workspaceOf(appId);
      if (ws) this.deps.bus.publish(REALTIME_ROOMS.workspace(ws), REALTIME_EVENTS.APP_PRESENCE_UPDATED, payload);
    }
    return roster;
  }

  #workspaceOf(appId: string): string | null {
    const viewers = this.#byApp.get(appId);
    const first = viewers?.values().next().value;
    return first?.workspaceId ?? null;
  }

  /** Start the periodic stale-viewer sweep (idempotent). Best-effort; unref'd. */
  start(): void {
    if (this.#sweepTimer) return;
    this.#sweepTimer = setInterval(() => {
      for (const appId of [...this.#byApp.keys()]) {
        if (this.#expire(appId)) this.#broadcast(appId);
      }
    }, PRESENCE_SWEEP_MS);
    this.#sweepTimer.unref?.();
  }

  stop(): void {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
  }
}
