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
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
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

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function requireAgent(deps: ToolHandlerDeps, workspaceId: string, value: unknown): string {
  const agentId = requireStr(value, 'agentId');
  const row = deps.db.select({ id: schema.agents.id }).from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId))).get();
  if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `agent ${agentId} not found in this workspace`);
  return row.id;
}

function inspectAgentBrain(deps: ToolHandlerDeps, ctx: AgentisToolContext, agentId: string) {
  const memories = deps.memory?.list({ workspaceId: ctx.workspaceId, scopeId: agentId, limit: 500 }) ?? [];
  const skills = deps.skills?.listForScopes(ctx.workspaceId, [agentId]) ?? [];
  const examples = (deps.skills?.listExamples(ctx.workspaceId) ?? []).filter((item) => item.scopeId === agentId);
  const knowledgeBases = deps.knowledgeBases?.listKnowledgeBases(ctx.workspaceId, { scopeId: agentId }) ?? [];
  const knowledge = knowledgeBases.flatMap((base) =>
    (deps.knowledgeBases?.listDocuments(ctx.workspaceId, base.id) ?? []).map((doc) => ({
      id: doc.id,
      title: doc.name,
      status: doc.status,
      knowledgeBaseId: base.id,
    })));
  return {
    agentId,
    counts: { memories: memories.length, knowledge: knowledge.length, skills: skills.length, examples: examples.length },
    memories: memories.map((item) => ({ id: item.id, title: item.title, kind: item.kind })),
    knowledge,
    skills: skills.map((item) => ({ id: item.id, slug: item.slug, name: item.name, confidence: item.confidence })),
    examples: examples.map((item) => ({ id: item.id, title: item.title })),
  };
}

export function registerBrainTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.agent.brain.inspect',
        family: 'inspect',
        mcpExposed: true,
        description: 'Inspect one specialist private Brain across Memory, Knowledge, Skills, and Examples. Use after configuring a specialist; do not claim completion until the requested content is visible here.',
        inputSchema: {
          type: 'object',
          properties: { agentId: { type: 'string' } },
          required: ['agentId'],
        },
        mutating: false,
      },
      handler: (args, ctx) => inspectAgentBrain(deps, ctx, requireAgent(deps, ctx.workspaceId, args.agentId)),
    },
    {
      definition: {
        id: 'agentis.agent.brain.configure',
        family: 'build',
        mcpExposed: true,
        description:
          'Author or update a target specialist private Brain in one idempotent batch: durable memories, scoped knowledge documents, Living Skills, and worked examples. This is cross-agent administration; all content is stored under agentId, never the App/workspace Brain.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string' },
            memories: { type: 'array', items: { type: 'object' } },
            knowledge: { type: 'array', items: { type: 'object' } },
            skills: { type: 'array', items: { type: 'object' } },
            examples: { type: 'array', items: { type: 'object' } },
          },
          required: ['agentId'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: async (args, ctx) => {
        const agentId = requireAgent(deps, ctx.workspaceId, args.agentId);
        if (!deps.memory || !deps.skills) throw new AgentisError('VALIDATION_FAILED', 'Brain memory and skills are not available');
        const results = { memories: [] as string[], knowledge: [] as string[], skills: [] as string[], examples: [] as string[] };
        for (const item of records(args.memories)) {
          const title = requireStr(item.title, 'memories[].title');
          const content = requireStr(item.content, 'memories[].content');
          const existing = deps.memory.list({ workspaceId: ctx.workspaceId, scopeId: agentId, limit: 500 })
            .find((row) => row.title.trim().toLowerCase() === title.toLowerCase());
          if (existing) {
            deps.memory.update(ctx.workspaceId, agentId, existing.id, { content });
            results.memories.push(existing.id);
          } else {
            results.memories.push(deps.memory.write({
              workspaceId: ctx.workspaceId,
              scopeId: agentId,
              kind: String(item.kind ?? 'rule') as 'rule',
              source: 'operator',
              title,
              content,
              trust: 0.9,
              importance: Number(item.importance ?? 0.8),
              tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
            }));
          }
        }
        const createdSkills = new Map<string, string>();
        for (const item of records(args.skills)) {
          const saved = deps.skills.upsertSkill({
            workspaceId: ctx.workspaceId,
            scopeId: agentId,
            name: requireStr(item.name, 'skills[].name'),
            description: requireStr(item.description, 'skills[].description'),
            body: requireStr(item.body, 'skills[].body'),
            source: 'agent',
            ...(typeof item.slug === 'string' ? { slug: item.slug } : {}),
          });
          createdSkills.set(saved.slug, saved.id);
          createdSkills.set(saved.name.toLowerCase(), saved.id);
          results.skills.push(saved.id);
        }
        if (records(args.knowledge).length > 0) {
          if (!deps.knowledgeBases) throw new AgentisError('VALIDATION_FAILED', 'knowledge bases are not available');
          const base = deps.knowledgeBases.listKnowledgeBases(ctx.workspaceId, { scopeId: agentId })
            .find((row) => row.scopeId === agentId)
            ?? deps.knowledgeBases.createKnowledgeBase({ workspaceId: ctx.workspaceId, scopeId: agentId, name: 'Private specialist knowledge' });
          const existingDocs = deps.knowledgeBases.listDocuments(ctx.workspaceId, base.id);
          for (const item of records(args.knowledge)) {
            const title = requireStr(item.title, 'knowledge[].title');
            const existing = existingDocs.find((doc) => doc.name.trim().toLowerCase() === title.toLowerCase());
            if (existing) { results.knowledge.push(existing.id); continue; }
            const doc = await deps.knowledgeBases.addDocument({
              workspaceId: ctx.workspaceId,
              knowledgeBaseId: base.id,
              name: title,
              content: requireStr(item.content, 'knowledge[].content'),
            });
            results.knowledge.push(doc.id);
          }
        }
        for (const item of records(args.examples)) {
          const ref = requireStr(item.skill, 'examples[].skill');
          const skillId = createdSkills.get(ref) ?? createdSkills.get(ref.toLowerCase())
            ?? deps.skills.getByScopeAndSlug(ctx.workspaceId, agentId, ref)?.id;
          if (!skillId) throw new AgentisError('RESOURCE_NOT_FOUND', `private skill "${ref}" not found for target agent`);
          const inputText = requireStr(item.input, 'examples[].input');
          const outputText = requireStr(item.output, 'examples[].output');
          const expectedContent = `Task: ${inputText.slice(0, 4000)}\nResponse: ${outputText.slice(0, 8000)}`;
          const existing = deps.skills.listLinkedExamples(ctx.workspaceId, skillId, 100)
            .find((example) => example.content === expectedContent);
          if (existing) {
            results.examples.push(existing.id);
            continue;
          }
          const id = deps.skills.promoteExample({
            workspaceId: ctx.workspaceId,
            skillId,
            inputText,
            outputText,
            source: 'agent',
          });
          if (id) results.examples.push(id);
        }
        const materialized = deps.skillMaterializer?.materializeForAgent(ctx.workspaceId, agentId).materialized.length ?? 0;
        return { configured: true, agentId, results, materialized, verification: inspectAgentBrain(deps, ctx, agentId) };
      },
    },
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
    {
      definition: {
        id: 'agentis.skill.create',
        family: 'run',
        description:
          'Author a durable, reusable SKILL — a procedure you worked out that should be recalled and applied again, by you or a peer, instead of re-derived. Use this the moment you land a repeatable way of doing something (a deploy sequence, a data-cleaning recipe, a channel-onboarding flow). The `description` is the short trigger the Brain matches on for recall — write it as WHEN to reach for this skill; `body` is the full SKILL.md procedure loaded on demand via agentis.skill.load. Idempotent by slug within its scope: creating with an existing name/slug UPDATES that skill. Scope "agent" (default) keeps it private to you; "workspace" shares it with every agent here. Returns { skillId, slug, scope, replaced }. Example: {"name":"Deploy migrations safely","description":"shipping a DB schema change to production","body":"1. Flag the column...\\n2. Migrate...\\n3. Verify...\\n4. Flip the read path"}.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Human name for the skill (also the default slug).' },
            description: {
              type: 'string',
              description: 'The short recall trigger — WHEN to use this skill. This is what the Brain matches against, so make it about the situation, not the steps.',
            },
            body: { type: 'string', description: 'The full procedure (SKILL.md markdown body).' },
            scope: {
              type: 'string',
              enum: ['agent', 'workspace'],
              description: 'Who can recall it: "agent" (default) = private to you; "workspace" = shared with every agent here.',
            },
            slug: { type: 'string', description: 'Optional stable slug for idempotent updates. Defaults to a slug of the name.' },
            agentId: { type: 'string', description: 'Target specialist Brain. Omit to use the calling agent.' },
          },
          required: ['name', 'description', 'body'],
        },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        if (!deps.skills) {
          throw new AgentisError('VALIDATION_FAILED', 'skills are not available in this workspace');
        }
        const name = requireStr(args.name, 'name');
        const description = requireStr(args.description, 'description');
        const body = requireStr(args.body, 'body');
        // "agent" scopes the skill to the authoring agent's Brain; "workspace"
        // shares it. Absent an agent identity, "agent" degrades to workspace-global
        // (a null scope) rather than silently dropping the skill.
        const scope = args.scope === 'workspace' ? 'workspace' : 'agent';
        const scopeId = scope === 'workspace'
          ? null
          : args.agentId
            ? requireAgent(deps, ctx.workspaceId, args.agentId)
            : (ctx.agentId ?? null);
        const slug = typeof args.slug === 'string' && args.slug.trim() ? args.slug.trim() : undefined;
        const before = deps.skills.getByScopeAndSlug(ctx.workspaceId, scopeId, slug ?? name);
        const saved = deps.skills.upsertSkill({
          workspaceId: ctx.workspaceId,
          scopeId,
          name,
          description,
          body,
          source: 'agent',
          ...(slug ? { slug } : {}),
        });
        return {
          skillId: saved.id,
          slug: saved.slug,
          scope: scopeId ? 'agent' : 'workspace',
          replaced: before !== null,
          guidance:
            'Skill saved. It is now discoverable via agentis.brain.search (kind:"skill") and materialized to disk so harnesses load it natively; read the full procedure any time with agentis.skill.load. As runs that used it are judged, its confidence moves — a proven-good skill sticks, a proven-bad one sinks.',
        };
      },
    },
  ]);
}
