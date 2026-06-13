/**
 * Listener health + event-log store — EXTENSIONS-AND-LISTENER-10X §1.7, §4.3, §4.4.
 *
 * Health is kept in-memory: it is a live diagnostic surface, not an audit log.
 * The event log is a bounded ring buffer per trigger (default 100 events) so
 * operators can see exactly which events arrived and why they were/weren't
 * fired — without persisting a firehose to SQLite. (DB-persisted event logs
 * are an opt-in follow-up — see §11 Open Questions.)
 */

import { randomUUID } from 'node:crypto';
import type {
  FirePolicyMode,
  ListenerEventLogEntry,
  ListenerHealth,
  ListenerSourceKind,
  PredicateResult,
} from '@agentis/core';

const EVENT_LOG_LIMIT = 100;

function emptyHealth(sourceKind: ListenerSourceKind): ListenerHealth {
  return {
    connected: false,
    status: 'connecting',
    sourceKind,
    eventCount: 0,
    fireCount: 0,
    skipCount: 0,
    errorCount: 0,
    consecutiveErrors: 0,
  };
}

export class ListenerHealthStore {
  readonly #health = new Map<string, ListenerHealth>();
  readonly #events = new Map<string, ListenerEventLogEntry[]>();

  register(triggerId: string, sourceKind: ListenerSourceKind): void {
    this.#health.set(triggerId, emptyHealth(sourceKind));
    this.#events.set(triggerId, []);
  }

  remove(triggerId: string): void {
    this.#health.delete(triggerId);
    this.#events.delete(triggerId);
  }

  get(triggerId: string): ListenerHealth | undefined {
    return this.#health.get(triggerId);
  }

  events(triggerId: string, limit = EVENT_LOG_LIMIT): ListenerEventLogEntry[] {
    const log = this.#events.get(triggerId) ?? [];
    return limit >= log.length ? [...log].reverse() : log.slice(log.length - limit).reverse();
  }

  clearEvents(triggerId: string): void {
    this.#events.set(triggerId, []);
  }

  #mutate(triggerId: string, fn: (h: ListenerHealth) => void): void {
    const current = this.#health.get(triggerId);
    if (!current) return;
    fn(current);
  }

  setStatus(triggerId: string, status: ListenerHealth['status']): void {
    this.#mutate(triggerId, (h) => {
      h.status = status;
      if (status !== 'active' && status !== 'connecting') h.connected = false;
    });
  }

  markConnected(triggerId: string, connected: boolean): void {
    this.#mutate(triggerId, (h) => {
      h.connected = connected;
      if (connected) {
        h.status = 'active';
        h.consecutiveErrors = 0;
      }
    });
  }

  /** Record a received event; returns the new log entry id. */
  recordEvent(triggerId: string, payload: Record<string, unknown>): string {
    const id = `evt_${randomUUID()}`;
    this.#mutate(triggerId, (h) => {
      h.eventCount += 1;
      h.lastEventAt = new Date().toISOString();
    });
    const log = this.#events.get(triggerId);
    if (log) {
      log.push({ id, receivedAt: new Date().toISOString(), payloadSummary: summarize(payload) });
      if (log.length > EVENT_LOG_LIMIT) log.splice(0, log.length - EVENT_LOG_LIMIT);
    }
    return id;
  }

  recordPredicate(triggerId: string, eventId: string, result: PredicateResult): void {
    if (!result.matched) this.#mutate(triggerId, (h) => void (h.skipCount += 1));
    this.#patchEntry(triggerId, eventId, (e) => void (e.predicateResult = result));
  }

  recordFire(triggerId: string, eventId: string, runId: string): void {
    this.#mutate(triggerId, (h) => {
      h.fireCount += 1;
      h.lastFireAt = new Date().toISOString();
    });
    this.#patchEntry(triggerId, eventId, (e) => void (e.firedRunId = runId));
  }

  recordSuppressed(triggerId: string, eventId: string, policy: FirePolicyMode): void {
    this.#mutate(triggerId, (h) => void (h.skipCount += 1));
    this.#patchEntry(triggerId, eventId, (e) => void (e.suppressedBy = policy));
  }

  recordError(triggerId: string, message: string): void {
    this.#mutate(triggerId, (h) => {
      h.errorCount += 1;
      h.consecutiveErrors += 1;
      h.lastError = message;
    });
  }

  #patchEntry(triggerId: string, eventId: string, fn: (e: ListenerEventLogEntry) => void): void {
    const entry = this.#events.get(triggerId)?.find((e) => e.id === eventId);
    if (entry) fn(entry);
  }
}

function summarize(payload: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(payload);
    return json.length > 280 ? `${json.slice(0, 277)}…` : json;
  } catch {
    return '[unserializable payload]';
  }
}
