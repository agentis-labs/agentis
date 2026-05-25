/**
 * BrainService — composes the workspace Brain read model (`BrainOverview`).
 *
 * The Brain surface is *composed*: this service stitches together the three
 * workspace-scoped memory strata — context files + the MEMORY.md log, knowledge
 * bases, and per-workflow memory — plus a roll-up of agent-scoped memory, into
 * one honest picture. Absence is surfaced as `gaps` rather than hidden, so the
 * UI can tell an operator their Brain is under-filled instead of looking empty
 * for no reason.
 */

import { eq } from 'drizzle-orm';
import type {
  BrainContextFileStatus,
  BrainGap,
  BrainKnowledgeBaseStat,
  BrainMemoryStat,
  BrainOverview,
  BrainWorkflowMemoryStat,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import {
  WorkspaceIntelligenceService,
  parseMemoryEntries,
  stripPlaceholders,
  type ContextFileName,
} from './workspaceIntelligence.js';
import type { KnowledgeBaseService } from './knowledgeBase.js';
import type { AgentMemoryService } from './agentMemory.js';

const CONTEXT_FILES: Array<BrainContextFileStatus['name']> = ['WORKSPACE.md', 'WORKFLOW.md', 'DECISIONS.md'];

export interface BrainServiceDeps {
  db: AgentisSqliteDb;
  intelligence: WorkspaceIntelligenceService;
  knowledgeBases: KnowledgeBaseService;
  agentMemory: AgentMemoryService;
}

export class BrainService {
  constructor(private readonly deps: BrainServiceDeps) {}

  async overview(workspaceId: string): Promise<BrainOverview> {
    const [files, memory] = await Promise.all([
      this.#contextFiles(workspaceId),
      this.#memoryStat(workspaceId),
    ]);
    const bases = this.#knowledgeStats(workspaceId);
    const workflows = this.#workflowMemoryStats(workspaceId);
    const agentMemoryTotal = this.deps.agentMemory.statsByWorkspace(workspaceId).total;

    const documents = bases.reduce((s, b) => s + b.documentCount, 0);
    const chunks = bases.reduce((s, b) => s + b.chunkCount, 0);
    const workflowMemoryKeys = workflows.reduce((s, w) => s + w.keyCount, 0);
    const contextFilesFilled = files.filter((f) => f.filled).length;

    const gaps = this.#deriveGaps({ bases, memory, contextFilesFilled, agentMemoryTotal });

    return {
      workspaceId,
      stats: {
        knowledgeBases: bases.length,
        documents,
        chunks,
        memoryEntries: memory.totalEntries,
        workflowMemoryKeys,
        contextFilesFilled,
      },
      context: { files, memory },
      knowledge: { bases },
      workflowMemory: { workflows },
      gaps,
    };
  }

  async #contextFiles(workspaceId: string): Promise<BrainContextFileStatus[]> {
    const out: BrainContextFileStatus[] = [];
    for (const name of CONTEXT_FILES) {
      let content = '';
      try {
        content = await this.deps.intelligence.getContextFile(workspaceId, name as ContextFileName);
      } catch { /* best effort */ }
      // A freshly-seeded file is just section headings + placeholder hints. It
      // only counts as "filled" once an operator has written real content, so
      // strip headings + placeholders + blanks before measuring.
      const meaningful = stripPlaceholders(content)
        .split('\n')
        .filter((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()))
        .join('\n')
        .trim();
      out.push({ name, filled: meaningful.length > 0, bytes: meaningful.length });
    }
    return out;
  }

  async #memoryStat(workspaceId: string): Promise<BrainMemoryStat> {
    let md = '';
    try {
      md = await this.deps.intelligence.getContextFile(workspaceId, 'MEMORY.md');
    } catch { /* best effort */ }
    const entries = parseMemoryEntries(md);
    const bySectionMap = new Map<string, number>();
    for (const e of entries) bySectionMap.set(e.section, (bySectionMap.get(e.section) ?? 0) + 1);
    const recent = [...entries]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 8)
      .map((e) => ({
        section: e.section,
        text: e.text,
        confidence: e.confidence,
        timestamp: e.timestamp || null,
        uses: e.uses,
      }));
    return {
      totalEntries: entries.length,
      bySection: [...bySectionMap.entries()].map(([section, count]) => ({ section, count })),
      recent,
    };
  }

  #knowledgeStats(workspaceId: string): BrainKnowledgeBaseStat[] {
    const bases = this.deps.knowledgeBases.listKnowledgeBases(workspaceId);
    return bases.map((kb) => {
      const documents = this.deps.db
        .select({ id: schema.kbDocuments.id, archivedAt: schema.kbDocuments.archivedAt })
        .from(schema.kbDocuments)
        .where(eq(schema.kbDocuments.knowledgeBaseId, kb.id))
        .all()
        .filter((d) => !d.archivedAt);
      const chunkRows = this.deps.db
        .select({ createdAt: schema.kbChunks.createdAt })
        .from(schema.kbChunks)
        .where(eq(schema.kbChunks.knowledgeBaseId, kb.id))
        .all();
      let lastIndexedAt: string | null = null;
      for (const c of chunkRows) if (!lastIndexedAt || c.createdAt > lastIndexedAt) lastIndexedAt = c.createdAt;
      return {
        id: kb.id,
        name: kb.name,
        description: kb.description ?? null,
        documentCount: documents.length,
        chunkCount: chunkRows.length,
        lastIndexedAt,
      };
    });
  }

  #workflowMemoryStats(workspaceId: string): BrainWorkflowMemoryStat[] {
    const rows = this.deps.db
      .select({
        workflowId: schema.workflowKvEntries.workflowId,
        updatedAt: schema.workflowKvEntries.updatedAt,
      })
      .from(schema.workflowKvEntries)
      .where(eq(schema.workflowKvEntries.workspaceId, workspaceId))
      .all();
    if (rows.length === 0) return [];

    const titles = new Map<string, string>();
    for (const wf of this.deps.db
      .select({ id: schema.workflows.id, title: schema.workflows.title })
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, workspaceId))
      .all()) {
      titles.set(wf.id, wf.title);
    }

    const grouped = new Map<string, { keyCount: number; updatedAt: string | null }>();
    for (const r of rows) {
      const g = grouped.get(r.workflowId) ?? { keyCount: 0, updatedAt: null };
      g.keyCount += 1;
      if (!g.updatedAt || r.updatedAt > g.updatedAt) g.updatedAt = r.updatedAt;
      grouped.set(r.workflowId, g);
    }
    return [...grouped.entries()]
      .map(([workflowId, g]) => ({
        workflowId,
        workflowTitle: titles.get(workflowId) ?? null,
        keyCount: g.keyCount,
        updatedAt: g.updatedAt,
      }))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  #deriveGaps(input: {
    bases: BrainKnowledgeBaseStat[];
    memory: BrainMemoryStat;
    contextFilesFilled: number;
    agentMemoryTotal: number;
  }): BrainGap[] {
    const gaps: BrainGap[] = [];
    if (input.bases.length === 0) {
      gaps.push({ code: 'no_knowledge_bases', message: 'No knowledge bases yet. Add documents your agents can retrieve when they run.' });
    } else {
      for (const b of input.bases) {
        if (b.chunkCount === 0) {
          gaps.push({ code: 'empty_knowledge_base', message: `"${b.name}" has no indexed content yet — upload a document so agents can retrieve from it.`, refId: b.id });
        }
      }
    }
    if (input.contextFilesFilled === 0) {
      gaps.push({ code: 'blank_workspace_context', message: 'Your workspace context is blank — agents are working without facts about your stack and conventions.' });
    }
    if (input.memory.totalEntries === 0 && input.agentMemoryTotal === 0) {
      gaps.push({ code: 'no_memory', message: 'No memories recorded yet. As workflows run, agents will accumulate findings here.' });
    }
    return gaps;
  }
}
