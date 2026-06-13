import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { AgentisError, type BrainGraph } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { cosineSimilarity, embedText, type EmbeddingProvider } from './embeddingProvider.js';

export interface PersonalNoteInput {
  title?: string | null;
  content: string;
  noteType?: string;
  tags?: string[];
  pinned?: boolean;
}

export class PersonalBrainService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  list(userId: string) {
    return this.db.select().from(schema.userNotes)
      .where(eq(schema.userNotes.userId, userId))
      .orderBy(desc(schema.userNotes.updatedAt))
      .all();
  }

  async create(userId: string, input: PersonalNoteInput) {
    const now = new Date().toISOString();
    const embedding = await embedText(this.embeddings, `${input.title ?? ''}\n${input.content}`);
    const row = {
      id: randomUUID(),
      userId,
      title: input.title?.trim() || null,
      content: input.content.trim(),
      noteType: input.noteType ?? 'note',
      embedding,
      tags: input.tags ?? [],
      source: 'user_typed',
      agentId: null,
      pinned: input.pinned ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.userNotes).values(row).run();
    return row;
  }

  async update(userId: string, id: string, input: Partial<PersonalNoteInput>) {
    const existing = this.db.select().from(schema.userNotes)
      .where(and(eq(schema.userNotes.id, id), eq(schema.userNotes.userId, userId)))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', 'Personal note not found');
    const title = input.title === undefined ? existing.title : input.title?.trim() || null;
    const content = input.content?.trim() ?? existing.content;
    const embedding = await embedText(this.embeddings, `${title ?? ''}\n${content}`);
    const patch = {
      title,
      content,
      embedding,
      noteType: input.noteType ?? existing.noteType,
      tags: input.tags ?? parseTags(existing.tags),
      pinned: input.pinned ?? existing.pinned,
      updatedAt: new Date().toISOString(),
    };
    this.db.update(schema.userNotes).set(patch)
      .where(and(eq(schema.userNotes.id, id), eq(schema.userNotes.userId, userId)))
      .run();
    return { ...existing, ...patch };
  }

  remove(userId: string, id: string): boolean {
    return this.db.delete(schema.userNotes)
      .where(and(eq(schema.userNotes.id, id), eq(schema.userNotes.userId, userId)))
      .run().changes > 0;
  }

  async search(userId: string, query: string, limit = 8) {
    const vector = await embedText(this.embeddings, query);
    return this.list(userId)
      .map((note) => ({ note, score: cosineSimilarity(vector, parseEmbedding(note.embedding)) }))
      .filter((entry) => entry.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(limit, 30)))
      .map(({ note, score }) => ({ ...note, score }));
  }

  grants(userId: string) {
    return this.db.select({
      id: schema.personalBrainGrants.id,
      agentId: schema.personalBrainGrants.agentId,
      accessLevel: schema.personalBrainGrants.accessLevel,
      createdAt: schema.personalBrainGrants.createdAt,
      agentName: schema.agents.name,
    }).from(schema.personalBrainGrants)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.personalBrainGrants.agentId))
      .where(eq(schema.personalBrainGrants.userId, userId))
      .all();
  }

  grant(userId: string, agentId: string, accessLevel = 'read') {
    const agent = this.db.select({ id: schema.agents.id }).from(schema.agents)
      .where(and(eq(schema.agents.id, agentId), eq(schema.agents.userId, userId)))
      .get();
    if (!agent) throw new AgentisError('RESOURCE_NOT_FOUND', 'Agent not found');
    const existing = this.db.select().from(schema.personalBrainGrants)
      .where(and(eq(schema.personalBrainGrants.userId, userId), eq(schema.personalBrainGrants.agentId, agentId)))
      .get();
    if (existing) {
      this.db.update(schema.personalBrainGrants).set({ accessLevel }).where(eq(schema.personalBrainGrants.id, existing.id)).run();
      return { ...existing, accessLevel };
    }
    const row = { id: randomUUID(), userId, agentId, accessLevel, createdAt: new Date().toISOString() };
    this.db.insert(schema.personalBrainGrants).values(row).run();
    return row;
  }

  revoke(userId: string, agentId: string): boolean {
    return this.db.delete(schema.personalBrainGrants)
      .where(and(eq(schema.personalBrainGrants.userId, userId), eq(schema.personalBrainGrants.agentId, agentId)))
      .run().changes > 0;
  }

  async contextForAgent(userId: string, agentId: string, query: string): Promise<string> {
    const granted = this.db.select({ id: schema.personalBrainGrants.id }).from(schema.personalBrainGrants)
      .where(and(eq(schema.personalBrainGrants.userId, userId), eq(schema.personalBrainGrants.agentId, agentId)))
      .get();
    if (!granted) return '';
    const notes = await this.search(userId, query || 'important preferences', 5);
    if (!notes.length) return '';
    return `<personal_brain>\n${notes.map((note) => `- ${note.content.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}\n</personal_brain>`;
  }

  graph(userId: string): BrainGraph {
    const notes = this.list(userId);
    const now = new Date().toISOString();
    const nodes: BrainGraph['nodes'] = [];
    const links: BrainGraph['links'] = [];

    // 1. Add center core node
    nodes.push({
      id: 'core',
      atomId: 'core',
      atomKind: 'core',
      label: 'Personal brain',
      summary: 'Private notes and preferences, visible only to you by default.',
      confidence: 1,
      trust: 1,
      reinforceCount: 1,
      createdAt: now,
      updatedAt: now,
      metadata: { scope: 'personal' },
    });

    // 2. Identify all folders and add folder nodes
    const foldersSet = new Set<string>();
    for (const note of notes) {
      const parsedTags = safeParseTags(note.tags);
      const folderPath = parsedTags[0] || 'Uncategorized';
      
      const parts = folderPath.split('/');
      let currentPath = '';
      for (const part of parts) {
        if (!part.trim()) continue;
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        foldersSet.add(currentPath);
      }
    }

    // Generate folder nodes and link them to their parent folders or core
    for (const folderPath of foldersSet) {
      const parts = folderPath.split('/');
      const name = parts[parts.length - 1] || folderPath;
      nodes.push({
        id: `folder:${folderPath}`,
        atomId: `folder:${folderPath}`,
        atomKind: 'memory' as const,
        label: name,
        summary: `Folder: ${folderPath}`,
        confidence: 0.9,
        trust: 1,
        reinforceCount: 1,
        createdAt: now,
        updatedAt: now,
        metadata: { tags: [folderPath], privateScope: 'personal', folder: true },
      });

      const parentPath = parts.slice(0, -1).join('/');
      if (parentPath) {
        links.push({
          id: `personal-folder-link:${parentPath}:${folderPath}`,
          source: `folder:${parentPath}`,
          target: `folder:${folderPath}`,
          sourceAtomId: `folder:${parentPath}`,
          sourceKind: 'memory',
          targetAtomId: `folder:${folderPath}`,
          targetKind: 'memory',
          relation: 'supports',
          confidence: 0.85,
          reinforceCount: 1,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        links.push({
          id: `personal-folder-core:${folderPath}`,
          source: `folder:${folderPath}`,
          target: 'core',
          sourceAtomId: `folder:${folderPath}`,
          sourceKind: 'memory',
          targetAtomId: 'core',
          targetKind: 'memory',
          relation: 'derived_from',
          confidence: 0.85,
          reinforceCount: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // 3. Add note nodes and link them to their immediate parent folder node
    for (const note of notes) {
      const parsedTags = safeParseTags(note.tags);
      const folderPath = parsedTags[0] || 'Uncategorized';

      nodes.push({
        id: `memory:${note.id}`,
        atomId: note.id,
        atomKind: 'memory' as const,
        label: note.title || 'Untitled note',
        summary: note.content.slice(0, 180),
        confidence: note.pinned ? 0.95 : 0.82,
        trust: 1,
        reinforceCount: 1,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        metadata: { 
          tags: [folderPath, ...parsedTags.slice(1)], 
          noteType: note.noteType, 
          pinned: note.pinned, 
          privateScope: 'personal' 
        },
      });

      links.push({
        id: `personal-note-folder:${note.id}:${folderPath}`,
        source: `memory:${note.id}`,
        target: `folder:${folderPath}`,
        sourceAtomId: note.id,
        sourceKind: 'memory',
        targetAtomId: `folder:${folderPath}`,
        targetKind: 'memory',
        relation: 'derived_from',
        confidence: note.pinned ? 0.92 : 0.76,
        reinforceCount: 1,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      });
    }

    // 4. Add semantic similarity links, but ONLY if they are highly related (cosineSimilarity >= 0.45)
    for (let index = 0; index < notes.length; index += 1) {
      for (let other = index + 1; other < notes.length; other += 1) {
        const score = cosineSimilarity(parseEmbedding(notes[index]!.embedding), parseEmbedding(notes[other]!.embedding));
        if (score < 0.45) continue;
        links.push({
          id: `personal-related:${notes[index]!.id}:${notes[other]!.id}`,
          source: `memory:${notes[index]!.id}`,
          target: `memory:${notes[other]!.id}`,
          sourceAtomId: notes[index]!.id,
          sourceKind: 'memory',
          targetAtomId: notes[other]!.id,
          targetKind: 'memory',
          relation: 'co_observed',
          confidence: Math.min(0.9, score),
          reinforceCount: 1,
          createdAt: notes[index]!.createdAt,
          updatedAt: notes[index]!.updatedAt,
        });
      }
    }

    return {
      nodes,
      links,
      meta: {
        workspaceId: `personal:${userId}`,
        scope: 'scoped',
        scopeId: userId,
        // Atoms are the real notes — not the synthetic core/folder nodes the map adds for layout.
        atomCount: notes.length,
        linkCount: links.length,
        lastActivityAt: notes[0]?.updatedAt ?? null,
        adapterTypes: [],
      },
    };
  }

  detail(userId: string, graphNodeId: string) {
    const graph = this.graph(userId);
    const node = graph.nodes.find((candidate) => candidate.id === graphNodeId || candidate.atomId === graphNodeId);
    if (!node) return null;
    const links = graph.links.filter((link) => link.source === node.id || link.target === node.id);
    const relatedIds = new Set(links.map((link) => link.source === node.id ? link.target : link.source));
    const note = node.atomKind === 'memory'
      ? this.list(userId).find((candidate) => candidate.id === node.atomId) ?? null
      : null;
    return {
      node,
      links,
      relatedNodes: graph.nodes.filter((candidate) => relatedIds.has(candidate.id)),
      content: note?.content ?? node.summary ?? '',
      provenance: {
        createdBy: note ? 'You' : 'Agentis',
        createdAt: note?.createdAt ?? node.createdAt,
        updatedAt: note?.updatedAt ?? node.updatedAt,
        source: note ? 'Personal note' : 'Personal Brain',
        reinforced: node.reinforceCount,
      },
      usedBy: [],
    };
  }
}

function parseEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) return value.filter((item): item is number => typeof item === 'number');
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === 'number') : [];
  } catch {
    return [];
  }
}

function safeParseTags(tags: unknown): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) {
    return tags.map(t => String(t).trim());
  }
  if (typeof tags === 'string') {
    const trimmed = tags.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map(t => String(t).trim());
        }
      } catch (e) {
        // Fallback
      }
    }
    if (trimmed.includes(',')) {
      return trimmed.split(',').map(t => t.trim()).filter(Boolean);
    }
    return [trimmed];
  }
  return [];
}

function parseTags(value: unknown): string[] {
  return safeParseTags(value);
}
