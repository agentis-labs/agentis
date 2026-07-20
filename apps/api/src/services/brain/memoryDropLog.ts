/**
 * §B7 — "why isn't this in my brain?", answerable from stored data.
 *
 * The formation path drops candidates at ~40 places and, before this, exactly
 * two of them recorded anything. Everything else returned `null`, `continue`,
 * or a falsy result and the knowledge simply ceased to exist — no log, no
 * event, no user-visible signal. The operator's only symptom was an empty
 * canvas, which is indistinguishable from "the agent learned nothing".
 *
 * The model generalised here is `feynmanReflection`'s quality event: it is the
 * one existing place where a rejection is written down WITH ITS REASON, so an
 * operator can ask the database what happened instead of guessing.
 *
 * Design constraints, learned the hard way:
 *  - **Never per-row logging.** A shipped regression once flooded logs with an
 *    8-line error every 1–2s by logging a whole-sweep outage per row. Drops are
 *    recorded as durable rows, not log lines.
 *  - **Best-effort.** Recording a drop must never fail the write path that
 *    produced it; every method swallows.
 *  - **Sampled.** A high-traffic channel can produce thousands of identical
 *    drops; only the first `SAMPLE_LIMIT` per (reason, gate) per process window
 *    are stored, with the rest counted.
 */
import { randomUUID } from 'node:crypto';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';

/** Where in the pipeline the candidate died. Stable strings — they are queried. */
export type MemoryDropGate =
  | 'sender_untrusted'      // §B6.1 external sender may not author authority
  | 'rejectable'            // structurally not a memory (URL, table row, narration)
  | 'below_score'           // deterministic quality score under the threshold
  | 'task_command'          // one-off work, not a standing rule
  | 'question'              // interrogative, not a statement
  | 'sensitive'             // looked like a secret
  | 'policy_none'           // write policy said do not form
  | 'policy_episodic_only'  // demoted to a decaying marker
  | 'judge_rejected'        // the Formation Judge declined it
  | 'duplicate'             // collapsed into an existing atom
  | 'too_short'
  | 'empty';

export interface MemoryDropRecord {
  workspaceId: string;
  gate: MemoryDropGate;
  /** The text that was dropped, truncated. Null when the caller must not store it. */
  text?: string | null;
  scopeId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  originSurface?: string | null;
  /** Free-text detail, e.g. the score that missed, or the duplicate's id. */
  detail?: string | null;
}

const SAMPLE_LIMIT = 25;
const TEXT_MAX = 300;

export class MemoryDropLog {
  /** (gate) → how many have been seen; only the first SAMPLE_LIMIT are stored. */
  readonly #seen = new Map<string, number>();

  constructor(private readonly db: AgentisSqliteDb, private readonly logger: Logger) {}

  record(drop: MemoryDropRecord): void {
    try {
      const key = `${drop.workspaceId}::${drop.gate}`;
      const count = (this.#seen.get(key) ?? 0) + 1;
      this.#seen.set(key, count);
      if (count > SAMPLE_LIMIT) return;

      this.db.insert(schema.brainQualityEvents).values({
        id: randomUUID(),
        workspaceId: drop.workspaceId,
        scopeId: drop.scopeId ?? null,
        agentId: drop.agentId ?? null,
        eventType: 'memory_dropped',
        atomId: null,
        abilityId: null,
        runId: drop.runId ?? null,
        delta: null,
        metadata: {
          gate: drop.gate,
          // Sensitive-looking text is exactly what must NOT be persisted to
          // explain why it wasn't persisted.
          text: drop.gate === 'sensitive' ? null : (drop.text ?? '').slice(0, TEXT_MAX) || null,
          detail: drop.detail ?? null,
          originSurface: drop.originSurface ?? null,
          conversationId: drop.conversationId ?? null,
          sampled: count === SAMPLE_LIMIT ? 'limit_reached' : null,
        },
        createdAt: new Date().toISOString(),
      }).run();
    } catch (err) {
      // Never let observability break the thing being observed.
      this.logger.warn('brain.drop_log_failed', {
        workspaceId: drop.workspaceId,
        gate: drop.gate,
        message: (err as Error).message,
      });
    }
  }

  /** Total drops seen this process, per gate — including ones past the sample limit. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, count] of this.#seen) {
      const gate = key.split('::')[1] ?? key;
      out[gate] = (out[gate] ?? 0) + count;
    }
    return out;
  }
}
