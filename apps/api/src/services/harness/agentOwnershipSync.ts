import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import type { SkillService } from '../skillService.js';
import type { HarnessMemoryIngestionService, IngestibleAgent } from './harnessMemoryIngestion.js';
import { discoverAgents, readAgentInputs } from '../harnessImport/registry.js';

export type AgentSyncMode = 'manual_review' | 'auto_trusted' | 'disabled';
export type AgentSyncItemStatus = 'pending' | 'quarantined' | 'applied' | 'rejected' | 'deleted' | 'conflict';

export interface AgentSyncPolicy {
  memory: 'review' | 'auto_quality' | 'disabled';
  skills: 'review' | 'auto_owned' | 'disabled';
  identity: 'review' | 'auto_trusted' | 'disabled';
  deletions: 'review' | 'auto' | 'ignore';
  minAutoQuality: number;
}

const DEFAULT_POLICY: AgentSyncPolicy = {
  memory: 'review', skills: 'review', identity: 'review', deletions: 'review', minAutoQuality: 0.82,
};

export class AgentOwnershipSyncService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly ingestion: HarnessMemoryIngestionService,
    private readonly skills: SkillService | undefined,
    private readonly logger: Logger,
  ) {}

  listSources(workspaceId: string) {
    this.ensureSources(workspaceId);
    return this.db.select().from(schema.agentSyncSources)
      .where(eq(schema.agentSyncSources.workspaceId, workspaceId)).all();
  }

  getSource(workspaceId: string, agentId: string) {
    this.ensureSources(workspaceId);
    return this.db.select().from(schema.agentSyncSources).where(and(
      eq(schema.agentSyncSources.workspaceId, workspaceId), eq(schema.agentSyncSources.agentId, agentId),
    )).get() ?? null;
  }

  updatePolicy(workspaceId: string, agentId: string, input: { mode?: AgentSyncMode; policy?: Partial<AgentSyncPolicy> }) {
    const source = this.getSource(workspaceId, agentId);
    if (!source) return null;
    const policy = { ...DEFAULT_POLICY, ...record(source.policyJson), ...(input.policy ?? {}) };
    const now = new Date().toISOString();
    this.db.update(schema.agentSyncSources).set({
      ...(input.mode ? { mode: input.mode } : {}), policyJson: policy, updatedAt: now,
    }).where(eq(schema.agentSyncSources.id, source.id)).run();
    return this.getSource(workspaceId, agentId);
  }

  async scan(workspaceId: string, agentId: string, trigger: 'manual' | 'scheduled' | 'watch' = 'manual') {
    const source = this.getSource(workspaceId, agentId);
    if (!source) throw new Error('Imported agent sync source not found');
    const runId = randomUUID();
    const now = new Date().toISOString();
    this.db.insert(schema.agentSyncRuns).values({ id: runId, workspaceId, sourceId: source.id, trigger, mode: source.mode }).run();
    try {
      if (source.mode === 'disabled') return this.#completeRun(runId, source.id, { disabled: 1 }, {});
      const discovered = (await discoverAgents()).find((agent) => agent.externalId === source.externalId && agent.adapterType === source.adapterType);
      if (!discovered) throw new Error(`External agent ${source.externalId} is no longer discoverable`);
      const inputs = readAgentInputs(discovered, { cwd: source.rootPath ?? undefined });
      const ingestible: IngestibleAgent = { id: agentId, workspaceId, adapterType: discovered.adapterType, config: discovered.config, instructions: discovered.persona };
      const preview = this.ingestion.previewImport(ingestible, inputs.files);
      const seen = new Set<string>();
      const counts = { added: 0, changed: 0, unchanged: 0, deleted: 0, quarantined: 0 };

      const identityPayload = { name: discovered.name, persona: discovered.persona ?? null, runtimeModel: discovered.detectedModel ?? null, role: discovered.role ?? null };
      seen.add('identity:profile');
      counts[this.#observeItem({
        workspaceId, sourceId: source.id, itemKey: 'identity:profile', itemType: 'identity', sourcePath: null,
        origin: discovered.adapterType, contentHash: hash(JSON.stringify(identityPayload)), status: 'pending', quality: 1,
        decisionReason: 'external_identity_changed', payloadJson: identityPayload,
      })] += 1;

      for (const candidate of preview.candidates) {
        const key = `memory:${hash(`${candidate.origin.fileKey}\n${normalize(candidate.title)}`)}`;
        seen.add(key);
        const status: AgentSyncItemStatus = candidate.quality >= policyOf(source).minAutoQuality ? 'pending' : 'quarantined';
        const changed = this.#observeItem({
          workspaceId, sourceId: source.id, itemKey: key, itemType: 'memory', sourcePath: candidate.origin.fileKey,
          origin: candidate.origin.instructionSource, contentHash: candidate.hash, status, quality: candidate.quality,
          decisionReason: status === 'quarantined' ? 'below_auto_quality_threshold' : null,
          payloadJson: { hash: candidate.hash, title: candidate.title, summary: candidate.summary, scopeHint: candidate.scopeHint },
        });
        counts[changed] += 1;
        if (status === 'quarantined' && changed !== 'unchanged') counts.quarantined += 1;
      }

      for (const skill of inputs.skills) {
        const key = `skill:${hash(skill.path)}`;
        seen.add(key);
        const contentHash = hash(`${skill.name}\n${skill.description ?? ''}\n${skill.content}`);
        const status: AgentSyncItemStatus = skill.origin === 'marketplace' ? 'quarantined' : 'pending';
        const changed = this.#observeItem({
          workspaceId, sourceId: source.id, itemKey: key, itemType: 'skill', sourcePath: skill.path,
          origin: skill.origin, contentHash, status, quality: skill.origin === 'marketplace' ? 0.5 : 0.9,
          decisionReason: skill.origin === 'marketplace' ? 'marketplace_requires_review' : null,
          payloadJson: { path: skill.path, name: skill.name, description: skill.description ?? '', body: skill.content, origin: skill.origin },
        });
        counts[changed] += 1;
        if (status === 'quarantined' && changed !== 'unchanged') counts.quarantined += 1;
      }

      const prior = this.db.select().from(schema.agentSyncItems).where(eq(schema.agentSyncItems.sourceId, source.id)).all();
      for (const item of prior) {
        if (seen.has(item.itemKey) || item.status === 'deleted') continue;
        this.db.update(schema.agentSyncItems).set({ status: 'pending', decisionReason: 'source_deleted', updatedAt: now })
          .where(eq(schema.agentSyncItems.id, item.id)).run();
        counts.deleted += 1;
      }

      this.db.update(schema.agentSyncSources).set({ rootPath: discovered.origin.rootPath, lastScanAt: now, lastError: null, updatedAt: now })
        .where(eq(schema.agentSyncSources.id, source.id)).run();
      let applied: Record<string, number> = {};
      if (source.mode === 'auto_trusted') applied = await this.applyEligible(workspaceId, agentId, runId);
      return this.#completeRun(runId, source.id, counts, applied);
    } catch (error) {
      const message = (error as Error).message;
      this.db.update(schema.agentSyncRuns).set({ status: 'failed', error: message, completedAt: new Date().toISOString() })
        .where(eq(schema.agentSyncRuns.id, runId)).run();
      this.db.update(schema.agentSyncSources).set({ lastError: message, updatedAt: new Date().toISOString() })
        .where(eq(schema.agentSyncSources.id, source.id)).run();
      throw error;
    }
  }

  listItems(workspaceId: string, agentId: string, status?: AgentSyncItemStatus) {
    const source = this.getSource(workspaceId, agentId);
    if (!source) return [];
    return this.db.select().from(schema.agentSyncItems).where(status
      ? and(eq(schema.agentSyncItems.sourceId, source.id), eq(schema.agentSyncItems.status, status))
      : eq(schema.agentSyncItems.sourceId, source.id)).all();
  }

  history(workspaceId: string, agentId: string, limit = 50) {
    const source = this.getSource(workspaceId, agentId);
    if (!source) return [];
    return this.db.select().from(schema.agentSyncRuns).where(eq(schema.agentSyncRuns.sourceId, source.id))
      .orderBy(desc(schema.agentSyncRuns.startedAt)).limit(Math.max(1, Math.min(200, limit))).all();
  }

  async apply(workspaceId: string, agentId: string, itemIds: string[], runId?: string) {
    const source = this.getSource(workspaceId, agentId);
    if (!source) throw new Error('Imported agent sync source not found');
    const selected = new Set(itemIds);
    const items = this.listItems(workspaceId, agentId).filter((item) => selected.has(item.id));
    return this.#applyItems(workspaceId, agentId, source, items, runId);
  }

  async applyEligible(workspaceId: string, agentId: string, runId?: string) {
    const source = this.getSource(workspaceId, agentId);
    if (!source) return {};
    const policy = policyOf(source);
    const items = this.listItems(workspaceId, agentId).filter((item) => {
      if (item.status !== 'pending') return false;
      if (item.decisionReason === 'source_deleted') return policy.deletions === 'auto';
      if (item.itemType === 'memory') return policy.memory === 'auto_quality' && Number(item.quality ?? 0) >= policy.minAutoQuality;
      if (item.itemType === 'skill') return policy.skills === 'auto_owned' && item.origin !== 'marketplace';
      if (item.itemType === 'identity') return policy.identity === 'auto_trusted';
      return false;
    });
    return this.#applyItems(workspaceId, agentId, source, items, runId);
  }

  reject(workspaceId: string, agentId: string, itemIds: string[], reason = 'operator_rejected') {
    const allowed = new Set(this.listItems(workspaceId, agentId).map((item) => item.id));
    let rejected = 0;
    for (const id of new Set(itemIds)) if (allowed.has(id)) rejected += this.db.update(schema.agentSyncItems)
      .set({ status: 'rejected', decisionReason: reason, updatedAt: new Date().toISOString() })
      .where(eq(schema.agentSyncItems.id, id)).run().changes;
    return { rejected };
  }

  ensureSources(workspaceId: string) {
    const rows = this.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)).all();
    for (const agent of rows) {
      const config = record(agent.config);
      const origin = record(config.importOrigin);
      if (typeof origin.externalId !== 'string') continue;
      const exists = this.db.select({ id: schema.agentSyncSources.id }).from(schema.agentSyncSources)
        .where(and(eq(schema.agentSyncSources.workspaceId, workspaceId), eq(schema.agentSyncSources.agentId, agent.id))).get();
      if (exists) continue;
      this.db.insert(schema.agentSyncSources).values({
        id: randomUUID(), workspaceId, agentId: agent.id, adapterType: String(origin.adapterType ?? agent.adapterType),
        externalId: origin.externalId, rootPath: stringValue(config.cwd) ?? stringValue(config.workingDirectory),
        mode: 'manual_review', policyJson: DEFAULT_POLICY,
      }).run();
    }
  }

  async scanWorkspace(workspaceId: string, trigger: 'scheduled' | 'watch' = 'scheduled') {
    const outcomes = [];
    for (const source of this.listSources(workspaceId)) {
      if (source.mode === 'disabled') continue;
      try { outcomes.push(await this.scan(workspaceId, source.agentId, trigger)); }
      catch (error) { this.logger.warn('agent.sync.scan_failed', { workspaceId, agentId: source.agentId, message: (error as Error).message }); }
    }
    return outcomes;
  }

  watchRoots(): string[] {
    const roots = new Set<string>();
    for (const source of this.db.select().from(schema.agentSyncSources).all()) if (source.rootPath) roots.add(source.rootPath);
    for (const item of this.db.select({ sourcePath: schema.agentSyncItems.sourcePath }).from(schema.agentSyncItems).all()) {
      if (item.sourcePath) roots.add(dirname(item.sourcePath));
    }
    return [...roots];
  }

  async #applyItems(workspaceId: string, agentId: string, source: typeof schema.agentSyncSources.$inferSelect, items: Array<typeof schema.agentSyncItems.$inferSelect>, runId?: string) {
    if (items.length === 0) return { memories: 0, skills: 0, deleted: 0 };
    const discovered = (await discoverAgents()).find((agent) => agent.externalId === source.externalId && agent.adapterType === source.adapterType);
    if (!discovered) throw new Error('External agent is no longer discoverable');
    const inputs = readAgentInputs(discovered, { cwd: source.rootPath ?? undefined });
    const ingestible: IngestibleAgent = { id: agentId, workspaceId, adapterType: discovered.adapterType, config: discovered.config, instructions: discovered.persona };
    const memoryHashes = items.filter((item) => item.itemType === 'memory' && item.decisionReason !== 'source_deleted')
      .map((item) => stringValue(record(item.payloadJson).hash)).filter((value): value is string => Boolean(value));
    let memories = 0;
    let episodeIds: string[] = [];
    if (memoryHashes.length > 0) {
      const result = await this.ingestion.commitImport(ingestible, inputs.files, { acceptHashes: memoryHashes });
      memories = result.written + result.reinforced;
      episodeIds = result.episodeIds;
    }
    let skills = 0;
    let identities = 0;
    let deleted = 0;
    let episodeCursor = 0;
    for (const item of items) {
      if (item.decisionReason === 'source_deleted') {
        if (item.targetKind === 'episode' && item.targetId) {
          const archivedAt = new Date().toISOString();
          this.db.update(schema.memoryEpisodes).set({ status: 'archived', archivedAt, updatedAt: archivedAt })
            .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, item.targetId))).run();
        }
        this.db.update(schema.agentSyncItems).set({ status: 'deleted', decisionReason: 'source_deleted_applied', updatedAt: new Date().toISOString() })
          .where(eq(schema.agentSyncItems.id, item.id)).run();
        deleted += 1;
        continue;
      }
      let targetId: string | null = null;
      if (item.itemType === 'skill' && this.skills) {
        const payload = record(item.payloadJson);
        const skill = this.skills.upsertSkill({
          workspaceId, scopeId: agentId, name: String(payload.name ?? 'Imported skill'),
          description: String(payload.description ?? ''), body: String(payload.body ?? ''), source: 'agent',
        });
        targetId = skill.id;
        skills += 1;
      } else if (item.itemType === 'memory') {
        targetId = episodeIds[episodeCursor++] ?? item.targetId ?? null;
      } else if (item.itemType === 'identity') {
        const payload = record(item.payloadJson);
        this.db.update(schema.agents).set({
          ...(stringValue(payload.name) ? { name: stringValue(payload.name)! } : {}),
          instructions: stringValue(payload.persona), runtimeModel: stringValue(payload.runtimeModel),
          ...(stringValue(payload.role) ? { role: stringValue(payload.role)! } : {}),
        }).where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.id, agentId))).run();
        targetId = agentId;
        identities += 1;
      }
      this.db.update(schema.agentSyncItems).set({
        status: 'applied', decisionReason: 'applied', targetKind: item.itemType === 'skill' ? 'skill' : item.itemType === 'identity' ? 'agent' : 'episode',
        targetId, appliedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }).where(eq(schema.agentSyncItems.id, item.id)).run();
    }
    const applied = { memories, skills, identities, deleted };
    if (runId) this.db.update(schema.agentSyncRuns).set({ appliedJson: applied }).where(eq(schema.agentSyncRuns.id, runId)).run();
    this.db.update(schema.agentSyncSources).set({ lastSuccessAt: new Date().toISOString(), lastError: null, updatedAt: new Date().toISOString() })
      .where(eq(schema.agentSyncSources.id, source.id)).run();
    return applied;
  }

  #observeItem(input: Omit<typeof schema.agentSyncItems.$inferInsert, 'id' | 'firstSeenAt' | 'lastSeenAt' | 'createdAt' | 'updatedAt'>): 'added' | 'changed' | 'unchanged' {
    const existing = this.db.select().from(schema.agentSyncItems)
      .where(and(eq(schema.agentSyncItems.sourceId, input.sourceId), eq(schema.agentSyncItems.itemKey, input.itemKey))).get();
    const now = new Date().toISOString();
    if (!existing) {
      this.db.insert(schema.agentSyncItems).values({ id: randomUUID(), ...input, firstSeenAt: now, lastSeenAt: now }).run();
      return 'added';
    }
    if (existing.contentHash === input.contentHash) {
      this.db.update(schema.agentSyncItems).set({ lastSeenAt: now, updatedAt: now }).where(eq(schema.agentSyncItems.id, existing.id)).run();
      return 'unchanged';
    }
    this.db.update(schema.agentSyncItems).set({ ...input, previousHash: existing.contentHash, lastSeenAt: now, updatedAt: now })
      .where(eq(schema.agentSyncItems.id, existing.id)).run();
    return 'changed';
  }

  #completeRun(runId: string, sourceId: string, detected: Record<string, number>, applied: Record<string, number>) {
    const completedAt = new Date().toISOString();
    this.db.update(schema.agentSyncRuns).set({ status: 'completed', detectedJson: detected, appliedJson: applied, completedAt })
      .where(eq(schema.agentSyncRuns.id, runId)).run();
    return this.db.select().from(schema.agentSyncRuns).where(eq(schema.agentSyncRuns.id, runId)).get()!;
  }
}

function policyOf(source: typeof schema.agentSyncSources.$inferSelect): AgentSyncPolicy {
  const stored = record(source.policyJson);
  const policy = { ...DEFAULT_POLICY, ...stored } as AgentSyncPolicy;
  if (source.mode === 'auto_trusted') {
    if (policy.memory === 'review') policy.memory = 'auto_quality';
    if (policy.skills === 'review') policy.skills = 'auto_owned';
    if (policy.identity === 'review') policy.identity = 'auto_trusted';
  }
  return policy;
}
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function normalize(value: string) { return value.trim().toLowerCase().replace(/\s+/g, ' '); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
