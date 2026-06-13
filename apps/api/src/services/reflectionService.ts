import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import type { SharedIntelligenceService } from './sharedIntelligence.js';
import {
  type ConclusionType,
  type PeerCardCategory,
  type PeerCardFact,
  type PeerProfileService,
  type PeerType,
  type VolatilityClass,
} from './peerProfileService.js';
import { embedText, selectEmbeddingProvider, type EmbeddingProvider } from './embeddingProvider.js';
import { normalizeTextKey, safeJson, tokenize } from './brainText.js';

export interface DreamPassResult {
  peersProcessed: number;
  factsUpserted: number;
  superseded: number;
  inductiveConclusions: number;
  contradictions: number;
}

type PeerConclusionRow = typeof schema.peerProfileConclusions.$inferSelect;

export class ReflectionService {
  readonly #embeddingProviders = new Map<string, EmbeddingProvider>();

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly peers: PeerProfileService,
    private readonly brain: SharedIntelligenceService,
  ) {}

  async run(args: {
    workspaceId: string;
    peerId: string;
    peerType?: PeerType;
    observerPeerId?: string | null;
    phase?: 'deduction' | 'induction' | 'both';
  }): Promise<DreamPassResult> {
    const peerType = args.peerType ?? 'user';
    const phase = args.phase ?? 'both';
    let factsUpserted = 0;
    let superseded = 0;
    let inductiveConclusions = 0;
    let contradictions = 0;

    if (phase === 'deduction' || phase === 'both') {
      const deduction = await this.#deduction(args.workspaceId, peerType, args.peerId, args.observerPeerId ?? null);
      factsUpserted += deduction.factsUpserted;
      superseded += deduction.superseded;
      contradictions += deduction.contradictions;
    }
    if (phase === 'induction' || phase === 'both') {
      const induction = await this.#induction(args.workspaceId, args.peerId, args.observerPeerId ?? null);
      inductiveConclusions += induction.inductiveConclusions;
    }

    await this.peers.markDreamed(args.workspaceId, peerType, args.peerId, new Date().toISOString(), args.observerPeerId ?? null);
    const result = { peersProcessed: 1, factsUpserted, superseded, inductiveConclusions, contradictions };
    this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BRAIN_DREAM_PASS_COMPLETED, {
      workspaceId: args.workspaceId,
      peerId: args.peerId,
      peerType,
      phase,
      ...result,
    });
    this.db.insert(schema.brainQualityEvents).values({
      id: randomUUID(),
      workspaceId: args.workspaceId,
      scopeId: null,
      agentId: null,
      eventType: 'brain_dream_pass_completed',
      atomId: null,
      abilityId: null,
      runId: null,
      delta: null,
      metadata: { peerId: args.peerId, peerType, observerPeerId: args.observerPeerId ?? null, phase, ...result },
      createdAt: new Date().toISOString(),
    }).run();
    this.logger.info('brain.dream_pass.completed', { workspaceId: args.workspaceId, peerId: args.peerId, phase, ...result });
    return result;
  }

  async runDue(workspaceId: string, options: { force?: boolean; phase?: 'deduction' | 'induction' | 'both'; limit?: number } = {}): Promise<DreamPassResult> {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const peers = this.db.select().from(schema.peerProfiles)
      .where(eq(schema.peerProfiles.workspaceId, workspaceId))
      .orderBy(desc(schema.peerProfiles.updatedAt))
      .limit(limit)
      .all()
      .filter((peer) => options.force || this.#isDue(workspaceId, peer.peerId, peer.lastDreamAt));
    const total: DreamPassResult = { peersProcessed: 0, factsUpserted: 0, superseded: 0, inductiveConclusions: 0, contradictions: 0 };
    for (const peer of peers) {
      const result = await this.run({
        workspaceId,
        peerId: peer.peerId,
        peerType: peer.peerType === 'agent' ? 'agent' : 'user',
        phase: options.phase ?? 'both',
      });
      total.peersProcessed += result.peersProcessed;
      total.factsUpserted += result.factsUpserted;
      total.superseded += result.superseded;
      total.inductiveConclusions += result.inductiveConclusions;
      total.contradictions += result.contradictions;
    }
    return total;
  }

  async #deduction(workspaceId: string, peerType: PeerType, peerId: string, observerPeerId: string | null): Promise<Omit<DreamPassResult, 'peersProcessed' | 'inductiveConclusions'>> {
    const conclusions = this.#activeConclusions(workspaceId, peerId, observerPeerId);
    const now = new Date().toISOString();
    const facts = conclusions
      .filter((row) => shouldInjectConclusion(row.conclusionType, row.confidence, row.supportingSessionCount))
      .map((row) => conclusionToFact(row, now))
      .filter((fact): fact is PeerCardFact => Boolean(fact));
    const upserted = await this.peers.upsertPeerCardFacts({ workspaceId, peerId, peerType, observerPeerId, facts });
    const superseded = this.#supersedeStaleVolatileFacts(workspaceId, conclusions);
    const contradictions = await this.#flagBeliefContradictions(workspaceId, peerId, conclusions);
    return { factsUpserted: upserted.count, superseded, contradictions };
  }

  async #induction(workspaceId: string, peerId: string, observerPeerId: string | null): Promise<{ inductiveConclusions: number }> {
    const rows = this.#activeConclusions(workspaceId, peerId, observerPeerId);
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = inductionKey(row.content);
      if (!key) continue;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    let inserted = 0;
    const now = new Date().toISOString();
    for (const group of groups.values()) {
      const sessionCount = new Set(group.map((row) => row.sourceSessionId).filter(Boolean)).size;
      if (sessionCount < 3) continue;
      const content = `Observed cross-session trait: ${group[0]!.content.replace(/^(Operator|User)\s+(signal|context):\s*/i, '').slice(0, 180)}`;
      if (rows.some((row) => row.conclusionType === 'inductive' && normalize(row.content) === normalize(content))) continue;
      this.db.insert(schema.peerProfileConclusions).values({
        id: randomUUID(),
        workspaceId,
        subjectPeerId: peerId,
        observerPeerId: observerPeerId ?? 'global',
        content,
        sourceSessionId: null,
        confidence: Math.min(0.9, 0.62 + sessionCount * 0.05),
        conclusionType: 'inductive',
        volatilityClass: 'contextual',
        supportingSessionCount: sessionCount,
        supersededById: null,
        status: 'active',
        embedding: await this.#embed(workspaceId, content),
        createdAt: now,
        updatedAt: now,
      }).run();
      inserted += 1;
    }
    return { inductiveConclusions: inserted };
  }

  #activeConclusions(workspaceId: string, peerId: string, observerPeerId: string | null) {
    return this.db.select().from(schema.peerProfileConclusions)
      .where(and(
        eq(schema.peerProfileConclusions.workspaceId, workspaceId),
        eq(schema.peerProfileConclusions.subjectPeerId, peerId),
        eq(schema.peerProfileConclusions.status, 'active'),
      ))
      .orderBy(desc(schema.peerProfileConclusions.createdAt))
      .limit(250)
      .all()
      .filter((row) => !row.supersededById)
      .filter((row) => observerPeerId
        ? row.observerPeerId === observerPeerId
        : row.observerPeerId === peerId || row.observerPeerId === 'global');
  }

  #isDue(workspaceId: string, peerId: string, lastDreamAt: string | null): boolean {
    if (!lastDreamAt) return true;
    if (Date.now() - Date.parse(lastDreamAt) >= 8 * 60 * 60 * 1000) return true;
    return this.#activeConclusions(workspaceId, peerId, null).length >= 30;
  }

  #supersedeStaleVolatileFacts(workspaceId: string, rows: PeerConclusionRow[]): number {
    const groups = new Map<string, typeof rows>();
    for (const row of rows.filter((item) => item.volatilityClass === 'volatile' || classifyCategory(item.content) === 'CONTEXT')) {
      const key = `${classifyCategory(row.content)}:${topicKey(row.content)}`;
      if (key.endsWith(':')) continue;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    let changed = 0;
    const now = new Date().toISOString();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const sorted = group.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const keeper = sorted[0];
      if (!keeper) continue;
      const older = sorted.slice(1).filter((row) => hasSupersessionEvidence(keeper, row));
      for (const row of older) {
        this.db.update(schema.peerProfileConclusions)
          .set({ status: 'archived', supersededById: keeper!.id, updatedAt: now })
          .where(and(eq(schema.peerProfileConclusions.workspaceId, workspaceId), eq(schema.peerProfileConclusions.id, row.id)))
          .run();
        changed += 1;
      }
    }
    return changed;
  }

  async #flagBeliefContradictions(workspaceId: string, peerId: string, rows: PeerConclusionRow[]): Promise<number> {
    let flagged = 0;
    for (const row of rows.filter((item) => classifyCategory(item.content) === 'BELIEF')) {
      const atoms = await this.brain.searchAtoms({
        workspaceId,
        query: row.content,
        scope: 'workspace',
        limit: 3,
        minConfidence: 0.65,
      });
      const contradiction = atoms.find((atom) => contradicts(row.content, atom.content));
      if (!contradiction) continue;
      flagged += 1;
      this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.BRAIN_BELIEF_CONTRADICTION, {
        workspaceId,
        peerId,
        conclusionId: row.id,
        atomId: contradiction.id,
        belief: row.content,
        truth: contradiction.content,
      });
    }
    return flagged;
  }

  invalidateEmbeddingProvider(workspaceId: string): void {
    this.#embeddingProviders.delete(workspaceId);
  }

  #resolveEmbeddingProvider(workspaceId: string): EmbeddingProvider {
    const cached = this.#embeddingProviders.get(workspaceId);
    if (cached) return cached;
    const row = this.db.select({
      type: schema.workspaces.embeddingProviderType,
      config: schema.workspaces.embeddingProviderConfig,
    }).from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    const provider = selectEmbeddingProvider(row?.type ?? 'hashing', parseRecord(row?.config));
    this.#embeddingProviders.set(workspaceId, provider);
    return provider;
  }

  async #embed(workspaceId: string, text: string): Promise<number[] | null> {
    if (!text.trim()) return null;
    try {
      return await embedText(this.#resolveEmbeddingProvider(workspaceId), text);
    } catch (err) {
      this.logger.warn('brain.dream_pass.embed_failed', { workspaceId, message: (err as Error).message });
      return null;
    }
  }
}

function conclusionToFact(row: typeof schema.peerProfileConclusions.$inferSelect, now: string): PeerCardFact | null {
  const category = classifyCategory(row.content);
  if (!category) return null;
  return {
    category,
    content: row.content.replace(/^(Operator|User)\s+(signal|context):\s*/i, '').slice(0, 120),
    confidence: row.confidence,
    volatility: normalizeVolatility(row.volatilityClass),
    source: 'dream_inferred',
    createdAt: row.createdAt || now,
    lastVerifiedAt: now,
  };
}

function shouldInjectConclusion(type: string, confidence: number, supportingSessionCount: number): boolean {
  if (type === 'deductive') return confidence >= 0.5;
  if (type === 'inductive') return confidence >= 0.65 && supportingSessionCount >= 2;
  if (type === 'abductive') return confidence >= 0.8;
  return confidence >= 0.7;
}

function classifyCategory(content: string): PeerCardCategory | null {
  if (/\b(always|never|must|do not|don't|please|remember to|make sure)\b/i.test(content)) return 'INSTRUCTION';
  if (/\b(prefer|like|hate|want|need|avoid|use)\b/i.test(content)) return 'PREFERENCE';
  if (/\b(i am|i'm|my role|our team|my company|head of|founder)\b/i.test(content)) return 'IDENTITY';
  if (/\b(currently|right now|this week|this month|campaign|project|launch|deadline|q[1-4])\b/i.test(content)) return 'CONTEXT';
  if (/\b(i think|i believe|we think|we believe|assume|doesn't support|does not support|supports|can't|cannot)\b/i.test(content)) return 'BELIEF';
  if (/\b(tend|usually|often|style|workflow|process|engages)\b/i.test(content)) return 'TRAIT';
  return 'TRAIT';
}

function normalizeVolatility(value: unknown): VolatilityClass {
  return value === 'stable' || value === 'contextual' || value === 'variable' || value === 'volatile'
    ? value
    : 'contextual';
}

function inductionKey(content: string): string {
  const tokens = tokenize(content).filter((token) => !COMMON.has(token));
  return tokens.slice(0, 6).join(' ');
}

function topicKey(content: string): string {
  return tokenize(content).filter((token) => !COMMON.has(token)).slice(0, 4).join(' ');
}

function hasSupersessionEvidence(keeper: PeerConclusionRow, older: PeerConclusionRow): boolean {
  if (keeper.id === older.id) return false;
  if (keeper.sourceSessionId && older.sourceSessionId && keeper.sourceSessionId === older.sourceSessionId) return false;
  if (normalize(keeper.content) === normalize(older.content)) return false;
  if (classifyCategory(keeper.content) !== classifyCategory(older.content)) return false;
  return topicKey(keeper.content) === topicKey(older.content);
}

function contradicts(belief: string, atom: string): boolean {
  const beliefTokens = new Set(tokenize(belief));
  const atomTokens = new Set(tokenize(atom));
  const overlap = [...beliefTokens].filter((token) => atomTokens.has(token) && !COMMON.has(token)).length;
  if (overlap < 2) return false;
  const beliefNegated = /\b(doesn't|does not|cannot|can't|not|no)\b/i.test(belief);
  const atomNegated = /\b(doesn't|does not|cannot|can't|not|no)\b/i.test(atom);
  return beliefNegated !== atomNegated;
}

function normalize(value: string): string {
  return normalizeTextKey(value);
}

function parseRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  const parsed = safeJson(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

const COMMON = new Set([
  'the',
  'and',
  'that',
  'this',
  'with',
  'for',
  'from',
  'operator',
  'signal',
  'context',
  'user',
  'prefer',
  'prefers',
  'believe',
  'believes',
  'current',
  'currently',
  'project',
  'campaign',
]);
