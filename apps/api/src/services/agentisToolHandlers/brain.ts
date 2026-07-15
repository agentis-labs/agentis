/**
 * Brain tool family — agent-initiated recall (the PULL complement to the
 * automatic dispatch-context injection).
 *
 * The dispatch context PUSHES a pre-computed set of relevant atoms at the start
 * of a turn — before the agent has reasoned about the task. `agentis.brain.search`
 * lets the agent PULL from its Brain mid-task instead: durable memories, workspace
 * knowledge, and (opt-in) its Skill library. This is the fix for blind
 * pre-reasoning injection — the agent decides what it needs.
 *
 * `agentis.skill.load` returns a Skill's full SKILL.md body on demand (progressive
 * disclosure): the short description is discoverable via search / the materialized
 * skills; the whole procedure loads only when the agent commits to applying it.
 */

import { AgentisError, type AgentisToolContext, type KnowledgeAtomKind } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

/** Agent-facing search facets → the underlying Brain atom kinds. */
const SEARCH_KINDS = ['memory', 'knowledge', 'skill', 'example', 'all'] as const;
type SearchKind = (typeof SEARCH_KINDS)[number];

const FACET_TO_ATOM_KINDS: Record<Exclude<SearchKind, 'all'>, KnowledgeAtomKind[]> = {
  memory: ['episode', 'pattern'],
  knowledge: ['knowledge_chunk', 'kb_chunk'],
  skill: ['skill'],
  example: ['example'],
};

function requireStr(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentisError('VALIDATION_FAILED', `'${name}' must be a non-empty string`);
  }
  return value.trim();
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function snippet(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export function registerBrainTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.brain.search',
        family: 'run',
        description:
          'Search YOUR Brain by meaning, mid-task — durable memories, workspace knowledge, and (on request) your Skill library. Use it when you need a fact, rule, or procedure you were not handed at the start of the turn, instead of guessing. Especially useful after a PRE-TASK MEMORY note says nothing matched: that upfront pass can miss things a targeted re-query with different or broader terms finds — try again before concluding it doesn\'t exist. Returns ranked atoms ({ id, kind, title, snippet, score }). Skills/examples are EXCLUDED by default (they are reached on demand); pass kind:"skill" (or "example"/"all") to include them, then read a skill\'s full procedure with agentis.skill.load. Prefer short keyword-first queries. Example: {"query":"deploy migrations safely","kind":"skill"}.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you are looking for (natural language or keywords).' },
            kind: {
              type: 'string',
              enum: [...SEARCH_KINDS],
              description:
                'Restrict the search. Omit to search durable memory + knowledge (the skill library is excluded). Use "skill"/"example" to search the skill library, or "all" for everything.',
            },
            limit: { type: 'number', description: 'Max results (1–20, default 6).' },
          },
          required: ['query'],
        },
        mutating: false,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: async (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        if (!deps.sharedIntelligence) {
          throw new AgentisError('VALIDATION_FAILED', 'brain search is not available in this workspace');
        }
        const query = requireStr(args.query, 'query');
        const limit = clampLimit(args.limit, 6, 20);
        const facet = (typeof args.kind === 'string' && (SEARCH_KINDS as readonly string[]).includes(args.kind)
          ? args.kind
          : null) as SearchKind | null;
        // An agent searches the union of its OWN brain scope + workspace-shared,
        // under team RLS (its private atoms + shared, never another scope's private).
        const scopeId = ctx.agentId ?? null;
        const hits = await deps.sharedIntelligence.searchAtoms({
          workspaceId: ctx.workspaceId,
          scopeId,
          query,
          scope: scopeId ? 'both' : 'workspace',
          limit,
          requesterScopeId: scopeId,
          // Facet → kinds allowlist. No facet ⇒ default (skill library excluded).
          // "all" ⇒ clear the default exclusion so skills/examples surface too.
          ...(facet && facet !== 'all' ? { kinds: FACET_TO_ATOM_KINDS[facet] } : {}),
          ...(facet === 'all' ? { excludeKinds: [] } : {}),
        });
        return {
          count: hits.length,
          results: hits.map((h) => ({
            id: h.id,
            kind: h.kind,
            title: h.title,
            snippet: snippet(h.content),
            score: Math.round(h.score * 100) / 100,
            confidence: Math.round(h.confidence * 100) / 100,
          })),
        };
      },
    },
    {
      definition: {
        id: 'agentis.skill.load',
        family: 'run',
        description:
          "Load a Skill's full procedure (its SKILL.md body) by id or slug. The short description is discoverable via agentis.brain.search or from your materialized skills; call this to read the WHOLE procedure before you apply it. Returns { id, slug, name, description, body, confidence }. Example: {\"skill\":\"deploy-migrations-safely\"}.",
        inputSchema: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: 'Skill id or slug.' },
          },
          required: ['skill'],
        },
        mutating: false,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        if (!deps.skills) {
          throw new AgentisError('VALIDATION_FAILED', 'skills are not available in this workspace');
        }
        const ref = requireStr(args.skill, 'skill');
        // Resolve by id first, then by slug within the agent's scope, then global.
        const found =
          deps.skills.getSkill(ctx.workspaceId, ref)
          ?? deps.skills.getByScopeAndSlug(ctx.workspaceId, ctx.agentId ?? null, ref)
          ?? deps.skills.getByScopeAndSlug(ctx.workspaceId, null, ref);
        if (!found) {
          throw new AgentisError('RESOURCE_NOT_FOUND', `skill "${ref}" not found in this workspace`);
        }
        // Loading a skill = committing to it. Attribute it to the run so the run's
        // verdict later moves the skill's confidence (Living Skills metabolism).
        deps.skills.recordUsage({
          workspaceId: ctx.workspaceId,
          skillId: found.id,
          runId: ctx.runId ?? null,
          agentId: ctx.agentId ?? null,
          scopeId: ctx.agentId ?? null,
        });
        // The metabolism rides along: worked examples + hard-won lessons.
        const examples = deps.skills.listLinkedExamples(ctx.workspaceId, found.id, 4).map((e) => e.content);
        const lessons = deps.skills.listLinkedLessons(ctx.workspaceId, found.id, 4).map((l) => l.content);
        return {
          id: found.id,
          slug: found.slug,
          name: found.name,
          description: found.description,
          body: found.body,
          confidence: Math.round(found.confidence * 100) / 100,
          ...(examples.length ? { examples } : {}),
          ...(lessons.length ? { lessons } : {}),
        };
      },
    },
    {
      definition: {
        id: 'agentis.skill.promote_example',
        family: 'run',
        description:
          "Save a worked input→output pair as an EXAMPLE of a skill done right — its demonstration set grows from real wins and rides along the next time the skill is loaded. Use after a skill produced a genuinely good result worth teaching. Returns { exampleId }. Example: {\"skill\":\"deploy-migrations-safely\",\"input\":\"ship column add\",\"output\":\"flagged, migrated, verified, flipped\"}.",
        inputSchema: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: 'Skill id or slug the example demonstrates.' },
            input: { type: 'string', description: 'The task/input the skill handled.' },
            output: { type: 'string', description: 'The good result the skill produced.' },
          },
          required: ['skill', 'input', 'output'],
        },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        if (!deps.skills) {
          throw new AgentisError('VALIDATION_FAILED', 'skills are not available in this workspace');
        }
        const ref = requireStr(args.skill, 'skill');
        const inputText = requireStr(args.input, 'input');
        const outputText = requireStr(args.output, 'output');
        const skill =
          deps.skills.getSkill(ctx.workspaceId, ref)
          ?? deps.skills.getByScopeAndSlug(ctx.workspaceId, ctx.agentId ?? null, ref)
          ?? deps.skills.getByScopeAndSlug(ctx.workspaceId, null, ref);
        if (!skill) {
          throw new AgentisError('RESOURCE_NOT_FOUND', `skill "${ref}" not found in this workspace`);
        }
        const exampleId = deps.skills.promoteExample({
          workspaceId: ctx.workspaceId,
          skillId: skill.id,
          inputText,
          outputText,
          source: 'agent',
        });
        return { exampleId, skillId: skill.id };
      },
    },
  ]);
}
