/**
 * ExperimentService — the experiment/measurement substrate (Agent-Native §3.5).
 *
 * The one genuinely-absent primitive. General, domain-neutral: assign each subject to
 * a variant (sticky — a subject keeps its arm), record its terminal outcome, and
 * aggregate the success rate PER variant. The operator's "A/B test the 1st/2nd/3rd
 * message, success % of each" falls out of this with zero message-specific code — as
 * does any other experiment (which model, which prompt, which price).
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

/** Outcomes counted as a success when computing per-variant success rate. */
const SUCCESS_OUTCOMES = new Set(['won', 'success', 'positive', 'converted']);

export interface DefineExperimentInput {
  workspaceId: string;
  appId?: string | null;
  key: string;
  variants: string[];
}

export interface VariantResult {
  variant: string;
  assigned: number;
  withOutcome: number;
  outcomes: Record<string, number>;
  /** successes / assigned (proportion of the arm that converted). */
  successRate: number;
}

export class ExperimentService {
  constructor(private readonly db: AgentisSqliteDb) {}

  /** Find-or-create the experiment by (workspace, key). Updates variants when provided. */
  define(input: DefineExperimentInput) {
    const now = new Date().toISOString();
    const existing = this.#byKey(input.workspaceId, input.key);
    if (existing) {
      if (input.variants.length > 0) {
        this.db.update(schema.experiments)
          .set({ variantsJson: input.variants, ...(input.appId !== undefined ? { appId: input.appId } : {}), updatedAt: now })
          .where(eq(schema.experiments.id, existing.id)).run();
      }
      return this.#get(existing.id)!;
    }
    const id = randomUUID();
    this.db.insert(schema.experiments).values({
      id, workspaceId: input.workspaceId, appId: input.appId ?? null,
      key: input.key, variantsJson: input.variants, status: 'running', createdAt: now, updatedAt: now,
    }).run();
    return this.#get(id)!;
  }

  /**
   * Assign a subject to a variant (sticky + idempotent). Deterministic hash of the
   * subjectKey → the same subject always lands in the same arm, and arms stay roughly
   * balanced. Returns the chosen variant, or null when the experiment/variants are absent.
   */
  assign(input: { workspaceId: string; key: string; subjectKey: string }): string | null {
    const exp = this.#byKey(input.workspaceId, input.key);
    if (!exp) return null;
    const variants = (exp.variantsJson as string[]) ?? [];
    if (variants.length === 0) return null;

    const existing = this.db.select().from(schema.experimentAssignments)
      .where(and(eq(schema.experimentAssignments.experimentId, exp.id), eq(schema.experimentAssignments.subjectKey, input.subjectKey)))
      .get();
    if (existing) return existing.variant;

    const variant = variants[hash(input.subjectKey) % variants.length]!;
    this.db.insert(schema.experimentAssignments).values({
      id: randomUUID(), workspaceId: input.workspaceId, experimentId: exp.id,
      subjectKey: input.subjectKey, variant, outcome: null,
      assignedAt: new Date().toISOString(), outcomeAt: null,
    }).run();
    return variant;
  }

  /** Record a subject's terminal outcome against its assigned variant. Idempotent-overwrite. */
  record(input: { workspaceId: string; key: string; subjectKey: string; outcome: string }): boolean {
    const exp = this.#byKey(input.workspaceId, input.key);
    if (!exp) return false;
    const res = this.db.update(schema.experimentAssignments)
      .set({ outcome: input.outcome, outcomeAt: new Date().toISOString() })
      .where(and(eq(schema.experimentAssignments.experimentId, exp.id), eq(schema.experimentAssignments.subjectKey, input.subjectKey)))
      .run();
    return res.changes > 0;
  }

  /** Per-variant success rates — "the percentage of success of each". */
  results(workspaceId: string, key: string): { key: string; variants: VariantResult[] } | null {
    const exp = this.#byKey(workspaceId, key);
    if (!exp) return null;
    const rows = this.db.select().from(schema.experimentAssignments)
      .where(eq(schema.experimentAssignments.experimentId, exp.id)).all();
    const variants = (exp.variantsJson as string[]) ?? [];
    const byVariant = new Map<string, VariantResult>();
    for (const v of variants) byVariant.set(v, { variant: v, assigned: 0, withOutcome: 0, outcomes: {}, successRate: 0 });
    for (const r of rows) {
      const vr = byVariant.get(r.variant) ?? { variant: r.variant, assigned: 0, withOutcome: 0, outcomes: {}, successRate: 0 };
      vr.assigned += 1;
      if (r.outcome) {
        vr.withOutcome += 1;
        vr.outcomes[r.outcome] = (vr.outcomes[r.outcome] ?? 0) + 1;
      }
      byVariant.set(r.variant, vr);
    }
    for (const vr of byVariant.values()) {
      const successes = Object.entries(vr.outcomes).reduce((n, [o, c]) => n + (SUCCESS_OUTCOMES.has(o) ? c : 0), 0);
      vr.successRate = vr.assigned > 0 ? successes / vr.assigned : 0;
    }
    return { key: exp.key, variants: [...byVariant.values()] };
  }

  /** All experiments in a workspace (for the mission-control dashboard). */
  listExperiments(workspaceId: string) {
    return this.db.select().from(schema.experiments)
      .where(eq(schema.experiments.workspaceId, workspaceId)).all();
  }

  #byKey(workspaceId: string, key: string) {
    return this.db.select().from(schema.experiments)
      .where(and(eq(schema.experiments.workspaceId, workspaceId), eq(schema.experiments.key, key))).get() ?? null;
  }

  #get(id: string) {
    return this.db.select().from(schema.experiments).where(eq(schema.experiments.id, id)).get() ?? null;
  }
}

/** djb2 — a stable, fast string hash for deterministic (sticky, balanced) arm assignment. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}
