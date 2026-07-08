import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { KnowledgeLinkRelation } from '@agentis/core';
import type { Logger } from '../../logger.js';
import { EvaluatorRuntime } from '../evaluatorRuntime.js';
import type { SharedIntelligenceService } from '../sharedIntelligence.js';
import { embedText, type EmbeddingProvider } from '../embedding/embeddingProvider.js';
import { KnowledgeStore } from '../knowledge/knowledgeStore.js';

export interface ChunkEnrichment {
  summary: string;
  contextPrefix: string;
  keyFacts: string[];
  entities: string[];
  importanceScore?: number;
  model?: string;
}

export interface BrainEnrichmentProvider {
  enrichChunk(args: { workspaceId: string; documentName: string; mimeType: string; chunkIndex: number; chunkCount: number; content: string }): Promise<ChunkEnrichment | null>;
  expandGroundedQuery(args: { workspaceId: string; query: string; snippets: string[] }): Promise<string[]>;
  classifyRelation(args: { workspaceId: string; source: string; target: string }): Promise<KnowledgeLinkRelation | null>;
  describeImage?(args: { workspaceId: string; bytes: Buffer; mimeType: string; fileName: string }): Promise<string>;
  transcribeAudio?(args: { workspaceId: string; bytes: Buffer; mimeType: string; fileName: string }): Promise<string>;
}

interface OpenAiMediaOptions {
  baseUrl: string;
  apiKey?: string;
  visionModel?: string;
  transcriptionModel?: string;
  fetchImpl?: typeof fetch;
}

export class ModelBrainEnrichmentProvider implements BrainEnrichmentProvider {
  readonly #fetch: typeof fetch;

  constructor(
    private readonly runtime: Pick<EvaluatorRuntime, 'completeStructured'>,
    private readonly media: OpenAiMediaOptions | null = null,
    private readonly modelLabel = 'configured-auxiliary-model',
  ) {
    this.#fetch = media?.fetchImpl ?? fetch;
  }

  async enrichChunk(args: { documentName: string; mimeType: string; chunkIndex: number; chunkCount: number; content: string }): Promise<ChunkEnrichment | null> {
    const output = await this.runtime.completeStructured<Record<string, unknown>>({
      system: 'You enrich retrieved knowledge. Stay grounded only in the supplied chunk. Return JSON with summary, contextPrefix, keyFacts, entities, and importanceScore. Never infer facts absent from the text.',
      user: [
        `DOCUMENT: ${args.documentName} (${args.mimeType}), chunk ${args.chunkIndex + 1} of ${args.chunkCount}`,
        'CHUNK:',
        args.content.slice(0, 7000),
        'JSON SCHEMA: {"summary":"<=240 chars","contextPrefix":"one grounded retrieval sentence","keyFacts":["<=5 short factual claims"],"entities":["named concepts only"],"importanceScore":0.0}',
      ].join('\n'),
      maxTokens: 700,
      maxAttempts: 2,
    });
    if (!output) return null;
    const summary = stringValue(output.summary, 400);
    const contextPrefix = stringValue(output.contextPrefix, 500);
    if (!summary || !contextPrefix) return null;
    return {
      summary,
      contextPrefix,
      keyFacts: stringList(output.keyFacts, 5, 240),
      entities: stringList(output.entities, 12, 100),
      importanceScore: number01(output.importanceScore),
      model: this.modelLabel,
    };
  }

  async expandGroundedQuery(args: { query: string; snippets: string[] }): Promise<string[]> {
    if (args.snippets.length === 0) return [];
    const output = await this.runtime.completeStructured<Record<string, unknown>>({
      system: 'Generate retrieval queries for broad exploration. Use only vocabulary and facets supported by the retrieved snippets. Return distinct short queries, not hypothetical answers.',
      user: [
        `ORIGINAL QUERY: ${args.query}`,
        'INITIAL RETRIEVAL SNIPPETS:',
        ...args.snippets.map((snippet, index) => `[${index + 1}] ${snippet.slice(0, 500)}`),
        'JSON SCHEMA: {"queries":["3 to 5 distinct grounded search queries"]}',
      ].join('\n'),
      maxTokens: 350,
      maxAttempts: 2,
    });
    return output ? stringList(output.queries, 5, 240).filter((query) => query !== args.query) : [];
  }

  async classifyRelation(args: { source: string; target: string }): Promise<KnowledgeLinkRelation | null> {
    const output = await this.runtime.completeStructured<Record<string, unknown>>({
      system: 'Classify the relation between two grounded knowledge excerpts. Do not claim contradiction without explicit conflict. Return JSON only.',
      user: [
        `SOURCE:\n${args.source.slice(0, 1500)}`,
        `TARGET:\n${args.target.slice(0, 1500)}`,
        'Allowed relation: supports, contradicts, refines, derived_from, co_observed.',
        'JSON SCHEMA: {"relation":"co_observed","confidence":0.0}',
      ].join('\n\n'),
      maxTokens: 100,
      maxAttempts: 2,
    });
    const relation = output?.relation;
    return relation === 'supports' || relation === 'contradicts' || relation === 'refines'
      || relation === 'derived_from' || relation === 'co_observed'
      ? relation
      : null;
  }

  async describeImage(args: { bytes: Buffer; mimeType: string; fileName: string }): Promise<string> {
    if (!this.media?.visionModel) throw new Error('No vision description model is configured');
    const response = await this.#fetch(`${trimUrl(this.media.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(this.media.apiKey),
      body: JSON.stringify({
        model: this.media.visionModel,
        max_tokens: 450,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image compactly for knowledge retrieval. Include readable labels, notable relationships, and avoid speculation.' },
            { type: 'image_url', image_url: { url: `data:${args.mimeType};base64,${args.bytes.toString('base64')}` } },
          ],
        }],
      }),
    });
    if (!response.ok) throw new Error(`vision provider returned ${response.status}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const description = payload.choices?.[0]?.message?.content?.trim();
    if (!description) throw new Error('vision provider returned no description');
    return `[Visual description: ${args.fileName}]\n${description.slice(0, 1500)}`;
  }

  async transcribeAudio(args: { bytes: Buffer; mimeType: string; fileName: string }): Promise<string> {
    if (!this.media?.transcriptionModel) throw new Error('No transcription model is configured');
    const form = new FormData();
    form.set('model', this.media.transcriptionModel);
    form.set('file', new Blob([new Uint8Array(args.bytes)], { type: args.mimeType }), args.fileName);
    const headers: Record<string, string> = {};
    if (this.media.apiKey) headers.authorization = `Bearer ${this.media.apiKey}`;
    const response = await this.#fetch(`${trimUrl(this.media.baseUrl)}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
    });
    if (!response.ok) throw new Error(`transcription provider returned ${response.status}`);
    const payload = await response.json() as { text?: string };
    const transcript = payload.text?.trim();
    if (!transcript) throw new Error('transcription provider returned no transcript');
    return `[Audio transcript: ${args.fileName}]\n${transcript}`;
  }
}

export interface BrainEnrichmentDefaults {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  visionModel?: string;
  transcriptionModel?: string;
}

/**
 * Resolves generation settings for every workspace request, so operators can
 * enable or tune Brain enrichment in the UI without restarting the server.
 */
export class ConfiguredBrainEnrichmentProvider implements BrainEnrichmentProvider {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
    private readonly defaults: BrainEnrichmentDefaults = {},
  ) {}

  async enrichChunk(args: { workspaceId: string; documentName: string; mimeType: string; chunkIndex: number; chunkCount: number; content: string }): Promise<ChunkEnrichment | null> {
    return this.provider(args.workspaceId)?.enrichChunk(args) ?? null;
  }

  async expandGroundedQuery(args: { workspaceId: string; query: string; snippets: string[] }): Promise<string[]> {
    return this.provider(args.workspaceId)?.expandGroundedQuery(args) ?? [];
  }

  async classifyRelation(args: { workspaceId: string; source: string; target: string }): Promise<KnowledgeLinkRelation | null> {
    return this.provider(args.workspaceId)?.classifyRelation(args) ?? null;
  }

  async describeImage(args: { workspaceId: string; bytes: Buffer; mimeType: string; fileName: string }): Promise<string> {
    const settings = this.settings(args.workspaceId);
    if (!settings.visualDescriptions) throw new Error('Visual descriptions are disabled in Brain settings');
    const provider = this.provider(args.workspaceId);
    if (!provider) throw new Error('Brain enrichment model is not configured');
    return provider.describeImage(args);
  }

  async transcribeAudio(args: { workspaceId: string; bytes: Buffer; mimeType: string; fileName: string }): Promise<string> {
    const settings = this.settings(args.workspaceId);
    if (!settings.audioTranscription) throw new Error('Audio transcription is disabled in Brain settings');
    const provider = this.provider(args.workspaceId);
    if (!provider) throw new Error('Brain enrichment model is not configured');
    return provider.transcribeAudio(args);
  }

  private provider(workspaceId: string): ModelBrainEnrichmentProvider | null {
    const settings = this.settings(workspaceId);
    if (!settings.enabled || !settings.baseUrl || !settings.model) return null;
    const runtime = new EvaluatorRuntime({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      logger: this.logger,
    });
    return new ModelBrainEnrichmentProvider(runtime, {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      visionModel: settings.visualDescriptions ? settings.visionModel : undefined,
      transcriptionModel: settings.audioTranscription ? settings.transcriptionModel : undefined,
    }, settings.model);
  }

  private settings(workspaceId: string) {
    const row = this.db.select({ brainSettings: schema.workspaces.brainSettings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    const root = recordValue(row?.brainSettings);
    const stored = recordValue(root.enrichmentConfig);
    const enabled = typeof stored.enabled === 'boolean' ? stored.enabled : Boolean(this.defaults.enabled);
    return {
      enabled,
      baseUrl: stringOr(stored.baseUrl, this.defaults.baseUrl),
      apiKey: stringOr(stored.apiKey, this.defaults.apiKey),
      model: stringOr(stored.model, this.defaults.model),
      visualDescriptions: Boolean(stored.visualDescriptions),
      visionModel: stringOr(stored.visionModel, this.defaults.visionModel),
      audioTranscription: Boolean(stored.audioTranscription),
      transcriptionModel: stringOr(stored.transcriptionModel, this.defaults.transcriptionModel),
    };
  }
}

/**
 * Materializes high-signal enrichment as native graph atoms without duplicating
 * raw chunks. Entities are shared across documents; each enriched document
 * receives one compact grounded community summary.
 */
export class EnrichedKnowledgeGraphWriter {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly intelligence: SharedIntelligenceService,
    private readonly logger: Logger,
    private readonly embeddingProvider?: (workspaceId: string) => EmbeddingProvider,
  ) {}

  async writeDocument(args: {
    workspaceId: string;
    documentId: string;
    documentName: string;
    chunkIds: string[];
    enrichments: Array<ChunkEnrichment | null>;
  }): Promise<void> {
    const available = args.enrichments.filter((item): item is ChunkEnrichment => item !== null);
    if (available.length === 0) return;
    try {
      const entityNames = [...new Set(available.flatMap((item) => item.entities).map(normalizeEntity).filter(Boolean))];
      const entityIds = new Map<string, string>();
      for (const entity of entityNames) {
        entityIds.set(entity, await this.upsertConcept(args.workspaceId, `Entity: ${entity}`, `Named concept extracted from indexed knowledge: ${entity}.`, {
          nodeRole: 'entity',
          entity,
        }));
      }
      const facts = [...new Set(available.flatMap((item) => item.keyFacts))].slice(0, 8);
      const summaries = available.map((item) => item.summary).filter(Boolean).slice(0, 4);
      const communityContent = [
        `Grounded source summary for ${args.documentName}.`,
        ...summaries,
        ...(facts.length ? ['Key facts:', ...facts.map((fact) => `- ${fact}`)] : []),
      ].join('\n');
      const communityId = await this.upsertCommunity(args.workspaceId, args.documentId, entityNames, communityContent);
      for (const [index, chunkId] of args.chunkIds.entries()) {
        this.intelligence.createLink({
          workspaceId: args.workspaceId,
          sourceId: chunkId,
          sourceKind: 'kb_chunk',
          targetId: communityId,
          targetKind: 'knowledge_chunk',
          relation: 'derived_from',
          confidence: 0.9,
        });
        for (const rawEntity of args.enrichments[index]?.entities ?? []) {
          const entityId = entityIds.get(normalizeEntity(rawEntity));
          if (!entityId) continue;
          this.intelligence.createLink({
            workspaceId: args.workspaceId,
            sourceId: chunkId,
            sourceKind: 'kb_chunk',
            targetId: entityId,
            targetKind: 'knowledge_chunk',
            relation: 'supports',
            confidence: 0.82,
          });
        }
      }
      for (const entityId of entityIds.values()) {
        this.intelligence.createLink({
          workspaceId: args.workspaceId,
          sourceId: entityId,
          sourceKind: 'knowledge_chunk',
          targetId: communityId,
          targetKind: 'knowledge_chunk',
          relation: 'co_observed',
          confidence: 0.75,
        });
      }
    } catch (error) {
      this.logger.warn('brain.enrichment.graph_write_failed', {
        workspaceId: args.workspaceId,
        documentId: args.documentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async upsertConcept(workspaceId: string, title: string, content: string, provenance: Record<string, unknown>): Promise<string> {
    const existing = this.db.select().from(schema.knowledgeChunks)
      .where(and(eq(schema.knowledgeChunks.workspaceId, workspaceId), eq(schema.knowledgeChunks.title, title)))
      .get();
    const now = new Date().toISOString();
    const embedding = this.embeddingProvider ? await embedText(this.embeddingProvider(workspaceId), `${title}\n${content}`).catch(() => null) : null;
    if (existing) {
      this.db.update(schema.knowledgeChunks).set({
        content,
        contentTokens: KnowledgeStore.tokenize(`${title} ${content}`),
        provenance,
        ...(embedding ? { embedding } : {}),
        updatedAt: now,
      }).where(eq(schema.knowledgeChunks.id, existing.id)).run();
      return existing.id;
    }
    const id = randomUUID();
    this.db.insert(schema.knowledgeChunks).values({
      id,
      workspaceId,
      scopeId: null,
      title,
      content,
      contentTokens: KnowledgeStore.tokenize(`${title} ${content}`),
      source: 'promotion',
      provenance,
      tags: [String(provenance.nodeRole ?? 'enrichment')],
      ...(embedding ? { embedding } : {}),
      trust: '0.82',
      createdAt: now,
      updatedAt: now,
    }).run();
    return id;
  }

  private async upsertCommunity(workspaceId: string, documentId: string, entities: string[], sourceSummary: string): Promise<string> {
    const candidates = this.db.select().from(schema.knowledgeChunks)
      .where(eq(schema.knowledgeChunks.workspaceId, workspaceId))
      .all()
      .map((row) => ({ row, provenance: recordValue(row.provenance) }))
      .filter(({ provenance }) => provenance.nodeRole === 'community_summary');
    const wanted = new Set(entities);
    const matching = candidates
      .map(({ row, provenance }) => ({
        row,
        provenance,
        overlap: stringList(provenance.entities, 50, 100).filter((entity) => wanted.has(entity)).length,
      }))
      .filter((candidate) => candidate.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)[0];
    const title = matching?.row.title ?? `Community: ${entities.slice(0, 3).join(', ') || 'Unclassified knowledge'}`;
    const prior = matching ? `${matching.row.content}\n\n` : '';
    const content = `${prior}${sourceSummary}`.slice(0, 6000);
    const members = [...new Set([
      ...stringList(matching?.provenance.entities, 50, 100),
      ...entities,
    ])];
    return this.upsertConcept(workspaceId, title, content, {
      nodeRole: 'community_summary',
      documentIds: [...new Set([...stringList(matching?.provenance.documentIds, 100, 100), documentId])],
      entities: members,
    });
  }
}

function authHeaders(apiKey?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function stringValue(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim().slice(0, maxLength))
    .slice(0, maxItems);
}

function number01(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : undefined;
}

function normalizeEntity(entity: string): string {
  return entity.replace(/\s+/g, ' ').trim().slice(0, 100);
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringOr(value: unknown, fallback?: string): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
