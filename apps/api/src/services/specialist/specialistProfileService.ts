/**
 * SpecialistProfileService — Phase 1 (SPECIALISTS-10X).
 *
 * The durable expert definition for a functional role: identity, runtime
 * contract, generated card, status, version. One profile per (workspace, role);
 * the materialized agent rows are its instances. A profile is authored alongside
 * the agent (see SpecialistAgentService.authorSpecialist via the route) and
 * enriched over time with mind, loadout, and evals.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { normalizeRole, type SpecialistDefinition } from '@agentis/core';

export type SpecialistStatus = 'draft' | 'ready' | 'degraded' | 'archived';

export interface SpecialistRuntimeProfile {
  /** default | deep_reasoning | cheap | vision | local */
  modelPolicy?: string;
  /** advise | draft | act_with_approval | autonomous_limited */
  autonomyLevel?: string;
  /** stateless | persistent | per_workflow | per_user */
  sessionPolicy?: string;
  budget?: { maxTokens?: number; maxDollars?: number; maxDelegations?: number; maxDepth?: number };
  [k: string]: unknown;
}

/** A2A-aligned, secret-free capability contract for a specialist. */
export interface SpecialistCard {
  name: string;
  role: string;
  description: string;
  version: number;
  status: SpecialistStatus;
  skills: string[];
  modalities: { inputs: string[]; outputs: string[] };
  capabilities: { streaming: boolean; artifacts: boolean; stateHistory: boolean; delegation: boolean };
  tools: string[];
  abilities: Array<{ name: string; mode: string }>;
  autonomy: string;
  safety: { requiresApprovalForHighImpact: boolean; sourceTrustEnforced: boolean };
  generatedAt: string;
}

export interface SpecialistProfile {
  id: string;
  role: string;
  name: string;
  title: string | null;
  description: string | null;
  identityPrompt: string | null;
  responsibilityContract: string | null;
  boundaries: string | null;
  status: SpecialistStatus;
  runtimeProfile: SpecialistRuntimeProfile;
  card: SpecialistCard | null;
  version: number;
}

export interface CardInputs {
  /** Resolved specialist definition (built-in/library/generic). */
  def: SpecialistDefinition;
  /** Role-scoped tool names available at dispatch. */
  tools: string[];
  /** Loadout abilities (name + mode) bound to the role. */
  abilities: Array<{ name: string; mode: string }>;
  /** Whether the runtime supports stateful sessions/artifacts. */
  modalities?: { inputs?: string[]; outputs?: string[] };
}

const STATUSES = new Set<SpecialistStatus>(['draft', 'ready', 'degraded', 'archived']);

export class SpecialistProfileService {
  constructor(private readonly db: AgentisSqliteDb) {}

  get(workspaceId: string, role: string): SpecialistProfile | null {
    const row = this.#row(workspaceId, normalizeRole(role));
    return row ? toProfile(row) : null;
  }

  list(workspaceId: string): SpecialistProfile[] {
    return this.db
      .select()
      .from(schema.specialistProfiles)
      .where(eq(schema.specialistProfiles.workspaceId, workspaceId))
      .all()
      .map(toProfile);
  }

  /** Create or refresh a profile from a specialist definition (idempotent by role). */
  ensureFromDef(workspaceId: string, def: SpecialistDefinition, createdBy?: string): SpecialistProfile {
    const role = normalizeRole(def.role);
    const existing = this.#row(workspaceId, role);
    const now = new Date().toISOString();
    if (existing) {
      // Don't clobber operator-edited identity; only backfill empty fields.
      this.db.update(schema.specialistProfiles).set({
        name: existing.name || def.name,
        description: existing.description ?? def.description,
        identityPrompt: existing.identityPrompt ?? def.systemPrompt,
        updatedAt: now,
      }).where(eq(schema.specialistProfiles.id, existing.id)).run();
      return this.get(workspaceId, role)!;
    }
    const id = randomUUID();
    this.db.insert(schema.specialistProfiles).values({
      id,
      workspaceId,
      role,
      name: def.name,
      title: null,
      description: def.description,
      identityPrompt: def.systemPrompt,
      responsibilityContract: null,
      boundaries: null,
      status: 'draft',
      runtimeProfile: { modelPolicy: 'default', autonomyLevel: 'act_with_approval', sessionPolicy: 'stateless' },
      card: null,
      version: 1,
      createdBy: createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.get(workspaceId, role)!;
  }

  patch(
    workspaceId: string,
    role: string,
    patch: Partial<Pick<SpecialistProfile, 'name' | 'title' | 'description' | 'identityPrompt' | 'responsibilityContract' | 'boundaries' | 'status' | 'runtimeProfile'>>,
  ): SpecialistProfile {
    const r = normalizeRole(role);
    const existing = this.#row(workspaceId, r);
    if (!existing) throw new Error(`no specialist profile for role '${r}'`);
    const status = patch.status && STATUSES.has(patch.status) ? patch.status : undefined;
    this.db.update(schema.specialistProfiles).set({
      name: patch.name ?? existing.name,
      title: patch.title ?? existing.title,
      description: patch.description ?? existing.description,
      identityPrompt: patch.identityPrompt ?? existing.identityPrompt,
      responsibilityContract: patch.responsibilityContract ?? existing.responsibilityContract,
      boundaries: patch.boundaries ?? existing.boundaries,
      status: status ?? existing.status,
      runtimeProfile: patch.runtimeProfile ?? (existing.runtimeProfile as SpecialistRuntimeProfile),
      version: existing.version + (patch.status === 'ready' ? 1 : 0),
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.specialistProfiles.id, existing.id)).run();
    return this.get(workspaceId, r)!;
  }

  /** Synthesize and persist a SpecialistCard from current identity + tools + loadout. */
  generateCard(workspaceId: string, role: string, inputs: CardInputs): SpecialistCard {
    const r = normalizeRole(role);
    const profile = this.ensureFromDef(workspaceId, inputs.def);
    const runtime = profile.runtimeProfile;
    const card: SpecialistCard = {
      name: inputs.def.name,
      role: r,
      description: inputs.def.description,
      version: profile.version,
      status: profile.status,
      skills: inputs.def.capabilityTags ?? [],
      modalities: {
        inputs: inputs.modalities?.inputs ?? ['text'],
        outputs: inputs.modalities?.outputs ?? ['text'],
      },
      capabilities: { streaming: true, artifacts: true, stateHistory: true, delegation: true },
      tools: inputs.tools,
      abilities: inputs.abilities,
      autonomy: String(runtime.autonomyLevel ?? 'act_with_approval'),
      safety: { requiresApprovalForHighImpact: runtime.autonomyLevel !== 'autonomous_limited', sourceTrustEnforced: true },
      generatedAt: new Date().toISOString(),
    };
    this.db.update(schema.specialistProfiles).set({ card, updatedAt: card.generatedAt }).where(and(
      eq(schema.specialistProfiles.workspaceId, workspaceId),
      eq(schema.specialistProfiles.role, r),
    )).run();
    return card;
  }

  #row(workspaceId: string, role: string) {
    return this.db.select().from(schema.specialistProfiles).where(and(
      eq(schema.specialistProfiles.workspaceId, workspaceId),
      eq(schema.specialistProfiles.role, role),
    )).get();
  }
}

function toProfile(row: typeof schema.specialistProfiles.$inferSelect): SpecialistProfile {
  return {
    id: row.id,
    role: row.role,
    name: row.name,
    title: row.title,
    description: row.description,
    identityPrompt: row.identityPrompt,
    responsibilityContract: row.responsibilityContract,
    boundaries: row.boundaries,
    status: (STATUSES.has(row.status as SpecialistStatus) ? row.status : 'draft') as SpecialistStatus,
    runtimeProfile: (row.runtimeProfile ?? {}) as SpecialistRuntimeProfile,
    card: (row.card ?? null) as SpecialistCard | null,
    version: row.version,
  };
}
