/**
 * Source drivers — EXTENSIONS-AND-LISTENER-10X §1.2, §1.7.
 *
 * Each ListenerSource kind becomes a concrete SourceDriver. Drivers that need
 * native dependencies not present on a vanilla Node 24 host (Kafka/AMQP/SQS,
 * Postgres LISTEN/NOTIFY) resolve to an UnavailableSource that fails activation
 * with a clear, structured error instead of crashing boot. The websocket / sse
 * / http_poll drivers use Node 24 globals (WebSocket, fetch, ReadableStream)
 * with zero new dependencies.
 */

import { watch, type FSWatcher } from 'node:fs';
import {
  AgentisError,
  REALTIME_EVENTS,
  type ListenerSource,
  type SourceDriver,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import type { Logger } from '../../logger.js';
import type { EventBus } from '../../event-bus.js';
import type { ExtensionRuntime } from '../../services/extensionRuntime.js';
import { assertSafeUrl } from '../../services/safeUrl.js';
import { getPath } from './jsonpath.js';
import type { ListenerCursor } from './cursor.js';

export interface SourceDeps {
  workspaceId: string;
  workflowId: string;
  triggerId: string;
  logger: Logger;
  bus: EventBus;
  db: AgentisSqliteDb;
  extensionRuntime?: ExtensionRuntime;
  cursor?: ListenerCursor;
  allowPrivateNetwork: boolean;
  onConnectionChange?: (connected: boolean) => void;
  onError?: (error: Error) => void;
}

const MIN_POLL_MS = 5_000;
/** Heartbeat floor — no external call, so it can tick faster than a network poll. */
const MIN_INTERVAL_MS = 1_000;

export function createSourceDriver(source: ListenerSource, deps: SourceDeps): SourceDriver {
  switch (source.kind) {
    case 'interval':
      return new IntervalSource(source, deps);
    case 'http_poll':
      return new HttpPollSource(source, deps);
    case 'websocket':
      return new WebSocketSource(source, deps);
    case 'sse':
      return new SseSource(source, deps);
    case 'extension':
      return new ExtensionSource(source, deps);
    case 'agent_event':
      return new AgentEventSource(source, deps);
    case 'workflow_event':
      return new WorkflowEventSource(source, deps);
    case 'file_watch':
      return new FileWatchSource(source, deps);
    case 'rss':
      return new RssSource(source, deps);
    case 'email_imap':
      return new UnavailableSource('email_imap', 'IMAP email sources require an IMAP client add-on not installed on this host.');
    case 'message_queue':
      return new UnavailableSource('message_queue', `Message-queue sources (${source.protocol}) require a broker client add-on not installed on this host.`);
    case 'db_notify':
      return new UnavailableSource('db_notify', 'Postgres LISTEN/NOTIFY sources require a pg client add-on not installed on this host.');
  }
}

// ── interval (heartbeat / "run every N seconds") ─────────────────────────────

class IntervalSource implements SourceDriver {
  readonly kind = 'interval' as const;
  #timer: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  #tick = 0;
  #intervalMs: number;

  constructor(private readonly source: Extract<ListenerSource, { kind: 'interval' }>, private readonly deps: SourceDeps) {
    this.#intervalMs = Math.max(MIN_INTERVAL_MS, source.intervalMs);
  }

  async start(onEvent: (payload: Record<string, unknown>) => void): Promise<void> {
    // A timer is "connected" the moment it is scheduled — there is no transport.
    this.deps.onConnectionChange?.(true);
    const fire = () => {
      if (this.#closed) return;
      this.#tick += 1;
      onEvent({ ...(this.source.payload ?? {}), tick: this.#tick, firedAt: new Date().toISOString() });
    };
    if (this.source.fireOnStart) fire();
    this.#timer = setInterval(fire, this.#intervalMs);
    this.#timer.unref?.();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.deps.onConnectionChange?.(false);
  }

  isConnected(): boolean {
    return !this.#closed && this.#timer !== null;
  }
}

// ── rss (RSS/Atom feed poller) ────────────────────────────────────────────────

class RssSource implements SourceDriver {
  readonly kind = 'rss' as const;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #connected = false;
  #seen = new Set<string>();
  #primed = false;
  #intervalMs: number;

  constructor(private readonly source: Extract<ListenerSource, { kind: 'rss' }>, private readonly deps: SourceDeps) {
    this.#intervalMs = Math.max(MIN_POLL_MS, source.intervalMs ?? 300_000);
  }

  async start(onEvent: (payload: Record<string, unknown>) => void): Promise<void> {
    const poll = async () => {
      if (this.#closed) return;
      try {
        await this.#pollOnce(onEvent);
        this.#connected = true;
        this.deps.onConnectionChange?.(true);
      } catch (err) {
        this.#connected = false;
        const error = asError(err);
        this.deps.onConnectionChange?.(false);
        this.deps.onError?.(error);
        this.deps.logger.warn('listener.rss.error', { triggerId: this.deps.triggerId, err: error.message });
      } finally {
        if (!this.#closed) {
          this.#timer = setTimeout(() => void poll().catch(() => {}), this.#intervalMs);
          this.#timer.unref?.();
        }
      }
    };
    void poll();
  }

  async #pollOnce(onEvent: (payload: Record<string, unknown>) => void): Promise<void> {
    const safe = await assertSafeUrl(this.source.feedUrl, { allowPrivate: this.deps.allowPrivateNetwork, allowedDomains: [] });
    const res = await fetch(safe.toString(), { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', ...(this.source.headers ?? {}) } });
    const text = await res.text();
    const items = parseFeedItems(text);
    // First poll primes the seen-set without emitting, so activation does not
    // flood the workflow with the whole backlog (n8n RSS-trigger behavior).
    for (const item of items) {
      const id = String(item.id ?? item.link ?? item.guid ?? item.title ?? JSON.stringify(item));
      if (this.#seen.has(id)) continue;
      this.#seen.add(id);
      if (this.#primed) onEvent(item);
    }
    this.#primed = true;
    // Bound memory: keep the seen-set from growing forever on a busy feed.
    if (this.#seen.size > 5_000) this.#seen = new Set([...this.#seen].slice(-2_000));
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#connected = false;
  }

  isConnected(): boolean {
    return this.#connected && !this.#closed;
  }
}

/** Extract item/entry records from an RSS 2.0 or Atom feed (dependency-free). */
export function parseFeedItems(xml: string): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  const blockRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml))) {
    const body = m[2] ?? '';
    const field = (name: string): string | undefined => {
      const tag = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(body);
      if (tag) return cleanXmlText(tag[1] ?? '');
      // Atom link is an attribute: <link href="..."/>
      const attr = new RegExp(`<${name}\\b[^>]*href=["']([^"']+)["']`, 'i').exec(body);
      return attr ? attr[1] : undefined;
    };
    items.push({
      title: field('title'),
      link: field('link'),
      guid: field('guid') ?? field('id'),
      id: field('guid') ?? field('id') ?? field('link'),
      pubDate: field('pubDate') ?? field('published') ?? field('updated'),
      description: field('description') ?? field('summary') ?? field('content'),
    });
  }
  return items;
}

function cleanXmlText(s: string): string {
  return decodeXmlEntities(stripXmlTags(unwrapCdata(s))).trim();
}

function unwrapCdata(value: string): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf('<![CDATA[', i);
    if (start < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, start);
    const bodyStart = start + '<![CDATA['.length;
    const end = value.indexOf(']]>', bodyStart);
    if (end < 0) {
      out += value.slice(bodyStart);
      break;
    }
    out += value.slice(bodyStart, end);
    i = end + 3;
  }
  return out;
}

function stripXmlTags(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '<') {
      out += value[i];
      continue;
    }
    const end = value.indexOf('>', i + 1);
    if (end < 0) {
      out += value.slice(i);
      break;
    }
    i = end;
  }
  return out;
}

function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    '#39': "'",
  };
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '&') {
      out += value[i];
      continue;
    }
    const semi = value.indexOf(';', i + 1);
    if (semi < 0 || semi - i > 12) {
      out += value[i];
      continue;
    }
    const key = value.slice(i + 1, semi);
    out += named[key] ?? value.slice(i, semi + 1);
    i = semi;
  }
  return out;
}

// ── http_poll ────────────────────────────────────────────────────────────────

class HttpPollSource implements SourceDriver {
  readonly kind = 'http_poll' as const;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #connected = false;
  #intervalMs: number;

  constructor(private readonly source: Extract<ListenerSource, { kind: 'http_poll' }>, private readonly deps: SourceDeps) {
    this.#intervalMs = Math.max(MIN_POLL_MS, source.intervalMs);
  }

  async start(onEvent: (payload: Record<string, unknown>) => void): Promise<void> {
    const poll = async () => {
      if (this.#closed) return;
      try {
        const emitted = await this.#pollOnce(onEvent);
        this.#connected = true;
        this.deps.onConnectionChange?.(true);
        if (this.source.adaptiveBackoff) {
          this.#intervalMs = emitted > 0
            ? Math.max(MIN_POLL_MS, this.source.intervalMs)
            : Math.min(this.#intervalMs * 2, 600_000);
        }
      } catch (err) {
        this.#connected = false;
        const error = asError(err);
        this.deps.onConnectionChange?.(false);
        this.deps.onError?.(error);
        this.deps.logger.warn('listener.http_poll.error', { triggerId: this.deps.triggerId, err: error.message });
      } finally {
        this.#scheduleNext(poll);
      }
    };
    void poll();
  }

  #scheduleNext(poll: () => Promise<void>): void {
    if (this.#closed) return;
    this.#timer = setTimeout(() => void poll().catch(() => {}), this.#intervalMs);
    this.#timer.unref?.();
  }

  async #pollOnce(onEvent: (payload: Record<string, unknown>) => void): Promise<number> {
    let url = this.source.url;
    const cursorValue = this.deps.cursor?.read();
    if (this.source.cursor?.includeCursorInPayload && cursorValue != null) {
      const param = this.source.cursor.cursorParamName ?? 'since';
      const u = new URL(url);
      u.searchParams.set(param, String(cursorValue));
      url = u.toString();
    }
    const safe = await assertSafeUrl(url, { allowPrivate: this.deps.allowPrivateNetwork, allowedDomains: [] });
    const res = await fetch(safe.toString(), {
      method: this.source.method ?? 'GET',
      headers: this.source.headers,
      body: this.source.body != null ? JSON.stringify(this.source.body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    const items = this.source.itemsPath ? getPath(parsed, this.source.itemsPath) : parsed;
    let count = 0;
    if (Array.isArray(items)) {
      for (const item of items) {
        const event = asRecord(item);
        onEvent(event);
        this.deps.cursor?.advanceFrom(event);
        count += 1;
      }
    } else {
      const event = asRecord(parsed);
      onEvent(event);
      this.deps.cursor?.advanceFrom(event);
      count = 1;
    }
    return count;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#connected = false;
  }

  isConnected(): boolean {
    return this.#connected && !this.#closed;
  }
}

// ── websocket ──────────────────────────────────────────────────────────────

class WebSocketSource implements SourceDriver {
  readonly kind = 'websocket' as const;
  #ws: WebSocket | null = null;
  #closed = false;
  #reconnects = 0;

  constructor(private readonly source: Extract<ListenerSource, { kind: 'websocket' }>, private readonly deps: SourceDeps) {}

  async start(onEvent: (payload: Record<string, unknown>) => void): Promise<void> {
    if (typeof WebSocket === 'undefined') {
      throw new AgentisError('LISTENER_SOURCE_UNAVAILABLE', 'global WebSocket is unavailable on this runtime');
    }
    await assertSafeUrl(this.source.url.replace(/^ws/, 'http'), { allowPrivate: this.deps.allowPrivateNetwork, allowedDomains: [] });
    this.#connect(onEvent);
  }

  #connect(onEvent: (payload: Record<string, unknown>) => void): void {
    if (this.#closed) return;
    const ws = new WebSocket(this.source.url);
    this.#ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      const format = this.source.messageFormat ?? 'json';
      const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
      if (format === 'text') return onEvent({ message: data });
      try {
        onEvent(asRecord(JSON.parse(data)));
      } catch {
        onEvent({ raw: data });
      }
    };
    ws.onopen = () => {
      this.#reconnects = 0;
      this.deps.onConnectionChange?.(true);
      this.deps.logger.info('listener.websocket.open', { triggerId: this.deps.triggerId });
    };
    ws.onclose = () => {
      this.deps.onConnectionChange?.(false);
      if (this.#closed) return;
      const max = this.source.maxReconnects ?? Infinity;
      if (this.#reconnects >= max) return;
      this.#reconnects += 1;
      const base = this.source.reconnectBackoffMs ?? 1000;
      const delay = Math.min(base * 2 ** Math.min(this.#reconnects, 6), 60_000);
      setTimeout(() => this.#connect(onEvent), delay).unref?.();
    };
    ws.onerror = () => {
      this.deps.onError?.(new Error('WebSocket source connection failed'));
      this.deps.logger.warn('listener.websocket.error', { triggerId: this.deps.triggerId });
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    try {
      this.#ws?.close();
    } catch {
      /* ignore */
    }
    this.#ws = null;
  }

  isConnected(): boolean {
    return !this.#closed && this.#ws?.readyState === WebSocket.OPEN;
  }
}

// ── sse ──────────────────────────────────────────────────────────────────────

class SseSource implements SourceDriver {
  readonly kind = 'sse' as const;
  #closed = false;
  #connected = false;
  #controller: AbortController | null = null;

  constructor(private readonly source: Extract<ListenerSource, { kind: 'sse' }>, private readonly deps: SourceDeps) {}

  async start(onEvent: (payload: Record<string, unknown>) => void): Promise<void> {
    const safe = await assertSafeUrl(this.source.url, { allowPrivate: this.deps.allowPrivateNetwork, allowedDomains: [] });
    void this.#stream(safe.toString(), onEvent);
  }

  async #stream(url: string, onEvent: (payload: Record<string, unknown>) => void): Promise<void> {
    while (!this.#closed) {
      this.#controller = new AbortController();
      try {
        const res = await fetch(url, {
          headers: { Accept: 'text/event-stream', ...(this.source.headers ?? {}) },
          signal: this.#controller.signal,
        });
        if (!res.body) throw new Error('SSE response has no body');
        this.#connected = true;
        this.deps.onConnectionChange?.(true);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            this.#dispatch(rawEvent, onEvent);
          }
        }
      } catch (err) {
        if (this.#closed) return;
        const error = asError(err);
        this.deps.onError?.(error);
        this.deps.logger.warn('listener.sse.error', { triggerId: this.deps.triggerId, err: error.message });
      } finally {
        this.#connected = false;
        this.deps.onConnectionChange?.(false);
      }
      if (this.#closed) return;
      await delay(this.source.reconnectDelayMs ?? 3000);
    }
  }

  #dispatch(rawEvent: string, onEvent: (payload: Record<string, unknown>) => void): void {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    if (this.source.eventTypes?.length && !this.source.eventTypes.includes(eventName)) return;
    const data = dataLines.join('\n');
    try {
      onEvent({ event: eventName, ...asRecord(JSON.parse(data)) });
    } catch {
      onEvent({ event: eventName, data });
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#controller?.abort();
    this.#connected = false;
  }

  isConnected(): boolean {
    return this.#connected && !this.#closed;
  }
}

// ── extension (the power move) ────────────────────────────────────────────────

class ExtensionSource implements SourceDriver {
  readonly kind = 'extension' as const;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #connected = false;

  constructor(private readonly source: Extract<ListenerSource, { kind: 'extension' }>, private readonly deps: SourceDeps) {}

  async start(onEvent: (payload: Record<string, unknown>) => void): Promise<void> {
    if (!this.deps.extensionRuntime) {
      throw new AgentisError('LISTENER_SOURCE_UNAVAILABLE', 'extension runtime is not wired');
    }
    const interval = Math.max(MIN_POLL_MS, this.source.pollIntervalMs ?? 60_000);
    const tick = async () => {
      if (this.#closed) return;
      try {
        await this.deps.extensionRuntime!.executeListenerSource({
          workspaceId: this.deps.workspaceId,
          extensionId: this.source.extensionId,
          extensionSlug: this.source.extensionSlug,
          operationName: this.source.operationName,
          config: this.source.config ?? {},
          cursor: this.deps.cursor,
          onEmit: onEvent,
        });
        this.#connected = true;
        this.deps.onConnectionChange?.(true);
      } catch (err) {
        this.#connected = false;
        const error = asError(err);
        this.deps.onConnectionChange?.(false);
        this.deps.onError?.(error);
        this.deps.logger.warn('listener.extension.error', { triggerId: this.deps.triggerId, err: error.message });
      } finally {
        if (!this.#closed) {
          this.#timer = setTimeout(() => void tick(), interval);
          this.#timer.unref?.();
        }
      }
    };
    void tick();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#connected = false;
  }

  isConnected(): boolean {
    return this.#connected && !this.#closed;
  }
}

// ── bus-backed sources ─────────────────────────────────────────────────────

const RUN_STATUS_EVENTS: Record<string, string> = {
  COMPLETED: REALTIME_EVENTS.RUN_COMPLETED,
  FAILED: REALTIME_EVENTS.RUN_FAILED,
  CANCELLED: REALTIME_EVENTS.RUN_FAILED,
};

class AgentEventSource implements SourceDriver {
  readonly kind = 'agent_event' as const;
  #unsub: (() => void) | null = null;

  constructor(private readonly source: Extract<ListenerSource, { kind: 'agent_event' }>, private readonly deps: SourceDeps) {}

  async start(onEvent: (payload: Record<string, unknown>) => void): Promise<void> {
    const room = `agent:${this.source.agentId}`;
    this.#unsub = this.deps.bus.subscribe(({ room: msgRoom, envelope }) => {
      if (msgRoom !== room) return;
      if (this.source.eventTypes.length && !this.source.eventTypes.includes(envelope.event)) return;
      onEvent({ event: envelope.event, ...asRecord(envelope.payload) });
    });
  }

  async close(): Promise<void> {
    this.#unsub?.();
    this.#unsub = null;
  }

  isConnected(): boolean {
    return this.#unsub !== null;
  }
}

class WorkflowEventSource implements SourceDriver {
  readonly kind = 'workflow_event' as const;
  #unsub: (() => void) | null = null;

  constructor(private readonly source: Extract<ListenerSource, { kind: 'workflow_event' }>, private readonly deps: SourceDeps) {}

  async start(onEvent: (payload: Record<string, unknown>) => void): Promise<void> {
    const wanted = new Set(this.source.onStatus.map((s) => RUN_STATUS_EVENTS[s]).filter(Boolean));
    // `'*'` matches any workflow in the workspace — the error_trigger "any" scope.
    const anyWorkflow = this.source.workflowId === '*';
    this.#unsub = this.deps.bus.subscribe(({ envelope }) => {
      if (!wanted.has(envelope.event)) return;
      const payload = asRecord(envelope.payload);
      // The bus is process-global; a wildcard ('*') error_trigger must only see
      // failures from its OWN workspace.
      if (anyWorkflow && typeof payload.workspaceId === 'string' && payload.workspaceId !== this.deps.workspaceId) return;
      const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : this.#lookupWorkflow(payload.runId);
      if (!anyWorkflow && workflowId !== this.source.workflowId) return;
      // Loop guard: an error-handler workflow must never fire on its OWN failure
      // (otherwise a wildcard error_trigger would re-trigger itself forever).
      if (workflowId && workflowId === this.deps.workflowId) return;
      onEvent({ event: envelope.event, ...payload });
    });
  }

  #lookupWorkflow(runId: unknown): string | undefined {
    if (typeof runId !== 'string') return undefined;
    const row = this.deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    return row?.workflowId ?? undefined;
  }

  async close(): Promise<void> {
    this.#unsub?.();
    this.#unsub = null;
  }

  isConnected(): boolean {
    return this.#unsub !== null;
  }
}

// ── file_watch ─────────────────────────────────────────────────────────────

class FileWatchSource implements SourceDriver {
  readonly kind = 'file_watch' as const;
  #watcher: FSWatcher | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly source: Extract<ListenerSource, { kind: 'file_watch' }>, private readonly deps: SourceDeps) {}

  async start(onEvent: (payload: Record<string, unknown>) => void): Promise<void> {
    this.#watcher = watch(this.source.path, { persistent: false }, (eventType, filename) => {
      const mapped = eventType === 'rename' ? 'unlink' : 'change';
      if (this.source.events.length && !this.source.events.includes(mapped as 'add' | 'change' | 'unlink')) return;
      const fire = () => onEvent({ event: mapped, path: this.source.path, filename: filename ? String(filename) : null, at: new Date().toISOString() });
      const debounceMs = this.source.debounceMs ?? 0;
      if (debounceMs > 0) {
        if (this.#debounce) clearTimeout(this.#debounce);
        this.#debounce = setTimeout(fire, debounceMs);
        this.#debounce.unref?.();
      } else {
        fire();
      }
    });
  }

  async close(): Promise<void> {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#debounce) clearTimeout(this.#debounce);
  }

  isConnected(): boolean {
    return this.#watcher !== null;
  }
}

// ── unavailable (needs native add-ons) ───────────────────────────────────────

class UnavailableSource implements SourceDriver {
  constructor(public readonly kind: SourceDriver['kind'], private readonly reason: string) {}
  async start(): Promise<void> {
    throw new AgentisError('LISTENER_SOURCE_UNAVAILABLE', this.reason);
  }
  async close(): Promise<void> {}
  isConnected(): boolean {
    return false;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
