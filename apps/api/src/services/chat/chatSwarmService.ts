import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { AgentAdapter, ChatDelta, ChatMessage, ChatSwarm, ChatSwarmStatus, ChatSwarmWorker, ChatSwarmWorkerStatus, ChatTurnContext } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AdapterManager } from '../../adapters/AdapterManager.js';
import type { Logger } from '../../logger.js';

export const MAX_CHAT_SWARM_WORKERS = 6;
export const MAX_CHAT_SWARM_PARALLEL = 3;

export interface ChatSwarmTask {
  task: string;
  role?: string;
  capabilityTags?: string[];
}

export interface ChatSwarmRequest {
  objective?: string;
  tasks: ChatSwarmTask[];
  mergeStrategy?: 'collect_all' | 'compare' | 'best_effort';
}

type Runtime = {
  ctx: ChatTurnContext;
  callId: string;
  stopped: boolean;
  paused: boolean;
  active: Map<string, AbortController>;
  queued: string[];
  launch?: () => void;
  wake?: () => void;
};

type WorkerRow = typeof schema.conversationSwarmWorkers.$inferSelect;

/**
 * Temporary, bounded workers for an interactive chat turn. The worker identity
 * is a durable audit record only; it never creates an `agents` row. A worker
 * receives no tool catalog, which is the permission attenuation boundary.
 */
export class ChatSwarmService {
  readonly #runtime = new Map<string, Runtime>();

  constructor(private readonly deps: {
    db: AgentisSqliteDb;
    adapters: AdapterManager;
    logger?: Logger;
  }) {}

  async *run(request: ChatSwarmRequest, ctx: ChatTurnContext, callId: string): AsyncIterable<ChatDelta> {
    const tasks = sanitizeTasks(request.tasks);
    if (tasks.length < 2) {
      yield { type: 'tool_result', id: callId, name: 'agentis.team.spawn', result: null, error: 'A chat team needs at least two independent tasks.' };
      return;
    }
    if (tasks.length > MAX_CHAT_SWARM_WORKERS) {
      yield { type: 'tool_result', id: callId, name: 'agentis.team.spawn', result: null, error: `This request needs ${tasks.length} workers. Chat teams are limited to ${MAX_CHAT_SWARM_WORKERS}; ask the operator to approve a larger workflow-backed team.` };
      return;
    }

    const turnId = ctx.durableTurnId ?? this.deps.db.select({ id: schema.conversationTurns.id }).from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, ctx.workspaceId),
      eq(schema.conversationTurns.conversationId, ctx.conversationId),
      eq(schema.conversationTurns.clientTurnId, ctx.clientTurnId ?? ''),
    )).get()?.id;
    if (!turnId) {
      yield { type: 'tool_result', id: callId, name: 'agentis.team.spawn', result: null, error: 'This chat turn is not durable yet, so a recoverable team cannot be started.' };
      return;
    }
    const now = new Date().toISOString();
    const swarmId = randomUUID();
    const workers = await Promise.all(tasks.map(async (task, ordinal) => {
      const selected = await this.#selectAgent(ctx.workspaceId, ctx.agentId, task);
      const id = randomUUID();
      const row = {
        id,
        swarmId,
        workspaceId: ctx.workspaceId,
        ordinal,
        parentWorkerId: null,
        durableAgentId: selected?.id ?? null,
        role: task.role || selected?.role || 'temporary specialist',
        task: task.task,
        capabilityTags: task.capabilityTags ?? [],
        runtime: selected?.runtimeModel ?? null,
        status: 'queued',
        latestProgress: null,
        result: null,
        error: null,
        retryOfWorkerId: null,
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      return row;
    }));
    const objective = clean(request.objective) || tasks.map((task) => task.task).join('; ');
    await this.deps.db.insert(schema.conversationSwarms).values({
      id: swarmId,
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      turnId,
      coordinatorAgentId: ctx.agentId,
      objective,
      mergeStrategy: request.mergeStrategy ?? 'collect_all',
      maxWorkers: MAX_CHAT_SWARM_WORKERS,
      maxParallel: MAX_CHAT_SWARM_PARALLEL,
      status: 'queued',
      steering: [],
      synthesis: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await this.deps.db.insert(schema.conversationSwarmWorkers).values(workers);

    const runtime: Runtime = { ctx, callId, stopped: false, paused: false, active: new Map(), queued: workers.map((worker) => worker.id) };
    this.#runtime.set(swarmId, runtime);
    let snapshots: ChatSwarm[] = [await this.get(ctx.workspaceId, swarmId)];
    const push = async () => {
      snapshots.push(await this.get(ctx.workspaceId, swarmId));
      runtime.wake?.();
      runtime.wake = undefined;
    };
    const waitForUpdate = () => new Promise<void>((resolve) => { runtime.wake = resolve; });

    await this.#setSwarm(swarmId, { status: 'running', startedAt: now });
    await push();
    let active = 0;
    let allStarted = false;
    const launch = () => {
      while (!runtime.stopped && !runtime.paused && active < MAX_CHAT_SWARM_PARALLEL && runtime.queued.length > 0) {
        const workerId = runtime.queued.shift();
        if (!workerId) break;
        active += 1;
        void this.#runWorker(swarmId, workerId, runtime, push)
          .catch((err) => this.deps.logger?.warn('chat.swarm.worker.unhandled', { swarmId, workerId, err: err instanceof Error ? err.message : String(err) }))
          .finally(() => { active -= 1; void push(); });
      }
      allStarted = runtime.queued.length === 0;
    };
    runtime.launch = launch;
    launch();

    while (!runtime.stopped && (!allStarted || active > 0 || runtime.paused)) {
      while (snapshots.length > 0) yield { type: 'swarm', swarm: snapshots.shift()! };
      if (!runtime.paused) launch();
      if (!runtime.stopped && (active > 0 || runtime.paused || !allStarted)) await waitForUpdate();
    }
    while (snapshots.length > 0) yield { type: 'swarm', swarm: snapshots.shift()! };

    const final = await this.get(ctx.workspaceId, swarmId);
    if (!isTerminal(final.status)) {
      const failed = final.workers.filter((worker) => worker.status === 'failed' || worker.status === 'blocked');
      const completed = final.workers.filter((worker) => worker.status === 'completed');
      const status: ChatSwarmStatus = runtime.stopped ? 'cancelled' : completed.length > 0 ? 'completed' : failed.length > 0 ? 'failed' : 'cancelled';
      await this.#setSwarm(swarmId, { status, completedAt: new Date().toISOString(), error: failed.length === final.workers.length ? 'All workers were blocked or failed.' : null });
    }
    const settled = await this.get(ctx.workspaceId, swarmId);
    yield { type: 'swarm', swarm: settled };
    yield {
      type: 'tool_result',
      id: callId,
      name: 'agentis.team.spawn',
      result: {
        swarmId,
        status: settled.status,
        objective: settled.objective,
        workers: settled.workers.map((worker) => ({ role: worker.role, task: worker.task, status: worker.status, result: worker.result, error: worker.error })),
        steering: settled.steering,
      },
    };
    this.#runtime.delete(swarmId);
  }

  async get(workspaceId: string, swarmId: string): Promise<ChatSwarm> {
    const swarm = this.deps.db.select().from(schema.conversationSwarms).where(and(eq(schema.conversationSwarms.workspaceId, workspaceId), eq(schema.conversationSwarms.id, swarmId))).get();
    if (!swarm) throw new Error('Chat team not found.');
    const workers = this.deps.db.select().from(schema.conversationSwarmWorkers).where(and(eq(schema.conversationSwarmWorkers.workspaceId, workspaceId), eq(schema.conversationSwarmWorkers.swarmId, swarmId))).orderBy(asc(schema.conversationSwarmWorkers.ordinal)).all();
    return toSwarm(swarm, workers);
  }

  async pause(workspaceId: string, swarmId: string): Promise<ChatSwarm> {
    const runtime = this.#runtime.get(swarmId);
    if (runtime) {
      runtime.paused = true;
      for (const [workerId, controller] of runtime.active) {
        runtime.queued.push(workerId);
        controller.abort(new Error('swarm_paused'));
      }
    }
    await this.#setSwarm(swarmId, { status: 'paused' });
    await this.deps.db.update(schema.conversationSwarmWorkers).set({ status: 'paused', updatedAt: new Date().toISOString() }).where(and(eq(schema.conversationSwarmWorkers.workspaceId, workspaceId), eq(schema.conversationSwarmWorkers.swarmId, swarmId), eq(schema.conversationSwarmWorkers.status, 'running')));
    runtime?.wake?.();
    return this.get(workspaceId, swarmId);
  }

  async resume(workspaceId: string, swarmId: string): Promise<ChatSwarm> {
    const runtime = this.#runtime.get(swarmId);
    if (!runtime) throw new Error('This team is no longer live. Start a new team to continue its remaining work.');
    runtime.paused = false;
    await this.#setSwarm(swarmId, { status: 'running' });
    await this.deps.db.update(schema.conversationSwarmWorkers).set({ status: 'queued', updatedAt: new Date().toISOString() }).where(and(eq(schema.conversationSwarmWorkers.workspaceId, workspaceId), eq(schema.conversationSwarmWorkers.swarmId, swarmId), eq(schema.conversationSwarmWorkers.status, 'paused')));
    runtime.launch?.();
    runtime.wake?.();
    return this.get(workspaceId, swarmId);
  }

  async stop(workspaceId: string, swarmId: string): Promise<ChatSwarm> {
    const runtime = this.#runtime.get(swarmId);
    if (runtime) {
      runtime.stopped = true;
      for (const controller of runtime.active.values()) controller.abort(new Error('swarm_stopped'));
      runtime.wake?.();
    }
    const now = new Date().toISOString();
    await this.#setSwarm(swarmId, { status: 'cancelled', completedAt: now });
    await this.deps.db.update(schema.conversationSwarmWorkers).set({ status: 'cancelled', completedAt: now, updatedAt: now }).where(and(eq(schema.conversationSwarmWorkers.workspaceId, workspaceId), eq(schema.conversationSwarmWorkers.swarmId, swarmId)));
    return this.get(workspaceId, swarmId);
  }

  async stopWorker(workspaceId: string, swarmId: string, workerId: string): Promise<ChatSwarm> {
    this.#runtime.get(swarmId)?.active.get(workerId)?.abort(new Error('worker_stopped'));
    const now = new Date().toISOString();
    await this.deps.db.update(schema.conversationSwarmWorkers).set({ status: 'cancelled', completedAt: now, updatedAt: now }).where(and(eq(schema.conversationSwarmWorkers.workspaceId, workspaceId), eq(schema.conversationSwarmWorkers.swarmId, swarmId), eq(schema.conversationSwarmWorkers.id, workerId)));
    return this.get(workspaceId, swarmId);
  }

  async retryWorker(workspaceId: string, swarmId: string, workerId: string): Promise<ChatSwarm> {
    const runtime = this.#runtime.get(swarmId);
    if (!runtime || runtime.stopped) throw new Error('This team is no longer live. Start a new team to retry work.');
    const worker = this.deps.db.select().from(schema.conversationSwarmWorkers).where(and(eq(schema.conversationSwarmWorkers.workspaceId, workspaceId), eq(schema.conversationSwarmWorkers.swarmId, swarmId), eq(schema.conversationSwarmWorkers.id, workerId))).get();
    if (!worker) throw new Error('Worker not found.');
    if (!['failed', 'blocked', 'cancelled'].includes(worker.status)) throw new Error('Only a failed, blocked, or stopped worker can be retried.');
    await this.#setWorker(workerId, { status: 'queued', error: null, result: null, latestProgress: 'Queued for retry.', completedAt: null, retryOfWorkerId: worker.retryOfWorkerId ?? worker.id });
    runtime.queued.push(workerId);
    runtime.launch?.();
    runtime.wake?.();
    return this.get(workspaceId, swarmId);
  }

  async steer(workspaceId: string, swarmId: string, instruction: string): Promise<ChatSwarm> {
    const swarm = await this.get(workspaceId, swarmId);
    const note = clean(instruction);
    if (!note) throw new Error('A lead instruction is required.');
    await this.#setSwarm(swarmId, { steering: [...swarm.steering, note].slice(-12) });
    this.#runtime.get(swarmId)?.wake?.();
    return this.get(workspaceId, swarmId);
  }

  async stopForConversation(workspaceId: string, conversationId: string): Promise<void> {
    const rows = this.deps.db.select({ id: schema.conversationSwarms.id }).from(schema.conversationSwarms).where(and(eq(schema.conversationSwarms.workspaceId, workspaceId), eq(schema.conversationSwarms.conversationId, conversationId))).all();
    await Promise.all(rows.map((row) => this.stop(workspaceId, row.id)));
  }

  async #runWorker(swarmId: string, workerId: string, runtime: Runtime, emit: () => Promise<void>): Promise<void> {
    const worker = this.deps.db.select().from(schema.conversationSwarmWorkers).where(eq(schema.conversationSwarmWorkers.id, workerId)).get();
    if (!worker || runtime.stopped || runtime.paused) return;
    const controller = new AbortController();
    runtime.active.set(workerId, controller);
    const abortParent = () => controller.abort(runtime.ctx.signal?.reason);
    runtime.ctx.signal?.addEventListener('abort', abortParent, { once: true });
    const now = new Date().toISOString();
    await this.#setWorker(workerId, { status: 'running', startedAt: now, latestProgress: 'Starting assigned work.' });
    await emit();
    try {
      const selected = worker.durableAgentId ? this.deps.adapters.get(worker.durableAgentId)?.adapter : undefined;
      const adapter = selected ?? this.deps.adapters.get(runtime.ctx.agentId)?.adapter;
      if (!adapter?.chat) throw new Error('No interactive runtime is available for this worker.');
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a temporary specialist in a coordinated team. Work only on the assigned subproblem. Do not delegate. Do not use tools. Give a concise, evidence-based result for the lead. Never expose private reasoning; send short public progress updates only when useful.' },
        { role: 'user', content: `Team objective: ${await this.#objective(swarmId)}\n\nYour assigned task: ${worker.task}` },
      ];
      let output = '';
      let failure: string | null = null;
      for await (const delta of adapter.chat(messages, [], {
        signal: controller.signal,
        sessionKey: `chat-swarm:${swarmId}:${workerId}`,
        latencyClass: 'deliberate',
        toolMode: 'caller_loop',
        executionMode: runtime.ctx.permissionMode === 'plan' ? 'plan' : 'ask',
        approvalSensitivity: runtime.ctx.approvalSensitivity,
        conversationId: runtime.ctx.conversationId,
        turnLease: runtime.ctx.turnLease,
      })) {
        if (delta.type === 'commentary' && clean(delta.text)) {
          await this.#setWorker(workerId, { latestProgress: truncate(clean(delta.text), 280) });
          await emit();
        } else if (delta.type === 'activity' && delta.status === 'running' && clean(delta.label)) {
          await this.#setWorker(workerId, { latestProgress: truncate(clean(delta.label), 280) });
          await emit();
        } else if (delta.type === 'text') {
          output += delta.delta;
        } else if (delta.type === 'tool_result' && delta.error) {
          failure = delta.error;
        }
      }
      if (controller.signal.aborted) {
        const status: ChatSwarmWorkerStatus = runtime.stopped ? 'cancelled' : runtime.paused ? 'paused' : 'cancelled';
        await this.#setWorker(workerId, { status, latestProgress: status === 'paused' ? 'Paused by operator.' : 'Stopped by operator.', completedAt: new Date().toISOString() });
      } else if (failure) {
        const status: ChatSwarmWorkerStatus = isQuotaFailure(failure) ? 'blocked' : 'failed';
        await this.#setWorker(workerId, { status, error: failure, latestProgress: status === 'blocked' ? 'Blocked by runtime credits or quota.' : 'Worker failed.', completedAt: new Date().toISOString() });
      } else {
        await this.#setWorker(workerId, { status: 'completed', result: { summary: truncate(clean(output), 12_000) || 'Completed without a text result.' }, latestProgress: 'Completed.', completedAt: new Date().toISOString() });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        await this.#setWorker(workerId, { status: isQuotaFailure(message) ? 'blocked' : 'failed', error: message, latestProgress: 'Worker failed.', completedAt: new Date().toISOString() });
      }
    } finally {
      runtime.ctx.signal?.removeEventListener('abort', abortParent);
      runtime.active.delete(workerId);
      await emit();
    }
  }

  async #selectAgent(workspaceId: string, coordinatorId: string, task: ChatSwarmTask) {
    const wanted = new Set((task.capabilityTags ?? []).map((tag) => tag.toLowerCase()));
    const candidates = this.deps.db.select().from(schema.agents).where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.isPaused, false))).all();
    return candidates.find((agent) => agent.id !== coordinatorId
      && Boolean(this.deps.adapters.get(agent.id)?.adapter.chat)
      && (wanted.size === 0 || (agent.capabilityTags as string[]).some((tag) => wanted.has(tag.toLowerCase())))) ?? null;
  }

  async #objective(swarmId: string): Promise<string> {
    return this.deps.db.select({ objective: schema.conversationSwarms.objective }).from(schema.conversationSwarms).where(eq(schema.conversationSwarms.id, swarmId)).get()?.objective ?? 'Complete the assigned work.';
  }

  async #setSwarm(swarmId: string, values: Partial<typeof schema.conversationSwarms.$inferInsert>): Promise<void> {
    await this.deps.db.update(schema.conversationSwarms).set({ ...values, updatedAt: new Date().toISOString() }).where(eq(schema.conversationSwarms.id, swarmId));
  }

  async #setWorker(workerId: string, values: Partial<typeof schema.conversationSwarmWorkers.$inferInsert>): Promise<void> {
    await this.deps.db.update(schema.conversationSwarmWorkers).set({ ...values, updatedAt: new Date().toISOString() }).where(eq(schema.conversationSwarmWorkers.id, workerId));
  }
}

function sanitizeTasks(tasks: ChatSwarmTask[] | undefined): ChatSwarmTask[] {
  return (tasks ?? []).map((task) => ({ task: clean(task?.task), role: clean(task?.role), capabilityTags: (task?.capabilityTags ?? []).map(clean).filter(Boolean).slice(0, 8) })).filter((task) => Boolean(task.task)).slice(0, MAX_CHAT_SWARM_WORKERS + 1);
}
function clean(value: unknown): string { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''; }
function truncate(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function isQuotaFailure(value: string): boolean { return /\b402\b|credits?|quota|billing|payment required|insufficient funds/i.test(value); }
function isTerminal(status: ChatSwarmStatus): boolean { return status === 'completed' || status === 'failed' || status === 'blocked' || status === 'cancelled'; }
function toSwarm(swarm: typeof schema.conversationSwarms.$inferSelect, workers: WorkerRow[]): ChatSwarm {
  return {
    id: swarm.id, objective: swarm.objective, status: swarm.status as ChatSwarmStatus, mergeStrategy: swarm.mergeStrategy,
    maxWorkers: swarm.maxWorkers, maxParallel: swarm.maxParallel, steering: (swarm.steering as string[]) ?? [],
    synthesis: swarm.synthesis, error: swarm.error, startedAt: swarm.startedAt, completedAt: swarm.completedAt,
    workers: workers.map((worker) => ({ id: worker.id, role: worker.role, task: worker.task, status: worker.status as ChatSwarmWorkerStatus, capabilityTags: (worker.capabilityTags as string[]) ?? [], runtime: worker.runtime, latestProgress: worker.latestProgress, result: worker.result, error: worker.error, retryOfWorkerId: worker.retryOfWorkerId, startedAt: worker.startedAt, completedAt: worker.completedAt })),
  };
}
