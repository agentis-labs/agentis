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
import { SPECIALIST_AGENTS, specialistForRole, type AgentRole, type SpecialistDefinition } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export class SpecialistAgentService {
  constructor(private readonly db: AgentisSqliteDb) {}

  /** Resolve a role to a concrete agentId, seeding the specialist if absent. */
  ensureRole(workspaceId: string, userId: string, role: AgentRole): string {
    const existing = this.#findByRole(workspaceId, role);
    if (existing) return existing;
    return this.#create(workspaceId, userId, specialistForRole(role));
  }

  /** Resolve a role to an existing agentId without creating one. */
  resolveRole(workspaceId: string, role: AgentRole): string | null {
    return this.#findByRole(workspaceId, role);
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

  list(workspaceId: string): Array<{ id: string; role: string | null; name: string; status: string }> {
    const roleSet = new Set<string>(SPECIALIST_AGENTS.map((s) => s.role));
    return this.db
      .select({ id: schema.agents.id, role: schema.agents.role, name: schema.agents.name, status: schema.agents.status })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId))
      .all()
      .filter((a) => a.role != null && roleSet.has(a.role));
  }

  #findByRole(workspaceId: string, role: AgentRole): string | null {
    const row = this.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, role)))
      .get();
    return row?.id ?? null;
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
