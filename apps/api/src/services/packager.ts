import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, like, or } from 'drizzle-orm';
import {
  AgentisError,
  CONSTANTS,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type PackageContents,
  type PackageKind,
  type SkillManifest,
  type AgentisPackageContents,
  type PackageManifest,
  type PackageExportEnvelope,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import { scanArtifactBytes, type ScanFinding } from './registryScanner.js';

export interface PackageScope {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
}

export interface PackageMeta {
  name: string;
  slug?: string;
  version?: string;
  description?: string | null;
  tags?: string[];
}

export interface ImportResult {
  packageId: string;
  warnings: ScanFinding[];
}

export interface UsePackageResult {
  kind: PackageKind;
  resourceId: string;
  path: string;
}

import type { Logger } from '../logger.js';

export class PackagerService {
  constructor(
    private readonly deps: {
      db: AgentisSqliteDb;
      bus?: EventBus;
      logger?: Logger;
    },
  ) {}

  list(scope: Pick<PackageScope, 'workspaceId'>, filters: { kind?: PackageKind; q?: string } = {}) {
    const q = filters.q?.trim();
    const kind = filters.kind === 'agentis' ? 'agentis' : filters.kind;
    return this.deps.db
      .select()
      .from(schema.libraryPackages)
      .where(and(
        eq(schema.libraryPackages.workspaceId, scope.workspaceId),
        ...(kind ? [eq(schema.libraryPackages.kind, kind)] : []),
        ...(q ? [or(
          like(schema.libraryPackages.name, `%${q}%`),
          like(schema.libraryPackages.slug, `%${q}%`),
          like(schema.libraryPackages.description, `%${q}%`),
        )!] : []),
      ))
      .orderBy(desc(schema.libraryPackages.updatedAt))
      .all();
  }

  get(id: string, workspaceId: string) {
    const row = this.deps.db
      .select()
      .from(schema.libraryPackages)
      .where(and(eq(schema.libraryPackages.id, id), eq(schema.libraryPackages.workspaceId, workspaceId)))
      .get();
    if (!row) throw new AgentisError('PACKAGE_NOT_FOUND', 'package not found');
    return row;
  }

  create(scope: PackageScope, meta: PackageMeta, kind: PackageKind, contents: PackageContents) {
    if (contents.kind !== kind) {
      throw new AgentisError('PACKAGE_IMPORT_INVALID', 'package kind does not match contents kind');
    }
    const slug = this.availableSlug(scope.workspaceId, meta.name, meta.slug);
    const now = new Date().toISOString();
    const id = randomUUID();
    const checksum = this.computeChecksum(contents);
    this.deps.db
      .insert(schema.libraryPackages)
      .values({
        id,
        workspaceId: scope.workspaceId,
        ambientId: scope.ambientId,
        userId: scope.userId,
        slug,
        name: meta.name,
        version: meta.version ?? '1.0.0',
        kind,
        description: meta.description ?? null,
        tags: meta.tags ?? [],
        contents,
        sourceId: null,
        sourceKind: null,
        checksum,
        remoteId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    this.publishInstalled(scope.workspaceId, id, kind);
    return this.get(id, scope.workspaceId);
  }

  packFromWorkflow(scope: PackageScope, workflowId: string, meta: Partial<PackageMeta> = {}) {
    const workflow = this.deps.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.workspaceId, scope.workspaceId)))
      .get();
    if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', 'workflow not found');
    const name = meta.name ?? workflow.title;
    const contents: PackageContents = {
      kind: 'workflow',
      workflow: {
        title: workflow.title,
        summary: workflow.summary ?? null,
        intendedBehavior: workflow.intendedBehavior ?? null,
        graph: objectRecord(workflow.graph),
        settings: objectRecord(workflow.settings),
        maxConcurrentRuns: workflow.maxConcurrentRuns ?? null,
        concurrencyOverflow: workflowOverflow(workflow.concurrencyOverflow),
      },
    };
    return this.insertPacked(scope, { ...meta, name }, 'workflow', contents, workflow.id);
  }

  /**
   * Auto-save bridge: keep a workflow-kind libraryPackages row in sync with a
   * workflow row. Idempotent — if a package already exists for this workflow
   * (matched by sourceId+sourceKind), updates it in place; otherwise creates
   * a new one. Used by the workflow create/update routes so every workflow
   * shows up in Packages without a manual publish step.
   *
   * Does not bump version or change slug on update — that's a publish concern.
   */
  mirrorWorkflow(scope: PackageScope, workflowId: string): typeof schema.libraryPackages.$inferSelect {
    const workflow = this.deps.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.workspaceId, scope.workspaceId)))
      .get();
    if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', 'workflow not found');
    const contents: PackageContents = {
      kind: 'workflow',
      workflow: {
        title: workflow.title,
        summary: workflow.summary ?? null,
        intendedBehavior: workflow.intendedBehavior ?? null,
        graph: objectRecord(workflow.graph),
        settings: objectRecord(workflow.settings),
        maxConcurrentRuns: workflow.maxConcurrentRuns ?? null,
        concurrencyOverflow: workflowOverflow(workflow.concurrencyOverflow),
      },
    };
    const checksum = this.computeChecksum(contents);
    const now = new Date().toISOString();
    const existing = this.deps.db
      .select()
      .from(schema.libraryPackages)
      .where(and(
        eq(schema.libraryPackages.workspaceId, scope.workspaceId),
        eq(schema.libraryPackages.sourceId, workflow.id),
        eq(schema.libraryPackages.sourceKind, 'workflow'),
      ))
      .get();
    if (existing) {
      this.deps.db
        .update(schema.libraryPackages)
        .set({
          name: workflow.title,
          description: workflow.summary ?? null,
          contents,
          checksum,
          updatedAt: now,
        })
        .where(eq(schema.libraryPackages.id, existing.id))
        .run();
      return this.get(existing.id, scope.workspaceId);
    }
    return this.insertPacked(scope, { name: workflow.title, description: workflow.summary ?? null }, 'workflow', contents, workflow.id);
  }

  packFromAgent(scope: PackageScope, agentId: string, meta: Partial<PackageMeta> = {}) {
    const agent = this.deps.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, scope.workspaceId)))
      .get();
    if (!agent) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const name = meta.name ?? agent.name;
    const contents: PackageContents = {
      kind: 'agent',
      agent: {
        name: agent.name,
        adapterType: agent.adapterType,
        capabilityTags: stringArray(agent.capabilityTags),
        config: objectRecord(agent.config),
        instructions: agent.instructions ?? null,
        avatarGlyph: agent.avatarGlyph ?? null,
        runtimeModel: agent.runtimeModel ?? null,
        role: agent.role ?? null,
      },
    };
    return this.insertPacked(scope, { ...meta, name }, 'agent', contents, agent.id);
  }

  packFromSkill(scope: PackageScope, skillId: string, meta: Partial<PackageMeta> = {}) {
    const skill = this.deps.db
      .select()
      .from(schema.skills)
      .where(and(eq(schema.skills.id, skillId), eq(schema.skills.workspaceId, scope.workspaceId)))
      .get();
    if (!skill) throw new AgentisError('SKILL_NOT_FOUND', 'skill not found');
    const name = meta.name ?? skill.name;
    const contents: PackageContents = {
      kind: 'skill',
      skill: {
        name: skill.name,
        slug: skill.slug,
        version: skill.version,
        runtime: skill.runtime as 'builtin' | 'node_worker' | 'docker_sandbox',
        manifest: objectRecord(skill.manifest) as unknown as SkillManifest,
      },
    };
    return this.insertPacked(scope, { ...meta, name }, 'skill', contents, skill.id);
  }

  exportEnvelope(packageId: string, workspaceId: string): PackageExportEnvelope {
    const row = this.get(packageId, workspaceId);
    const manifest = this.manifestFromRow(row);
    return {
      packageManifest: manifest,
      agentisVersion: manifest.agentisVersion,
      exportedAt: new Date().toISOString(),
    };
  }

  importManifest(scope: PackageScope, manifest: PackageManifest): ImportResult {
    const checksum = this.computeChecksum(manifest.contents);
    if (checksum !== manifest.checksum) {
      throw new AgentisError('PACKAGE_CHECKSUM_MISMATCH', 'package checksum does not match contents');
    }
    const scan = scanArtifactBytes(Buffer.from(stableJson(manifest.contents), 'utf8'), manifest.slug);
    const blockers = scan.findings.filter((finding) => finding.severity === 'block');
    if (blockers.length > 0) {
      throw new AgentisError('PACKAGE_IMPORT_INVALID', 'package import blocked by security scan', {
        details: { findings: blockers },
      });
    }
    const imported = this.insertPacked(
      scope,
      {
        name: manifest.name,
        slug: manifest.slug,
        version: manifest.version,
        description: manifest.description ?? null,
        tags: manifest.tags,
      },
      manifest.kind,
      manifest.contents,
      manifest.source?.id ?? null,
      manifest.remoteId ?? null,
    );
    return {
      packageId: imported.id,
      warnings: scan.findings.filter((finding) => finding.severity === 'warn'),
    };
  }

  usePackage(scope: PackageScope, packageId: string): UsePackageResult {
    const row = this.get(packageId, scope.workspaceId);
    const contents = row.contents as PackageContents;
    const now = new Date().toISOString();
    if (contents.kind === 'workflow') {
      const id = randomUUID();
      this.deps.db
        .insert(schema.workflows)
        .values({
          id,
          workspaceId: scope.workspaceId,
          ambientId: scope.ambientId,
          userId: scope.userId,
          registryEntryId: null,
          registryVersion: null,
          title: contents.workflow.title,
          summary: contents.workflow.summary ?? row.description ?? null,
          graph: contents.workflow.graph,
          settings: contents.workflow.settings,
          maxConcurrentRuns: contents.workflow.maxConcurrentRuns ?? null,
          concurrencyOverflow: contents.workflow.concurrencyOverflow ?? 'queue',
          isFromRegistry: false,
          tags: [],
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return { kind: 'workflow', resourceId: id, path: `/workflows/${id}` };
    }
    if (contents.kind === 'agent') {
      const id = randomUUID();
      const colorHex = CONSTANTS.AGENT_COLOR_PALETTE[Math.floor(Math.random() * CONSTANTS.AGENT_COLOR_PALETTE.length)];
      this.deps.db
        .insert(schema.agents)
        .values({
          id,
          workspaceId: scope.workspaceId,
          ambientId: scope.ambientId,
          userId: scope.userId,
          gatewayId: null,
          packageId: null,
          name: contents.agent.name,
          adapterType: contents.agent.adapterType,
          capabilityTags: contents.agent.capabilityTags,
          config: contents.agent.config,
          status: 'offline',
          colorHex,
          instructions: contents.agent.instructions ?? null,
          avatarGlyph: contents.agent.avatarGlyph ?? null,
          runtimeModel: contents.agent.runtimeModel ?? null,
          role: contents.agent.role ?? 'agent',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return { kind: 'agent', resourceId: id, path: `/agents/${id}` };
    }
    if (contents.kind === 'skill') {
      if (contents.skill.runtime === 'builtin') {
        throw new AgentisError('VALIDATION_FAILED', 'builtin skills cannot be reinstalled from Library packages');
      }
      const id = randomUUID();
      this.deps.db
        .insert(schema.skills)
        .values({
          id,
          workspaceId: scope.workspaceId,
          ambientId: scope.ambientId,
          userId: scope.userId,
          packageId: null,
          name: contents.skill.name,
          slug: contents.skill.slug,
          version: contents.skill.version,
          runtime: contents.skill.runtime,
          manifest: contents.skill.manifest,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return { kind: 'skill', resourceId: id, path: '/packages?tab=skills' };
    }
    if (contents.kind === 'integration') {
      return {
        kind: 'integration',
        resourceId: contents.integration.service,
        path: `/packages?tab=integration&service=${encodeURIComponent(contents.integration.service)}`,
      };
    }
    if (contents.kind === 'agentis') {
      return this.activateApp(scope, row, contents, now);
    }
    throw new AgentisError('VALIDATION_FAILED', 'package kind cannot be used yet');
  }

  deletePackage(packageId: string, workspaceId: string) {
    const result = this.deps.db
      .delete(schema.libraryPackages)
      .where(and(eq(schema.libraryPackages.id, packageId), eq(schema.libraryPackages.workspaceId, workspaceId)))
      .run();
    if (result.changes === 0) throw new AgentisError('PACKAGE_NOT_FOUND', 'package not found');
  }

  computeChecksum(contents: PackageContents): string {
    return createHash('sha256').update(stableJson(contents)).digest('hex');
  }

  manifestFromRow(row: typeof schema.libraryPackages.$inferSelect): PackageManifest {
    const contents = row.contents as PackageContents;
    return {
      manifestVersion: 1,
      agentisVersion: '1.0.0',
      slug: row.slug,
      name: row.name,
      version: row.version,
      kind: row.kind as PackageKind,
      description: row.description ?? null,
      tags: stringArray(row.tags),
      contents,
      checksum: row.checksum ?? this.computeChecksum(contents),
      source: row.sourceId && row.sourceKind ? { id: row.sourceId, kind: row.sourceKind as PackageKind } : null,
      remoteId: row.remoteId ?? null,
      author: null,
    };
  }

  private insertPacked(
    scope: PackageScope,
    meta: Partial<PackageMeta> & { name: string },
    kind: PackageKind,
    contents: PackageContents,
    sourceId: string | null,
    remoteId: string | null = null,
  ) {
    const slug = this.availableSlug(scope.workspaceId, meta.name, meta.slug);
    const now = new Date().toISOString();
    const id = randomUUID();
    const checksum = this.computeChecksum(contents);
    this.deps.db
      .insert(schema.libraryPackages)
      .values({
        id,
        workspaceId: scope.workspaceId,
        ambientId: scope.ambientId,
        userId: scope.userId,
        slug,
        name: meta.name,
        version: meta.version ?? '1.0.0',
        kind,
        description: meta.description ?? null,
        tags: meta.tags ?? [],
        contents,
        sourceId,
        sourceKind: sourceId ? kind : null,
        checksum,
        remoteId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    this.publishInstalled(scope.workspaceId, id, kind);
    return this.get(id, scope.workspaceId);
  }

  private assertSlugAvailable(workspaceId: string, slug: string) {
    const existing = this.deps.db
      .select({ id: schema.libraryPackages.id })
      .from(schema.libraryPackages)
      .where(and(eq(schema.libraryPackages.workspaceId, workspaceId), eq(schema.libraryPackages.slug, slug)))
      .get();
    if (existing) throw new AgentisError('PACKAGE_SLUG_CONFLICT', `package slug already exists: ${slug}`);
  }

  private availableSlug(workspaceId: string, name: string, requested?: string): string {
    const base = this.slugFor(name, requested);
    if (requested) {
      this.assertSlugAvailable(workspaceId, base);
      return base;
    }
    let slug = base;
    for (let suffix = 2; this.slugExists(workspaceId, slug); suffix += 1) {
      slug = `${base}-${suffix}`;
    }
    return slug;
  }

  private slugExists(workspaceId: string, slug: string): boolean {
    return Boolean(
      this.deps.db
        .select({ id: schema.libraryPackages.id })
        .from(schema.libraryPackages)
        .where(and(eq(schema.libraryPackages.workspaceId, workspaceId), eq(schema.libraryPackages.slug, slug)))
        .get(),
    );
  }

  private activateApp(
    scope: PackageScope,
    row: typeof schema.libraryPackages.$inferSelect,
    contents: AgentisPackageContents,
    now: string,
  ): UsePackageResult {
    const appSlug = row.slug;
    const workflowIds = new Map<string, string>();
    const agentIds = new Map<string, string>();
    const skillIds = this.workspaceSkillIds(scope.workspaceId);
    const seedKnowledgeBaseId = contents.knowledgeSeeds.length > 0
      ? this.createSeedKnowledgeBase(scope, row.name, contents.knowledgeSeeds, now)
      : null;

    for (const agent of contents.agents) {
      const id = randomUUID();
      const colorHex = CONSTANTS.AGENT_COLOR_PALETTE[Math.floor(Math.random() * CONSTANTS.AGENT_COLOR_PALETTE.length)];
      this.deps.db
        .insert(schema.agents)
        .values({
          id,
          workspaceId: scope.workspaceId,
          ambientId: scope.ambientId,
          userId: scope.userId,
          gatewayId: null,
          packageId: null,
          name: agent.name,
          adapterType: agent.adapterType,
          capabilityTags: agent.capabilityTags,
          config: agent.config,
          status: 'offline',
          colorHex,
          instructions: agent.instructions ?? null,
          avatarGlyph: agent.avatarGlyph ?? null,
          runtimeModel: agent.runtimeModel ?? null,
          role: agent.role ?? 'agent',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      agentIds.set(agent.name, id);
      agentIds.set(this.slugFor(agent.name), id);
    }

    for (const workflow of contents.workflows) {
      const id = randomUUID();
      const slug = workflow.slug ?? this.slugFor(workflow.title);
      const graph = this.resolvePackageGraphRefs(workflow.graph, {
        agentIds,
        skillIds,
        seedKnowledgeBaseId,
      });
      this.deps.db
        .insert(schema.workflows)
        .values({
          id,
          workspaceId: scope.workspaceId,
          ambientId: scope.ambientId,
          userId: scope.userId,
          registryEntryId: null,
          registryVersion: null,
          title: workflow.title,
          summary: workflow.summary ?? null,
          intendedBehavior: workflow.intendedBehavior ?? null,
          graph,
          settings: objectRecord(workflow.settings),
          maxConcurrentRuns: workflow.maxConcurrentRuns ?? null,
          concurrencyOverflow: workflow.concurrencyOverflow ?? 'queue',
          isFromRegistry: false,
          tags: [appSlug],
          createdAt: now,
          updatedAt: now,
        })
        .run();
      workflowIds.set(slug, id);
      workflowIds.set(this.slugFor(workflow.title), id);
    }

    for (const skill of contents.skills) {
      if (skill.runtime === 'builtin') continue;
      const id = randomUUID();
      this.deps.db
        .insert(schema.skills)
        .values({
          id,
          workspaceId: scope.workspaceId,
          ambientId: scope.ambientId,
          userId: scope.userId,
          packageId: null,
          name: skill.name,
          slug: skill.slug,
          version: skill.version,
          runtime: skill.runtime,
          manifest: skill.manifest,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    this.deps.bus?.publish(REALTIME_ROOMS.workspace(scope.workspaceId), REALTIME_EVENTS.PACKAGE_INSTALLED, {
      packageId: row.id,
      kind: 'agentis',
    });
    return { kind: 'agentis', resourceId: row.id, path: `/packages/${row.id}` };
  }

  private createSeedKnowledgeBase(
    scope: PackageScope,
    appName: string,
    seeds: AgentisPackageContents['knowledgeSeeds'],
    now: string,
  ): string {
    return this.createKnowledgeBaseFromDocuments(
      scope,
      `${appName} Seeds`,
      `Seed knowledge activated with ${appName}`,
      seeds.map((seed) => ({
        name: seed.title,
        mimeType: 'text/markdown',
        content: seed.content,
        metadata: seed.metadata,
      })),
      now,
      'agentis_seed',
    );
  }

  private createKnowledgeBaseFromDocuments(
    scope: PackageScope,
    name: string,
    description: string | null,
    documents: Array<{ name: string; mimeType?: string; content: string; metadata?: Record<string, unknown> }>,
    now: string,
    metadataKind: string,
  ): string {
    const knowledgeBaseId = randomUUID();
    this.deps.db
      .insert(schema.knowledgeBases)
      .values({
        id: knowledgeBaseId,
        workspaceId: scope.workspaceId,
        name,
        description,
        embeddingModel: 'lexical-v1',
        embeddingDimension: 0,
        chunkingConfig: { maxTokens: 240, overlapTokens: 40 },
        createdAt: now,
        updatedAt: now,
      })
      .run();
    for (const document of documents) {
      const documentId = randomUUID();
      const chunks = chunkText(document.content);
      this.deps.db
        .insert(schema.kbDocuments)
        .values({
          id: documentId,
          knowledgeBaseId,
          workspaceId: scope.workspaceId,
          name: document.name,
          mimeType: document.mimeType ?? 'text/plain',
          status: 'ready',
          tokenCount: tokenize(document.content).length,
          error: null,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      chunks.forEach((chunk, index) => {
        this.deps.db
          .insert(schema.kbChunks)
          .values({
            id: randomUUID(),
            documentId,
            knowledgeBaseId,
            workspaceId: scope.workspaceId,
            chunkIndex: index,
            content: chunk,
            metadata: { ...objectRecord(document.metadata), source: document.name, kind: metadataKind },
            tokenCount: tokenize(chunk).length,
            createdAt: now,
          })
          .run();
      });
    }
    return knowledgeBaseId;
  }

  private workspaceSkillIds(workspaceId: string): Map<string, string> {
    const rows = this.deps.db
      .select({ id: schema.skills.id, slug: schema.skills.slug, name: schema.skills.name })
      .from(schema.skills)
      .where(eq(schema.skills.workspaceId, workspaceId))
      .all();
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.id, row.id);
      map.set(row.slug, row.id);
      map.set(row.name, row.id);
    }
    return map;
  }

  private resolvePackageGraphRefs(
    graph: unknown,
    refs: { agentIds: Map<string, string>; skillIds: Map<string, string>; seedKnowledgeBaseId: string | null },
  ): Record<string, unknown> {
    const cloned = cloneJson(graph);
    const record = objectRecord(cloned);
    const nodes = Array.isArray(record.nodes) ? record.nodes : [];
    for (const rawNode of nodes) {
      if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) continue;
      const node = rawNode as { config?: unknown };
      const config = objectRecord(node.config);
      if (config.kind === 'agent_task') {
        const ref = typeof config.agentPackageRef === 'string' ? config.agentPackageRef : null;
        if (!config.agentId && ref) {
          const resolved = refs.agentIds.get(ref) ?? refs.agentIds.get(this.slugFor(ref));
          if (resolved) config.agentId = resolved;
        }
      }
      if (config.kind === 'skill_task' && typeof config.skillId === 'string') {
        config.skillId = refs.skillIds.get(config.skillId) ?? config.skillId;
      }
      if (config.kind === 'knowledge' && config.knowledgeBaseId === '__seeds' && refs.seedKnowledgeBaseId) {
        config.knowledgeBaseId = refs.seedKnowledgeBaseId;
      }
      node.config = config;
    }
    return record;
  }

  private slugFor(name: string, requested?: string): string {
    const raw = requested?.trim() || name.trim();
    const slug = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    if (!slug) throw new AgentisError('VALIDATION_FAILED', 'package slug is required');
    return slug;
  }

  private publishInstalled(workspaceId: string, packageId: string, kind: PackageKind) {
    this.deps.bus?.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.PACKAGE_INSTALLED, {
      packageId,
      kind,
    });
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function workflowOverflow(value: unknown): 'queue' | 'reject' | 'replace_oldest' | null {
  return value === 'queue' || value === 'reject' || value === 'replace_oldest' ? value : null;
}

function chunkText(content: string, maxTokens = 240, overlapTokens = 40): string[] {
  const words = content.split(/\s+/).filter(Boolean);
  if (words.length <= maxTokens) return [content.trim()];
  const chunks: string[] = [];
  const step = Math.max(maxTokens - overlapTokens, 1);
  for (let start = 0; start < words.length; start += step) {
    chunks.push(words.slice(start, start + maxTokens).join(' '));
    if (start + maxTokens >= words.length) break;
  }
  return chunks;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function cloneJson(value: unknown): unknown {
  return value === undefined ? {} : JSON.parse(JSON.stringify(value));
}
