/**
 * The Blackboard — run-scoped shared state + inter-agent bus.
 *
 * Two layers, one service:
 *   1. A fast in-memory layer (KV pads + channel logs) used on the hot path of a
 *      live run — sessions read/write this every turn with zero IO.
 *   2. A durable, identity-tagged audit layer (`blackboard_entries`) written
 *      through on every mutation when a db is wired. This is what survives an
 *      API restart and what the operator Blackboard panel renders: every entry
 *      records WHO (agent) on WHICH runtime wrote it and WHICH convergence
 *      iteration produced it (AGENT-COOPERATION-10X §Pillar 2).
 *
 * Backward-compatible: `read`/`write`/`delete`/`broadcast`/`readChannel`/
 * `snapshotOf`/`dispose` keep their original signatures; identity + namespace +
 * iteration are optional and default to the anonymous, run-level entry.
 *
 * Every write publishes `BLACKBOARD_ENTRY` (the live panel) and keeps emitting
 * `SCRATCHPAD_WRITTEN` for the legacy State Surfaces consumers.
 */

import { randomUUID } from 'node:crypto';
import { CONSTANTS, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { and, eq } from 'drizzle-orm';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';

/** A single message on a run-scoped agent channel (the swarm "bus"). */
export interface ChannelMessage {
  from: string;
  message: string;
  at: string;
}

/** Who wrote a blackboard entry — the cross-runtime identity the operator sees. */
export interface BlackboardIdentity {
  agentId?: string | null;
  /** Runtime family: 'opus' | 'codex' | 'cursor' | 'hermes' | … — drives the panel avatar. */
  runtime?: string | null;
  /** Human display label (agent name / role). */
  label?: string | null;
}

export type BlackboardEntryKind = 'fact' | 'message' | 'claim' | 'artifact_ref';

/** One durable, identity-tagged unit of shared state. */
export interface BlackboardEntry {
  id: string;
  runId: string;
  /** converge.stateKey for loop state, else 'run'. */
  namespace: string;
  kind: BlackboardEntryKind;
  key?: string | null;
  channel?: string | null;
  author: BlackboardIdentity;
  iteration: number;
  confidence?: number | null;
  supersedes?: string | null;
  value: unknown;
  at: string;
}

/** Optional authoring context threaded through writes. */
export interface WriteContext {
  identity?: BlackboardIdentity;
  namespace?: string;
  iteration?: number;
}

const ENTRY_MEMORY_CAP = 2_000;

export class ScratchpadService {
  readonly #pads = new Map<string, Map<string, unknown>>();
  readonly #sizeBytes = new Map<string, number>();
  /** Run-scoped pub/sub channels — backs session `broadcast`/`read_channel` tools. */
  readonly #channels = new Map<string, Map<string, ChannelMessage[]>>();
  /** In-memory mirror of the durable entry log (capped) for fast reads when no db. */
  readonly #entries = new Map<string, BlackboardEntry[]>();

  constructor(
    private readonly bus: EventBus,
    private readonly logger: Logger,
    /** When wired, every entry is written through to `blackboard_entries`. */
    private readonly db?: AgentisSqliteDb,
  ) {}

  read(runId: string, key: string): unknown {
    return this.#pads.get(runId)?.get(key);
  }

  write(runId: string, key: string, value: unknown, ctx?: WriteContext): void {
    let pad = this.#pads.get(runId);
    if (!pad) {
      pad = new Map();
      this.#pads.set(runId, pad);
    }
    const serialized = JSON.stringify(value ?? null);
    const padSize = (this.#sizeBytes.get(runId) ?? 0) + serialized.length;
    this.#sizeBytes.set(runId, padSize);
    if (padSize > CONSTANTS.SCRATCHPAD_SIZE_WARNING_BYTES) {
      this.logger.warn('scratchpad.size.warning', {
        runId,
        bytes: padSize,
        threshold: CONSTANTS.SCRATCHPAD_SIZE_WARNING_BYTES,
      });
    }
    pad.set(key, value);
    // Legacy State Surfaces consumers.
    this.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.SCRATCHPAD_WRITTEN, { runId, key, value });
    this.#record(runId, { kind: 'fact', key, value, ...ctx });
  }

  delete(runId: string, key: string, ctx?: WriteContext): void {
    this.#pads.get(runId)?.delete(key);
    this.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.SCRATCHPAD_WRITTEN, {
      runId,
      key,
      value: null,
      deleted: true,
    });
    this.#record(runId, { kind: 'fact', key, value: null, ...ctx });
  }

  snapshotOf(runId: string): Record<string, unknown> {
    const pad = this.#pads.get(runId);
    if (!pad) return {};
    return Object.fromEntries(pad.entries());
  }

  // ──────────────────────────────────────────────────────────
  // Channels — run-scoped agent broadcast bus (SMARTER-AGENTS-10X §VIII).
  // Sessions in the same run gossip findings here without polluting the KV.
  // Append-only, capped, and cleared with the run.
  // ──────────────────────────────────────────────────────────

  broadcast(runId: string, channel: string, from: string, message: string, ctx?: WriteContext): void {
    let run = this.#channels.get(runId);
    if (!run) {
      run = new Map();
      this.#channels.set(runId, run);
    }
    let log = run.get(channel);
    if (!log) {
      log = [];
      run.set(channel, log);
    }
    log.push({ from, message, at: new Date().toISOString() });
    if (log.length > CONSTANTS.CHANNEL_MAX_MESSAGES) log.splice(0, log.length - CONSTANTS.CHANNEL_MAX_MESSAGES);
    const identity: BlackboardIdentity = ctx?.identity ?? { label: from };
    this.#record(runId, { kind: 'message', channel, value: message, ...ctx, identity });
  }

  /** Read the last `limit` messages on a channel, oldest first. */
  readChannel(runId: string, channel: string, limit = 50): ChannelMessage[] {
    const log = this.#channels.get(runId)?.get(channel) ?? [];
    return limit >= log.length ? [...log] : log.slice(log.length - limit);
  }

  // ──────────────────────────────────────────────────────────
  // Claims — structured assertions with confidence + supersede, so an operator
  // sees disagreement between runtimes (Opus claims fixed; Codex verify disputes).
  // ──────────────────────────────────────────────────────────

  claim(
    runId: string,
    statement: string,
    opts: WriteContext & { confidence?: number; supersedes?: string; key?: string },
  ): string {
    return this.#record(runId, {
      kind: 'claim',
      key: opts.key,
      value: statement,
      confidence: opts.confidence,
      supersedes: opts.supersedes,
      ...opts,
    });
  }

  /** Durable entry log for a run, oldest first (audit + operator panel). */
  listEntries(runId: string, opts?: { namespace?: string; limit?: number }): BlackboardEntry[] {
    const limit = opts?.limit ?? 1_000;
    if (this.db) {
      try {
        const where = opts?.namespace
          ? and(eq(schema.blackboardEntries.runId, runId), eq(schema.blackboardEntries.namespace, opts.namespace))
          : eq(schema.blackboardEntries.runId, runId);
        const rows = this.db.select().from(schema.blackboardEntries).where(where).all();
        return rows
          .map(rowToEntry)
          .sort((a, b) => a.at.localeCompare(b.at))
          .slice(-limit);
      } catch (err) {
        this.logger.warn('blackboard.list.failed', { runId, err: (err as Error).message });
      }
    }
    const mem = this.#entries.get(runId) ?? [];
    const filtered = opts?.namespace ? mem.filter((e) => e.namespace === opts.namespace) : mem;
    return filtered.slice(-limit);
  }

  /** Re-hydrate the in-memory KV/channels from the durable log (crash-recovery resume). */
  hydrate(runId: string): void {
    if (!this.db) return;
    for (const entry of this.listEntries(runId)) {
      if (entry.kind === 'fact' && entry.key) {
        let pad = this.#pads.get(runId);
        if (!pad) this.#pads.set(runId, (pad = new Map()));
        if (entry.value === null) pad.delete(entry.key);
        else pad.set(entry.key, entry.value);
      } else if (entry.kind === 'message' && entry.channel) {
        let run = this.#channels.get(runId);
        if (!run) this.#channels.set(runId, (run = new Map()));
        let log = run.get(entry.channel);
        if (!log) run.set(entry.channel, (log = []));
        log.push({ from: entry.author.label ?? entry.author.agentId ?? 'agent', message: String(entry.value ?? ''), at: entry.at });
      }
    }
  }

  dispose(runId: string): void {
    this.#pads.delete(runId);
    this.#channels.delete(runId);
    this.#sizeBytes.delete(runId);
    this.#entries.delete(runId);
    // Durable `blackboard_entries` rows are intentionally retained as an audit
    // trail; they cascade away only when the workspace is deleted.
  }

  // ──────────────────────────────────────────────────────────

  #record(
    runId: string,
    e: {
      kind: BlackboardEntryKind;
      key?: string | null;
      channel?: string | null;
      value: unknown;
      identity?: BlackboardIdentity;
      namespace?: string;
      iteration?: number;
      confidence?: number;
      supersedes?: string;
    },
  ): string {
    const entry: BlackboardEntry = {
      id: randomUUID(),
      runId,
      namespace: e.namespace ?? 'run',
      kind: e.kind,
      key: e.key ?? null,
      channel: e.channel ?? null,
      author: e.identity ?? {},
      iteration: e.iteration ?? 0,
      confidence: e.confidence ?? null,
      supersedes: e.supersedes ?? null,
      value: e.value,
      at: new Date().toISOString(),
    };

    // In-memory mirror (capped) for fast reads when no db is wired.
    let mem = this.#entries.get(runId);
    if (!mem) this.#entries.set(runId, (mem = []));
    mem.push(entry);
    if (mem.length > ENTRY_MEMORY_CAP) mem.splice(0, mem.length - ENTRY_MEMORY_CAP);

    // Durable write-through — best-effort; a db failure never breaks the run.
    if (this.db) {
      try {
        this.db
          .insert(schema.blackboardEntries)
          .values({
            id: entry.id,
            runId,
            // workspaceId is resolved from the run lazily; callers that have it
            // pass it via identity? No — we look it up cheaply once per run below.
            workspaceId: this.#workspaceFor(runId),
            namespace: entry.namespace,
            kind: entry.kind,
            key: entry.key,
            channel: entry.channel,
            authorAgentId: entry.author.agentId ?? null,
            authorRuntime: entry.author.runtime ?? null,
            authorLabel: entry.author.label ?? null,
            iteration: entry.iteration,
            confidence: entry.confidence,
            supersedes: entry.supersedes,
            value: entry.value as unknown,
          })
          .run();
      } catch (err) {
        this.logger.warn('blackboard.persist.failed', { runId, err: (err as Error).message });
      }
    }

    this.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.BLACKBOARD_ENTRY, { runId, entry });
    return entry.id;
  }

  /** Resolve a run's workspace once and cache it for FK-correct durable writes. */
  readonly #workspaceCache = new Map<string, string>();
  #workspaceFor(runId: string): string {
    const cached = this.#workspaceCache.get(runId);
    if (cached) return cached;
    let ws = '';
    if (this.db) {
      try {
        const row = this.db
          .select({ workspaceId: schema.workflowRuns.workspaceId })
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.id, runId))
          .get();
        ws = row?.workspaceId ?? '';
      } catch {
        ws = '';
      }
    }
    if (ws) this.#workspaceCache.set(runId, ws);
    return ws;
  }
}

function rowToEntry(row: typeof schema.blackboardEntries.$inferSelect): BlackboardEntry {
  return {
    id: row.id,
    runId: row.runId,
    namespace: row.namespace,
    kind: row.kind as BlackboardEntryKind,
    key: row.key,
    channel: row.channel,
    author: { agentId: row.authorAgentId, runtime: row.authorRuntime, label: row.authorLabel },
    iteration: row.iteration,
    confidence: row.confidence,
    supersedes: row.supersedes,
    value: row.value,
    at: row.createdAt,
  };
}
