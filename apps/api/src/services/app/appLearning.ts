/**
 * AppLearningService — everything an App learns, and the ONLY writer that can make an
 * App's Brain map fill.
 *
 * THE SCOPE RULE: an App's lessons are scoped to the APP (`scopeId === appId`), never
 * to whichever agent happened to operate it. The App Brain map reads exactly that
 * scope, so anything written elsewhere is invisible there — and an App's intelligence
 * has to travel with the App, not with a borrowed agent. The operating/owner agent is
 * recorded as `agentId` (attribution), never as the scope. A workflow that no App owns
 * is its own scope, which is what fills the Workflow Brain.
 *
 * Two things feed that scope:
 *
 *   1. RUN OUTCOMES (`onRunSettled`) — every terminal run deposits one durable, graded
 *      atom: what it proved, or what it failed at and why. This is what a deterministic
 *      App (compute/http/channel, no agent node) learns from, and it is the ONLY thing
 *      such an App ever learns from.
 *   2. RELATIONSHIP OUTCOMES (`recordOutcome` / `recordConversationOutcome`) — a contact
 *      or per-contact conversation reaches a terminal state (won | lost | abandoned) and
 *      deposits a distilled "what worked / what didn't" lesson. Never a raw transcript.
 *
 * Both commit through `SharedIntelligence.commitDurableAtom`, which writes CONSOLIDATED
 * atoms and reinforces a scope-local near-duplicate instead of writing a second copy.
 * That distinction is load-bearing: the other path into a scope — `promote()`, which
 * mines untrusted agent prose — stages everything as `unconsolidated`, and the graph
 * deliberately hides those. A scope fed only by mining can never render a single node.
 * Dedup also means a hundred runs converge onto a handful of strong, reinforced nodes
 * rather than a hundred clones.
 *
 * GRADUATION — these lessons live in the SAME episodic plane `MemoryReflectionService`
 * reflects over. When lessons of the same shape recur, reflection derives a generalized
 * rule and fires the existing SkillProposer hook (→ Brain `skill` atoms), so the App
 * inherits it. A scoped pass is nudged on each terminal outcome so graduation is prompt
 * rather than waiting on the periodic cron.
 *
 * VISIBILITY — `recentLearnings` returns what currently sits in the App's scope.
 *
 * ADDITIVE + NON-THROWING + MODEL-AGNOSTIC. Every step is wrapped so a failure is a
 * silent no-op: learning must NEVER break a run, a turn, or a conversation. With no
 * model wired, lessons are still deposited (deterministic) and reflection degrades to
 * recurrence-reinforcement — it never fabricates a rule or a skill.
 */

import { and, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { BaselineWindow } from '@agentis/core';
import type { Logger } from '../../logger.js';
import type { SharedIntelligenceService } from '../sharedIntelligence.js';
import type { MemoryReflectionService } from '../memory/memoryReflectionService.js';
import type { RollingBaselineStore } from '../rollingBaselineStore.js';

export type AppOutcome = 'won' | 'lost' | 'abandoned';

const OUTCOME_VALUES: ReadonlySet<string> = new Set(['won', 'lost', 'abandoned']);
/** Lesson episodes carry this tag so the visibility query can find them cheaply. */
const LESSON_TAG = 'm2_lesson';
/** Run-outcome atoms carry this tag — the App/workflow's own graded history. */
const RUN_OUTCOME_TAG = 'run_outcome';
/** Stages that themselves imply a terminal outcome (App-defined but conventional). */
const STAGE_OUTCOME: Record<string, AppOutcome> = { won: 'won', closed_won: 'won', lost: 'lost', closed_lost: 'lost' };
/** Default abandonment threshold: no touch in 14 days and no terminal outcome. */
const DEFAULT_ABANDON_MS = 14 * 86_400_000;
/**
 * Recurrence count at which a scoped reflection pass is nudged. Aligned with the
 * reflection engine's ≥3-distinct-sources skill-proposal gate so the FIRST pass can
 * graduate directly (see recordOutcome for why an earlier pass is counter-productive).
 */
const GRADUATION_THRESHOLD = 3;

export interface AppLearningDeps {
  db: AgentisSqliteDb;
  shared: SharedIntelligenceService;
  logger: Logger;
  /** Optional — triggers a scoped reflection pass so graduation is prompt. */
  reflection?: Pick<MemoryReflectionService, 'run'>;
  /** Optional — captures rolling performance baselines per workflow on settle (Evolution Loop MEASURE). */
  baselines?: Pick<RollingBaselineStore, 'capture' | 'latest'>;
}

/** A terminal run, as the engine reports it to the learning loop. */
export interface RunSettledInput {
  workspaceId: string;
  workflowId: string;
  workflowTitle: string;
  runId: string;
  /** Terminal run status (COMPLETED, FAILED, COMPLETED_WITH_ERRORS, …). */
  status: string;
  /** The graded outcome, when the workflow declared a spec to grade against. */
  verdict?: {
    outcome: 'accomplished' | 'partial' | 'hollow' | 'failed_checks';
    deficiencies: Array<{ claim: string; detail: string }>;
  } | null;
  /** Nodes that hard-failed, with their errors. */
  failures?: Array<{ nodeId: string; nodeTitle: string; error: string }>;
  /** The agent that operated the run, when one did. Attribution only. */
  agentId?: string | null;
}

export interface RecordOutcomeInput {
  workspaceId: string;
  appId: string;
  contactId: string;
  outcome: AppOutcome;
  /** Optional distilled note from the agent on what worked / what didn't. */
  note?: string | null;
  /** When set, also writes the pipeline stage (e.g. 'won'/'lost'). */
  setStage?: string | null;
}

export interface RecordOutcomeResult {
  recorded: boolean;
  lessonDeposited: boolean;
  reflection?: { generalizations: number; skillsProposed: number } | null;
}

export interface LearnedLesson {
  id: string;
  title: string;
  summary: string;
  outcome: string | null;
  createdAt: string;
}

export interface RecentLearnings {
  appId: string;
  ownerAgentId: string | null;
  lessons: LearnedLesson[];
}

const TERMINAL_RUN_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'COMPLETED_WITH_ERRORS']);
function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export class AppLearningService {
  constructor(private readonly deps: AppLearningDeps) {}

  /**
   * EVERY terminal run deposits one durable, graded atom into the brain scope that
   * OWNS the run — the App when an App owns the workflow, else the workflow itself.
   *
   * This is the writer an App never had. The only other path into an App's scope is
   * run-output mining (`SharedIntelligence.promote`), which stages everything as
   * `unconsolidated` — and the graph deliberately hides those — so an App's Brain
   * map was structurally empty no matter how many times it ran. Worse, mining only
   * fires on agent/session nodes, so a deterministic App (compute/http/channel) never
   * reached it at all.
   *
   * What lands here is the run's OWN graded history: what it accomplished, or what it
   * failed at and why. Commits are scope-strict and dedup-by-similarity, so a hundred
   * runs converge onto a handful of strong, reinforced nodes rather than a hundred
   * clones. Never throws — learning must not be able to break a run's terminal path.
   */
  async onRunSettled(input: RunSettledInput): Promise<{ atomId: string; created: boolean; reinforced: boolean } | null> {
    try {
      const scopeId = this.#runScopeId(input.workspaceId, input.workflowId);
      if (!scopeId) return null;
      const appId = this.#appIdForWorkflow(input.workspaceId, input.workflowId);
      // Evolution Loop MEASURE — capture rolling performance baselines for this
      // workflow (throttled, best-effort; never blocks or breaks the run).
      this.#captureBaseline(input.workspaceId, input.workflowId, scopeId);
      const lesson = this.#composeRunLesson(input);
      if (!lesson) return null;

      return await this.deps.shared.commitDurableAtom({
        workspaceId: input.workspaceId,
        scopeId,
        // Attribution only — the SCOPE is the App/workflow, so the lesson travels
        // with it. Scoping to the operating agent (the old AppLearning behaviour)
        // is what buried these in the agent's map, or in the workspace bucket when
        // the App had no owner agent at all.
        agentId: input.agentId ?? null,
        workflowId: input.workflowId,
        runId: input.runId,
        title: lesson.title,
        content: lesson.content,
        type: lesson.type,
        source: 'system_write',
        confidence: lesson.confidence,
        importance: lesson.success ? 0.6 : 0.75,
        outcomeStatus: lesson.success ? 'good' : 'bad',
        tags: [
          RUN_OUTCOME_TAG,
          `status:${input.status.toLowerCase()}`,
          ...(input.verdict ? [`verdict:${input.verdict.outcome}`] : []),
          ...(appId ? [`app:${appId}`] : []),
        ],
        metadata: {
          runOutcome: true,
          appId,
          workflowId: input.workflowId,
          runId: input.runId,
          status: input.status,
          verdict: input.verdict?.outcome ?? null,
        },
      });
    } catch (err) {
      this.deps.logger.warn('app.learning.run_settled_failed', {
        workflowId: input.workflowId,
        runId: input.runId,
        err: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Capture rolling performance baselines (7d/30d/90d) for a workflow. Throttled
   * per window so a busy workflow doesn't re-snapshot on every settle, and fully
   * best-effort — a baseline failure must never affect the run's terminal path.
   */
  #captureBaseline(workspaceId: string, workflowId: string, scopeId: string): void {
    const store = this.deps.baselines;
    if (!store) return;
    try {
      const now = Date.now();
      const windows: Array<{ window: BaselineWindow; days: number; throttleMs: number }> = [
        { window: 'rolling_7d', days: 7, throttleMs: 60 * 60 * 1000 },
        { window: 'rolling_30d', days: 30, throttleMs: 6 * 60 * 60 * 1000 },
        { window: 'rolling_90d', days: 90, throttleMs: 24 * 60 * 60 * 1000 },
      ];
      const latest = store.latest(workspaceId, workflowId);
      for (const w of windows) {
        const last = latest[w.window];
        if (last && now - new Date(last.capturedAt).getTime() < w.throttleMs) continue;
        const m = this.#aggregateWindow(workspaceId, workflowId, w.days);
        if (m.sampleSize === 0) continue;
        store.capture({
          workspaceId,
          scopeId,
          workflowId,
          window: w.window,
          successRate: m.successRate,
          p50LatencyMs: m.p50LatencyMs,
          p95LatencyMs: m.p95LatencyMs,
          avgCostMicros: 0, // cost/replay/approval/evaluator not derived here — left 0 (anomaly checks skip 0-baselines)
          avgReplayCount: 0,
          avgApprovalCount: 0,
          evaluatorPassRate: 0,
          sampleSize: m.sampleSize,
          windowStart: new Date(now - w.days * 86_400_000).toISOString(),
          windowEnd: new Date(now).toISOString(),
        });
      }
    } catch (err) {
      this.deps.logger.warn('app.learning.baseline_capture_failed', { workflowId, err: (err as Error).message });
    }
  }

  /** Aggregate terminal-run success rate + latency percentiles over the last N days. */
  #aggregateWindow(workspaceId: string, workflowId: string, days: number): { sampleSize: number; successRate: number; p50LatencyMs: number; p95LatencyMs: number } {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = this.deps.db
      .select({ status: schema.workflowRuns.status, startedAt: schema.workflowRuns.startedAt, completedAt: schema.workflowRuns.completedAt })
      .from(schema.workflowRuns)
      .where(and(
        eq(schema.workflowRuns.workspaceId, workspaceId),
        eq(schema.workflowRuns.workflowId, workflowId),
        gte(schema.workflowRuns.createdAt, since),
      ))
      .all();
    let terminal = 0;
    let succeeded = 0;
    const durations: number[] = [];
    for (const r of rows) {
      if (!isTerminalRunStatus(r.status)) continue;
      terminal += 1;
      if (r.status === 'COMPLETED') succeeded += 1;
      if (r.startedAt && r.completedAt) {
        const d = new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime();
        if (Number.isFinite(d) && d >= 0) durations.push(d);
      }
    }
    durations.sort((a, b) => a - b);
    const pct = (p: number) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(p * durations.length))]! : 0);
    return {
      sampleSize: terminal,
      successRate: terminal > 0 ? succeeded / terminal : 0,
      p50LatencyMs: pct(0.5),
      p95LatencyMs: pct(0.95),
    };
  }

  /**
   * Distil a terminal run into a durable, reusable statement. Deterministic and
   * model-free: it states what the run PROVED, so repeats of the same shape collapse
   * onto one atom via the commit's similarity dedup. Returns null when there is
   * nothing worth keeping (a cancelled run proved nothing).
   */
  #composeRunLesson(input: RunSettledInput): { title: string; content: string; type: 'success_pattern' | 'failure'; confidence: number; success: boolean } | null {
    const status = input.status.toUpperCase();
    if (status === 'CANCELLED') return null;

    const name = truncate(input.workflowTitle, 80);
    const failures = input.failures ?? [];
    const verdict = input.verdict ?? null;

    // A run that finished AND graded clean is the only thing we call proven.
    if (status === 'COMPLETED' && (!verdict || verdict.outcome === 'accomplished') && failures.length === 0) {
      return {
        title: truncate(`Proven: ${name}`, 88),
        content: truncate(
          `"${name}" ran end-to-end and delivered its declared outcome`
          + (verdict ? ` (verdict: accomplished, ${verdict.deficiencies.length === 0 ? 'all acceptance checks passed' : 'checks graded clean'})` : ' (no acceptance checks declared)')
          + '. This shape of the pipeline works — keep it as the baseline and prefer repairing a step over redesigning it.',
          480,
        ),
        type: 'success_pattern',
        confidence: 0.7,
        success: true,
      };
    }

    // Deficient: it "completed" but did not accomplish. This is the most valuable
    // lesson in the system and the one that was being silently discarded.
    if (verdict && verdict.outcome !== 'accomplished') {
      const why = verdict.deficiencies.slice(0, 3).map((d) => `${d.claim} — ${d.detail}`).join('; ');
      return {
        title: truncate(`Deficient (${verdict.outcome}): ${name}`, 88),
        content: truncate(
          `"${name}" reached a terminal state but did NOT accomplish its objective (verdict: ${verdict.outcome}).`
          + (why ? ` Unmet: ${why}.` : ' No acceptance check produced usable evidence.')
          + ' Treat a completed run as unproven until the acceptance checks pass — verify the deliverable exists, not that the steps ran.',
          480,
        ),
        type: 'failure',
        confidence: 0.72,
        success: false,
      };
    }

    if (failures.length > 0) {
      const first = failures[0]!;
      const rest = failures.length > 1 ? ` (+${failures.length - 1} more failing step${failures.length > 2 ? 's' : ''})` : '';
      return {
        title: truncate(`Failure: ${name} @ ${first.nodeTitle}`, 88),
        content: truncate(
          `"${name}" failed at step "${first.nodeTitle}"${rest}: ${first.error}`
          + ' Check this step first when the pipeline breaks again; it is the recurring weak point.',
          480,
        ),
        type: 'failure',
        confidence: 0.72,
        success: false,
      };
    }

    if (status === 'FAILED' || status === 'COMPLETED_WITH_ERRORS' || status === 'COMPLETED_WITH_CONTRACT_VIOLATION') {
      return {
        title: truncate(`Failure: ${name}`, 88),
        content: truncate(`"${name}" ended ${status} with no single failing step attributed — the failure is in how the steps compose, not in one of them.`, 480),
        type: 'failure',
        confidence: 0.6,
        success: false,
      };
    }
    return null;
  }

  /**
   * The brain scope a run's lessons belong to: the owning App when there is one,
   * else the workflow itself. Both surfaces (App Brain, Workflow Brain) read their
   * map at exactly this scope id, so this is what makes either of them fill.
   *
   * Null when the workflow doesn't exist — better to learn nothing than to strand
   * an atom in a scope no surface will ever read.
   */
  #runScopeId(workspaceId: string, workflowId: string): string | null {
    const row = this.#workflowRow(workspaceId, workflowId);
    if (!row) return null;
    return row.appId ?? workflowId;
  }

  #appIdForWorkflow(workspaceId: string, workflowId: string): string | null {
    return this.#workflowRow(workspaceId, workflowId)?.appId ?? null;
  }

  #workflowRow(workspaceId: string, workflowId: string): { appId: string | null } | null {
    try {
      return this.deps.db
        .select({ appId: schema.workflows.appId })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId)))
        .get() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Map a pipeline stage to a terminal outcome, if it implies one. Lets callers
   * derive an outcome from a `stage → 'won'/'lost'` transition with no new field.
   */
  static outcomeForStage(stage: string | null | undefined): AppOutcome | null {
    if (!stage) return null;
    return STAGE_OUTCOME[stage.trim().toLowerCase()] ?? null;
  }

  /**
   * Record a terminal outcome for a contact: stamp the contact, deposit a graded
   * lesson scoped to the App's owner agent, then trigger a scoped reflection pass
   * (graduation). Idempotent on the contact's terminal outcome — re-recording the
   * SAME outcome is a no-op (won't double-deposit). Never throws.
   */
  async recordOutcome(input: RecordOutcomeInput): Promise<RecordOutcomeResult> {
    const result: RecordOutcomeResult = { recorded: false, lessonDeposited: false, reflection: null };
    if (!OUTCOME_VALUES.has(input.outcome)) return result;
    try {
      const contact = this.deps.db
        .select()
        .from(schema.appContacts)
        .where(and(eq(schema.appContacts.workspaceId, input.workspaceId), eq(schema.appContacts.id, input.contactId)))
        .get();
      if (!contact || contact.appId !== input.appId) return result;
      // Idempotency: same terminal outcome already recorded → nothing to do.
      if (contact.outcome === input.outcome) return result;

      const now = new Date().toISOString();
      this.deps.db.update(schema.appContacts)
        .set({
          outcome: input.outcome,
          outcomeAt: now,
          ...(input.setStage !== undefined && input.setStage !== null ? { stage: input.setStage } : {}),
          updatedAt: now,
        })
        .where(eq(schema.appContacts.id, contact.id))
        .run();
      result.recorded = true;

      const ownerAgentId = this.#ownerAgentId(input.appId);
      const lesson = this.#composeLesson({ contact, outcome: input.outcome, note: input.note });
      if (lesson) {
        try {
          await this.deps.shared.commitDurableAtom({
            workspaceId: input.workspaceId,
            // The APP is the scope — what an App learns lives with the App and
            // travels with it. Scoping to the owner agent (the old behaviour) put
            // the lesson in that agent's map instead, and for an App with no owner
            // agent it degraded to null, i.e. the workspace bucket: invisible in
            // the App's Brain either way. The owner agent is attribution, not scope.
            scopeId: input.appId,
            agentId: ownerAgentId,
            content: lesson.content,
            title: lesson.title,
            confidence: 0.62,
            source: 'system_write',
            outcomeStatus: input.outcome === 'won' ? 'good' : 'bad',
            tags: [LESSON_TAG, `app:${input.appId}`, `outcome:${input.outcome}`, ...(ownerAgentId ? [`role:${ownerAgentId}`] : [])],
            metadata: {
              m2: true,
              appId: input.appId,
              contactId: contact.id,
              outcome: input.outcome,
              stage: input.setStage ?? contact.stage ?? null,
            },
          });
          result.lessonDeposited = true;
        } catch (err) {
          this.deps.logger.warn('app.learning.lesson_failed', { appId: input.appId, err: (err as Error).message });
        }
      }

      // GRADUATION — reflect over the (now-richer) scoped plane so recurring winning
      // patterns can graduate into an ability via the existing SkillProposer hook.
      // Gate on a recurrence THRESHOLD: only nudge a reflection pass once the scoped
      // lesson count crosses a multiple of GRADUATION_THRESHOLD. This matters — the
      // SkillProposer needs ≥3 DISTINCT sources, so a too-eager pass at 2 lessons would
      // commit a 2-source generalization that then blocks the 3-source pass (the
      // reflection engine skips clusters it has already generalized). Waiting until the
      // first pass sees ≥3 lets graduation fire directly. The periodic brain-queue
      // reflection still runs independently for the slow path.
      if (result.lessonDeposited && this.deps.reflection) {
        result.reflection = await this.#maybeGraduate(input.workspaceId, input.appId);
      }
    } catch (err) {
      this.deps.logger.warn('app.learning.record_failed', { appId: input.appId, err: (err as Error).message });
    }
    return result;
  }

  /**
   * Reflect over the App's (now-richer) scoped plane so recurring winning patterns
   * can graduate into a skill via the existing SkillProposer hook.
   *
   * Gated on a recurrence THRESHOLD: only nudge a pass once the scoped lesson count
   * crosses a multiple of GRADUATION_THRESHOLD. This matters — the SkillProposer
   * needs ≥3 DISTINCT sources, so a too-eager pass at 2 lessons would commit a
   * 2-source generalization that then blocks the 3-source pass (the reflection
   * engine skips clusters it has already generalized). Waiting until the first pass
   * sees ≥3 lets graduation fire directly. The periodic brain-queue reflection still
   * runs independently for the slow path.
   */
  async #maybeGraduate(workspaceId: string, appId: string): Promise<{ generalizations: number; skillsProposed: number } | null> {
    if (!this.deps.reflection) return null;
    const scopedLessons = this.#scopedLessonCount(workspaceId, appId);
    if (scopedLessons < GRADUATION_THRESHOLD || scopedLessons % GRADUATION_THRESHOLD !== 0) return null;
    try {
      const r = await this.deps.reflection.run({ workspaceId, scopeId: appId, trigger: 'episode_threshold' });
      return { generalizations: r.generalizations, skillsProposed: r.skillsProposed };
    } catch (err) {
      this.deps.logger.warn('app.learning.reflection_failed', { appId, err: (err as Error).message });
      return null;
    }
  }

  /**
   * Conversation-driven learning: a per-contact SCRIPT (GAP B1/B3) reached a
   * terminal outcome — deposit a graded lesson to the App owner's memory plane,
   * exactly like {@link recordOutcome} but sourced from a datastore-backed
   * conversation contact (no `app_contacts` row required). This is what makes ANY
   * relationship App's Brain (support, booking, sales, collections…) fill with
   * real "what worked / what didn't" over time. Non-throwing.
   */
  async recordConversationOutcome(input: {
    workspaceId: string;
    appId: string;
    address: string;
    outcome: AppOutcome;
    /** A short, scrubbed note on what happened (e.g. the last exchange). */
    summary?: string | null;
  }): Promise<RecordOutcomeResult> {
    const result: RecordOutcomeResult = { recorded: false, lessonDeposited: false, reflection: null };
    if (!OUTCOME_VALUES.has(input.outcome)) return result;
    try {
      const ownerAgentId = this.#ownerAgentId(input.appId);
      const verb = input.outcome === 'won' ? 'WON' : input.outcome === 'lost' ? 'LOST' : 'ABANDONED';
      const title = `Conversation ${verb}: ${input.address}`;
      const content =
        `A per-contact conversation ended ${verb} for this App.\nContact: ${input.address}.`
        + (input.summary ? `\nWhat happened: ${input.summary}` : '');
      result.recorded = true;
      await this.deps.shared.commitDurableAtom({
        workspaceId: input.workspaceId,
        // Scoped to the App (see recordOutcome) — the owner agent is attribution.
        scopeId: input.appId,
        agentId: ownerAgentId,
        content,
        title,
        confidence: 0.62,
        source: 'system_write',
        outcomeStatus: input.outcome === 'won' ? 'good' : 'bad',
        tags: [LESSON_TAG, `app:${input.appId}`, `outcome:${input.outcome}`, ...(ownerAgentId ? [`role:${ownerAgentId}`] : [])],
        metadata: { m2: true, appId: input.appId, outcome: input.outcome, contactRef: input.address },
      });
      result.lessonDeposited = true;
      // GRADUATION — same recurrence-gated nudge as recordOutcome.
      result.reflection = await this.#maybeGraduate(input.workspaceId, input.appId);
    } catch (err) {
      this.deps.logger.warn('app.learning.conversation_outcome_failed', { appId: input.appId, err: (err as Error).message });
    }
    return result;
  }

  /**
   * Mark contacts abandoned when they have gone untouched past a threshold and
   * carry no terminal outcome yet. Each becomes a recorded 'abandoned' outcome
   * (→ a graded lesson). Returns how many were swept. Non-throwing.
   */
  async sweepAbandoned(now: string = new Date().toISOString(), thresholdMs: number = DEFAULT_ABANDON_MS): Promise<{ swept: number }> {
    let swept = 0;
    try {
      const cutoff = new Date(Date.parse(now) - Math.max(0, thresholdMs)).toISOString();
      const stale = this.deps.db
        .select({ id: schema.appContacts.id, workspaceId: schema.appContacts.workspaceId, appId: schema.appContacts.appId })
        .from(schema.appContacts)
        .where(and(
          isNull(schema.appContacts.outcome),
          // never touched, or last touched before the cutoff
          or(isNull(schema.appContacts.lastTouchAt), lte(schema.appContacts.lastTouchAt, cutoff)),
        ))
        .limit(100)
        .all();
      for (const c of stale) {
        const r = await this.recordOutcome({ workspaceId: c.workspaceId, appId: c.appId, contactId: c.id, outcome: 'abandoned' });
        if (r.recorded) swept += 1;
      }
    } catch (err) {
      this.deps.logger.warn('app.learning.sweep_failed', { err: (err as Error).message });
    }
    return { swept };
  }

  /**
   * "What this agent learned" — recent graded lessons + graduated abilities for an
   * App. Lessons are the App-tagged distilled-lesson episodes; abilities are those
   * whose origin/lessons trace back to this App's owner role. Never throws.
   */
  recentLearnings(workspaceId: string, appId: string, limit = 20): RecentLearnings {
    const out: RecentLearnings = { appId, ownerAgentId: null, lessons: [] };
    try {
      const ownerAgentId = this.#ownerAgentId(appId);
      out.ownerAgentId = ownerAgentId;

      // The App IS the brain scope, so "what this App learned" is simply what sits
      // in its scope: relationship lessons AND the graded run outcomes that
      // onRunSettled deposits. Reading the scope (not a tag LIKE) means a lesson
      // written by any future App-scoped writer shows up here for free.
      const lessonRows = this.deps.db
        .select({
          id: schema.memoryEpisodes.id,
          title: schema.memoryEpisodes.title,
          summary: schema.memoryEpisodes.summary,
          metadata: schema.memoryEpisodes.metadata,
          createdAt: schema.memoryEpisodes.createdAt,
        })
        .from(schema.memoryEpisodes)
        .where(and(
          eq(schema.memoryEpisodes.workspaceId, workspaceId),
          eq(schema.memoryEpisodes.scopeId, appId),
          isNull(schema.memoryEpisodes.archivedAt),
          // Staged run-output traces are noise here (and are hidden from the graph
          // for the same reason) — only durable, formed lessons count as learning.
          sql`${schema.memoryEpisodes.tags} NOT LIKE '%unconsolidated%'`,
        ))
        .orderBy(desc(schema.memoryEpisodes.createdAt))
        .limit(limit)
        .all();
      out.lessons = lessonRows.map((r) => {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        return {
          id: r.id,
          title: r.title,
          summary: r.summary,
          outcome: typeof meta.outcome === 'string' ? meta.outcome : null,
          createdAt: r.createdAt,
        };
      });

    } catch (err) {
      this.deps.logger.warn('app.learning.recent_failed', { appId, err: (err as Error).message });
    }
    return out;
  }


  #ownerAgentId(appId: string): string | null {
    try {
      const row = this.deps.db.select({ ownerAgentId: schema.apps.ownerAgentId }).from(schema.apps).where(eq(schema.apps.id, appId)).get();
      return row?.ownerAgentId ?? null;
    } catch {
      return null;
    }
  }

  /** How many graded lessons currently sit in the owner agent's scope. */
  #scopedLessonCount(workspaceId: string, scopeId: string): number {
    try {
      const rows = this.deps.db
        .select({ id: schema.memoryEpisodes.id })
        .from(schema.memoryEpisodes)
        .where(and(
          eq(schema.memoryEpisodes.workspaceId, workspaceId),
          eq(schema.memoryEpisodes.scopeId, scopeId),
          isNull(schema.memoryEpisodes.archivedAt),
          sql`${schema.memoryEpisodes.tags} LIKE ${'%' + LESSON_TAG + '%'}`,
        ))
        .all();
      return rows.length;
    } catch {
      return 0;
    }
  }

  /**
   * Distil a durable, reusable lesson from the outcome + contact context. This is
   * NOT the transcript — it's a third-person, reusable rule the role should carry.
   * The agent's own note (already distilled) is preferred when present; otherwise a
   * grounded template keyed off the outcome + stage/goal so something durable is
   * always written (deterministic, model-free).
   */
  #composeLesson(args: {
    contact: { stage: string | null; goal: string | null; channelKind: string | null; displayName: string | null };
    outcome: AppOutcome;
    note?: string | null;
  }): { title: string; content: string } | null {
    const { contact, outcome } = args;
    const channel = contact.channelKind ?? 'a channel';
    const stage = contact.stage ?? 'an unknown stage';
    const goal = contact.goal ? ` toward the goal "${truncate(contact.goal, 120)}"` : '';
    const note = args.note?.trim();

    let body: string;
    if (note && note.length >= 12) {
      // The agent distilled it — keep it, framed for reuse.
      body = `When working a ${channel} relationship${goal}, a recently ${outcome} conversation taught: ${truncate(note, 320)}`;
    } else if (outcome === 'won') {
      body = `Relationships on ${channel} that reached "${stage}"${goal} were won — repeat the approach that advanced them through that stage; keep momentum and follow up as promised.`;
    } else if (outcome === 'lost') {
      body = `Relationships on ${channel} that stalled at "${stage}"${goal} were lost — treat that stage as a risk point; surface objections early and offer the next concrete step instead of letting it drift.`;
    } else {
      body = `Relationships on ${channel} left untouched at "${stage}"${goal} were abandoned — reach out before the thread goes cold; set a next-touch and follow up proactively rather than waiting.`;
    }
    const title = truncate(`Lesson (${outcome}): ${channel} @ ${stage}`, 88);
    return { title, content: truncate(body, 480) };
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trim()}…`;
}
