/**
 * SkillService — the Living Skills backbone.
 *
 * A Skill is "body on disk, metabolism in the Brain": the procedure is a real
 * SKILL.md file (materialized so CLI harnesses load it natively via their own
 * progressive-disclosure loader — we inject nothing), while its discoverable
 * description, confidence, and linked lessons/examples live as a `skill` atom in
 * the Brain (SharedIntelligenceService) on the skill-library plane
 * (see memoryStore.ts `SKILL_LIBRARY_PLANE`).
 *
 * This service is the ONE place that reads/writes that atom and projects it to a
 * SKILL.md string. The `content`/summary is the cheap searchable description; the
 * `details` column carries the full SKILL.md body (the procedure) so retrieval
 * stays cheap while the whole procedure travels with the atom.
 */

import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import { MemoryStore, SKILL_LIBRARY_PLANE } from './memory/memoryStore.js';
import type { SharedIntelligenceService } from './sharedIntelligence.js';

const SKILL_LIBRARY_PLANE_LIKE = `%plane:${SKILL_LIBRARY_PLANE}%`;
const SKILL_SLUG_TAG_PREFIX = 'skillslug:';

export interface SkillInput {
  workspaceId: string;
  /** Brain scope: an agentId / appId / workflowId, or null for workspace-global. */
  scopeId?: string | null;
  name: string;
  description: string;
  /** The SKILL.md body (the procedure). */
  body: string;
  source?: 'operator' | 'agent' | 'seed' | 'promotion' | 'system';
  slug?: string;
}

export interface SkillRecord {
  id: string;
  workspaceId: string;
  scopeId: string | null;
  slug: string;
  name: string;
  description: string;
  body: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export class SkillService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly memory: MemoryStore,
    private readonly brain: SharedIntelligenceService,
    private readonly logger: Logger,
  ) {}

  /** Create — or replace by slug within a scope — a skill atom. */
  upsertSkill(input: SkillInput): SkillRecord {
    const slug = slugifySkill(input.slug ?? input.name);
    const now = new Date().toISOString();
    const existing = this.#findBySlug(input.workspaceId, input.scopeId ?? null, slug);
    if (existing) {
      this.db.update(schema.memoryEpisodes)
        .set({ title: input.name, summary: input.description, details: input.body, updatedAt: now })
        .where(eq(schema.memoryEpisodes.id, existing.id))
        .run();
      return this.getSkill(input.workspaceId, existing.id)!;
    }
    const id = this.memory.write({
      workspaceId: input.workspaceId,
      scopeId: input.scopeId ?? null,
      kind: 'skill',
      source: input.source ?? 'operator',
      title: input.name,
      content: input.description,
      details: input.body,
      tags: [`${SKILL_SLUG_TAG_PREFIX}${slug}`],
    });
    return this.getSkill(input.workspaceId, id)!;
  }

  getSkill(workspaceId: string, id: string): SkillRecord | null {
    const row = this.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, id)))
      .get();
    return row && rowIsSkill(row) ? toSkillRecord(row) : null;
  }

  /** Find a skill by slug (or name) within a scope. Used for idempotent import. */
  getByScopeAndSlug(workspaceId: string, scopeId: string | null, slugOrName: string): SkillRecord | null {
    const row = this.#findBySlug(workspaceId, scopeId, slugifySkill(slugOrName));
    return row ? toSkillRecord(row) : null;
  }

  /** List skills owned by any of the given scopes ∪ workspace-global. */
  listForScopes(workspaceId: string, scopeIds: Array<string | null>, minConfidence = 0): SkillRecord[] {
    const wantWorkspace = scopeIds.some((s) => s == null);
    const scoped = scopeIds.filter((s): s is string => typeof s === 'string');
    return this.#skillRows(workspaceId)
      .filter((row) => (row.scopeId == null ? wantWorkspace : scoped.includes(row.scopeId)))
      .map(toSkillRecord)
      .filter((s) => s.confidence >= minConfidence);
  }

  /** All skills in a workspace (for the Skills UI). */
  listSkills(workspaceId: string): SkillRecord[] {
    return this.#skillRows(workspaceId).map(toSkillRecord);
  }

  /** Edit a skill's name/description/body in place (keeps its slug + confidence). */
  updateSkill(workspaceId: string, id: string, patch: { name?: string; description?: string; body?: string }): SkillRecord | null {
    const existing = this.getSkill(workspaceId, id);
    if (!existing) return null;
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) set.title = patch.name;
    if (patch.description !== undefined) set.summary = patch.description;
    if (patch.body !== undefined) set.details = patch.body;
    this.db.update(schema.memoryEpisodes).set(set).where(eq(schema.memoryEpisodes.id, id)).run();
    return this.getSkill(workspaceId, id);
  }

  deleteSkill(workspaceId: string, id: string): boolean {
    return this.memory.delete(workspaceId, undefined as unknown as string | null, id);
  }

  /** All `example` atoms in a workspace (for the Examples UI). */
  listExamples(workspaceId: string): Array<{ id: string; title: string; content: string; scopeId: string | null; updatedAt: string }> {
    return this.db.select().from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        isNull(schema.memoryEpisodes.archivedAt),
        sql`${schema.memoryEpisodes.tags} LIKE ${SKILL_LIBRARY_PLANE_LIKE}`,
      ))
      .orderBy(desc(schema.memoryEpisodes.updatedAt))
      .all()
      .filter((row) => {
        const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
        return meta.memoryKind === 'example';
      })
      .map((row) => ({ id: row.id, title: row.title, content: row.summary, scopeId: row.scopeId ?? null, updatedAt: row.updatedAt }));
  }

  // ── Metabolism (Living Skills) ────────────────────────────
  //
  // A skill's confidence, its worked examples, and its hard-won lessons are the
  // "metabolism in the Brain" half. Confidence moves through the EXISTING
  // evaluator-verdict seam: recording a skill as `atom_injected` for a run means
  // `SharedIntelligenceService.applyEvaluatorVerdict` nudges its confidence when
  // that run is judged — proven-bad skills sink below the materializer floor and
  // stop being written to disk, with no engine surgery.

  /**
   * Mark that an agent committed to a skill during a run (it loaded the body).
   * Records an `atom_injected` quality event so the run's verdict later moves the
   * skill's confidence. No-op without a runId (only run-attributed use feeds back).
   */
  recordUsage(input: { workspaceId: string; skillId: string; runId?: string | null; agentId?: string | null; scopeId?: string | null }): void {
    if (!input.runId) return;
    this.brain.recordQualityEvent({
      workspaceId: input.workspaceId,
      scopeId: input.scopeId ?? null,
      agentId: input.agentId ?? null,
      runId: input.runId,
      eventType: 'atom_injected',
      atomId: input.skillId,
    });
  }

  /** Promote a worked input→output pair into an `example` atom linked to the skill. */
  promoteExample(input: { workspaceId: string; skillId: string; inputText: string; outputText: string; source?: 'operator' | 'agent' | 'promotion' }): string | null {
    const skill = this.getSkill(input.workspaceId, input.skillId);
    if (!skill) return null;
    const exampleId = this.memory.write({
      workspaceId: input.workspaceId,
      scopeId: skill.scopeId,
      kind: 'example',
      source: input.source ?? 'promotion',
      title: `Example — ${skill.name}`,
      content: `Task: ${input.inputText.slice(0, 4000)}\nResponse: ${input.outputText.slice(0, 8000)}`,
      tags: [`${SKILL_SLUG_TAG_PREFIX}${skill.slug}`],
    });
    this.brain.createLink({
      workspaceId: input.workspaceId,
      sourceId: exampleId,
      sourceKind: 'example',
      targetId: input.skillId,
      targetKind: 'skill',
      relation: 'supports',
      ...(skill.scopeId ? { scopeId: skill.scopeId } : {}),
    });
    return exampleId;
  }

  /** Link a failure `lesson` (an episode atom) to the skill it refines. */
  linkLesson(workspaceId: string, skillId: string, lessonAtomId: string): boolean {
    const link = this.brain.createLink({
      workspaceId,
      sourceId: lessonAtomId,
      sourceKind: 'episode',
      targetId: skillId,
      targetKind: 'skill',
      relation: 'refines',
    });
    return link !== null;
  }

  /**
   * Link a lesson to every skill that was ACTIVE in a run (agents loaded it, so
   * it was recorded as `atom_injected`). Lets a run's failure lessons accrue onto
   * exactly the procedures that were in play — war-stories attached to the skill.
   * Returns how many links were made.
   */
  linkLessonToRunSkills(workspaceId: string, runId: string, lessonAtomId: string): number {
    if (!runId) return 0;
    const events = this.db.select({ atomId: schema.brainQualityEvents.atomId })
      .from(schema.brainQualityEvents)
      .where(and(
        eq(schema.brainQualityEvents.workspaceId, workspaceId),
        eq(schema.brainQualityEvents.runId, runId),
        eq(schema.brainQualityEvents.eventType, 'atom_injected'),
      ))
      .all();
    const skillIds = [...new Set(events.map((e) => e.atomId).filter((id): id is string => !!id))]
      .filter((id) => this.getSkill(workspaceId, id) !== null);
    let linked = 0;
    for (const skillId of skillIds) {
      if (this.linkLesson(workspaceId, skillId, lessonAtomId)) linked += 1;
    }
    return linked;
  }

  /** Atoms of `sourceKind` linked into this skill (its examples / lessons). */
  #linkedInto(workspaceId: string, skillId: string, sourceKind: 'example' | 'episode', limit: number): Array<{ id: string; title: string; content: string }> {
    const links = this.db.select().from(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, workspaceId),
        eq(schema.knowledgeLinks.targetId, skillId),
        eq(schema.knowledgeLinks.targetKind, 'skill'),
        eq(schema.knowledgeLinks.sourceKind, sourceKind),
        isNull(schema.knowledgeLinks.invalidAt),
      ))
      .orderBy(desc(schema.knowledgeLinks.updatedAt))
      .limit(limit)
      .all();
    const out: Array<{ id: string; title: string; content: string }> = [];
    for (const link of links) {
      const row = this.db.select().from(schema.memoryEpisodes)
        .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, link.sourceId), isNull(schema.memoryEpisodes.archivedAt)))
        .get();
      if (row) out.push({ id: row.id, title: row.title, content: row.summary });
    }
    return out;
  }

  listLinkedExamples(workspaceId: string, skillId: string, limit = 5): Array<{ id: string; title: string; content: string }> {
    return this.#linkedInto(workspaceId, skillId, 'example', limit);
  }

  listLinkedLessons(workspaceId: string, skillId: string, limit = 5): Array<{ id: string; title: string; content: string }> {
    return this.#linkedInto(workspaceId, skillId, 'episode', limit);
  }

  /** Project a skill to a standalone SKILL.md string (frontmatter + body). */
  toSkillMarkdown(skill: Pick<SkillRecord, 'name' | 'description' | 'body'>): string {
    return serializeSkillMarkdown({ name: skill.name, description: skill.description, body: skill.body });
  }


  #skillRows(workspaceId: string): Array<typeof schema.memoryEpisodes.$inferSelect> {
    return this.db.select().from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        isNull(schema.memoryEpisodes.archivedAt),
        sql`${schema.memoryEpisodes.tags} LIKE ${SKILL_LIBRARY_PLANE_LIKE}`,
      ))
      .orderBy(desc(schema.memoryEpisodes.updatedAt))
      .all()
      .filter(rowIsSkill);
  }

  #findBySlug(workspaceId: string, scopeId: string | null, slug: string): typeof schema.memoryEpisodes.$inferSelect | null {
    const tag = `${SKILL_SLUG_TAG_PREFIX}${slug}`;
    return this.#skillRows(workspaceId).find((row) =>
      (row.scopeId ?? null) === scopeId && parseTags(row.tags).includes(tag)) ?? null;
  }
}

// ────────────────────────────────────────────────────────────
// Row mapping
// ────────────────────────────────────────────────────────────

function rowIsSkill(row: typeof schema.memoryEpisodes.$inferSelect): boolean {
  const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
  return meta.memoryKind === 'skill';
}

function toSkillRecord(row: typeof schema.memoryEpisodes.$inferSelect): SkillRecord {
  const slug = parseTags(row.tags)
    .find((t) => t.startsWith(SKILL_SLUG_TAG_PREFIX))?.slice(SKILL_SLUG_TAG_PREFIX.length)
    ?? slugifySkill(row.title);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    scopeId: row.scopeId ?? null,
    slug,
    name: row.title,
    description: row.summary,
    body: row.details ?? '',
    confidence: Number(row.confidence) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

// ────────────────────────────────────────────────────────────
// SKILL.md frontmatter (shared by materializer + import + export)
// ────────────────────────────────────────────────────────────

export interface SkillMarkdown {
  name: string;
  description: string;
  body: string;
}

/** Serialize to a standard `SKILL.md` (YAML frontmatter `name`/`description` + body). */
export function serializeSkillMarkdown(skill: SkillMarkdown): string {
  return `---\nname: ${yamlQuotedScalar(skill.name)}\ndescription: ${yamlQuotedScalar(skill.description)}\n---\n\n${skill.body.trim()}\n`;
}

function yamlQuotedScalar(value: string): string {
  let normalized = '';
  let pendingSpace = false;
  for (const ch of value) {
    if (ch === '\r' || ch === '\n') {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace && ch !== ' ') normalized += ' ';
    normalized += ch;
    pendingSpace = false;
  }
  return JSON.stringify(normalized.trim());
}

/**
 * Parse a `SKILL.md`: pull `name`/`description` from the leading YAML frontmatter
 * block; everything after the closing `---` is the body. Tolerant of a missing
 * frontmatter block (falls back to a heading / first line for the name).
 */
export function parseSkillMarkdown(raw: string): SkillMarkdown {
  const text = raw.replace(/^﻿/, '');
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (fm) {
    const front = fm[1] ?? '';
    const body = (fm[2] ?? '').trim();
    const name = matchFrontKey(front, 'name') ?? firstHeading(body) ?? 'Untitled skill';
    const description = matchFrontKey(front, 'description') ?? '';
    return { name, description, body };
  }
  const body = text.trim();
  return { name: firstHeading(body) ?? 'Untitled skill', description: '', body };
}

function matchFrontKey(front: string, key: string): string | null {
  const m = front.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'mi'));
  if (!m) return null;
  return m[1]!.trim().replace(/^["']|["']$/g, '').trim() || null;
}

function firstHeading(body: string): string | null {
  const h = body.match(/^#{1,6}\s+(.+)$/m);
  if (h) return h[1]!.trim();
  const line = body.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 80) : null;
}

/** Filesystem-safe skill slug (also the `.claude/skills/<slug>/` folder name). */
export function slugifySkill(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'skill';
}
