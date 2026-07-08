/**
 * feynmanReflection — the real Feynman repair loop (proposition §6.4 / Phase 4).
 *
 * The Feynman technique, made concrete for Agentis: when a node fails in a way
 * that the cheap layers couldn't resolve, force a COMPACT, GROUNDED explanation
 * of what went wrong, validate that the explanation references real evidence,
 * and only then commit a reusable lesson. A weak or ungrounded explanation
 * produces nothing — that is the correct, expected outcome.
 *
 * This is layered on top of the existing, cheaper failure-understanding tiers:
 *   L0 `runFailureAnalysis.analyzeRunFailure` — deterministic, model-free.
 *   L1 `WorkflowEngine` self-heal retry — re-dispatch with error context.
 *   L2 `FailureReflectionService` — a canned agent-memory lesson.
 *   L3 (THIS) — a queued, model-graded, evidence-checked repair lesson that
 *      lands in `memory_episodes` (agent- or workspace-scoped) so dispatch can
 *      retrieve it on future runs.
 *
 * Triggered ONLY by:
 *   - self-heal exhaustion, or
 *   - repeated failure of the same node across runs.
 * Never on every run — it is a queue job, not a per-run tax (proposition §3.3).
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { SharedIntelligenceService } from './sharedIntelligence.js';
import type { StructuredCompleter } from './structuredCompleter.js';
import { analyzeRunFailure } from './run/runFailureAnalysis.js';
import { tokenize } from './brain/brainText.js';
import { classifyPacer } from './brain/brainPacer.js';

export type FeynmanTrigger = 'self_heal_exhausted' | 'repeated_failure' | 'contradiction';

export interface FeynmanReflectionPayload {
  workspaceId: string;
  runId?: string | null;
  workflowId?: string | null;
  nodeId: string;
  nodeTitle?: string | null;
  agentId?: string | null;
  /** Agent intelligence scope — when set, a specialist-specific lesson is scoped here. */
  scopeId?: string | null;
  /** The failing node's prompt/instruction, if any. */
  prompt?: string | null;
  /** The real engine error string. */
  error: string;
  /** Compact preview of recent tool observations / node input. */
  observations?: string | null;
  trigger: FeynmanTrigger;
}

interface FeynmanExplanation {
  whatFailed: string;
  whyFailed: string;
  wrongAssumption: string;
  whatToVerify: string;
  lesson: string;
  lessonClass: 'procedural' | 'conceptual';
  scope: 'agent' | 'workspace';
  confidence: number;
}

/** Minimum grounding overlap (0..1) between the explanation and real evidence. */
const MIN_GROUNDING = 0.18;
/** Minimum model confidence to commit a lesson. */
const MIN_CONFIDENCE = 0.5;
/** How many same-node failures (incl. the current one) trip `repeated_failure`. */
export const REPEAT_FAILURE_THRESHOLD = 3;

export class FeynmanReflectionService {
  #completer: StructuredCompleter | null = null;
  #modelAssistedRuntimeEnabled: (workspaceId: string) => boolean = () => true;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly shared: SharedIntelligenceService,
    private readonly logger: Logger,
  ) {}

  /** Wire (or clear) the grading model. Mirrors SharedIntelligence's pattern. */
  setCompleter(completer: StructuredCompleter | null): void {
    this.#completer = completer;
  }

  setModelAssistedRuntimeEnabled(resolver: (workspaceId: string) => boolean): void {
    this.#modelAssistedRuntimeEnabled = resolver;
  }

  /**
   * Record a node failure as a durable signal and return how many times this
   * (workflow, node) has failed recently. The engine uses the count to decide
   * whether to enqueue a reflection. Cheap, deterministic — runs on every fail.
   */
  recordFailure(args: { workspaceId: string; workflowId?: string | null; nodeId: string; runId?: string | null; agentId?: string | null }): number {
    const key = `${args.workflowId ?? 'wf'}::${args.nodeId}`;
    try {
      this.db.insert(schema.brainQualityEvents).values({
        id: randomUUID(),
        workspaceId: args.workspaceId,
        scopeId: null,
        agentId: args.agentId ?? null,
        eventType: 'node_failure',
        atomId: null,
        abilityId: null,
        runId: args.runId ?? null,
        delta: null,
        metadata: { nodeFailureKey: key, workflowId: args.workflowId ?? null, nodeId: args.nodeId },
        createdAt: new Date().toISOString(),
      }).run();
    } catch (err) {
      this.logger.warn('feynman.record_failure_failed', { workspaceId: args.workspaceId, message: (err as Error).message });
    }
    return this.#countFailures(args.workspaceId, key);
  }

  #countFailures(workspaceId: string, key: string): number {
    const rows = this.db.select({ metadata: schema.brainQualityEvents.metadata })
      .from(schema.brainQualityEvents)
      .where(and(
        eq(schema.brainQualityEvents.workspaceId, workspaceId),
        eq(schema.brainQualityEvents.eventType, 'node_failure'),
      ))
      .orderBy(desc(schema.brainQualityEvents.createdAt))
      .limit(500)
      .all();
    let count = 0;
    for (const row of rows) {
      const meta = row.metadata as Record<string, unknown> | null;
      if (meta && meta.nodeFailureKey === key) count += 1;
    }
    return count;
  }

  /**
   * Run a reflection job. Returns what happened for observability/tests.
   * Never throws into the queue — it logs and returns a no-op result instead.
   */
  async run(payload: FeynmanReflectionPayload): Promise<{ stored: boolean; reason: string; atomId?: string }> {
    // L0 — deterministic grounding from real run state.
    const diagnosis = payload.runId
      ? analyzeRunFailure(this.db, payload.workspaceId, payload.runId)
      : null;

    const evidence = [
      payload.error,
      payload.nodeTitle ?? '',
      payload.prompt ?? '',
      payload.observations ?? '',
      diagnosis?.explanation ?? '',
      ...(diagnosis?.fixes ?? []),
    ].join('\n');

    // No model → fall back to a grounded procedural lesson ONLY when the
    // deterministic analyzer recognized the failure (high confidence, no model
    // risk). Otherwise no-op: an ungrounded guess is worse than nothing.
    if (!this.#completer || !this.#modelAssistedRuntimeEnabled(payload.workspaceId)) {
      if (diagnosis?.recognized && diagnosis.fixes.length > 0) {
        const lesson = `When "${payload.nodeTitle ?? payload.nodeId}" fails with this class of error (${oneLine(diagnosis.error ?? payload.error)}): ${diagnosis.fixes.join(' ')}`;
        const atomId = await this.#commit(payload, lesson, 'procedural', payload.scopeId ? 'agent' : 'workspace');
        this.#record(payload, true, 'deterministic_recognized', 1);
        return { stored: true, reason: 'deterministic_recognized', atomId };
      }
      this.#record(payload, false, 'no_model_unrecognized', 0);
      return { stored: false, reason: 'no_model_unrecognized' };
    }

    // L3 — model-graded structured explanation.
    const explanation = await this.#explain(payload, diagnosis?.explanation ?? null, diagnosis?.fixes ?? []);
    if (!explanation) {
      this.#record(payload, false, 'no_explanation', 0);
      return { stored: false, reason: 'no_explanation' };
    }

    // Grounding gate — the explanation must reference the real evidence, not
    // free-associate. This is the "compare the explanation to real state" step.
    const grounding = groundingOverlap(`${explanation.whatFailed} ${explanation.whyFailed} ${explanation.wrongAssumption}`, evidence);
    if (grounding < MIN_GROUNDING || explanation.confidence < MIN_CONFIDENCE) {
      this.#record(payload, false, `weak(grounding=${grounding.toFixed(2)},conf=${explanation.confidence.toFixed(2)})`, grounding);
      return { stored: false, reason: 'weak_explanation' };
    }

    const lesson = explanation.lesson.trim();
    if (lesson.length < 16) {
      this.#record(payload, false, 'empty_lesson', grounding);
      return { stored: false, reason: 'empty_lesson' };
    }
    const scope = explanation.scope === 'agent' && payload.scopeId ? 'agent' : 'workspace';
    const atomId = await this.#commit(payload, lesson, explanation.lessonClass, scope);
    this.#record(payload, true, `committed(grounding=${grounding.toFixed(2)})`, grounding);
    this.logger.info('feynman.reflection.committed', {
      workspaceId: payload.workspaceId,
      runId: payload.runId,
      nodeId: payload.nodeId,
      trigger: payload.trigger,
      lessonClass: explanation.lessonClass,
      scope,
      grounding,
    });
    return { stored: true, reason: 'committed', atomId };
  }

  async #explain(payload: FeynmanReflectionPayload, deterministicExplanation: string | null, fixes: string[]): Promise<FeynmanExplanation | null> {
    const system = [
      'You diagnose a failed step in an autonomous-agent workflow.',
      'Produce a COMPACT, GROUNDED explanation. Use ONLY the evidence given — the real error, the node prompt, and observations.',
      'Do NOT invent causes that the evidence does not support. If the evidence is insufficient, say so and set low confidence.',
      'Then distill ONE reusable lesson that would prevent or repair this failure on a FUTURE, DIFFERENT run.',
      'A procedural lesson is a concrete repair/avoidance step ("when X fails, do Y"). A conceptual lesson is an invariant/rationale.',
      'Write the lesson third-person and context-free (no "I"/"we", no run-specific ids).',
    ].join(' ');

    const user = [
      `FAILED NODE: ${payload.nodeTitle ?? payload.nodeId}`,
      payload.prompt ? `NODE INSTRUCTION:\n${truncate(payload.prompt, 800)}` : '',
      `REAL ERROR:\n${truncate(payload.error, 600)}`,
      payload.observations ? `RECENT OBSERVATIONS:\n${truncate(payload.observations, 800)}` : '',
      deterministicExplanation ? `DETERMINISTIC DIAGNOSIS:\n${deterministicExplanation}` : '',
      fixes.length ? `KNOWN FIXES:\n${fixes.map((f) => `- ${f}`).join('\n')}` : '',
      '',
      'Return JSON ONLY:',
      '{"whatFailed":"","whyFailed":"","wrongAssumption":"","whatToVerify":"","lesson":"reusable third-person rule","lessonClass":"procedural|conceptual","scope":"agent|workspace","confidence":0.0}',
    ].filter(Boolean).join('\n');

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = await this.#completer!.completeStructured<Record<string, unknown>>({
        system,
        user,
        workspaceId: payload.workspaceId,
        maxTokens: 600,
        maxAttempts: 2,
      });
    } catch {
      return null;
    }
    if (!parsed) return null;

    const lesson = typeof parsed.lesson === 'string' ? parsed.lesson.trim() : '';
    if (!lesson) return null;
    return {
      whatFailed: str(parsed.whatFailed),
      whyFailed: str(parsed.whyFailed),
      wrongAssumption: str(parsed.wrongAssumption),
      whatToVerify: str(parsed.whatToVerify),
      lesson,
      lessonClass: parsed.lessonClass === 'conceptual' ? 'conceptual' : 'procedural',
      scope: parsed.scope === 'workspace' ? 'workspace' : 'agent',
      confidence: clamp01(typeof parsed.confidence === 'number' ? parsed.confidence : 0.5),
    };
  }

  async #commit(payload: FeynmanReflectionPayload, lesson: string, lessonClass: 'procedural' | 'conceptual', scope: 'agent' | 'workspace'): Promise<string> {
    const pacer = classifyPacer({
      text: lesson,
      surface: 'agent_reflection',
      episodeType: lessonClass === 'procedural' ? 'recovery' : 'distilled_lesson',
    });
    const created = await this.shared.addAtom({
      workspaceId: payload.workspaceId,
      scopeId: scope === 'agent' ? (payload.scopeId ?? null) : null,
      workflowId: payload.workflowId ?? null,
      runId: payload.runId ?? null,
      agentId: payload.agentId ?? null,
      content: lesson,
      title: `Failure repair: ${truncate(payload.nodeTitle ?? payload.nodeId, 72)}`,
      tags: ['feynman', 'failure_repair', 'consolidated', `pacer:${pacer.pacerClass}`],
      confidence: 0.62,
      source: 'system_write',
      managed: true,
      metadata: {
        origin: 'feynman_reflection',
        trigger: payload.trigger,
        nodeId: payload.nodeId,
        pacerClass: pacer.pacerClass,
        pacerConfidence: pacer.confidence,
        originSurface: 'agent_reflection',
        formationMode: 'feynman',
      },
    });
    return created.id;
  }

  #record(payload: FeynmanReflectionPayload, stored: boolean, reason: string, grounding: number): void {
    this.shared.recordQualityEvent({
      workspaceId: payload.workspaceId,
      scopeId: payload.scopeId ?? null,
      agentId: payload.agentId ?? null,
      runId: payload.runId ?? null,
      eventType: 'feynman_reflection',
      metadata: { trigger: payload.trigger, nodeId: payload.nodeId, stored, reason, grounding },
    });
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/** Fraction of explanation tokens that also appear in the real evidence. */
function groundingOverlap(explanation: string, evidence: string): number {
  const expTokens = new Set(tokenize(explanation));
  if (expTokens.size === 0) return 0;
  const evidenceTokens = new Set(tokenize(evidence));
  let hit = 0;
  for (const t of expTokens) if (evidenceTokens.has(t)) hit += 1;
  return hit / expTokens.size;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
