import { randomUUID } from 'node:crypto';
import { and, desc, eq, or } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import { embedText, selectEmbeddingProvider, type EmbeddingProvider } from './embeddingProvider.js';
import type { CognitivePromotionQueueWorker } from './cognitivePromotionQueueWorker.js';
import { normalizeTextKey, safeJson, scoreText, tokenize } from './brainText.js';

export type PeerType = 'user' | 'agent';
export type PeerCardCategory = 'INSTRUCTION' | 'PREFERENCE' | 'TRAIT' | 'IDENTITY' | 'CONTEXT' | 'BELIEF';
export type VolatilityClass = 'stable' | 'contextual' | 'variable' | 'volatile';
export type ConclusionType = 'deductive' | 'inductive' | 'abductive';
export type PeerFactSource = 'session_observed' | 'dream_inferred' | 'operator_confirmed' | 'system';

export interface PeerCardFact {
  category: PeerCardCategory;
  content: string;
  confidence: number;
  volatility: VolatilityClass;
  source: PeerFactSource;
  createdAt: string;
  lastVerifiedAt: string;
}

export interface PeerConclusion {
  id: string;
  subjectPeerId: string;
  observerPeerId: string;
  content: string;
  confidence: number;
  sourceSessionId: string | null;
  conclusionType: ConclusionType;
  volatilityClass: VolatilityClass;
  supportingSessionCount: number;
  supersededById: string | null;
  status: string;
  createdAt: string;
}

export interface PeerConclusionQueryOptions {
  observerScope?: 'global' | string;
  conclusionType?: ConclusionType;
  includeSuperseded?: boolean;
  limit?: number;
}

const PEER_CARD_CAP = 40;

export class PeerProfileService {
  queue?: CognitivePromotionQueueWorker;
  readonly #embeddingProviders = new Map<string, EmbeddingProvider>();

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  getSummary(workspaceId: string, peerType: PeerType, peerId: string, observerScope: 'global' | string = 'global'): string | null {
    const directional = observerScope !== 'global'
      ? this.#getAgentPeerCard(workspaceId, observerScope, peerId)
      : null;
    if (directional?.summary) return directional.summary;
    const row = this.#getGlobalRepresentation(workspaceId, peerType, peerId);
    return row?.summary || null;
  }

  getPeerCard(workspaceId: string, peerType: PeerType, peerId: string, observerScope: 'global' | string = 'global'): PeerCardFact[] {
    const directional = observerScope !== 'global'
      ? this.#getAgentPeerCard(workspaceId, observerScope, peerId)
      : null;
    const card = parsePeerCard(directional?.peerCard);
    if (card.length > 0) return card;
    return parsePeerCard(this.#getGlobalRepresentation(workspaceId, peerType, peerId)?.peerCard);
  }

  getPeerCardStats(workspaceId: string, peerType: PeerType, peerId: string, observerScope: 'global' | string = 'global') {
    const facts = this.getPeerCard(workspaceId, peerType, peerId, observerScope);
    const byCategory: Record<PeerCardCategory, number> = {
      INSTRUCTION: 0,
      PREFERENCE: 0,
      TRAIT: 0,
      IDENTITY: 0,
      CONTEXT: 0,
      BELIEF: 0,
    };
    for (const fact of facts) byCategory[fact.category] += 1;
    return { count: facts.length, byCategory };
  }

  renderSystemInstructions(workspaceId: string, peerType: PeerType, peerId: string, observerScope: 'global' | string = 'global'): string {
    const instructions = this.getPeerCard(workspaceId, peerType, peerId, observerScope)
      .filter((fact) => fact.category === 'INSTRUCTION' && fact.confidence >= 0.5 && isTrustedInstruction(fact))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8);
    if (instructions.length === 0) return '';
    return [
      'PEER CARD INSTRUCTIONS',
      'Apply these standing operator instructions throughout the turn:',
      ...instructions.map((fact) => `- ${fact.content} [confidence ${fact.confidence.toFixed(2)}]`),
    ].join('\n');
  }

  renderContextFacts(workspaceId: string, peerType: PeerType, peerId: string, observerScope: 'global' | string = 'global'): string[] {
    const cardFacts = this.getPeerCard(workspaceId, peerType, peerId, observerScope)
      .filter((fact) => fact.confidence >= 0.5 && (fact.category !== 'INSTRUCTION' || !isTrustedInstruction(fact)))
      .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || b.confidence - a.confidence)
      .slice(0, 12)
      .map((fact) => `${fact.category}: ${fact.content} [${fact.volatility}, ${fact.confidence.toFixed(2)}]`);
    if (cardFacts.length > 0) return cardFacts;
    const summary = this.getSummary(workspaceId, peerType, peerId, observerScope);
    return summary ? [`SUMMARY: ${summary}`] : [];
  }

  getConclusions(workspaceId: string, peerId: string, limitOrOptions: number | PeerConclusionQueryOptions = 10): PeerConclusion[] {
    const options: PeerConclusionQueryOptions = typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : limitOrOptions;
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
    const rows = this.db.select().from(schema.peerProfileConclusions)
      .where(and(
        eq(schema.peerProfileConclusions.workspaceId, workspaceId),
        eq(schema.peerProfileConclusions.subjectPeerId, peerId),
      ))
      .orderBy(desc(schema.peerProfileConclusions.confidence), desc(schema.peerProfileConclusions.createdAt))
      .limit(Math.max(limit, 50))
      .all()
      .filter((row) => options.includeSuperseded || (row.status !== 'archived' && !row.supersededById))
      .filter((row) => !options.conclusionType || row.conclusionType === options.conclusionType);
    const scoped = options.observerScope && options.observerScope !== 'global'
      ? rows.filter((row) => row.observerPeerId === options.observerScope)
      : rows.filter((row) => row.observerPeerId === peerId || row.observerPeerId === 'global');
    return scoped.slice(0, limit).map(rowToConclusion);
  }

  query(workspaceId: string, peerId: string, question: string, observerScope: 'global' | string = 'global'): string {
    const tokens = new Set(tokenize(question));
    const ranked = this.getConclusions(workspaceId, peerId, { observerScope, limit: 50 })
      .map((conclusion) => ({ conclusion, score: score(tokens, conclusion.content) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((item) => renderConclusion(item.conclusion));
    if (ranked.length === 0) {
      const facts = this.renderContextFacts(workspaceId, 'user', peerId, observerScope);
      const summary = this.getSummary(workspaceId, 'user', peerId, observerScope) ?? this.getSummary(workspaceId, 'agent', peerId, observerScope);
      if (facts.length > 0) return facts.map((line) => `- ${line}`).join('\n');
      return summary ? `Peer card: ${summary}` : 'No peer conclusions are known yet.';
    }
    return ranked.map((line) => `- ${line}`).join('\n');
  }

  enqueueSessionUpdate(args: {
    workspaceId: string;
    sessionId: string;
    peerId: string;
    peerType?: PeerType;
    observerPeerId?: string | null;
  }): string | null {
    if (!this.queue) return null;
    return this.queue.enqueue({
      workspaceId: args.workspaceId,
      itemType: 'peer_update',
      priority: 'low',
      payload: {
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        peerId: args.peerId,
        peerType: args.peerType ?? 'user',
        observerPeerId: args.observerPeerId ?? null,
      },
    });
  }

  enqueueDreamPass(args: {
    workspaceId: string;
    peerId: string;
    peerType?: PeerType;
    observerPeerId?: string | null;
    phase?: 'deduction' | 'induction' | 'both';
  }): string | null {
    if (!this.queue) return null;
    return this.queue.enqueue({
      workspaceId: args.workspaceId,
      itemType: 'dream_pass',
      priority: 'low',
      payload: {
        workspaceId: args.workspaceId,
        peerId: args.peerId,
        peerType: args.peerType ?? 'user',
        observerPeerId: args.observerPeerId ?? null,
        phase: args.phase ?? 'both',
      },
    });
  }

  async upsertPeerCardFacts(args: {
    workspaceId: string;
    peerId: string;
    peerType?: PeerType;
    facts: PeerCardFact[];
    observerPeerId?: string | null;
    summary?: string | null;
    promoteToGlobal?: boolean;
  }): Promise<{ count: number }> {
    const now = new Date().toISOString();
    const peerType = args.peerType ?? 'user';
    const isDirectional = Boolean(args.observerPeerId && args.observerPeerId !== args.peerId);
    let count = 0;
    let summary = args.summary ?? null;

    if (!isDirectional || args.promoteToGlobal) {
      const global = await this.#ensureGlobalRepresentation(args.workspaceId, peerType, args.peerId, args.summary ?? null);
      const merged = mergePeerFacts(parsePeerCard(global.peerCard), args.facts, now);
      summary = args.summary ?? summarizeFacts(merged) ?? global.summary;
      this.db.update(schema.peerProfiles)
        .set({
          peerCard: merged,
          summary,
          embedding: await this.#embed(args.workspaceId, summary || merged.map((fact) => fact.content).join(' ')),
          updatedAt: now,
        })
        .where(eq(schema.peerProfiles.id, global.id))
        .run();
      count = merged.length;
    }

    if (isDirectional && args.observerPeerId) {
      const directional = await this.#ensureAgentPeerCard(args.workspaceId, args.observerPeerId, args.peerId, peerType, summary);
      const directionalMerged = mergePeerFacts(parsePeerCard(directional.peerCard), args.facts, now);
      const directionalSummary = args.summary ?? summarizeFacts(directionalMerged) ?? directional.summary;
      this.db.update(schema.agentPeerCards)
        .set({
          peerCard: directionalMerged,
          summary: directionalSummary,
          embedding: await this.#embed(args.workspaceId, directionalSummary || directionalMerged.map((fact) => fact.content).join(' ')),
          updatedAt: now,
        })
        .where(eq(schema.agentPeerCards.id, directional.id))
        .run();
      count = directionalMerged.length;
    }
    return { count };
  }

  async upsertFromSession(args: {
    workspaceId: string;
    sessionId: string;
    peerId: string;
    peerType?: PeerType;
    observerPeerId?: string | null;
  }): Promise<{ summary: string; conclusions: number; peerCardFacts: number }> {
    const peerType = args.peerType ?? 'user';
    const observerPeerId = args.observerPeerId ?? null;
    const isDirectional = Boolean(observerPeerId && observerPeerId !== args.peerId);
    const messages = this.#loadSessionMessages(args.workspaceId, args.sessionId);
    const operatorLines = messages.filter((m) => m.role === 'operator' || m.role === 'user').map((m) => m.text);
    const factCandidates = extractPeerFacts(operatorLines);
    const signalLines = factCandidates.map((fact) => `${fact.category}: ${fact.content}`);
    const existing = this.getSummary(args.workspaceId, peerType, args.peerId, isDirectional ? observerPeerId! : 'global');
    const summary = compactSummary(existing, signalLines, operatorLines);
    const now = new Date().toISOString();

    if (isDirectional && observerPeerId) {
      const directional = await this.#ensureAgentPeerCard(args.workspaceId, observerPeerId, args.peerId, peerType, summary);
      this.db.update(schema.agentPeerCards)
        .set({ summary, embedding: await this.#embed(args.workspaceId, summary), updatedAt: now })
        .where(eq(schema.agentPeerCards.id, directional.id))
        .run();
    } else {
      const global = await this.#ensureGlobalRepresentation(args.workspaceId, peerType, args.peerId, summary);
      this.db.update(schema.peerProfiles)
        .set({ summary, embedding: await this.#embed(args.workspaceId, summary), updatedAt: now })
        .where(eq(schema.peerProfiles.id, global.id))
        .run();
    }

    let inserted = 0;
    for (const fact of factCandidates.slice(0, 12)) {
      if (this.#conclusionExists(args.workspaceId, args.peerId, fact.content, observerPeerId)) continue;
      this.db.insert(schema.peerProfileConclusions).values({
        id: randomUUID(),
        workspaceId: args.workspaceId,
        subjectPeerId: args.peerId,
        observerPeerId: observerPeerId ?? args.peerId,
        content: fact.content,
        sourceSessionId: args.sessionId,
        confidence: fact.confidence,
        conclusionType: 'deductive',
        volatilityClass: fact.volatility,
        supportingSessionCount: 1,
        supersededById: null,
        status: 'active',
        embedding: await this.#embed(args.workspaceId, fact.content),
        createdAt: now,
        updatedAt: now,
      }).run();
      inserted += 1;
    }

    const cardFacts = factCandidates.filter((fact) => fact.confidence >= 0.68);
    const peerCard = await this.upsertPeerCardFacts({
      workspaceId: args.workspaceId,
      peerId: args.peerId,
      peerType,
      observerPeerId,
      facts: cardFacts,
      summary,
    });

    if (this.#dreamDue(args.workspaceId, args.peerId, inserted, observerPeerId)) {
      this.enqueueDreamPass({
        workspaceId: args.workspaceId,
        peerId: args.peerId,
        peerType,
        observerPeerId,
        phase: 'both',
      });
    }

    this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BRAIN_PEER_UPDATED, {
      workspaceId: args.workspaceId,
      peerId: args.peerId,
      peerType,
      summary,
      conclusions: inserted,
      peerCardFacts: peerCard.count,
    });
    this.logger.info('peer_profile.updated', {
      workspaceId: args.workspaceId,
      peerId: args.peerId,
      sessionId: args.sessionId,
      conclusions: inserted,
      peerCardFacts: peerCard.count,
    });
    return { summary, conclusions: inserted, peerCardFacts: peerCard.count };
  }

  async markDreamed(workspaceId: string, peerType: PeerType, peerId: string, at = new Date().toISOString(), observerPeerId?: string | null): Promise<void> {
    if (observerPeerId && observerPeerId !== peerId) {
      const row = await this.#ensureAgentPeerCard(workspaceId, observerPeerId, peerId, peerType, null);
      this.db.update(schema.agentPeerCards)
        .set({ lastDreamAt: at, updatedAt: at })
        .where(eq(schema.agentPeerCards.id, row.id))
        .run();
      return;
    }
    const row = await this.#ensureGlobalRepresentation(workspaceId, peerType, peerId, null);
    this.db.update(schema.peerProfiles)
      .set({ lastDreamAt: at, updatedAt: at })
      .where(eq(schema.peerProfiles.id, row.id))
      .run();
  }

  invalidateEmbeddingProvider(workspaceId: string): void {
    this.#embeddingProviders.delete(workspaceId);
  }

  #dreamDue(workspaceId: string, peerId: string, inserted: number, observerPeerId?: string | null): boolean {
    if (!this.queue || inserted === 0) return false;
    const row = observerPeerId && observerPeerId !== peerId
      ? this.#getAgentPeerCard(workspaceId, observerPeerId, peerId)
      : this.db.select().from(schema.peerProfiles)
        .where(and(eq(schema.peerProfiles.workspaceId, workspaceId), eq(schema.peerProfiles.peerId, peerId)))
        .get();
    const lastDreamAt = row?.lastDreamAt ? Date.parse(row.lastDreamAt) : 0;
    if (!lastDreamAt || Date.now() - lastDreamAt > 8 * 60 * 60 * 1000) return true;
    const observerScope = observerPeerId && observerPeerId !== peerId ? observerPeerId : 'global';
    const active = this.getConclusions(workspaceId, peerId, { observerScope, includeSuperseded: false, limit: 100 }).length;
    return active >= 30;
  }

  #conclusionExists(workspaceId: string, peerId: string, content: string, observerPeerId?: string | null): boolean {
    const observerScope = observerPeerId && observerPeerId !== peerId ? observerPeerId : 'global';
    const rows = this.getConclusions(workspaceId, peerId, { observerScope, includeSuperseded: true, limit: 100 });
    const key = normalize(content);
    return rows.some((row) => normalize(row.content) === key);
  }

  #getGlobalRepresentation(workspaceId: string, peerType: PeerType, peerId: string) {
    return this.db.select().from(schema.peerProfiles)
      .where(and(
        eq(schema.peerProfiles.workspaceId, workspaceId),
        eq(schema.peerProfiles.peerType, peerType),
        eq(schema.peerProfiles.peerId, peerId),
      ))
      .get();
  }

  async #ensureGlobalRepresentation(workspaceId: string, peerType: PeerType, peerId: string, summary: string | null) {
    const found = this.#getGlobalRepresentation(workspaceId, peerType, peerId);
    if (found) return found;
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      workspaceId,
      peerType,
      peerId,
      summary: summary ?? '',
      peerCard: [] as PeerCardFact[],
      lastDreamAt: null,
      embedding: await this.#embed(workspaceId, summary ?? ''),
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.peerProfiles).values(row).run();
    return row;
  }

  #getAgentPeerCard(workspaceId: string, observerPeerId: string, subjectPeerId: string) {
    return this.db.select().from(schema.agentPeerCards)
      .where(and(
        eq(schema.agentPeerCards.workspaceId, workspaceId),
        eq(schema.agentPeerCards.observerPeerId, observerPeerId),
        eq(schema.agentPeerCards.subjectPeerId, subjectPeerId),
      ))
      .get();
  }

  async #ensureAgentPeerCard(workspaceId: string, observerPeerId: string, subjectPeerId: string, subjectPeerType: PeerType, summary: string | null) {
    const found = this.#getAgentPeerCard(workspaceId, observerPeerId, subjectPeerId);
    if (found) return found;
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      workspaceId,
      observerPeerId,
      subjectPeerId,
      subjectPeerType,
      summary: summary ?? '',
      peerCard: [] as PeerCardFact[],
      embedding: await this.#embed(workspaceId, summary ?? ''),
      lastDreamAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.agentPeerCards).values(row).run();
    return row;
  }

  #loadSessionMessages(workspaceId: string, sessionId: string): Array<{ role: string; text: string }> {
    return this.db.select().from(schema.conversationMessages)
      .where(and(
        eq(schema.conversationMessages.workspaceId, workspaceId),
        or(eq(schema.conversationMessages.conversationId, sessionId), eq(schema.conversationMessages.sessionMessageId, sessionId))!,
      ))
      .orderBy(desc(schema.conversationMessages.createdAt))
      .limit(40)
      .all()
      .reverse()
      .map((row) => ({ role: row.authorType, text: row.body }))
      .filter((row) => row.text.length > 0);
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
    const provider = selectEmbeddingProvider(row?.type ?? 'local', parseRecord(row?.config));
    this.#embeddingProviders.set(workspaceId, provider);
    return provider;
  }

  async #embed(workspaceId: string, text: string): Promise<number[] | null> {
    if (!text.trim()) return null;
    try {
      return await embedText(this.#resolveEmbeddingProvider(workspaceId), text);
    } catch (err) {
      this.logger.warn('peer_profile.embed_failed', { workspaceId, message: (err as Error).message });
      return null;
    }
  }
}

function rowToConclusion(row: typeof schema.peerProfileConclusions.$inferSelect): PeerConclusion {
  return {
    id: row.id,
    subjectPeerId: row.subjectPeerId,
    observerPeerId: row.observerPeerId,
    content: row.content,
    confidence: row.confidence,
    sourceSessionId: row.sourceSessionId,
    conclusionType: normalizeConclusionType(row.conclusionType),
    volatilityClass: normalizeVolatility(row.volatilityClass),
    supportingSessionCount: row.supportingSessionCount,
    supersededById: row.supersededById,
    status: row.status,
    createdAt: row.createdAt,
  };
}

function extractPeerFacts(lines: string[]): PeerCardFact[] {
  const now = new Date().toISOString();
  const out: PeerCardFact[] = [];
  for (const line of lines) {
    const trimmed = line.trim().replace(/\s+/g, ' ');
    if (trimmed.length < 8) continue;
    const category = classifyCategory(trimmed);
    if (!category) continue;
    out.push({
      category,
      content: normalizeFactContent(trimmed, category),
      confidence: category === 'INSTRUCTION' || category === 'IDENTITY' ? 0.82 : 0.72,
      volatility: defaultVolatility(category, trimmed),
      source: 'session_observed',
      createdAt: now,
      lastVerifiedAt: now,
    });
  }
  return uniqueFacts(out).slice(0, 16);
}

function classifyCategory(line: string): PeerCardCategory | null {
  if (/\b(always|never|must|do not|don't|please|remember to|make sure)\b/i.test(line)) return 'INSTRUCTION';
  if (/\b(i|we)\s+(prefer|like|hate|want|need|avoid|use)\b/i.test(line) || /\bpreference\b/i.test(line)) return 'PREFERENCE';
  if (/\b(i am|i'm|my role|our team|my company|our company|title is|head of|founder|operator)\b/i.test(line)) return 'IDENTITY';
  if (/\b(currently|right now|this week|this month|campaign|project|launch|deadline|q[1-4])\b/i.test(line)) return 'CONTEXT';
  if (/\b(i think|i believe|we think|we believe|assume|doesn't support|does not support|supports|can't|cannot)\b/i.test(line)) return 'BELIEF';
  if (/\b(tend|usually|often|keeps|style|workflow|process)\b/i.test(line)) return 'TRAIT';
  return null;
}

function normalizeFactContent(line: string, category: PeerCardCategory): string {
  const cleaned = line
    .replace(/^Operator (signal|context):\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (category === 'INSTRUCTION') return cleaned.replace(/^please\s+/i, '').slice(0, 120);
  return cleaned.slice(0, 120);
}

function defaultVolatility(category: PeerCardCategory, content: string): VolatilityClass {
  if (category === 'INSTRUCTION' || category === 'PREFERENCE') return 'stable';
  if (category === 'TRAIT') return 'contextual';
  if (category === 'IDENTITY') return 'variable';
  if (category === 'BELIEF' || category === 'CONTEXT') return 'volatile';
  return /\b(today|this week|currently|right now)\b/i.test(content) ? 'volatile' : 'contextual';
}

function mergePeerFacts(existing: PeerCardFact[], incoming: PeerCardFact[], now: string): PeerCardFact[] {
  const byKey = new Map<string, PeerCardFact>();
  for (const fact of [...existing, ...incoming]) {
    const normalized = normalizePeerFact(fact, now);
    const key = `${normalized.category}:${normalize(normalized.content)}`;
    const current = byKey.get(key);
    if (!current || normalized.confidence >= current.confidence) {
      byKey.set(key, {
        ...normalized,
        createdAt: current?.createdAt ?? normalized.createdAt,
        lastVerifiedAt: now,
      });
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, PEER_CARD_CAP)
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || b.confidence - a.confidence);
}

function normalizePeerFact(fact: PeerCardFact, now: string): PeerCardFact {
  return {
    category: normalizeCategory(fact.category),
    content: String(fact.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    confidence: clamp01(Number(fact.confidence ?? 0.6)),
    volatility: normalizeVolatility(fact.volatility),
    source: normalizeSource(fact.source),
    createdAt: fact.createdAt || now,
    lastVerifiedAt: fact.lastVerifiedAt || now,
  };
}

function parsePeerCard(raw: unknown): PeerCardFact[] {
  if (!raw) return [];
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!Array.isArray(value)) return [];
  const now = new Date().toISOString();
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => normalizePeerFact(item as PeerCardFact, now))
    .filter((fact) => fact.content.length > 0);
}

function uniqueFacts(values: PeerCardFact[]): PeerCardFact[] {
  const seen = new Set<string>();
  const out: PeerCardFact[] = [];
  for (const value of values) {
    const key = `${value.category}:${normalize(value.content)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function summarizeFacts(facts: PeerCardFact[]): string | null {
  const top = facts
    .filter((fact) => fact.category !== 'INSTRUCTION')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .map((fact) => fact.content);
  return top.length > 0 ? top.join(' ').slice(0, 400) : null;
}

function compactSummary(existing: string | null, signals: string[], lines: string[]): string {
  const parts = [
    existing ?? '',
    ...signals.slice(0, 4).map((line) => line.replace(/^(INSTRUCTION|PREFERENCE|TRAIT|IDENTITY|CONTEXT|BELIEF):\s*/i, '')),
  ].filter(Boolean);
  if (parts.length === 0 && lines.length > 0) {
    parts.push(`Recent operator focus: ${lines.at(-1)?.slice(0, 220) ?? 'active Agentis work'}`);
  }
  return unique(parts).join(' ').slice(0, 400);
}

function parseRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  const parsed = safeJson(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function renderConclusion(conclusion: PeerConclusion): string {
  const uncertainty = conclusion.conclusionType === 'abductive' ? 'likely: ' : '';
  const support = conclusion.conclusionType === 'inductive' ? ` (${conclusion.supportingSessionCount} sessions)` : '';
  return `${uncertainty}${conclusion.content}${support}`;
}

function normalizeCategory(value: unknown): PeerCardCategory {
  return value === 'INSTRUCTION' || value === 'PREFERENCE' || value === 'TRAIT' || value === 'IDENTITY' || value === 'CONTEXT' || value === 'BELIEF'
    ? value
    : 'CONTEXT';
}

function normalizeVolatility(value: unknown): VolatilityClass {
  return value === 'stable' || value === 'contextual' || value === 'variable' || value === 'volatile'
    ? value
    : 'contextual';
}

function normalizeConclusionType(value: unknown): ConclusionType {
  return value === 'deductive' || value === 'inductive' || value === 'abductive' ? value : 'deductive';
}

function categoryRank(category: PeerCardCategory): number {
  return ['INSTRUCTION', 'PREFERENCE', 'IDENTITY', 'CONTEXT', 'TRAIT', 'BELIEF'].indexOf(category);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = normalize(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalize(value: string): string {
  return normalizeTextKey(value);
}

function normalizeSource(value: unknown): PeerFactSource {
  return value === 'operator_confirmed' || value === 'system' || value === 'dream_inferred' || value === 'session_observed'
    ? value
    : 'session_observed';
}

function score(tokens: Set<string>, text: string): number {
  return scoreText(tokens, text);
}

function isTrustedInstruction(fact: PeerCardFact): boolean {
  return fact.source === 'operator_confirmed' || fact.source === 'system';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
