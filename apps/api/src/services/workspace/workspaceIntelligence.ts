/**
 * WorkspaceIntelligenceService — operator-authored workspace context.
 *
 * Authored context (the workspace "charter": tech stack, architectural rules,
 * decisions, workflow conventions) is NOT stored as Markdown files. It lives in
 * the canonical DB brain as operator-sourced `workspace_memory` atoms tagged
 * `charter`, with high importance so the dispatch builder's constitutional tier
 * always injects them. Markdown is only a render/authoring format here — never
 * a backend. External `.md` (harness runtime files, knowledge sources) lives in
 * the volume/knowledge layer, not here.
 *
 * Each of the three logical documents maps to one charter atom (section
 * `workspace` | `decisions` | `workflow`). Editing a document upserts its atom;
 * clearing it deletes the atom. `buildContextBlock` renders the charter (plus
 * knowledge-base passages) for callers that don't yet run full brain dispatch
 * (chat, the creation pipeline); workflow dispatch reads the same atoms through
 * the brain directly.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { MemoryEpisode } from '@agentis/core';
import type { MemoryStore } from '../memory/memoryStore.js';
import type { KnowledgeBaseService } from '../knowledge/knowledgeBase.js';

export type ContextFileName = 'WORKSPACE.md' | 'DECISIONS.md' | 'WORKFLOW.md';

interface CharterSpec {
  section: 'workspace' | 'decisions' | 'workflow';
  title: string;
  kind: MemoryEpisode['kind'];
}

const CHARTER_BY_FILE: Record<ContextFileName, CharterSpec> = {
  'WORKSPACE.md': { section: 'workspace', title: 'Workspace context', kind: 'fact' },
  'DECISIONS.md': { section: 'decisions', title: 'Architectural decisions', kind: 'fact' },
  'WORKFLOW.md': { section: 'workflow', title: 'Workflow conventions', kind: 'rule' },
};

const SECTION_HEADING: Record<CharterSpec['section'], string> = {
  workspace: 'Workspace Context',
  decisions: 'Architectural Decisions',
  workflow: 'Workflow Conventions',
};

export interface BuildContextOptions {
  workflowId?: string;
  /**
   * When set, search workspace knowledge bases with this text and append the
   * top passages as a `Relevant Workspace Knowledge` section.
   */
  knowledgeQuery?: string;
  /** Knowledge-base service. Required for `knowledgeQuery` to take effect. */
  knowledgeBases?: KnowledgeBaseService;
  /** Number of passages to inject. Default 3. */
  knowledgeTopK?: number;
}

export class WorkspaceIntelligenceService {
  constructor(
    private readonly memory: MemoryStore,
    private readonly db: AgentisSqliteDb,
    /** Optional: provide currently-configured integration names for the block. */
    private readonly listActiveIntegrations?: (workspaceId: string) => string[],
  ) {}

  /** Read one authored document's content (empty string when not authored). */
  getContextFile(workspaceId: string, name: ContextFileName): string {
    return this.#findDoc(workspaceId, CHARTER_BY_FILE[name].section)?.content ?? '';
  }

  /**
   * Upsert one authored document as an operator charter atom. Empty content
   * deletes the atom so cleared documents stop injecting.
   */
  setContextFile(workspaceId: string, name: ContextFileName, content: string): void {
    const spec = CHARTER_BY_FILE[name];
    const trimmed = content.trim();
    const existing = this.#findDoc(workspaceId, spec.section);
    if (!trimmed) {
      if (existing) this.memory.delete(workspaceId, null, existing.id);
      return;
    }
    if (existing) {
      this.memory.update(workspaceId, null, existing.id, { title: spec.title, content: trimmed, importance: 0.9 });
      return;
    }
    this.memory.write({
      workspaceId,
      scopeId: null,
      kind: spec.kind,
      source: 'operator',
      title: spec.title,
      content: trimmed,
      trust: 0.85,
      importance: 0.9,
      tags: ['charter', spec.section],
      provenance: { source: 'workspace_context', section: spec.section },
    });
  }

  /**
   * Assemble the authored-context block for callers without full brain dispatch
   * (chat, creation). Workflow dispatch injects the same atoms via the brain's
   * constitutional tier instead. Empty string means no authored context exists.
   */
  async buildContextBlock(workspaceId: string, opts: BuildContextOptions = {}): Promise<string> {
    void opts.workflowId;
    const sections: string[] = [];
    for (const spec of Object.values(CHARTER_BY_FILE)) {
      const doc = this.#findDoc(workspaceId, spec.section);
      const content = doc?.content.trim();
      if (content) sections.push(`## ${SECTION_HEADING[spec.section]}\n${content}`);
    }

    const active = this.listActiveIntegrations?.(workspaceId) ?? [];
    if (active.length) sections.push(`## Active Integrations\n${active.join(', ')}`);

    const knowledge = await this.#retrieveKnowledge(workspaceId, opts);
    if (knowledge) sections.push(knowledge);

    if (!sections.length) return '';
    return `<workspace_context>\n${sections.join('\n\n')}\n</workspace_context>`;
  }

  /** The operator charter atom for a section, or null when not authored. */
  #findDoc(workspaceId: string, section: CharterSpec['section']) {
    // §B4 — read through the unified MemoryStore facade (one substrate).
    const rows = this.memory.list({ workspaceId, scopeId: null, source: 'operator', limit: 200 });
    return rows.find((row) => row.tags.includes('charter') && row.tags.includes(section)) ?? null;
  }

  /**
   * Best-effort knowledge-base retrieval. Never throws; context retrieval must
   * not block an agent dispatch.
   */
  async #retrieveKnowledge(workspaceId: string, opts: BuildContextOptions): Promise<string | null> {
    const query = opts.knowledgeQuery?.trim();
    if (!query || !opts.knowledgeBases) return null;
    const topK = Math.max(1, Math.min(opts.knowledgeTopK ?? 3, 8));
    try {
      const bases = opts.knowledgeBases.listKnowledgeBases(workspaceId, {
        scopeId: opts.workflowId ?? null,
        includeWorkspace: Boolean(opts.workflowId),
      });
      if (!bases.length) return null;
      const hits = (await Promise.all(bases
        .map((b) => opts.knowledgeBases!.search({ workspaceId, knowledgeBaseId: b.id, query, topK }))))
        .flat()
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      if (!hits.length) return null;
      const lines = hits.map((h) => `- ${collapse(h.content).slice(0, 500)}`);
      return `## Relevant Workspace Knowledge\n${lines.join('\n')}`;
    } catch {
      return null;
    }
  }
}

/** Collapse whitespace so a multi-line chunk reads as one bullet. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}
