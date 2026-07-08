/**
 * /v1/observability - replayable command-center event stream.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { REALTIME_EVENTS } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { AuthService } from '../services/auth.js';
import { ObservabilityService, type ObservabilityEvent } from '../services/observability.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

export function buildObservabilityRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  bus: EventBus;
  observability: ObservabilityService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/events', (c) => {
    const ws = getWorkspace(c);
    const query = parseObservabilityQuery(c.req.query());
    const events = deps.observability.list({
      workspaceId: ws.workspaceId,
      scopeType: query.scopeType,
      scopeId: query.scopeId,
      afterSequence: query.afterSequence,
      limit: query.limit,
    });
    return c.json({ events });
  });

  app.get('/stream', (c) => {
    const ws = getWorkspace(c);
    const query = parseObservabilityQuery(c.req.query());
    return streamSSE(c, async (stream) => {
      let closed = false;
      let unsubscribe: () => void = () => {};
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
      };
      const write = async (event: string, data: unknown) => {
        if (closed) return;
        try {
          await stream.writeSSE({ event, data: JSON.stringify(data) });
        } catch {
          close();
        }
      };

      const replay = deps.observability.list({
        workspaceId: ws.workspaceId,
        scopeType: query.scopeType,
        scopeId: query.scopeId,
        afterSequence: query.afterSequence,
        limit: query.limit,
      });
      for (const event of replay) await write(REALTIME_EVENTS.OBSERVABILITY_EVENT, event);

      unsubscribe = deps.bus.subscribe((message) => {
        if (message.envelope.event !== REALTIME_EVENTS.OBSERVABILITY_EVENT) return;
        const event = asObservabilityEvent(message.envelope.payload);
        if (!event) return;
        if (!deps.observability.matchesScope(event, {
          workspaceId: ws.workspaceId,
          scopeType: query.scopeType,
          scopeId: query.scopeId,
        })) return;
        void write(REALTIME_EVENTS.OBSERVABILITY_EVENT, event);
      });
      heartbeat = setInterval(() => {
        void write('heartbeat', { type: 'HEARTBEAT', at: new Date().toISOString() });
      }, 15_000);
      if (typeof heartbeat === 'object' && 'unref' in heartbeat) heartbeat.unref();

      c.req.raw.signal.addEventListener('abort', close, { once: true });
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      close();
    });
  });

  return app;
}

function parseObservabilityQuery(query: Record<string, string | undefined>): {
  scopeType: string;
  scopeId: string | null;
  afterSequence: number;
  limit: number;
} {
  const scopeType = normalizeScope(query.scope ?? query.scopeType);
  const scopeId = query.scopeId?.trim() || null;
  const afterSequence = numberQuery(query.afterSequence ?? query.after_sequence, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = numberQuery(query.limit, 120, 1, 500);
  return { scopeType, scopeId, afterSequence, limit };
}

function normalizeScope(value: string | undefined): string {
  const next = value?.trim();
  return next === 'run' || next === 'agent' || next === 'workflow' || next === 'brain' ? next : 'workspace';
}

function numberQuery(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function asObservabilityEvent(value: unknown): ObservabilityEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<ObservabilityEvent>;
  return typeof record.id === 'string'
    && typeof record.workspaceId === 'string'
    && typeof record.sequenceNumber === 'number'
    ? record as ObservabilityEvent
    : null;
}
