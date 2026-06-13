/**
 * SpecialistLoadoutService — Phase 3 (SPECIALISTS-10X).
 *
 * Binds abilities to a specialist *role* as explicit professional DNA, instead
 * of relying only on per-agent pins or semantic relevance. A loadout entry has
 * a mode:
 *   - required:  injected every dispatch for the role (like a pin, score 1.0)
 *   - preferred: injected when its relevance clears a lowered threshold
 *   - optional:  ordinary semantic matching (no boost)
 *   - forbidden: never injected for this role, even if pinned/semantic
 *
 * Keyed by role string so it governs every materialized agent carrying that
 * role. The engine consults {@link resolveForRole} inside #buildAbilityBlock.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { normalizeRole } from '@agentis/core';

export type LoadoutMode = 'required' | 'preferred' | 'optional' | 'forbidden';
export type ConflictPolicy = 'specialist_wins' | 'ability_wins' | 'newest_wins' | 'evaluator_decides';

export interface LoadoutEntry {
  id: string;
  role: string;
  abilityId: string;
  mode: LoadoutMode;
  priority: number;
  minRelevanceScore: number | null;
  conflictPolicy: ConflictPolicy;
  enabled: boolean;
}

export interface ResolvedLoadout {
  required: Set<string>;
  forbidden: Set<string>;
  /** abilityId → lowered min-relevance threshold for preferred abilities. */
  preferred: Map<string, number>;
  /** All enabled entries by ability id, for priority/conflict resolution. */
  byAbility: Map<string, LoadoutEntry>;
  isEmpty: boolean;
}

const MODES = new Set<LoadoutMode>(['required', 'preferred', 'optional', 'forbidden']);
const POLICIES = new Set<ConflictPolicy>(['specialist_wins', 'ability_wins', 'newest_wins', 'evaluator_decides']);

export class SpecialistLoadoutService {
  constructor(private readonly db: AgentisSqliteDb) {}

  /** Every loadout entry for a role (enabled and disabled). */
  listForRole(workspaceId: string, role: string): LoadoutEntry[] {
    const r = normalizeRole(role);
    return this.db
      .select()
      .from(schema.specialistAbilityLoadouts)
      .where(and(eq(schema.specialistAbilityLoadouts.workspaceId, workspaceId), eq(schema.specialistAbilityLoadouts.role, r)))
      .all()
      .map(toEntry)
      .sort((a, b) => b.priority - a.priority);
  }

  /** Upsert a single ability's loadout entry for a role. */
  setEntry(
    workspaceId: string,
    role: string,
    abilityId: string,
    patch: Partial<Pick<LoadoutEntry, 'mode' | 'priority' | 'minRelevanceScore' | 'conflictPolicy' | 'enabled'>>,
  ): LoadoutEntry {
    const r = normalizeRole(role);
    const mode: LoadoutMode = patch.mode && MODES.has(patch.mode) ? patch.mode : 'preferred';
    const conflictPolicy: ConflictPolicy = patch.conflictPolicy && POLICIES.has(patch.conflictPolicy) ? patch.conflictPolicy : 'specialist_wins';
    const now = new Date().toISOString();
    const existing = this.db
      .select()
      .from(schema.specialistAbilityLoadouts)
      .where(and(
        eq(schema.specialistAbilityLoadouts.workspaceId, workspaceId),
        eq(schema.specialistAbilityLoadouts.role, r),
        eq(schema.specialistAbilityLoadouts.abilityId, abilityId),
      ))
      .get();
    if (existing) {
      this.db.update(schema.specialistAbilityLoadouts).set({
        mode,
        priority: patch.priority ?? existing.priority,
        minRelevanceScore: patch.minRelevanceScore ?? existing.minRelevanceScore,
        conflictPolicy,
        enabled: patch.enabled ?? Boolean(existing.enabled),
        updatedAt: now,
      }).where(eq(schema.specialistAbilityLoadouts.id, existing.id)).run();
      return this.#get(existing.id);
    }
    const id = randomUUID();
    this.db.insert(schema.specialistAbilityLoadouts).values({
      id,
      workspaceId,
      role: r,
      abilityId,
      mode,
      priority: patch.priority ?? 0,
      minRelevanceScore: patch.minRelevanceScore ?? null,
      conflictPolicy,
      enabled: patch.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.#get(id);
  }

  removeEntry(workspaceId: string, role: string, abilityId: string): void {
    const r = normalizeRole(role);
    this.db.delete(schema.specialistAbilityLoadouts).where(and(
      eq(schema.specialistAbilityLoadouts.workspaceId, workspaceId),
      eq(schema.specialistAbilityLoadouts.role, r),
      eq(schema.specialistAbilityLoadouts.abilityId, abilityId),
    )).run();
  }

  /** Compile the loadout into the lookup sets the engine applies at dispatch. */
  resolveForRole(workspaceId: string, role: string): ResolvedLoadout {
    const entries = this.listForRole(workspaceId, role).filter((e) => e.enabled);
    const required = new Set<string>();
    const forbidden = new Set<string>();
    const preferred = new Map<string, number>();
    const byAbility = new Map<string, LoadoutEntry>();
    for (const e of entries) {
      byAbility.set(e.abilityId, e);
      if (e.mode === 'required') required.add(e.abilityId);
      else if (e.mode === 'forbidden') forbidden.add(e.abilityId);
      else if (e.mode === 'preferred') preferred.set(e.abilityId, e.minRelevanceScore ?? 0.2);
    }
    return { required, forbidden, preferred, byAbility, isEmpty: entries.length === 0 };
  }

  #get(id: string): LoadoutEntry {
    const row = this.db.select().from(schema.specialistAbilityLoadouts).where(eq(schema.specialistAbilityLoadouts.id, id)).get();
    if (!row) throw new Error(`loadout entry ${id} not found`);
    return toEntry(row);
  }
}

function toEntry(row: typeof schema.specialistAbilityLoadouts.$inferSelect): LoadoutEntry {
  return {
    id: row.id,
    role: row.role,
    abilityId: row.abilityId,
    mode: (MODES.has(row.mode as LoadoutMode) ? row.mode : 'preferred') as LoadoutMode,
    priority: row.priority,
    minRelevanceScore: row.minRelevanceScore,
    conflictPolicy: (POLICIES.has(row.conflictPolicy as ConflictPolicy) ? row.conflictPolicy : 'specialist_wins') as ConflictPolicy,
    enabled: Boolean(row.enabled),
  };
}
