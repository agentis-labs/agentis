/**
 * Run-settle helpers — event-driven, zero-token waits over run lifecycle.
 *
 * Extracted from agentisToolHandlers/run.ts so BOTH the agent tools (run.await /
 * run.await_all) and the engine (the in-session `await_runs` yield) share one
 * implementation without the engine importing the tool layer. Depends only on the
 * db + event bus — no engine, no tool-registry coupling.
 */

import { and, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../../event-bus.js';
import { collectFailedNodeIds } from './runStateFailures.js';

/** The minimal surface these waits need — db to read current state, bus to subscribe. */
export interface SettleDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
}

export const RUN_SETTLE_EVENTS: ReadonlySet<string> = new Set([
  REALTIME_EVENTS.RUN_COMPLETED,
  REALTIME_EVENTS.RUN_FAILED,
  REALTIME_EVENTS.RUN_CANCELLED,
  REALTIME_EVENTS.RUN_PAUSED,
]);

/** Statuses at which awaiting stops: terminal, or parked WAITING/PAUSED (e.g. an approval). */
export const SETTLED_RUN_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED', 'COMPLETED_WITH_CONTRACT_VIOLATION', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED', 'WAITING', 'PAUSED',
]);

export interface RunSettleResult {
  resolved: 'settled' | 'node' | 'timeout' | 'not_found';
  status?: string;
  nodeEvent?: 'completed' | 'failed';
}

/**
 * Event-driven wait (backs agentis.run.await): resolve when the run settles — or the
 * given node finishes — or on timeout, WITHOUT polling. Subscribes to the bus FIRST,
 * then reads the current state, so an event that fires between the read and the
 * subscribe is never missed. The agent spends no tokens while this blocks.
 */
export function waitForRunSettle(
  deps: SettleDeps,
  workspaceId: string,
  runId: string,
  opts: { nodeId?: string; timeoutMs: number },
): Promise<RunSettleResult> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    let unsub: () => void = () => {};
    const finish = (r: RunSettleResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(r);
    };
    unsub = deps.bus.subscribe((msg) => {
      const ev = msg.envelope.event as string;
      const p = (msg.envelope.payload ?? {}) as { runId?: string; nodeId?: string; status?: string };
      if (p.runId !== runId) return;
      if (opts.nodeId) {
        if (ev === REALTIME_EVENTS.NODE_COMPLETED && p.nodeId === opts.nodeId) return finish({ resolved: 'node', nodeEvent: 'completed' });
        if (ev === REALTIME_EVENTS.NODE_FAILED && p.nodeId === opts.nodeId) return finish({ resolved: 'node', nodeEvent: 'failed' });
      }
      if (RUN_SETTLE_EVENTS.has(ev)) return finish({ resolved: 'settled', ...(p.status ? { status: p.status } : {}) });
    });
    timer = setTimeout(() => finish({ resolved: 'timeout' }), opts.timeoutMs);
    // Subscribed — now resolve from the CURRENT state if it already settled.
    const row = deps.db
      .select({ status: schema.workflowRuns.status, runState: schema.workflowRuns.runState })
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.workspaceId, workspaceId)))
      .get();
    if (!row) return finish({ resolved: 'not_found' });
    if (opts.nodeId) {
      const st = row.runState as WorkflowRunState;
      if (st.completedNodeIds?.includes(opts.nodeId)) return finish({ resolved: 'node', nodeEvent: 'completed' });
      if (collectFailedNodeIds(st).includes(opts.nodeId)) return finish({ resolved: 'node', nodeEvent: 'failed' });
    }
    if (SETTLED_RUN_STATUSES.has(row.status)) return finish({ resolved: 'settled', status: row.status });
  });
}

export interface RunsFanInResult {
  resolved: 'all_settled' | 'timeout';
  /** Per requested runId: its settled status, or found:false if it never existed. */
  settled: Map<string, { status: string | null; found: boolean }>;
}

/**
 * Fan-in await (backs agentis.run.await_all and the engine's `await_runs` yield):
 * resolve when EVERY run in the set settles — the conjunction join that lets an
 * orchestrator start several apps and wake once, when the LAST finishes — or on
 * timeout. Same subscribe-first, then read-current-state discipline as
 * {@link waitForRunSettle} so a settle event firing in the gap is never missed,
 * extended across a set of runIds. A run that does not exist counts as settled
 * (found:false) so the join can never hang on a bad id. Zero tokens while blocked:
 * this is one bus subscription, not a poll.
 */
export function waitForAllRunsSettle(
  deps: SettleDeps,
  workspaceId: string,
  runIds: string[],
  opts: { timeoutMs: number },
): Promise<RunsFanInResult> {
  return new Promise((resolve) => {
    const remaining = new Set(runIds);
    const settled = new Map<string, { status: string | null; found: boolean }>();
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    let unsub: () => void = () => {};
    const finish = (resolved: 'all_settled' | 'timeout'): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve({ resolved, settled });
    };
    const markSettled = (runId: string, status: string | null, found: boolean): void => {
      if (!remaining.has(runId)) return;
      remaining.delete(runId);
      settled.set(runId, { status, found });
      if (remaining.size === 0) finish('all_settled');
    };
    unsub = deps.bus.subscribe((msg) => {
      const ev = msg.envelope.event as string;
      if (!RUN_SETTLE_EVENTS.has(ev)) return;
      const p = (msg.envelope.payload ?? {}) as { runId?: string; status?: string };
      if (!p.runId || !remaining.has(p.runId)) return;
      markSettled(p.runId, p.status ?? null, true);
    });
    timer = setTimeout(() => finish('timeout'), opts.timeoutMs);
    // Subscribed — now resolve any run that ALREADY settled (or never existed).
    for (const runId of [...remaining]) {
      const row = deps.db
        .select({ status: schema.workflowRuns.status })
        .from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.workspaceId, workspaceId)))
        .get();
      if (!row) { markSettled(runId, null, false); continue; }
      if (SETTLED_RUN_STATUSES.has(row.status)) markSettled(runId, row.status, true);
      if (done) return;
    }
  });
}

/**
 * Shape a fan-in result into the payload a waiting agent resumes with — per-run
 * status plus, on a partial timeout, the still-pending ids so it can await again.
 * Shared by the run.await_all tool and the engine's in-session `await_runs` wake.
 */
export function summarizeFanIn(
  runIds: string[],
  res: RunsFanInResult,
): { ok: true; awaited: 'all_settled' | 'timeout'; runs: Array<{ runId: string; found: boolean; status: string | null; settled: boolean }>; timedOut?: boolean; pending?: string[] } {
  const runs = runIds.map((runId) => {
    const s = res.settled.get(runId);
    return { runId, found: Boolean(s?.found), status: s?.status ?? null, settled: Boolean(s) };
  });
  const pending = runIds.filter((runId) => !res.settled.has(runId));
  return { ok: true, awaited: res.resolved, runs, ...(res.resolved === 'timeout' ? { timedOut: true, pending } : {}) };
}
