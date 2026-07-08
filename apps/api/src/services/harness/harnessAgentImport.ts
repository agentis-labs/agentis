/**
 * harnessAgentImport — the L3 import orchestrator (AGENT-TRANSITION §3).
 *
 * Turns a DiscoveredAgent into a living Agentis agent: commission identity +
 * an INITIAL (swappable, Track R) runtime binding, then ingest its real memory
 * into the Brain at the right scope. Idempotent at both levels:
 *   - agent: `config.importOrigin = { adapterType, externalId }` → re-import reuses
 *   - atom:  content-hash + semantic dedup (HarnessMemoryIngestionService)
 *
 * Reuses existing seams only: `commissionAgent` (creation) and
 * `HarnessMemoryIngestionService` (the Brain sink). No parallel logic.
 */

import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { commissionAgent, type AgentCommissionDeps } from '../agent/agentCommission.js';
import type { HarnessMemoryIngestionService, HarnessMemoryCandidate, IngestionCommitResult } from './harnessMemoryIngestion.js';
import type { IngestibleAgent } from './harnessMemoryIngestion.js';
import type { SkillService } from '../skillService.js';
import { discoverAgents, readAgentInputs } from '../harnessImport/registry.js';
import type { DiscoveredAgent, ImportSkill } from '../harnessImport/types.js';

export interface HarnessImportDeps extends AgentCommissionDeps {
  ingestion: HarnessMemoryIngestionService;
  /** Optional: when present, harness SKILL.md files become agent-scoped Brain
   * `skill` atoms (Living Skills) — scoping to the agent replaces old pinning. */
  skills?: SkillService;
}

export interface ImportScanOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string | null;
}

export interface DiscoveredAgentRow extends DiscoveredAgent {
  /** Resolved against existing agents' importOrigin — re-import reuses, never dupes. */
  alreadyImported: { agentId: string } | null;
}

/** A skill offered for transition into an Ability, with its dedup verdict. */
export interface SkillCandidate {
  path: string;
  name: string;
  description?: string | null;
  origin: ImportSkill['origin'];
  /** Already imported as an Ability in this workspace. */
  alreadyImported: boolean;
}

export interface AgentImportPreview {
  agent: DiscoveredAgentRow;
  candidates: HarnessMemoryCandidate[];
  skills: SkillCandidate[];
  scannedFiles: Array<{ fileName: string; source: string; candidateCount: number; skipped: boolean }>;
}

export interface ImportAgentSpec {
  externalId: string;
  overrides?: { name?: string; role?: string | null; reportsTo?: string | null };
  /** Memory subset to accept (by candidate hash). Omitted = all ≥ threshold. */
  acceptedHashes?: string[];
  /** Skill subset to transition (by SKILL.md path). Omitted = all non-marketplace. */
  acceptedSkillPaths?: string[];
  minQuality?: number;
}

export interface ImportAgentOutcome {
  externalId: string;
  agentId: string;
  created: boolean;
  name: string;
  adapterType: string;
  memory: IngestionCommitResult;
  /** Abilities created (or reused) + pinned from this agent's skills. */
  abilities: { created: number; reused: number };
}

export interface ImportBatchResult {
  imported: ImportAgentOutcome[];
  /** Total atoms written + reinforced across the batch (headline figure). */
  totalAtoms: number;
  /** Total abilities created across the batch. */
  totalAbilities: number;
}

/** List discoverable external agents, annotated with already-imported status. */
export async function discoverImportableAgents(deps: HarnessImportDeps, workspaceId: string, opts: ImportScanOptions = {}): Promise<DiscoveredAgentRow[]> {
  const discovered = await discoverAgents({ env: opts.env, cwd: opts.cwd });
  const originMap = importOriginMap(deps, workspaceId);
  return discovered.map((agent) => ({ ...agent, alreadyImported: originMap.get(agent.externalId) ?? null }));
}

export interface ImportUpdate {
  agentId: string;
  externalId: string;
  name: string;
  adapterType: string;
  /** New, non-duplicate memory atoms available since the last import. */
  pendingNew: number;
  /** New, non-duplicate memory atoms available since the last import. */
  pendingMemory: number;
  /** New user/project harness skills that can become Agentis Abilities. */
  pendingSkills: number;
}

/**
 * P4 continuous transition (approval-gated): re-scan already-imported agents and
 * report how much NEW memory their harness files have accumulated. Pure read —
 * nothing is written; the operator pulls via `importAgents` (idempotent).
 */
export async function checkImportUpdates(deps: HarnessImportDeps, workspaceId: string, opts: ImportScanOptions = {}): Promise<ImportUpdate[]> {
  const originMap = importOriginMap(deps, workspaceId);
  if (originMap.size === 0) return [];
  const discovered = await discoverAgents({ env: opts.env, cwd: opts.cwd });
  const byId = new Map(discovered.map((a) => [a.externalId, a]));
  const nameById = new Map(
    deps.db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)).all()
      .map((r) => [r.id, r.name] as const),
  );

  const updates: ImportUpdate[] = [];
  for (const [externalId, { agentId, cwd }] of originMap) {
    const agent = byId.get(externalId);
    if (!agent) continue;
    const readOpts = { env: opts.env, cwd: opts.cwd ?? cwd };
    const inputs = readAgentInputs(agent, readOpts);
    const ingestible = toIngestible(workspaceId, agentId, agent);
    const preview = deps.ingestion.previewImport(ingestible, inputs.files);
    const pendingMemory = preview.candidates.filter((c) => !c.duplicateOf).length;
    const pendingSkills = pendingSkillCount(deps, workspaceId, agentId, inputs.skills);
    if (pendingMemory > 0 || pendingSkills > 0) {
      updates.push({
        agentId,
        externalId,
        name: nameById.get(agentId) ?? agent.name,
        adapterType: agent.adapterType,
        pendingNew: pendingMemory,
        pendingMemory,
        pendingSkills,
      });
    }
  }
  return updates;
}

export interface ImportSyncOutcome {
  workspaceId: string;
  synced: ImportAgentOutcome[];
  totalAtoms: number;
  totalAbilities: number;
}

/**
 * Continuous import commit for already-imported agents. It applies safe defaults:
 * new memory above the quality gate and user/project skills. Marketplace/vendor
 * skills still require the explicit `importAgents` path with accepted paths.
 */
export async function syncImportedAgents(
  deps: HarnessImportDeps,
  workspaceId: string,
  opts: ImportScanOptions = {},
): Promise<ImportSyncOutcome> {
  const originMap = importOriginMap(deps, workspaceId);
  if (originMap.size === 0) return { workspaceId, synced: [], totalAtoms: 0, totalAbilities: 0 };

  const discovered = await discoverAgents({ env: opts.env, cwd: opts.cwd });
  const byId = new Map(discovered.map((a) => [a.externalId, a]));
  const result: ImportSyncOutcome = { workspaceId, synced: [], totalAtoms: 0, totalAbilities: 0 };

  for (const [externalId, existing] of originMap) {
    const agent = byId.get(externalId);
    if (!agent) continue;
    const readOpts = { env: opts.env, cwd: opts.cwd ?? existing.cwd };
    const inputs = readAgentInputs(agent, readOpts);
    const ingestible = toIngestible(workspaceId, existing.agentId, agent);
    const preview = deps.ingestion.previewImport(ingestible, inputs.files);
    const acceptedHashes = preview.candidates.filter((c) => !c.duplicateOf).map((c) => c.hash);
    const memory = await deps.ingestion.commitImport(ingestible, inputs.files, { acceptHashes: acceptedHashes });
    const acceptedSkillPaths = inputs.skills
      .filter((skill) => skill.origin !== 'marketplace' && !skillAlreadyAttached(deps, workspaceId, existing.agentId, skill.name))
      .map((skill) => skill.path);
    const abilities = await importSkills(deps, workspaceId, existing.userId, existing.agentId, inputs.skills, acceptedSkillPaths);

    if (memory.written > 0 || memory.reinforced > 0 || abilities.created > 0 || abilities.reused > 0) {
      result.synced.push({
        externalId,
        agentId: existing.agentId,
        created: false,
        name: existing.name,
        adapterType: agent.adapterType,
        memory,
        abilities,
      });
      result.totalAtoms += memory.written + memory.reinforced;
      result.totalAbilities += abilities.created;
      deps.logger.info('harness.agent.synced', {
        workspaceId,
        externalId,
        agentId: existing.agentId,
        written: memory.written,
        reinforced: memory.reinforced,
        abilities: abilities.created,
      });
    }
  }

  return result;
}

/** Preview one agent's import: identity + scope-routed, quality-gated memory. */
export async function previewAgentImport(deps: HarnessImportDeps, workspaceId: string, externalId: string, opts: ImportScanOptions & { minQuality?: number } = {}): Promise<AgentImportPreview> {
  const discovered = await discoverAgents({ env: opts.env, cwd: opts.cwd });
  const agent = discovered.find((a) => a.externalId === externalId);
  if (!agent) throw new Error(`discovered agent '${externalId}' not found`);
  const originMap = importOriginMap(deps, workspaceId);
  const alreadyImported = originMap.get(externalId) ?? null;

  const inputs = readAgentInputs(agent, { env: opts.env, cwd: opts.cwd });
  const ingestible = toIngestible(workspaceId, alreadyImported?.agentId ?? `preview:${externalId}`, agent);
  const preview = deps.ingestion.previewImport(ingestible, inputs.files, opts.minQuality);
  return {
    agent: { ...agent, alreadyImported },
    candidates: preview.candidates,
    skills: inputs.skills.map((s) => ({
      path: s.path,
      name: s.name,
      description: s.description ?? null,
      origin: s.origin,
      alreadyImported: abilityExists(deps, workspaceId, s.name),
    })),
    scannedFiles: preview.scannedFiles,
  };
}

/** Import a batch of agents: commission (or reuse) + scope-routed memory ingest. */
export async function importAgents(
  deps: HarnessImportDeps,
  input: { workspaceId: string; userId: string; specs: ImportAgentSpec[] } & ImportScanOptions,
): Promise<ImportBatchResult> {
  const discovered = await discoverAgents({ env: input.env, cwd: input.cwd });
  const byId = new Map(discovered.map((a) => [a.externalId, a]));
  const originMap = importOriginMap(deps, input.workspaceId);

  const result: ImportBatchResult = { imported: [], totalAtoms: 0, totalAbilities: 0 };

  for (const spec of input.specs) {
    const agent = byId.get(spec.externalId);
    if (!agent) continue;

    const existing = originMap.get(spec.externalId) ?? null;
    let agentId = existing?.agentId ?? null;
    let created = false;
    let name = spec.overrides?.name?.trim() || agent.name;

    if (!agentId) {
      const commissioned = await commissionAgent(deps, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        name,
        adapterType: agent.adapterType,
        // Stamp the import origin so re-import is idempotent at the agent level.
        config: { ...agent.config, importOrigin: { adapterType: agent.adapterType, externalId: agent.externalId } },
        instructions: agent.persona ?? null,
        runtimeModel: agent.detectedModel ?? null,
        role: spec.overrides?.role ?? agent.role ?? null,
        reportsTo: spec.overrides?.reportsTo ?? null,
        // B4: land ONLINE — the runtime was just detected. commissionAgent
        // registers the adapter and maps a registration failure to `error`
        // status (honest), never a silent pause.
        isPaused: false,
      });
      agentId = commissioned.id;
      name = commissioned.name;
      created = true;
    }

    const inputs = readAgentInputs(agent, { env: input.env, cwd: input.cwd });
    const ingestible = toIngestible(input.workspaceId, agentId, agent);
    const memory = await deps.ingestion.commitImport(ingestible, inputs.files, {
      acceptHashes: spec.acceptedHashes,
      minQuality: spec.minQuality,
    });

    const abilities = await importSkills(deps, input.workspaceId, input.userId, agentId, inputs.skills, spec.acceptedSkillPaths);

    result.imported.push({ externalId: agent.externalId, agentId, created, name, adapterType: agent.adapterType, memory, abilities });
    deps.logger.info('harness.agent.imported', { workspaceId: input.workspaceId, externalId: agent.externalId, agentId, created, written: memory.written, abilities: abilities.created });
  }

  for (const o of result.imported) {
    result.totalAtoms += o.memory.written + o.memory.reinforced;
    result.totalAbilities += o.abilities.created;
  }
  return result;
}

/**
 * Transition a discovered agent's SKILL.md files into agent-scoped Brain `skill`
 * atoms (Living Skills). Idempotent: a skill whose name already exists for the
 * agent is updated in place (upsert by slug within scope), never duplicated —
 * scoping to the agent replaces the old ability-pin. Marketplace skills are
 * imported only when explicitly accepted (opt-in).
 */
async function importSkills(
  deps: HarnessImportDeps,
  workspaceId: string,
  userId: string,
  agentId: string,
  skills: ImportSkill[],
  acceptedPaths: string[] | undefined,
): Promise<{ created: number; reused: number }> {
  void userId;
  if (!deps.skills || skills.length === 0) return { created: 0, reused: 0 };
  const accept = acceptedPaths ? new Set(acceptedPaths) : null;
  let created = 0;
  let reused = 0;

  for (const skill of skills) {
    // Default selection: the operator's own skills; marketplace only on opt-in.
    const chosen = accept ? accept.has(skill.path) : skill.origin !== 'marketplace';
    if (!chosen) continue;

    const alreadyAttached = deps.skills.getByScopeAndSlug(workspaceId, agentId, skill.name) !== null;
    try {
      deps.skills.upsertSkill({
        workspaceId,
        scopeId: agentId,
        name: skill.name,
        description: skill.description ?? '',
        body: skill.content,
        source: 'agent',
      });
      if (alreadyAttached) reused += 1; else created += 1;
    } catch (err) {
      deps.logger.warn('harness.skill.import_failed', { workspaceId, agentId, skill: skill.name, message: (err as Error).message });
    }
  }
  return { created, reused };
}

function abilityExists(deps: HarnessImportDeps, workspaceId: string, name: string): boolean {
  return deps.skills ? deps.skills.getByScopeAndSlug(workspaceId, null, name) !== null : false;
}

function pendingSkillCount(deps: HarnessImportDeps, workspaceId: string, agentId: string, skills: ImportSkill[]): number {
  if (!deps.skills || skills.length === 0) return 0;
  return skills.filter((skill) => skill.origin !== 'marketplace' && !skillAlreadyAttached(deps, workspaceId, agentId, skill.name)).length;
}

function skillAlreadyAttached(deps: HarnessImportDeps, workspaceId: string, agentId: string, name: string): boolean {
  return deps.skills ? deps.skills.getByScopeAndSlug(workspaceId, agentId, name) !== null : false;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function toIngestible(workspaceId: string, agentId: string, agent: DiscoveredAgent): IngestibleAgent {
  return { id: agentId, workspaceId, adapterType: agent.adapterType, config: agent.config, instructions: agent.persona ?? null };
}

/** Map externalId → existing agentId, read from agents.config.importOrigin. */
function importOriginMap(deps: HarnessImportDeps, workspaceId: string): Map<string, { agentId: string; userId: string; name: string; cwd: string | null }> {
  const rows = deps.db
    .select({ id: schema.agents.id, userId: schema.agents.userId, name: schema.agents.name, config: schema.agents.config })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all();
  const map = new Map<string, { agentId: string; userId: string; name: string; cwd: string | null }>();
  for (const row of rows) {
    const config = (row.config ?? {}) as Record<string, unknown>;
    const origin = config.importOrigin as { externalId?: unknown } | undefined;
    if (origin && typeof origin === 'object' && typeof origin.externalId === 'string') {
      map.set(origin.externalId, { agentId: row.id, userId: row.userId, name: row.name, cwd: firstString(config.cwd, config.workingDirectory, config.repositoryPath) });
    }
  }
  return map;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
