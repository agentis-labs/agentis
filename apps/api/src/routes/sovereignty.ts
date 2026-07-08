/**
 * /v1/sovereignty — "Your Data": the ownership surface.
 *
 * Agentis is an OSS, local-first platform. The knowledge an operator accrues —
 * memories, distilled lessons, imported harness brains, personal notes — lives
 * in a single SQLite file ON THEIR MACHINE. This route makes that ownership
 * legible and actionable:
 *
 *   GET    /overview        → what you own, where it came from, where it lives
 *   GET    /export          → a complete, open JSON copy of your data (take it)
 *   DELETE /memory/:id      → forget one memory, with a provable receipt
 *
 * Nothing here is a new store. It reports over the canonical Brain tables
 * (`memory_episodes`, `knowledge_chunks`, `user_notes`, `agents`) and deletes
 * through the same {@link EpisodicMemoryStore} the rest of the Brain writes to.
 * The sovereignty story is a productization of what is already true, not a
 * parallel subsystem.
 */

import { Hono } from 'hono';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import { AgentisError } from '@agentis/core';
import type { AuthService } from '../services/auth.js';
import type { EpisodicMemoryStore } from '../services/episodicMemoryStore.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export interface SovereigntyRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  /** Canonical episodic store — the delete path for provable forget. */
  episodes: EpisodicMemoryStore;
  /** Data dir; the local DB lives at `{dataDir}/data.db`. Absent on non-embedded deploys. */
  dataDir?: string | null;
}

/** Human-friendly label for the raw `source` column on a memory episode. */
const SOURCE_LABELS: Record<string, string> = {
  run_promotion: 'From your work',
  agent_write: 'Learned by an agent',
  operator_write: 'You wrote it',
  evaluator_write: 'From evaluation',
  system_write: 'System',
  harness_ingest: 'Imported from a harness',
  chat_capture: 'From your chats',
};

function labelSource(source: string): string {
  return SOURCE_LABELS[source] ?? source.replace(/_/g, ' ');
}

function count(query: { get(): { n: number } | undefined }): number {
  return query.get()?.n ?? 0;
}

/** Total on-disk footprint of the local database (main + WAL + shared-memory). */
function databaseFootprint(dataDir: string | null | undefined): { path: string | null; sizeBytes: number } {
  if (!dataDir) return { path: null, sizeBytes: 0 };
  const path = join(dataDir, 'data.db');
  let sizeBytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      sizeBytes += statSync(`${path}${suffix}`).size;
    } catch {
      /* file may not exist (e.g. no WAL yet) — skip */
    }
  }
  return { path, sizeBytes };
}

export function buildSovereigntyRoutes(deps: SovereigntyRoutesDeps) {
  const app = new Hono();
  const { db } = deps;
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // ── Overview: what you own, where it came from, where it lives ──────────────
  app.get('/overview', (c) => {
    const ws = getWorkspace(c);
    const wsId = ws.workspaceId;
    const userId = ws.user.id;

    const activeEpisodes = and(eq(schema.memoryEpisodes.workspaceId, wsId), isNull(schema.memoryEpisodes.archivedAt));

    const counts = {
      memories: count(db.select({ n: sql<number>`count(*)` }).from(schema.memoryEpisodes).where(activeEpisodes)),
      knowledge: count(db.select({ n: sql<number>`count(*)` }).from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.workspaceId, wsId))),
      notes: count(db.select({ n: sql<number>`count(*)` }).from(schema.userNotes).where(eq(schema.userNotes.userId, userId))),
      agents: count(db.select({ n: sql<number>`count(*)` }).from(schema.agents).where(eq(schema.agents.workspaceId, wsId))),
    };

    // Provenance — where your memory comes from (grouped by source).
    const provenanceRows = db
      .select({ source: schema.memoryEpisodes.source, n: sql<number>`count(*)` })
      .from(schema.memoryEpisodes)
      .where(activeEpisodes)
      .groupBy(schema.memoryEpisodes.source)
      .all();
    const provenance = provenanceRows
      .map((r) => ({ source: r.source, label: labelSource(r.source), count: r.n }))
      .sort((a, b) => b.count - a.count);

    // "Just remembered" — the continuous-care feed.
    const recent = db
      .select({
        id: schema.memoryEpisodes.id,
        title: schema.memoryEpisodes.title,
        type: schema.memoryEpisodes.type,
        source: schema.memoryEpisodes.source,
        agentId: schema.memoryEpisodes.agentId,
        createdAt: schema.memoryEpisodes.createdAt,
      })
      .from(schema.memoryEpisodes)
      .where(activeEpisodes)
      .orderBy(desc(schema.memoryEpisodes.createdAt))
      .limit(12)
      .all()
      .map((r) => ({ ...r, sourceLabel: labelSource(r.source) }));

    // Your agents — portable brains. Memory count is what travels when you
    // change the runtime (the identity + brain stay; the model is swappable).
    const agentRows = db
      .select({
        id: schema.agents.id,
        name: schema.agents.name,
        adapterType: schema.agents.adapterType,
        runtimeModel: schema.agents.runtimeModel,
        avatarGlyph: schema.agents.avatarGlyph,
        colorHex: schema.agents.colorHex,
      })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, wsId))
      .all();
    const agents = agentRows.map((a) => ({
      ...a,
      memories: count(
        db.select({ n: sql<number>`count(*)` }).from(schema.memoryEpisodes).where(and(eq(schema.memoryEpisodes.workspaceId, wsId), eq(schema.memoryEpisodes.scopeId, a.id))),
      ),
    }));

    const footprint = databaseFootprint(deps.dataDir);

    return c.json({
      storage: {
        engine: 'sqlite',
        location: 'local',
        path: footprint.path,
        sizeBytes: footprint.sizeBytes,
        // The honest guarantee: this file is on the operator's machine. Nothing
        // in it is transmitted anywhere unless the operator sends it.
        ownedBy: ws.user.displayName ?? ws.user.username ?? 'you',
      },
      counts,
      provenance,
      recent,
      agents,
    });
  });

  // ── Export: a complete, open copy of your data. Take it and leave. ──────────
  // Straight from the canonical tables — no 500-row cap, no truncation. Derived
  // embedding vectors are omitted (they are machine-generated and re-derived on
  // import); what remains is the knowledge you actually authored or accrued.
  app.get('/export', (c) => {
    const ws = getWorkspace(c);
    const wsId = ws.workspaceId;
    const userId = ws.user.id;

    const workspaceRow = db
      .select({ name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, wsId))
      .get();

    const memories = db
      .select({
        id: schema.memoryEpisodes.id,
        scopeId: schema.memoryEpisodes.scopeId,
        agentId: schema.memoryEpisodes.agentId,
        type: schema.memoryEpisodes.type,
        title: schema.memoryEpisodes.title,
        summary: schema.memoryEpisodes.summary,
        details: schema.memoryEpisodes.details,
        source: schema.memoryEpisodes.source,
        confidence: schema.memoryEpisodes.confidence,
        importance: schema.memoryEpisodes.importance,
        trust: schema.memoryEpisodes.trust,
        tags: schema.memoryEpisodes.tags,
        metadata: schema.memoryEpisodes.metadata,
        createdAt: schema.memoryEpisodes.createdAt,
      })
      .from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, wsId), isNull(schema.memoryEpisodes.archivedAt)))
      .orderBy(desc(schema.memoryEpisodes.createdAt))
      .all();

    const knowledge = db
      .select({
        id: schema.knowledgeChunks.id,
        title: schema.knowledgeChunks.title,
        content: schema.knowledgeChunks.content,
        createdAt: schema.knowledgeChunks.createdAt,
      })
      .from(schema.knowledgeChunks)
      .where(eq(schema.knowledgeChunks.workspaceId, wsId))
      .all();

    const notes = db
      .select({
        id: schema.userNotes.id,
        title: schema.userNotes.title,
        content: schema.userNotes.content,
        tags: schema.userNotes.tags,
        createdAt: schema.userNotes.createdAt,
      })
      .from(schema.userNotes)
      .where(eq(schema.userNotes.userId, userId))
      .all();

    const agents = db
      .select({
        id: schema.agents.id,
        name: schema.agents.name,
        adapterType: schema.agents.adapterType,
        runtimeModel: schema.agents.runtimeModel,
        instructions: schema.agents.instructions,
        role: schema.agents.role,
      })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, wsId))
      .all();

    return c.json({
      format: 'agentis.sovereign-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: { id: wsId, name: workspaceRow?.name ?? null },
      owner: { id: userId, name: ws.user.displayName ?? ws.user.username ?? null },
      note: 'A complete, open-format copy of the data you own in this workspace. It lives on your machine; this file is yours to keep, move, or re-import. Derived embedding vectors are omitted (re-generated on import).',
      counts: { memories: memories.length, knowledge: knowledge.length, notes: notes.length, agents: agents.length },
      memories,
      knowledge,
      notes,
      agents,
    });
  });

  // ── Forget: delete one memory, provably. ────────────────────────────────────
  app.delete('/memory/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const existing = deps.episodes.byId(ws.workspaceId, id);
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', 'Memory not found');

    const removed = deps.episodes.delete(ws.workspaceId, id);
    if (!removed) throw new AgentisError('RESOURCE_NOT_FOUND', 'Memory not found');

    // A forget receipt — the honest counterpart to "forget means forget".
    return c.json({
      ok: true,
      receipt: {
        id,
        title: existing.title,
        forgottenAt: new Date().toISOString(),
        note: 'Deleted from your Brain and excluded from all future recall. It is gone.',
      },
    });
  });

  return app;
}
