/**
 * CognitivePromotionQueueWorker � durable, restart-safe brain promotion.
 *
 *
 * Replaces `queueMicrotask` at the promotion call site. `queueMicrotask` is
 * not a job queue � if the process restarts between enqueue and execution the
 * promotion is silently lost. This worker:
 *
 *   - polls `cognitive_promotion_queue` every 5s; pending rows survive restarts
 *   - serialises work per workspace (one workspace can't starve another)
 *   - caps concurrency per workspace so 10 concurrent runs don't fire 10
 *     concurrent background LLM/embedding passes (the multi-tenancy price)
 *   - drains `high` priority first so evaluator-driven corrections never
 *     wait behind routine promotions
 *   - retries with an attempt cap, then parks the row as `failed`
 *   - trips a circuit breaker after repeated failures for a workspace
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, lt, lte, or, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { SharedIntelligenceService } from './sharedIntelligence.js';
// Ability review is an optional hook; kept loosely typed so the brain promotion
// queue does not depend on the agent-ability subsystem.
type AbilityReviewInput = Record<string, unknown>;
interface AgentAbilityReviewer { review(input: AbilityReviewInput): Promise<unknown>; }
import type { PeerProfileService } from './peerProfileService.js';
import type { ReflectionService } from './reflectionService.js';
import type { FeynmanReflectionService, FeynmanReflectionPayload } from './feynmanReflection.js';

const POLL_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 5;
const MAX_CONCURRENT_PER_WORKSPACE = 2;
const MAX_CONCURRENT_DREAM_PASS_PER_WORKSPACE = 1;
const PROCESSING_LEASE_MS = 10 * 60 * 1000;
const CIRCUIT_FAIL_THRESHOLD = 5;
const CIRCUIT_PAUSE_MS = 60_000;
const CLAIM_BATCH = 50;

/** atom_promotion payload � enqueued by WorkflowEngine after task completion. */
export interface AtomPromotionPayload {
  workspaceId: string;
  scopeId?: string | null;
  agentId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  nodeId?: string | null;
  adapterType?: string | null;
  taskInput?: unknown;
  taskOutput: unknown;
  /** Human-readable task label for the Formation Judge. */
  taskTitle?: string | null;
  /** Write-policy resolved at enqueue time: 'form' | 'episodic_only' | 'none'. */
  memoryPolicy?: 'form' | 'episodic_only' | 'none';
  /** PACER source surface (Phase 2). Defaults to 'run_completion' downstream. */
  originSurface?: string | null;
}

export type BrainQueueItemType =
  | 'atom_promotion'
  | 'ability_review'
  | 'peer_update'
  | 'contradiction_check'
  | 'curator_pass'
  | 'dream_pass'
  | 'feynman_reflection'
  | 'reembed_workspace';

export type BrainQueuePriority = 'high' | 'normal' | 'low';

export interface EnqueueArgs {
  workspaceId: string;
  itemType: BrainQueueItemType;
  priority?: BrainQueuePriority;
  payload: unknown;
}

interface CircuitState {
  failures: number;
  pausedUntil?: number;
}

export class CognitivePromotionQueueWorker {
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  readonly #activeByWorkspace = new Map<string, number>();
  readonly #activeDreamPassByWorkspace = new Map<string, number>();
  readonly #circuit = new Map<string, CircuitState>();

  /** Part IV � set after construction so abilities can wire lazily. */
  abilityReviewer?: AgentAbilityReviewer;
  /** Part V � peer summaries are updated by low-priority queue work. */
  PeerProfiles?: PeerProfileService;
  Reflection?: ReflectionService;
  /** Phase 4 — Feynman repair loop, wired lazily in bootstrap. */
  Feynman?: FeynmanReflectionService;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly SharedIntelligence: SharedIntelligenceService,
    private readonly logger: Logger,
  ) {}

  /** Enqueue a promotion job. Synchronous, durable � survives restarts. */
  enqueue(args: EnqueueArgs): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.insert(schema.cognitivePromotionQueue).values({
      id,
      workspaceId: args.workspaceId,
      itemType: args.itemType,
      priority: args.priority ?? 'normal',
      payload: args.payload as unknown as Record<string, unknown>,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }).run();
    return id;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.poll(); }, POLL_INTERVAL_MS);
    this.#timer.unref?.();
    this.logger.info('cognitive_promotion_queue.started', { intervalMs: POLL_INTERVAL_MS });
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Poll once � exposed for tests and graceful drain. */
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const items = this.db
        .select()
        .from(schema.cognitivePromotionQueue)
        .where(and(
          or(
            eq(schema.cognitivePromotionQueue.status, 'pending'),
            and(
              eq(schema.cognitivePromotionQueue.status, 'processing'),
              lte(schema.cognitivePromotionQueue.updatedAt, new Date(Date.now() - PROCESSING_LEASE_MS).toISOString()),
            ),
          )!,
          lt(schema.cognitivePromotionQueue.attempts, MAX_ATTEMPTS),
        ))
        .orderBy(
          sql`CASE ${schema.cognitivePromotionQueue.priority} WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END`,
          asc(schema.cognitivePromotionQueue.createdAt),
        )
        .limit(CLAIM_BATCH)
        .all();

      const tasks: Promise<void>[] = [];
      for (const item of items) {
        const active = this.#activeByWorkspace.get(item.workspaceId) ?? 0;
        const activeDreamPasses = this.#activeDreamPassByWorkspace.get(item.workspaceId) ?? 0;
        const isDreamPass = item.itemType === 'dream_pass';
        if (active >= MAX_CONCURRENT_PER_WORKSPACE) continue;
        if (isDreamPass && activeDreamPasses >= MAX_CONCURRENT_DREAM_PASS_PER_WORKSPACE) continue;
        if (this.#isCircuitBroken(item.workspaceId)) continue;

        // Claim the row so a second poll tick (or process) cannot double-run it.
        const claimed = this.db.update(schema.cognitivePromotionQueue)
          .set({
            status: 'processing',
            attempts: sql`${schema.cognitivePromotionQueue.attempts} + 1`,
            lastAttemptAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(and(
            eq(schema.cognitivePromotionQueue.id, item.id),
            eq(schema.cognitivePromotionQueue.status, item.status),
            eq(schema.cognitivePromotionQueue.updatedAt, item.updatedAt),
          ))
          .run();
        if (claimed.changes === 0) continue;

        this.#activeByWorkspace.set(item.workspaceId, active + 1);
        if (isDreamPass) {
          this.#activeDreamPassByWorkspace.set(item.workspaceId, activeDreamPasses + 1);
        }
        tasks.push(
          this.#processItem(item).finally(() => {
            const count = this.#activeByWorkspace.get(item.workspaceId) ?? 1;
            this.#activeByWorkspace.set(item.workspaceId, Math.max(0, count - 1));
            if (isDreamPass) {
              const dreamPassCount = this.#activeDreamPassByWorkspace.get(item.workspaceId) ?? 1;
              this.#activeDreamPassByWorkspace.set(item.workspaceId, Math.max(0, dreamPassCount - 1));
            }
          }),
        );
      }
      await Promise.allSettled(tasks);
    } catch (err) {
      this.logger.warn('cognitive_promotion_queue.poll_failed', { message: (err as Error).message });
    } finally {
      this.#polling = false;
    }
  }

  async #processItem(item: typeof schema.cognitivePromotionQueue.$inferSelect): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.#dispatch(item);
      this.db.update(schema.cognitivePromotionQueue)
        .set({ status: 'done', updatedAt: now, lastAttemptAt: now })
        .where(eq(schema.cognitivePromotionQueue.id, item.id))
        .run();
      this.#recordSuccess(item.workspaceId);
    } catch (err) {
      const attempts = (item.attempts ?? 0) + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      this.db.update(schema.cognitivePromotionQueue)
        .set({
          status: exhausted ? 'failed' : 'pending',
          attempts,
          lastAttemptAt: now,
          updatedAt: now,
          failReason: (err as Error).message.slice(0, 500),
        })
        .where(eq(schema.cognitivePromotionQueue.id, item.id))
        .run();
      this.#recordFailure(item.workspaceId);
      this.logger.warn('cognitive_promotion_queue.item_failed', {
        id: item.id,
        itemType: item.itemType,
        attempts,
        exhausted,
        message: (err as Error).message,
      });
    }
  }

  async #dispatch(item: typeof schema.cognitivePromotionQueue.$inferSelect): Promise<void> {
    const payload = (item.payload ?? {}) as Record<string, unknown>;
    switch (item.itemType) {
      case 'atom_promotion': {
        const p = payload as unknown as AtomPromotionPayload;
        await this.SharedIntelligence.promote({
          workspaceId: p.workspaceId,
          scopeId: p.scopeId ?? null,
          agentId: p.agentId ?? null,
          workflowId: p.workflowId ?? null,
          runId: p.runId ?? null,
          nodeId: p.nodeId ?? null,
          adapterType: p.adapterType ?? null,
          taskInput: p.taskInput,
          taskOutput: p.taskOutput,
          taskTitle: p.taskTitle ?? null,
          memoryPolicy: p.memoryPolicy ?? 'form',
          originSurface: (p.originSurface as never) ?? 'run_completion',
        });
        return;
      }
      case 'ability_review': {
        if (!this.abilityReviewer) {
          this.logger.info('cognitive_promotion_queue.ability_review_skipped', { reason: 'no reviewer wired' });
          return;
        }
        await this.abilityReviewer.review(payload as unknown as AbilityReviewInput);
        return;
      }
      case 'peer_update': {
        if (!this.PeerProfiles) {
          this.logger.info('cognitive_promotion_queue.peer_update_skipped', { reason: 'no peer service wired' });
          return;
        }
        const p = payload as {
          workspaceId?: string;
          sessionId?: string;
          peerId?: string;
          peerType?: 'user' | 'agent';
          observerPeerId?: string | null;
        };
        if (!p.workspaceId || !p.sessionId || !p.peerId) return;
        await this.PeerProfiles.upsertFromSession({
          workspaceId: p.workspaceId,
          sessionId: p.sessionId,
          peerId: p.peerId,
          peerType: p.peerType ?? 'user',
          observerPeerId: p.observerPeerId ?? null,
        });
        return;
      }
      case 'contradiction_check': {
        const p = payload as {
          workspaceId?: string;
          atomIdA?: string;
          atomIdB?: string;
          contradictionReason?: string;
          scopeId?: string | null;
          contextA?: string | null;
          contextB?: string | null;
          autoResolve?: boolean;
        };
        if (!p.workspaceId || !p.atomIdA || !p.atomIdB) return;
        const flagged = this.SharedIntelligence.flagDispute({
          workspaceId: p.workspaceId,
          atomIdA: p.atomIdA,
          atomIdB: p.atomIdB,
          reason: p.contradictionReason ?? 'Contradiction detected by background review.',
          scopeId: p.scopeId ?? null,
        });
        if (p.autoResolve && flagged.linkId) {
          await this.SharedIntelligence.resolveDispute({
            workspaceId: p.workspaceId,
            disputeId: flagged.linkId,
            action: 'context_split',
            contextA: p.contextA ?? 'Context A',
            contextB: p.contextB ?? 'Context B',
          });
        }
        return;
      }
      case 'curator_pass': {
        const p = payload as { workspaceId?: string; atomIds?: string[]; clusterTag?: string; scopeId?: string | null; pacerClass?: string };
        if (!p.workspaceId || !Array.isArray(p.atomIds) || p.atomIds.length === 0) return;
        await this.#runCuratorPass(p.workspaceId, p.atomIds, p.clusterTag ?? 'memory', p.scopeId ?? null, p.pacerClass ?? null);
        return;
      }
      case 'dream_pass': {
        if (!this.Reflection) {
          this.logger.info('cognitive_promotion_queue.dream_pass_skipped', { reason: 'no Reflection service wired' });
          return;
        }
        const p = payload as {
          workspaceId?: string;
          peerId?: string;
          peerType?: 'user' | 'agent';
          observerPeerId?: string | null;
          phase?: 'deduction' | 'induction' | 'both';
        };
        if (!p.workspaceId || !p.peerId) return;
        await this.Reflection.run({
          workspaceId: p.workspaceId,
          peerId: p.peerId,
          peerType: p.peerType ?? 'user',
          observerPeerId: p.observerPeerId ?? null,
          phase: p.phase ?? 'both',
        });
        return;
      }
      case 'feynman_reflection': {
        if (!this.Feynman) {
          this.logger.info('cognitive_promotion_queue.feynman_skipped', { reason: 'no Feynman service wired' });
          return;
        }
        const p = payload as unknown as FeynmanReflectionPayload;
        if (!p.workspaceId || !p.nodeId || !p.error) return;
        await this.Feynman.run(p);
        return;
      }
      case 'reembed_workspace': {
        const p = payload as { workspaceId?: string; requestId?: string | null };
        if (!p.workspaceId) return;
        await this.SharedIntelligence.reembedWorkspaceAtoms(p.workspaceId, p.requestId ?? null);
        return;
      }
      default:
        this.logger.info('cognitive_promotion_queue.item_skipped', { itemType: item.itemType });
        return;
    }
  }

  async #runCuratorPass(workspaceId: string, atomIds: string[], clusterTag: string, scopeId: string | null, pacerClass: string | null): Promise<void> {
    const rows = atomIds
      .map((id) => this.db.select().from(schema.memoryEpisodes)
        .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, id)))
        .get())
      .filter((row): row is typeof schema.memoryEpisodes.$inferSelect => Boolean(row && row.status !== 'archived'));
    if (rows.length < 2) return;
    const content = rows
      .slice(0, 8)
      .map((row) => row.summary.trim())
      .filter(Boolean)
      .join(' ');
    if (!content) return;
    const confidence = rows.reduce((sum, row) => sum + Number(row.confidence), 0) / rows.length;
    const created = await this.SharedIntelligence.addAtom({
      workspaceId,
      scopeId: scopeId ?? rows.find((row) => row.scopeId)?.scopeId ?? null,
      content: `Distilled ${clusterTag}: ${content.slice(0, 900)}`,
      tags: [clusterTag, 'curator_distilled', ...(pacerClass ? [`pacer:${pacerClass}`] : [])],
      confidence,
      source: 'system_write',
      managed: true,
      metadata: {
        source: 'curator_distilled',
        compressedFrom: rows.map((row) => row.id),
        ...(pacerClass ? { pacerClass, originSurface: 'run_completion', formationMode: 'curator_distilled' } : {}),
      },
      compressionTier: 3,
      compressedFrom: rows.map((row) => row.id),
    });
    const now = new Date().toISOString();
    for (const row of rows) {
      this.db.update(schema.memoryEpisodes)
        .set({ status: 'archived', archivedAt: now, compressedFrom: [created.id], compressionTier: 3, updatedAt: now })
        .where(eq(schema.memoryEpisodes.id, row.id))
        .run();
    }
  }

  // -- circuit breaker -----------------------------------------

  #isCircuitBroken(workspaceId: string): boolean {
    const state = this.#circuit.get(workspaceId);
    if (!state?.pausedUntil) return false;
    if (state.pausedUntil > Date.now()) return true;
    // Pause elapsed � reset and allow a probe.
    this.#circuit.set(workspaceId, { failures: 0 });
    return false;
  }

  #recordFailure(workspaceId: string): void {
    const state = this.#circuit.get(workspaceId) ?? { failures: 0 };
    state.failures += 1;
    if (state.failures >= CIRCUIT_FAIL_THRESHOLD) {
      state.pausedUntil = Date.now() + CIRCUIT_PAUSE_MS;
      this.logger.warn('cognitive_promotion_queue.circuit_open', {
        workspaceId,
        pauseMs: CIRCUIT_PAUSE_MS,
      });
    }
    this.#circuit.set(workspaceId, state);
  }

  #recordSuccess(workspaceId: string): void {
    const state = this.#circuit.get(workspaceId);
    if (state) this.#circuit.set(workspaceId, { failures: 0 });
  }
}
