/**
 * SpecialistMindService — Phase 2 (SPECIALISTS-10X).
 *
 * A specialist's MIND: curated, multimodal source material distilled into
 * retrievable atoms (facts, preferences, rules, visual patterns) that the engine
 * injects at dispatch. Reuses the workspace embedding provider for relevance and
 * the optional VisionService for design-DNA extraction from images — so a
 * "frontend architect" can be fed screenshots and later reason over their layout,
 * palette, typography, and component motifs.
 *
 * Ingestion never blocks dispatch: with no embedding provider, atoms are stored
 * and retrieved by recency; with no vision model, images are stored unextracted.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { normalizeRole } from '@agentis/core';
import type { Logger } from '../../logger.js';
import type { EmbeddingProvider } from '../embedding/embeddingProvider.js';
import { cosineSimilarity, embedText } from '../embedding/embeddingProvider.js';
import type { VisionService } from '../visionService.js';

export type MindSourceKind = 'text' | 'url' | 'file' | 'image' | 'audio' | 'video' | 'run' | 'brain_atom' | 'ability';
export type MindAtomType = 'fact' | 'preference' | 'rule' | 'visual_pattern' | 'anti_pattern' | 'example' | 'decision';

export interface MindSource {
  id: string; kind: MindSourceKind; title: string | null; uri: string | null;
  trust: string; status: string; rawExcerpt: string | null; createdAt: string;
}
export interface MindAtom {
  id: string; sourceId: string | null; atomType: MindAtomType; content: string;
  confidence: number; tags: string[]; createdAt: string;
}
export interface MindMedia {
  id: string; sourceId: string | null; mimeType: string | null; caption: string | null;
  palette: string[]; layoutNotes: string | null; tags: string[]; createdAt: string;
}
export interface MindView {
  role: string; summary: string | null; status: string;
  sources: MindSource[]; atoms: MindAtom[]; media: MindMedia[];
}

export interface AddTextSourceInput {
  kind?: 'text' | 'url' | 'file' | 'run' | 'brain_atom' | 'ability';
  title?: string;
  uri?: string;
  content: string;
  trust?: string;
}
export interface AddImageSourceInput {
  title?: string;
  bytes: Buffer;
  mimeType: string;
  caption?: string;
  trust?: string;
}

export interface SpecialistMindDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  /** Resolve the workspace embedding provider. Optional — falls back to recency. */
  embeddings?: (workspaceId: string) => EmbeddingProvider;
  /** Optional vision model for design-DNA extraction from images. */
  vision?: VisionService | (() => VisionService | undefined);
}

const DESIGN_PROMPT =
  'You are extracting the design DNA of this reference image for a frontend specialist who cannot see it. ' +
  'Describe, in compact bullet points: overall layout/structure, color palette (list concrete hex codes if inferable), ' +
  'typography (families/weights/scale), spacing density, notable component motifs, and any anti-patterns to avoid.';

const HEX_RE = /#[0-9a-fA-F]{6}\b/g;
const MAX_ATOMS_PER_SOURCE = 8;

export class SpecialistMindService {
  constructor(private readonly deps: SpecialistMindDeps) {}

  ensureMind(workspaceId: string, role: string): string {
    const r = normalizeRole(role);
    const existing = this.deps.db.select({ id: schema.specialistMinds.id }).from(schema.specialistMinds)
      .where(and(eq(schema.specialistMinds.workspaceId, workspaceId), eq(schema.specialistMinds.role, r))).get();
    if (existing) return existing.id;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.deps.db.insert(schema.specialistMinds).values({ id, workspaceId, role: r, status: 'ready', createdAt: now, updatedAt: now }).run();
    return id;
  }

  getMind(workspaceId: string, role: string): MindView | null {
    const r = normalizeRole(role);
    const mind = this.deps.db.select().from(schema.specialistMinds)
      .where(and(eq(schema.specialistMinds.workspaceId, workspaceId), eq(schema.specialistMinds.role, r))).get();
    if (!mind) return null;
    const sources = this.deps.db.select().from(schema.specialistMindSources)
      .where(eq(schema.specialistMindSources.mindId, mind.id)).orderBy(desc(schema.specialistMindSources.createdAt)).all();
    const atoms = this.deps.db.select().from(schema.specialistMindAtoms)
      .where(eq(schema.specialistMindAtoms.mindId, mind.id)).orderBy(desc(schema.specialistMindAtoms.createdAt)).all();
    const media = this.deps.db.select().from(schema.specialistMindMedia)
      .where(eq(schema.specialistMindMedia.mindId, mind.id)).orderBy(desc(schema.specialistMindMedia.createdAt)).all();
    return {
      role: r,
      summary: mind.summary,
      status: mind.status,
      sources: sources.map((s) => ({ id: s.id, kind: s.kind as MindSourceKind, title: s.title, uri: s.uri, trust: s.trust, status: s.status, rawExcerpt: s.rawExcerpt, createdAt: s.createdAt })),
      atoms: atoms.map(toAtom),
      media: media.map((m) => ({ id: m.id, sourceId: m.sourceId, mimeType: m.mimeType, caption: m.caption, palette: (m.palette as string[]) ?? [], layoutNotes: m.layoutNotes, tags: (m.tags as string[]) ?? [], createdAt: m.createdAt })),
    };
  }

  /** Ingest a text/url/run/brain/ability source: store it + distil into embedded atoms. */
  async addTextSource(workspaceId: string, role: string, input: AddTextSourceInput): Promise<{ sourceId: string; atomCount: number }> {
    const mindId = this.ensureMind(workspaceId, role);
    const kind = input.kind ?? 'text';
    const sourceId = randomUUID();
    const now = new Date().toISOString();
    this.deps.db.insert(schema.specialistMindSources).values({
      id: sourceId, mindId, workspaceId, kind, title: input.title ?? null, uri: input.uri ?? null,
      trust: input.trust ?? 'workspace', status: 'ready', rawExcerpt: input.content.slice(0, 500), createdAt: now,
    }).run();

    const provider = this.deps.embeddings?.(workspaceId);
    const chunks = chunkText(input.content);
    let count = 0;
    for (const chunk of chunks) {
      await this.#insertAtom(workspaceId, mindId, sourceId, 'fact', chunk, 0.75, [kind], provider);
      count += 1;
    }
    this.#touch(mindId);
    return { sourceId, atomCount: count };
  }

  /** Add a single curated atom, used by eval/run promotion and operator edits. */
  async addAtom(
    workspaceId: string,
    role: string,
    input: { content: string; atomType?: MindAtomType; sourceId?: string | null; confidence?: number; tags?: string[] },
  ): Promise<MindAtom> {
    const mindId = this.ensureMind(workspaceId, role);
    const provider = this.deps.embeddings?.(workspaceId);
    const id = randomUUID();
    const now = new Date().toISOString();
    const content = input.content.trim();
    const embedding = provider ? await safeEmbed(provider, content) : null;
    this.deps.db.insert(schema.specialistMindAtoms).values({
      id,
      mindId,
      workspaceId,
      sourceId: input.sourceId ?? null,
      atomType: input.atomType ?? 'decision',
      content,
      embedding,
      confidence: input.confidence ?? 0.8,
      tags: input.tags ?? ['promotion'],
      createdAt: now,
    }).run();
    this.#touch(mindId);
    return toAtom(this.deps.db.select().from(schema.specialistMindAtoms).where(eq(schema.specialistMindAtoms.id, id)).get()!);
  }

  /** Ingest an image: extract design DNA via the vision model, store media + atoms. */
  async addImageSource(workspaceId: string, role: string, input: AddImageSourceInput): Promise<{ sourceId: string; mediaId: string; extracted: boolean }> {
    const mindId = this.ensureMind(workspaceId, role);
    const sourceId = randomUUID();
    const mediaId = randomUUID();
    const now = new Date().toISOString();
    const vision = this.#vision();
    this.deps.db.insert(schema.specialistMindSources).values({
      id: sourceId, mindId, workspaceId, kind: 'image', title: input.title ?? null, uri: null,
      trust: input.trust ?? 'workspace', status: vision?.enabled ? 'extracting' : 'ready', createdAt: now,
    }).run();

    let description: string | null = null;
    try {
      description = (await vision?.describe({ bytes: input.bytes, mimeType: input.mimeType, caption: input.caption, prompt: DESIGN_PROMPT })) ?? null;
    } catch (err) {
      this.deps.logger.warn('specialist.mind.vision_failed', { role, err: (err as Error).message });
    }
    const palette = description ? Array.from(new Set(description.match(HEX_RE) ?? [])).slice(0, 12) : [];
    const provider = this.deps.embeddings?.(workspaceId);
    const embedding = description && provider ? await safeEmbed(provider, description) : null;

    this.deps.db.insert(schema.specialistMindMedia).values({
      id: mediaId, mindId, workspaceId, sourceId, mimeType: input.mimeType, storageRef: null,
      caption: input.caption ?? (description ? firstLine(description) : null), ocrText: null,
      palette, layoutNotes: description, tags: [], embedding, createdAt: now,
    }).run();

    if (description) {
      await this.#insertAtom(workspaceId, mindId, sourceId, 'visual_pattern', description, 0.7, ['design', 'image'], provider);
      if (palette.length > 0) {
        await this.#insertAtom(workspaceId, mindId, sourceId, 'preference', `Preferred palette: ${palette.join(', ')}`, 0.6, ['palette'], provider);
      }
      this.deps.db.update(schema.specialistMindSources).set({ status: 'ready', rawExcerpt: firstLine(description) }).where(eq(schema.specialistMindSources.id, sourceId)).run();
    } else {
      this.deps.db.update(schema.specialistMindSources).set({ status: 'ready', rawExcerpt: input.caption?.slice(0, 500) ?? null }).where(eq(schema.specialistMindSources.id, sourceId)).run();
    }
    this.#touch(mindId);
    return { sourceId, mediaId, extracted: Boolean(description) };
  }

  removeSource(workspaceId: string, sourceId: string): void {
    // Atoms reference the source via SET NULL; remove them explicitly so a deleted
    // source's distillations don't linger in retrieval.
    this.deps.db.delete(schema.specialistMindAtoms).where(eq(schema.specialistMindAtoms.sourceId, sourceId)).run();
    this.deps.db.delete(schema.specialistMindMedia).where(eq(schema.specialistMindMedia.sourceId, sourceId)).run();
    this.deps.db.delete(schema.specialistMindSources).where(and(eq(schema.specialistMindSources.id, sourceId), eq(schema.specialistMindSources.workspaceId, workspaceId))).run();
  }

  /** Recompute the canonical compact specialist-mind summary. */
  async compile(workspaceId: string, role: string): Promise<{ role: string; summary: string; atomCount: number; qualityScore: number; freshnessScore: number; provenanceScore: number }> {
    const r = normalizeRole(role);
    const mindId = this.ensureMind(workspaceId, r);
    const atoms = this.deps.db.select().from(schema.specialistMindAtoms)
      .where(eq(schema.specialistMindAtoms.mindId, mindId))
      .orderBy(desc(schema.specialistMindAtoms.createdAt))
      .all();
    const sources = this.deps.db.select().from(schema.specialistMindSources)
      .where(eq(schema.specialistMindSources.mindId, mindId))
      .all();
    const lines = atoms.slice(0, 12).map((a) => `- ${a.content.slice(0, 220)}`);
    const summary = lines.length > 0
      ? `Specialist mind for ${r}:\n${lines.join('\n')}`
      : `Specialist mind for ${r}: no curated sources yet.`;
    const provider = this.deps.embeddings?.(workspaceId);
    const embedding = provider ? await safeEmbed(provider, summary) : null;
    const readySources = sources.filter((s) => s.status === 'ready').length;
    const qualityScore = clamp(0.35 + Math.min(0.45, atoms.length * 0.04) + Math.min(0.2, readySources * 0.03));
    const freshnessScore = sources.length === 0 ? 0.4 : 1.0;
    const provenanceScore = sources.length === 0 ? 0.3 : clamp(readySources / Math.max(1, sources.length));
    this.deps.db.update(schema.specialistMinds).set({
      summary,
      distilledContext: summary,
      embedding,
      qualityScore,
      freshnessScore,
      provenanceScore,
      status: 'ready',
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.specialistMinds.id, mindId)).run();
    return { role: r, summary, atomCount: atoms.length, qualityScore, freshnessScore, provenanceScore };
  }

  /** Top-K atoms for a task, by cosine when an embedding is available, else recency. */
  async retrieve(workspaceId: string, role: string, task: string, topK = 6): Promise<MindAtom[]> {
    const r = normalizeRole(role);
    const mind = this.deps.db.select({ id: schema.specialistMinds.id }).from(schema.specialistMinds)
      .where(and(eq(schema.specialistMinds.workspaceId, workspaceId), eq(schema.specialistMinds.role, r))).get();
    if (!mind) return [];
    const rows = this.deps.db.select().from(schema.specialistMindAtoms)
      .where(eq(schema.specialistMindAtoms.mindId, mind.id)).orderBy(desc(schema.specialistMindAtoms.createdAt)).all();
    if (rows.length === 0) return [];
    const provider = this.deps.embeddings?.(workspaceId);
    let queryVec: number[] | null = null;
    if (provider && task.trim()) {
      try { queryVec = await embedText(provider, task.slice(0, 4000)); } catch { /* fall back to recency */ }
    }
    if (!queryVec) return rows.slice(0, topK).map(toAtom);
    return rows
      .map((row) => ({ row, score: row.embedding ? cosineSimilarity(queryVec!, row.embedding as number[]) : 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => toAtom(s.row));
  }

  /** Compact XML mind block for engine injection (empty string when no atoms). */
  async contextBlock(workspaceId: string, role: string, task: string, topK = 6): Promise<string> {
    const atoms = await this.retrieve(workspaceId, role, task, topK);
    if (atoms.length === 0) return '';
    const lines = atoms.map((a) => `  <atom type="${a.atomType}" confidence="${a.confidence.toFixed(2)}">${escapeXml(a.content.slice(0, 800))}</atom>`);
    return `<specialist_mind role="${normalizeRole(role)}">\n${lines.join('\n')}\n</specialist_mind>`;
  }

  async #insertAtom(workspaceId: string, mindId: string, sourceId: string | null, atomType: MindAtomType, content: string, confidence: number, tags: string[], provider?: EmbeddingProvider): Promise<void> {
    const embedding = provider ? await safeEmbed(provider, content) : null;
    this.deps.db.insert(schema.specialistMindAtoms).values({
      id: randomUUID(), mindId, workspaceId, sourceId, atomType, content, embedding, confidence, tags, createdAt: new Date().toISOString(),
    }).run();
  }

  #touch(mindId: string): void {
    this.deps.db.update(schema.specialistMinds).set({ updatedAt: new Date().toISOString() }).where(eq(schema.specialistMinds.id, mindId)).run();
  }

  #vision(): VisionService | undefined {
    return typeof this.deps.vision === 'function' ? this.deps.vision() : this.deps.vision;
  }
}

function toAtom(row: typeof schema.specialistMindAtoms.$inferSelect): MindAtom {
  return { id: row.id, sourceId: row.sourceId, atomType: row.atomType as MindAtomType, content: row.content, confidence: row.confidence, tags: (row.tags as string[]) ?? [], createdAt: row.createdAt };
}

async function safeEmbed(provider: EmbeddingProvider, text: string): Promise<number[] | null> {
  try { return await embedText(provider, text.slice(0, 4000)); } catch { return null; }
}

/** Split a source into a bounded set of atom-sized chunks (paragraph-aware). */
function chunkText(content: string): string[] {
  const paras = content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (const p of paras) {
    if (p.length <= 600) { chunks.push(p); continue; }
    for (let i = 0; i < p.length; i += 600) chunks.push(p.slice(i, i + 600));
  }
  return (chunks.length > 0 ? chunks : [content.trim()].filter(Boolean)).slice(0, MAX_ATOMS_PER_SOURCE);
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim())?.trim() ?? text).slice(0, 200);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}
