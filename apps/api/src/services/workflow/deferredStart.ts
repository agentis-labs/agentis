/**
 * Deferred start — the single place that answers "when should this begin?".
 *
 * The run queue has always carried a `scheduledAt` column and honoured it
 * (`SchedulerService.processDueQueue` → `WorkflowEngine.drainWorkflowQueue`),
 * but nothing could SET it to anything but "now". This turns a declarative delay
 * spec into that timestamp, so every start path — agent tool, chain link,
 * conversation enrolment, App schedule — expresses waiting the same way instead
 * of each growing its own timer.
 *
 * Jitter is not decoration. Perfectly regular spacing is both a machine
 * signature and a thundering-herd generator; `jitterMs` spreads starts inside a
 * window rather than aligning them on one instant.
 */

import { AgentisError, CONSTANTS } from '@agentis/core';

/**
 * One year. Shared with the binding/rule schemas that validate a declared delay,
 * so the zod bound and the runtime check can never drift apart.
 */
export const MAX_START_DELAY_MS = CONSTANTS.MAX_START_DELAY_MS;

export interface StartDelaySpec {
  /** Absolute ISO-8601 instant to begin at. Combines additively with `delayMs`. */
  startAt?: string | null;
  /** Milliseconds to wait, measured from `startAt` when present, else from now. */
  delayMs?: number | null;
  /** Uniform random extra drawn from [0, jitterMs). */
  jitterMs?: number | null;
}

export interface StaggerSpec extends StartDelaySpec {
  /** Spacing between consecutive items in a batch. */
  everyMs?: number | null;
}

/**
 * Resolve a delay spec to the `scheduledAt` the queue understands, or null for
 * "start immediately" — null is the value every existing caller already passes,
 * so an absent spec keeps today's behaviour exactly.
 */
export function resolveStartAt(
  spec: StartDelaySpec | null | undefined,
  now: Date = new Date(),
  random: () => number = Math.random,
): string | null {
  if (!spec) return null;
  const hasStartAt = spec.startAt != null && String(spec.startAt).trim() !== '';
  const hasDelay = spec.delayMs != null;
  const jitterMs = normaliseMs(spec.jitterMs, 'jitterMs');
  if (!hasStartAt && !hasDelay && jitterMs === 0) return null;

  let base = now.getTime();
  if (hasStartAt) {
    const parsed = Date.parse(String(spec.startAt));
    if (Number.isNaN(parsed)) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        `startAt must be an ISO-8601 instant (got ${JSON.stringify(spec.startAt)})`,
      );
    }
    // A startAt in the past means "already due" — a legitimate catch-up after
    // downtime, not an error. Clamping to now keeps it eligible on the next
    // sweep instead of stranding it behind the due filter.
    base = Math.max(parsed, now.getTime());
  }
  if (hasDelay) base += normaliseMs(spec.delayMs, 'delayMs');

  const at = base + (jitterMs > 0 ? Math.floor(random() * jitterMs) : 0);
  if (at > now.getTime() + MAX_START_DELAY_MS) {
    throw new AgentisError(
      'VALIDATION_FAILED',
      `start resolves to ${new Date(at).toISOString()}, more than a year out — `
      + 'check the unit (delays are milliseconds)',
    );
  }
  return new Date(at).toISOString();
}

/**
 * Spread `count` starts across a stagger: item 0 at the base start, each
 * subsequent item `everyMs` later. Jitter is drawn independently per item so the
 * batch is genuinely spread rather than shifted in lockstep.
 *
 * Returns one entry per item, positionally aligned with the caller's list.
 */
export function staggeredStarts(
  count: number,
  spec: StaggerSpec | null | undefined,
  now: Date = new Date(),
  random: () => number = Math.random,
): Array<string | null> {
  if (!Number.isInteger(count) || count < 0) {
    throw new AgentisError('VALIDATION_FAILED', 'count must be a non-negative integer');
  }
  const everyMs = normaliseMs(spec?.everyMs, 'everyMs');
  const starts: Array<string | null> = [];
  for (let index = 0; index < count; index += 1) {
    starts.push(
      resolveStartAt(
        {
          startAt: spec?.startAt ?? null,
          // Absent everyMs collapses to "all at the same base" — still a valid
          // batch, just not staggered. Only force a delay when one was asked for.
          delayMs: everyMs > 0 || spec?.delayMs != null
            ? (spec?.delayMs ?? 0) + everyMs * index
            : null,
          jitterMs: spec?.jitterMs ?? null,
        },
        now,
        random,
      ),
    );
  }
  return starts;
}

function normaliseMs(value: number | null | undefined, field: string): number {
  if (value == null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AgentisError('VALIDATION_FAILED', `${field} must be a finite number of milliseconds`);
  }
  if (value < 0) throw new AgentisError('VALIDATION_FAILED', `${field} cannot be negative`);
  if (value > MAX_START_DELAY_MS) {
    throw new AgentisError('VALIDATION_FAILED', `${field} exceeds the one-year cap (${MAX_START_DELAY_MS}ms)`);
  }
  return Math.floor(value);
}
