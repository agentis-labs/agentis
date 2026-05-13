import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type BrainGraph,
  type BrainGraphLink,
  type BrainGraphNode,
  type BrainGraphScope,
  type KnowledgeAtomKind,
  type KnowledgeLinkRelation,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { EpisodicMemoryStore } from './episodicMemoryStore.js';

export interface CollectiveBrainPromotionInput {
  workspaceId: string;
  workflowId?: string | null;
  runId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  adapterType?: string | null;
  appId?: string | null;
  taskInput?: unknown;
  taskOutput: unknown;
}

export interface BrainGraphOptions {
  scope?: BrainGraphScope;
  appId?: string | null;
  kinds?: KnowledgeAtomKind[];
  minConfidence?: number;
  limit?: number;
}

export interface KnowledgeLinkInput {
  workspaceId: string;
  sourceId: string;
  sourceKind: KnowledgeAtomKind;
  targetId: string;
  targetKind: KnowledgeAtomKind;
  relation: KnowledgeLinkRelation;
  confidence?: number;
  agentId?: string | null;
  adapterType?: string | null;
  runId?: string | null;
  appId?: string | null;
}

interface AtomCandidate {
  id: string;
  kind: KnowledgeAtomKind;
  text: string;
  node: BrainGraphNode;
}

interface SimilarAtom {
  atom: AtomCandidate;
  score: number;
}

const DEFAULT_GRAPH_LIMIT = 200;
const MAX_GRAPH_LIMIT = 500;
const HIGH_SIMILARITY = 0.86;
const RELATED_SIMILARITY = 0.52;
const GLOBAL_CONFIDENCE_THRESHOLD = 0.7;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'i', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this',
  'to', 'was', 'were', 'will', 'with', 'you', 'your', 'we', 'our', 'they', 'them', 'these',
  'those', 'do', 'does', 'did', 'if', 'then', 'than', 'so', 'too', 'can', 'could', 'would',
  'should', 'about', 'after', 'before', 'between', 'during', 'over', 'under', 'out', 'off',
]);

export class CollectiveBrainService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly episodes: EpisodicMemoryStore,
    private readonly logger: Logger,
  ) {}

  extractAndPromote(input: CollectiveBrainPromotionInput): { created: number; reinforced: number; linked: number } {
    const resolvedAgent = input.agentId ? this.resolveAgent(input.workspaceId, input.agentId) : null;
    const adapterType = input.adapterType ?? resolvedAgent?.adapterType ?? null;
    const candidates = extractPromotableFacts(input.taskOutput);
    if (candidates.length === 0) return { created: 0, reinforced: 0, linked: 0 };

    let created = 0;
    let reinforced = 0;
    let linked = 0;
    const existingAtoms = this.loadAtoms(input.workspaceId, {
      scope: input.appId ? 'app' : 'workspace',
      appId: input.appId ?? null,
      limit: MAX_GRAPH_LIMIT,
    });

    for (const fact of candidates) {
      const best = this.findBestSimilar(existingAtoms, fact);
      if (best && best.score >= HIGH_SIMILARITY) {
        const node = this.reinforceAtom(input.workspaceId, best.atom.kind, best.atom.id, {
          agentId: input.agentId ?? null,
          adapterType,
          runId: input.runId ?? null,
          appId: input.appId ?? null,
        });
        if (node) {
          reinforced += 1;
          this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node);
        }
        continue;
      }

      const episode = this.episodes.write({
        workspaceId: input.workspaceId,
        appId: input.appId ?? null,
        workflowId: input.workflowId ?? null,
        runId: input.runId ?? null,
        agentId: input.agentId ?? null,
        type: 'distilled_lesson',
        title: titleFromFact(fact),
        summary: fact,
        source: 'run_promotion',
        confidence: 0.58,
        importance: 0.62,
        trust: 0.55,
        tags: ['collective_brain', ...(adapterType ? [adapterType] : [])],
        entities: input.nodeId ? [input.nodeId] : [],
        outcomeStatus: 'mixed',
        metadata: {
          adapterType,
          nodeId: input.nodeId ?? null,
          origin: 'agent_task_output',
          taskInputPreview: compactValue(input.taskInput),
        },
      });
      created += 1;
      const createdNode = episodeToGraphNode(episode, 1);
      this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_CREATED, createdNode);

      const createdAtom: AtomCandidate = {
        id: episode.id,
        kind: 'episode',
        text: `${episode.title}\n${episode.summary}\n${episode.details ?? ''}`,
        node: createdNode,
      };
      existingAtoms.push(createdAtom);

      if (best && best.score >= RELATED_SIMILARITY) {
        const link = this.createLink({
          workspaceId: input.workspaceId,
          sourceId: episode.id,
          sourceKind: 'episode',
          targetId: best.atom.id,
          targetKind: best.atom.kind,
          relation: relationFor(fact, best.atom.text),
          confidence: Math.max(0.45, Math.min(0.85, best.score)),
          agentId: input.agentId ?? null,
          adapterType,
          runId: input.runId ?? null,
          appId: input.appId ?? null,
        });
        linked += link ? 1 : 0;
      }
    }

    if (created || reinforced || linked) {
      this.logger.info('collective_brain.promotion.applied', {
        workspaceId: input.workspaceId,
        runId: input.runId,
        agentId: input.agentId,
        created,
        reinforced,
        linked,
      });
    }
    return { created, reinforced, linked };
  }

  createLink(input: KnowledgeLinkInput): BrainGraphLink | null {
    if (input.sourceId === input.targetId && input.sourceKind === input.targetKind) return null;
    const existing = this.db.select().from(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, input.workspaceId),
        eq(schema.knowledgeLinks.sourceId, input.sourceId),
        eq(schema.knowledgeLinks.sourceKind, input.sourceKind),
        eq(schema.knowledgeLinks.targetId, input.targetId),
        eq(schema.knowledgeLinks.targetKind, input.targetKind),
        eq(schema.knowledgeLinks.relation, input.relation),
      ))
      .get();

    if (existing) {
      const now = new Date().toISOString();
      const confidence = clamp01(Number(existing.confidence) + (1 - Number(existing.confidence)) * 0.12);
      const reinforceCount = (existing.reinforceCount ?? 1) + 1;
      this.db.update(schema.knowledgeLinks)
        .set({ confidence, reinforceCount, updatedAt: now })
        .where(eq(schema.knowledgeLinks.id, existing.id))
        .run();
      const link = linkRowToGraph({ ...existing, confidence, reinforceCount, updatedAt: now });
      this.publishLink(input.workspaceId, link);
      return link;
    }

    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      sourceKind: input.sourceKind,
      targetId: input.targetId,
      targetKind: input.targetKind,
      relation: input.relation,
      confidence: clamp01(input.confidence ?? 0.5),
      reinforceCount: 1,
      agentId: input.agentId ?? null,
      adapterType: input.adapterType ?? null,
      runId: input.runId ?? null,
      appId: input.appId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.knowledgeLinks).values(row).run();
    const link = linkRowToGraph(row);
    this.publishLink(input.workspaceId, link);
    return link;
  }

  getGraph(workspaceId: string, options: BrainGraphOptions = {}): BrainGraph {
    const scope = options.scope ?? 'workspace';
    const appId = options.appId ? this.resolveAppId(workspaceId, options.appId) : null;
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_GRAPH_LIMIT, 1), MAX_GRAPH_LIMIT);
    const minConfidence = clamp01(options.minConfidence ?? 0);
    const kindFilter = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;

    const atoms = this.loadAtoms(workspaceId, { scope, appId, limit, kinds: options.kinds, minConfidence });
    const atomByKey = new Map(atoms.map((atom) => [atomKey(atom.kind, atom.id), atom] as const));

    const linkRows = this.db.select().from(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, workspaceId),
        ...(scope === 'app' && appId ? [or(eq(schema.knowledgeLinks.appId, appId), isNull(schema.knowledgeLinks.appId))!] : []),
      ))
      .orderBy(desc(schema.knowledgeLinks.updatedAt))
      .limit(limit * 4)
      .all();

    for (const row of linkRows) {
      const sourceKind = row.sourceKind as KnowledgeAtomKind;
      const targetKind = row.targetKind as KnowledgeAtomKind;
      if (kindFilter && (!kindFilter.has(sourceKind) || !kindFilter.has(targetKind))) continue;
      const sourceKey = atomKey(sourceKind, row.sourceId);
      const targetKey = atomKey(targetKind, row.targetId);
      if (!atomByKey.has(sourceKey)) {
        const source = this.loadAtomById(workspaceId, sourceKind, row.sourceId);
        if (source) atomByKey.set(sourceKey, source);
      }
      if (!atomByKey.has(targetKey)) {
        const target = this.loadAtomById(workspaceId, targetKind, row.targetId);
        if (target) atomByKey.set(targetKey, target);
      }
    }

    const graphLinks = linkRows
      .map(linkRowToGraph)
      .filter((link) => atomByKey.has(atomKey(link.sourceKind, link.sourceAtomId)) && atomByKey.has(atomKey(link.targetKind, link.targetAtomId)))
      .filter((link) => link.confidence >= minConfidence)
      .slice(0, limit * 2);

    const reinforceByNode = new Map<string, number>();
    for (const link of graphLinks) {
      reinforceByNode.set(link.source, (reinforceByNode.get(link.source) ?? 0) + link.reinforceCount);
      reinforceByNode.set(link.target, (reinforceByNode.get(link.target) ?? 0) + link.reinforceCount);
    }

    const nodes = [coreNode(workspaceId, scope, appId)];
    const atomNodes = [...atomByKey.values()]
      .map((atom) => ({ ...atom.node, reinforceCount: Math.max(atom.node.reinforceCount, reinforceByNode.get(atom.node.id) ?? 1) }))
      .filter((node) => node.confidence >= minConfidence)
      .sort((a, b) => scoreNode(b) - scoreNode(a))
      .slice(0, limit);
    nodes.push(...atomNodes);

    const visible = new Set(nodes.map((node) => node.id));
    const visibleLinks = graphLinks.filter((link) => visible.has(link.source) && visible.has(link.target));
    const lastActivityAt = latestActivity(nodes, visibleLinks);
    const adapterTypes = new Set<string>();
    for (const node of nodes) if (node.adapterType) adapterTypes.add(node.adapterType);
    for (const link of visibleLinks) if (link.adapterType) adapterTypes.add(link.adapterType);

    return {
      nodes,
      links: visibleLinks,
      meta: {
        workspaceId,
        scope,
        appId,
        atomCount: nodes.length - 1,
        linkCount: visibleLinks.length,
        lastActivityAt,
        adapterTypes: [...adapterTypes].sort(),
      },
    };
  }

  getNode(workspaceId: string, graphNodeId: string, options: BrainGraphOptions = {}) {
    const graph = this.getGraph(workspaceId, { ...options, limit: MAX_GRAPH_LIMIT });
    const node = graph.nodes.find((candidate) => candidate.id === graphNodeId || candidate.atomId === graphNodeId);
    if (!node) return null;
    const links = graph.links.filter((link) => link.source === node.id || link.target === node.id);
    const relatedIds = new Set<string>();
    for (const link of links) {
      relatedIds.add(link.source === node.id ? link.target : link.source);
    }
    return {
      node,
      links,
      relatedNodes: graph.nodes.filter((candidate) => relatedIds.has(candidate.id)),
    };
  }

  private reinforceAtom(
    workspaceId: string,
    kind: KnowledgeAtomKind,
    id: string,
    provenance: { agentId?: string | null; adapterType?: string | null; runId?: string | null; appId?: string | null },
  ): BrainGraphNode | null {
    if (kind === 'episode') {
      const updated = this.episodes.reinforce(workspaceId, id, { confidenceDelta: 0.06, trustDelta: 0.04 });
      if (!updated) return null;
      return episodeToGraphNode(updated, 2);
    }

    if (kind === 'memory') {
      const row = this.db.select().from(schema.appMemory)
        .where(and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.id, id)))
        .get();
      if (!row) return null;
      const now = new Date().toISOString();
      const trust = clamp01(Number(row.trust) + 0.04);
      const globalConfidence = clamp01(Number(row.globalConfidence ?? 0) + (1 - Number(row.globalConfidence ?? 0)) * 0.15);
      this.db.update(schema.appMemory)
        .set({
          trust: String(trust),
          globalConfidence: String(globalConfidence),
          adapterType: provenance.adapterType ?? row.adapterType ?? null,
          reinforcedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.appMemory.id, id))
        .run();
      return memoryRowToGraphNode({ ...row, trust: String(trust), globalConfidence: String(globalConfidence), adapterType: provenance.adapterType ?? row.adapterType, reinforcedAt: now, updatedAt: now }, 2);
    }

    return this.loadAtomById(workspaceId, kind, id)?.node ?? null;
  }

  private findBestSimilar(atoms: AtomCandidate[], fact: string): SimilarAtom | null {
    let best: SimilarAtom | null = null;
    for (const atom of atoms) {
      const score = similarity(fact, atom.text);
      if (!best || score > best.score) best = { atom, score };
    }
    return best;
  }

  private loadAtoms(workspaceId: string, options: BrainGraphOptions): AtomCandidate[] {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_GRAPH_LIMIT, 1), MAX_GRAPH_LIMIT);
    const perKind = Math.max(12, Math.ceil(limit / 4));
    const appId = options.appId ?? null;
    const scope = options.scope ?? 'workspace';
    const kindFilter = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
    const minConfidence = clamp01(options.minConfidence ?? 0);
    const out: AtomCandidate[] = [];

    if (!kindFilter || kindFilter.has('episode')) {
      const rows = this.db.select().from(schema.memoryEpisodes)
        .where(and(
          eq(schema.memoryEpisodes.workspaceId, workspaceId),
          isNull(schema.memoryEpisodes.archivedAt),
          ...(scope === 'app' && appId ? [or(eq(schema.memoryEpisodes.appId, appId), isNull(schema.memoryEpisodes.appId))!] : []),
        ))
        .orderBy(desc(schema.memoryEpisodes.updatedAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        const node = episodeRowToGraphNode(row, 1);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'episode', text: `${row.title}\n${row.summary}\n${row.details ?? ''}`, node });
      }
    }

    if (!kindFilter || kindFilter.has('memory')) {
      const rows = this.db.select().from(schema.appMemory)
        .where(and(
          eq(schema.appMemory.workspaceId, workspaceId),
          ...(scope === 'app' && appId ? [eq(schema.appMemory.appId, appId)] : []),
        ))
        .orderBy(desc(schema.appMemory.updatedAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        const node = memoryRowToGraphNode(row, 1);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'memory', text: `${row.title}\n${row.content}`, node });
      }
    }

    if (!kindFilter || kindFilter.has('pattern')) {
      const rows = this.db.select().from(schema.appPromotedPatterns)
        .where(and(
          eq(schema.appPromotedPatterns.workspaceId, workspaceId),
          ...(scope === 'app' && appId ? [eq(schema.appPromotedPatterns.appId, appId)] : []),
        ))
        .orderBy(desc(schema.appPromotedPatterns.updatedAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        const node = patternRowToGraphNode(row);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'pattern', text: `${row.title}\n${row.summary}`, node });
      }
    }

    if (!kindFilter || kindFilter.has('knowledge_chunk')) {
      const rows = this.db.select().from(schema.knowledgeChunks)
        .where(and(
          eq(schema.knowledgeChunks.workspaceId, workspaceId),
          ...(scope === 'app' && appId ? [eq(schema.knowledgeChunks.appId, appId)] : []),
        ))
        .orderBy(desc(schema.knowledgeChunks.updatedAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        const node = knowledgeChunkRowToGraphNode(row);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'knowledge_chunk', text: `${row.title}\n${row.content}`, node });
      }
    }

    if ((!kindFilter || kindFilter.has('kb_chunk')) && scope === 'workspace') {
      const rows = this.db.select().from(schema.kbChunks)
        .where(eq(schema.kbChunks.workspaceId, workspaceId))
        .orderBy(desc(schema.kbChunks.createdAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        const node = kbChunkRowToGraphNode(row);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'kb_chunk', text: row.content, node });
      }
    }

    return out;
  }

  private loadAtomById(workspaceId: string, kind: KnowledgeAtomKind, id: string): AtomCandidate | null {
    switch (kind) {
      case 'episode': {
        const row = this.db.select().from(schema.memoryEpisodes)
          .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, id)))
          .get();
        if (!row) return null;
        const node = episodeRowToGraphNode(row, 1);
        return { id: row.id, kind, text: `${row.title}\n${row.summary}\n${row.details ?? ''}`, node };
      }
      case 'memory': {
        const row = this.db.select().from(schema.appMemory)
          .where(and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.id, id)))
          .get();
        if (!row) return null;
        const node = memoryRowToGraphNode(row, 1);
        return { id: row.id, kind, text: `${row.title}\n${row.content}`, node };
      }
      case 'pattern': {
        const row = this.db.select().from(schema.appPromotedPatterns)
          .where(and(eq(schema.appPromotedPatterns.workspaceId, workspaceId), eq(schema.appPromotedPatterns.id, id)))
          .get();
        if (!row) return null;
        const node = patternRowToGraphNode(row);
        return { id: row.id, kind, text: `${row.title}\n${row.summary}`, node };
      }
      case 'knowledge_chunk': {
        const row = this.db.select().from(schema.knowledgeChunks)
          .where(and(eq(schema.knowledgeChunks.workspaceId, workspaceId), eq(schema.knowledgeChunks.id, id)))
          .get();
        if (!row) return null;
        const node = knowledgeChunkRowToGraphNode(row);
        return { id: row.id, kind, text: `${row.title}\n${row.content}`, node };
      }
      case 'kb_chunk': {
        const row = this.db.select().from(schema.kbChunks)
          .where(and(eq(schema.kbChunks.workspaceId, workspaceId), eq(schema.kbChunks.id, id)))
          .get();
        if (!row) return null;
        const node = kbChunkRowToGraphNode(row);
        return { id: row.id, kind, text: row.content, node };
      }
    }
  }

  private resolveAgent(workspaceId: string, agentId: string): { id: string; adapterType: string } | null {
    const row = this.db.select({ id: schema.agents.id, adapterType: schema.agents.adapterType })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.id, agentId)))
      .get();
    return row ?? null;
  }

  private resolveAppId(workspaceId: string, appIdOrSlug: string): string {
    const row = this.db.select({ id: schema.appInstances.id })
      .from(schema.appInstances)
      .where(and(
        eq(schema.appInstances.workspaceId, workspaceId),
        or(eq(schema.appInstances.id, appIdOrSlug), eq(schema.appInstances.slug, appIdOrSlug))!,
      ))
      .get();
    return row?.id ?? appIdOrSlug;
  }

  private publishAtom(workspaceId: string, event: typeof REALTIME_EVENTS.BRAIN_ATOM_CREATED | typeof REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node: BrainGraphNode): void {
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), event, {
      workspaceId,
      appId: node.appId ?? null,
      node,
    });
  }

  private publishLink(workspaceId: string, link: BrainGraphLink): void {
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.BRAIN_LINK_CREATED, {
      workspaceId,
      appId: link.appId ?? null,
      link,
    });
  }
}

function linkRowToGraph(row: typeof schema.knowledgeLinks.$inferSelect): BrainGraphLink {
  const sourceKind = row.sourceKind as KnowledgeAtomKind;
  const targetKind = row.targetKind as KnowledgeAtomKind;
  return {
    id: row.id,
    source: atomKey(sourceKind, row.sourceId),
    target: atomKey(targetKind, row.targetId),
    sourceAtomId: row.sourceId,
    sourceKind,
    targetAtomId: row.targetId,
    targetKind,
    relation: row.relation as KnowledgeLinkRelation,
    confidence: Number(row.confidence) || 0.5,
    reinforceCount: row.reinforceCount ?? 1,
    agentId: row.agentId,
    adapterType: row.adapterType,
    appId: row.appId,
    runId: row.runId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function episodeToGraphNode(row: ReturnType<EpisodicMemoryStore['write']>, reinforceCount: number): BrainGraphNode {
  return {
    id: atomKey('episode', row.id),
    atomId: row.id,
    atomKind: 'episode',
    label: row.title,
    summary: row.summary,
    confidence: clamp01(row.confidence),
    trust: row.trust,
    reinforceCount,
    agentId: row.agentId ?? null,
    adapterType: typeof row.metadata.adapterType === 'string' ? row.metadata.adapterType : null,
    appId: row.appId ?? null,
    runId: row.runId ?? null,
    isDisputed: Boolean(row.metadata.disputed),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      ...row.metadata,
      type: row.type,
      source: row.source,
      tags: row.tags,
      outcomeStatus: row.outcomeStatus ?? null,
    },
  };
}

function episodeRowToGraphNode(row: typeof schema.memoryEpisodes.$inferSelect, reinforceCount: number): BrainGraphNode {
  const metadata = parseJsonRecord(row.metadata);
  return {
    id: atomKey('episode', row.id),
    atomId: row.id,
    atomKind: 'episode',
    label: row.title,
    summary: row.summary,
    confidence: clamp01(Number(row.confidence)),
    trust: Number(row.trust),
    reinforceCount,
    agentId: row.agentId,
    adapterType: typeof metadata.adapterType === 'string' ? metadata.adapterType : null,
    appId: row.appId,
    runId: row.runId,
    isDisputed: Boolean(metadata.disputed),
    isStale: isStale(row.updatedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      ...metadata,
      type: row.type,
      source: row.source,
      tags: parseJsonArray<string>(row.tags),
      outcomeStatus: row.outcomeStatus ?? null,
    },
  };
}

function memoryRowToGraphNode(row: typeof schema.appMemory.$inferSelect, reinforceCount: number): BrainGraphNode {
  const trust = clamp01(Number(row.trust));
  const globalConfidence = clamp01(Number(row.globalConfidence ?? 0));
  return {
    id: atomKey('memory', row.id),
    atomId: row.id,
    atomKind: 'memory',
    label: row.title,
    summary: row.content,
    confidence: Math.max(globalConfidence, trust * 0.85),
    trust,
    reinforceCount,
    adapterType: row.adapterType,
    appId: row.appId,
    isStale: isStale(row.updatedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      kind: row.kind,
      source: row.source,
      tags: parseJsonArray<string>(row.tags),
      provenance: parseJsonRecord(row.provenance),
      globalConfidence,
      workspaceGlobal: globalConfidence >= GLOBAL_CONFIDENCE_THRESHOLD,
    },
  };
}

function patternRowToGraphNode(row: typeof schema.appPromotedPatterns.$inferSelect): BrainGraphNode {
  return {
    id: atomKey('pattern', row.id),
    atomId: row.id,
    atomKind: 'pattern',
    label: row.title,
    summary: row.summary,
    confidence: clamp01(Number(row.confidence)),
    trust: Number(row.trust),
    reinforceCount: row.evidenceCount,
    appId: row.appId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      kind: row.kind,
      provenance: parseJsonRecord(row.provenance),
      evidenceCount: row.evidenceCount,
    },
  };
}

function knowledgeChunkRowToGraphNode(row: typeof schema.knowledgeChunks.$inferSelect): BrainGraphNode {
  return {
    id: atomKey('knowledge_chunk', row.id),
    atomId: row.id,
    atomKind: 'knowledge_chunk',
    label: row.title,
    summary: truncate(row.content, 180),
    confidence: clamp01(Number(row.trust)),
    trust: Number(row.trust),
    reinforceCount: 1,
    appId: row.appId,
    isStale: isStale(row.updatedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      source: row.source,
      tags: parseJsonArray<string>(row.tags),
      provenance: parseJsonRecord(row.provenance),
    },
  };
}

function kbChunkRowToGraphNode(row: typeof schema.kbChunks.$inferSelect): BrainGraphNode {
  const metadata = parseJsonRecord(row.metadata);
  const source = typeof metadata.source === 'string' ? metadata.source : 'Knowledge document';
  return {
    id: atomKey('kb_chunk', row.id),
    atomId: row.id,
    atomKind: 'kb_chunk',
    label: source,
    summary: truncate(row.content, 180),
    confidence: 0.82,
    trust: 0.82,
    reinforceCount: 1,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    metadata: {
      ...metadata,
      documentId: row.documentId,
      knowledgeBaseId: row.knowledgeBaseId,
      chunkIndex: row.chunkIndex,
      tokenCount: row.tokenCount,
    },
  };
}

function coreNode(workspaceId: string, scope: BrainGraphScope, appId: string | null): BrainGraphNode {
  const now = new Date().toISOString();
  return {
    id: 'core',
    atomId: 'core',
    atomKind: 'core',
    label: scope === 'app' ? 'App brain' : 'Workspace brain',
    summary: scope === 'app' ? 'App-scoped intelligence plus global workspace memory' : 'Collective intelligence shared by every agent adapter',
    confidence: 1,
    trust: 1,
    reinforceCount: 1,
    appId,
    createdAt: now,
    updatedAt: now,
    metadata: { workspaceId, scope },
  };
}

function atomKey(kind: KnowledgeAtomKind, id: string): string {
  return `${kind}:${id}`;
}

function extractPromotableFacts(value: unknown): string[] {
  const raw = flattenText(value).join('\n');
  const sentences = raw
    .split(/(?:\r?\n|(?<=[.!?])\s+)/)
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter((part) => part.length >= 35 && part.length <= 360)
    .filter((part) => !looksSensitive(part))
    .filter((part) => hasUsefulSignal(part));
  return uniqueByNormalized(sentences).slice(0, 6);
}

function flattenText(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => flattenText(entry, depth + 1));
  if (typeof value === 'object') {
    const out: string[] = [];
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization|cookie/i.test(key)) continue;
      if (/summary|result|output|content|message|error|reason|lesson|observation|finding|conclusion/i.test(key)) {
        out.push(...flattenText(entry, depth + 1));
      } else if (depth < 2) {
        out.push(...flattenText(entry, depth + 1));
      }
    }
    return out;
  }
  return [];
}

function hasUsefulSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return /learned|observed|found|confirmed|failed|succeeded|requires|should|must|because|resolved|rate|limit|error|policy|rule|pattern|use|avoid|returns|returned/.test(lower)
    || tokenize(text).length >= 8;
}

function looksSensitive(text: string): boolean {
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /\b(?:sk|pk|ghp|gho|xoxb|xoxp)_[A-Za-z0-9_\-]{16,}\b/.test(text)
    || /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/.test(text);
}

function titleFromFact(fact: string): string {
  const clean = fact.replace(/^[-*\d.)\s]+/, '').trim();
  return truncate(clean, 92);
}

function relationFor(fact: string, target: string): KnowledgeLinkRelation {
  const lower = `${fact}\n${target}`.toLowerCase();
  if (/contradict|instead|not true|actually|but actual|differs|mismatch/.test(lower)) return 'contradicts';
  if (/because|therefore|derived|from/.test(lower)) return 'derived_from';
  return 'refines';
}

function similarity(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) if (bTokens.has(token)) overlap += 1;
  const union = new Set([...aTokens, ...bTokens]).size;
  const jaccard = overlap / union;
  const containment = overlap / Math.min(aTokens.size, bTokens.size);
  return jaccard * 0.65 + containment * 0.35;
}

function tokenize(input: string): string[] {
  const out: string[] = [];
  const cleaned = input.toLowerCase().replace(/[^a-z0-9_\s]+/g, ' ');
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw || raw.length < 2 || STOP_WORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

function uniqueByNormalized(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = tokenize(item).slice(0, 18).join(' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function compactValue(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return { type: 'array', count: value.length };
  return { type: 'object', keys: Object.keys(value as Record<string, unknown>).slice(0, 8) };
}

function latestActivity(nodes: BrainGraphNode[], links: BrainGraphLink[]): string | null {
  let latest = 0;
  for (const node of nodes) latest = Math.max(latest, Date.parse(node.updatedAt) || 0);
  for (const link of links) latest = Math.max(latest, Date.parse(link.updatedAt) || 0);
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function scoreNode(node: BrainGraphNode): number {
  return node.confidence * 3 + Math.log1p(node.reinforceCount) + Date.parse(node.updatedAt) / 10_000_000_000_000;
}

function isStale(iso: string): boolean {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at > 1000 * 60 * 60 * 24 * 90;
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'string') return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1))}...`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
