/**
 * SpecialistAgentService — Layer 2 §2.2.
 *
 * Materializes the built-in specialist agent library (Planner, Researcher,
 * Coder, …) into a workspace as real `agents` rows keyed by their `role`, and
 * resolves an `agent_task.agentRole` to a concrete agentId at dispatch time.
 *
 * Seeding is idempotent: a specialist already present (by workspace+role) is
 * left untouched so operator edits (model, instructions) survive re-seeds.
 * Specialists are created `offline` with `adapterType: 'http'` — they execute
 * once an adapter/runtime is connected for them, exactly like any other agent.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  SPECIALIST_AGENTS,
  specialistForRole,
  genericSpecialist,
  normalizeRole,
  type AgentRole,
  type SpecialistDefinition,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AgentDefinition, AgentLibraryService } from './agentLibrary.js';

export class SpecialistAgentService {
  constructor(
    private readonly db: AgentisSqliteDb,
    /**
     * Optional so existing callers/tests keep working. When present, custom and
     * AI-generated specialist roles resolve through the workspace agent library
     * (filesystem-backed) before falling back to a synthesized generic profile.
     */
    private readonly library?: AgentLibraryService,
  ) {}

  /**
   * Resolve a role string to a full specialist definition without throwing.
   * Order: built-in platform role → workspace library (sync cache) → synthesized
   * generic specialist. This is the single registry-aware resolver the engine
   * uses for system-prompt injection and that `ensureRole` uses for seeding.
   */
  defForRole(workspaceId: string, role: AgentRole): SpecialistDefinition {
    const normalized = normalizeRole(role);
    const builtin = specialistForRole(normalized, null);
    if (builtin) return builtin;
    const lib = this.library?.getByRoleSync(workspaceId, normalized);
    if (lib) return fromLibrary(lib);
    return genericSpecialist(normalized);
  }

  /** Resolve a role to a concrete agentId, seeding the specialist if absent. */
  ensureRole(workspaceId: string, userId: string, role: AgentRole): string {
    const normalized = normalizeRole(role);
    const existing = this.#findByRole(workspaceId, normalized);
    if (existing) return existing;
    return this.#create(workspaceId, userId, this.defForRole(workspaceId, normalized));
  }

  /** Resolve a role to an existing agentId without creating one. */
  resolveRole(workspaceId: string, role: AgentRole): string | null {
    return this.#findByRole(workspaceId, normalizeRole(role));
  }

  /**
   * Author a custom or AI-generated specialist: persist its definition to the
   * workspace agent library (filesystem, when wired) and upsert the materialized
   * agent row. After this returns, `delegate_task({ role })` and workflow nodes
   * referencing the role resolve immediately. This is the single code path
   * shared by the `/v1/specialists` API and the `create_specialist` runtime tool.
   */
  async authorSpecialist(
    workspaceId: string,
    userId: string,
    input: SpecialistAuthorInput,
  ): Promise<{ agentId: string; role: string; created: boolean; def: SpecialistDefinition }> {
    const role = slugifyRole(input.role ?? input.name);
    if (!role) throw new Error('specialist requires a role or name');
    const generated = input.source === 'generated';
    // Build the canonical definition (generic fills any gaps with sane defaults).
    const def = genericSpecialist(role, {
      source: generated ? 'generated' : 'custom',
      name: input.name?.trim() || undefined,
      description: input.description?.trim() || undefined,
      systemPrompt: input.instructions?.trim() || undefined,
      defaultModel: input.model?.trim() || undefined,
      tools: input.tools?.length ? (input.tools as SpecialistDefinition['tools']) : undefined,
      capabilityTags: input.capabilityTags?.length ? input.capabilityTags : undefined,
      colorHex: input.colorHex?.trim() || undefined,
      avatarGlyph: input.avatarGlyph?.trim() || undefined,
    });
    // Persist to the agent library (warms the sync cache so defForRole/ensureRole
    // pick up the rich definition rather than a bare generic one).
    if (this.library) {
      const libDef = {
        name: def.name,
        role,
        model: def.defaultModel,
        tools: def.tools as string[],
        capabilityTags: def.capabilityTags,
        colorHex: def.colorHex,
        avatarGlyph: def.avatarGlyph,
        description: def.description,
        body: def.systemPrompt,
      };
      if (generated) await this.library.writeGenerated(workspaceId, libDef);
      else await this.library.writeCustom(workspaceId, libDef);
    }
    const existing = this.#findByRole(workspaceId, role);
    const agentId = this.#upsert(workspaceId, userId, def, existing);
    return { agentId, role, created: existing === null, def };
  }

  /** Seed every built-in specialist into a workspace (idempotent). Returns created agentIds. */
  ensureAll(workspaceId: string, userId: string): string[] {
    const created: string[] = [];
    for (const spec of SPECIALIST_AGENTS) {
      if (this.#findByRole(workspaceId, spec.role)) continue;
      created.push(this.#create(workspaceId, userId, spec));
    }
    return created;
  }

  /**
   * Every materialized specialist agent in the workspace — built-in platform
   * roles *and* custom/generated functional roles. A specialist is any agent
   * with a role that isn't the orchestrator or manager hierarchy tier.
   */
  list(workspaceId: string): Array<{ id: string; role: string | null; name: string; status: string }> {
    const hierarchyTiers = new Set<string>(['orchestrator', 'manager']);
    return this.db
      .select({ id: schema.agents.id, role: schema.agents.role, name: schema.agents.name, status: schema.agents.status })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId))
      .all()
      .filter((a) => a.role != null && !hierarchyTiers.has(normalizeRole(a.role)));
  }

  #findByRole(workspaceId: string, role: string): string | null {
    const row = this.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, role)))
      .get();
    return row?.id ?? null;
  }

  /** Create the agent row for a role, or update an existing one's definition-derived fields. */
  #upsert(workspaceId: string, userId: string, spec: SpecialistDefinition, existingId: string | null): string {
    if (!existingId) return this.#create(workspaceId, userId, spec);
    const existing = this.db
      .select({ config: schema.agents.config })
      .from(schema.agents)
      .where(eq(schema.agents.id, existingId))
      .get();
    const prevConfig = (existing?.config && typeof existing.config === 'object' ? existing.config : {}) as Record<string, unknown>;
    this.db.update(schema.agents).set({
      name: spec.name,
      description: spec.description,
      capabilityTags: spec.capabilityTags,
      // Preserve operator-set adapter/runtime keys; refresh the specialist hints.
      config: { ...prevConfig, specialist: true, defaultModel: spec.defaultModel, tools: spec.tools },
      colorHex: spec.colorHex,
      instructions: spec.systemPrompt,
      avatarGlyph: spec.avatarGlyph,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.agents.id, existingId)).run();
    return existingId;
  }

  #create(workspaceId: string, userId: string, spec: SpecialistDefinition): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.insert(schema.agents).values({
      id,
      workspaceId,
      ambientId: null,
      userId,
      packageId: null,
      name: spec.name,
      description: spec.description,
      adapterType: 'http',
      capabilityTags: spec.capabilityTags,
      config: { specialist: true, defaultModel: spec.defaultModel, tools: spec.tools },
      status: 'offline',
      colorHex: spec.colorHex,
      instructions: spec.systemPrompt,
      avatarGlyph: spec.avatarGlyph,
      role: spec.role,
      createdAt: now,
      updatedAt: now,
    }).run();
    return id;
  }
}

/** Human/AI input for authoring a specialist. Only a role *or* name is required. */
export interface SpecialistAuthorInput {
  role?: string;
  name?: string;
  description?: string;
  /** The specialist's system prompt / identity instructions. */
  instructions?: string;
  model?: string;
  tools?: string[];
  capabilityTags?: string[];
  colorHex?: string;
  avatarGlyph?: string;
  /** `generated` marks AI-authored specialists for review; defaults to `custom`. */
  source?: 'custom' | 'generated';
}

/** Normalize a free-form role/name into a stable snake_case role slug. */
export function slugifyRole(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

/** Map a filesystem agent-library definition into a runtime specialist definition. */
function fromLibrary(def: AgentDefinition): SpecialistDefinition {
  const generic = genericSpecialist(def.role, {
    source: def.source,
    name: def.name,
    description: def.description,
    capabilityTags: def.capabilityTags.length ? def.capabilityTags : undefined,
    defaultModel: def.model || undefined,
    tools: def.tools.length ? (def.tools as SpecialistDefinition['tools']) : undefined,
    colorHex: def.colorHex,
    avatarGlyph: def.avatarGlyph,
    systemPrompt: def.body.trim() || undefined,
  });
  return generic;
}
