/**
 * AppLearningService — the conversational learning loop (LIVING-APPS-10X Phase M2 · G10).
 *
 * Closes the loop so a resident App agent gets MEASURABLY better over time:
 *
 *   1. OUTCOME  — a relationship reaches a terminal state (won | lost | abandoned),
 *      derived from `app_contacts.stage`/an explicit setter, or "abandoned" = no
 *      touch past a threshold. Recorded durably on the contact (`outcome`/`outcomeAt`).
 *   2. GRADED LESSON — on outcome, a distilled, durable lesson (what worked / what
 *      didn't for this App + role) is deposited through the EXISTING brain-formation
 *      path (`SharedIntelligence.addAtom` → a `distilled_lesson` episode), scoped to
 *      the App's owner agent so it lands in that agent's memory plane — never a raw
 *      transcript, and it respects the formation/scrubbing the brain already does.
 *   3. GRADUATION — those lessons live in the SAME episodic plane the cross-session
 *      `MemoryReflectionService` already reflects over. When lessons of the same
 *      shape recur (its ≥2-distinct-sources + ≥3-for-skill thresholds), reflection
 *      derives a generalized rule and fires the EXISTING `SkillProposer` hook —
 *      since the 2026-07-04 Abilities deletion that hook feeds the Living Skills
 *      path (Brain `skill` atoms), attributable to the agent scope, so future
 *      turns of that role inherit it.
 *      We trigger a SCOPED reflection pass on each terminal outcome so graduation is
 *      prompt, rather than only on the periodic cron.
 *   4. VISIBILITY — `recentLearnings` returns the recent graded lessons + graduated
 *      abilities for an App, so an operator can watch the skill grow.
 *
 * ADDITIVE + NON-THROWING + MODEL-AGNOSTIC. Every step is wrapped so a failure is a
 * silent no-op: the learning loop must NEVER break a turn or a conversation. With no
 * model wired, lessons are still deposited (deterministic) and reflection degrades to
 * recurrence-reinforcement — it never fabricates a rule or an ability.
 */

import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import type { SharedIntelligenceService } from '../sharedIntelligence.js';
import type { MemoryReflectionService } from '../memory/memoryReflectionService.js';

export type AppOutcome = 'won' | 'lost' | 'abandoned';

const OUTCOME_VALUES: ReadonlySet<string> = new Set(['won', 'lost', 'abandoned']);
/** Lesson episodes carry this tag so the visibility query can find them cheaply. */
const LESSON_TAG = 'm2_lesson';
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

export class AppLearningService {
  constructor(private readonly deps: AppLearningDeps) {}

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
          await this.deps.shared.addAtom({
            workspaceId: input.workspaceId,
            // Scope to the App's owner agent so it lands in that role's memory plane
            // (scopeId === agentId for agent-scoped memory). Null degrades to workspace.
            scopeId: ownerAgentId,
            agentId: ownerAgentId,
            content: lesson.content,
            title: lesson.title,
            confidence: 0.62,
            source: 'system_write',
            managed: true,
            tags: [LESSON_TAG, `app:${input.appId}`, `outcome:${input.outcome}`, 'pacer:procedural', ...(ownerAgentId ? [`role:${ownerAgentId}`] : [])],
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
      if (result.lessonDeposited && this.deps.reflection && ownerAgentId) {
        const scopedLessons = this.#scopedLessonCount(input.workspaceId, ownerAgentId);
        if (scopedLessons >= GRADUATION_THRESHOLD && scopedLessons % GRADUATION_THRESHOLD === 0) {
          try {
            const r = await this.deps.reflection.run({ workspaceId: input.workspaceId, scopeId: ownerAgentId, trigger: 'episode_threshold' });
            result.reflection = { generalizations: r.generalizations, skillsProposed: r.skillsProposed };
          } catch (err) {
            this.deps.logger.warn('app.learning.reflection_failed', { appId: input.appId, err: (err as Error).message });
          }
        }
      }
    } catch (err) {
      this.deps.logger.warn('app.learning.record_failed', { appId: input.appId, err: (err as Error).message });
    }
    return result;
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
      await this.deps.shared.addAtom({
        workspaceId: input.workspaceId,
        scopeId: ownerAgentId,
        agentId: ownerAgentId,
        content,
        title,
        confidence: 0.62,
        source: 'system_write',
        managed: true,
        tags: [LESSON_TAG, `app:${input.appId}`, `outcome:${input.outcome}`, 'pacer:procedural', ...(ownerAgentId ? [`role:${ownerAgentId}`] : [])],
        metadata: { m2: true, appId: input.appId, outcome: input.outcome, contactRef: input.address },
      });
      result.lessonDeposited = true;
      // GRADUATION — same recurrence-gated nudge as recordOutcome.
      if (this.deps.reflection && ownerAgentId) {
        const scopedLessons = this.#scopedLessonCount(input.workspaceId, ownerAgentId);
        if (scopedLessons >= GRADUATION_THRESHOLD && scopedLessons % GRADUATION_THRESHOLD === 0) {
          try {
            const r = await this.deps.reflection.run({ workspaceId: input.workspaceId, scopeId: ownerAgentId, trigger: 'episode_threshold' });
            result.reflection = { generalizations: r.generalizations, skillsProposed: r.skillsProposed };
          } catch (err) {
            this.deps.logger.warn('app.learning.reflection_failed', { appId: input.appId, err: (err as Error).message });
          }
        }
      }
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
          isNull(schema.memoryEpisodes.archivedAt),
          sql`${schema.memoryEpisodes.tags} LIKE ${'%' + LESSON_TAG + '%'}`,
          sql`${schema.memoryEpisodes.tags} LIKE ${'%app:' + appId + '%'}`,
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
