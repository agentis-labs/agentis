/**
 * CapabilityIndex — the compressed, searchable map of the whole workspace
 * (RADICAL-EFFICIENCY-CHAT-CAPABILITY-PLANE §1, "Efficient Global Awareness").
 *
 * Generalizes CommandIndex (keyword palette) + WorkspaceAwarenessService
 * (situational block) into ONE plane the chat/agent loop can query:
 *
 *   • manifest(workspaceId)  → a ~constant-size digest (counts + a few sample
 *     titles). Injected into every substantive chat turn so the agent KNOWS what
 *     exists without holding it — the "know-of-everything, load-almost-nothing"
 *     tier. Cheap: indexed reads, TTL-cached, no embeddings.
 *
 *   • search(workspaceId, intent) → ranked capability atoms (URN + one-line
 *     purpose + input digest). Hybrid retrieval: a cheap lexical prefilter
 *     shortlists candidates, then the workspace embedding provider re-ranks the
 *     shortlist semantically (bounded work + a content-hash vector cache keep
 *     first-call latency sane; it degrades to lexical order if embedding fails).
 *
 * Atoms are derived live from existing rows (apps, workflows and their nodes +
 * phases, agents, extensions) — no new table, no migration. Node and phase atoms
 * are what make deep targeting ("run the CRM's qualify node") addressable.
 */

import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowGraph } from '@agentis/core';
import type { Logger } from '../../logger.js';
import type { EmbeddingProvider } from '../embedding/embeddingProvider.js';
import { cosineSimilarity, embedText } from '../embedding/embeddingProvider.js';
import { appUrn, workflowUrn, nodeUrn, phaseUrn, agentUrn, skillUrn, type CapabilityKind } from './capabilityUrn.js';

export interface CapabilityAtom {
  urn: string;
  kind: CapabilityKind;
  title: string;
  /** One-line purpose used for ranking + shown to the agent. */
  purpose: string;
  /** Compact type hint (e.g. workflow input fields, node kind). */
  inputDigest?: string;
  workflowId?: string;
  appId?: string;
  /** Relevance score, set on search results (0–1). */
  score?: number;
}

export interface CapabilityManifest {
  workspaceName: string;
  counts: Record<string, number>;
  samples: { apps: string[]; workflows: string[]; agents: string[] };
}

export interface CapabilityIndexDeps {
  db: AgentisSqliteDb;
  logger?: Logger;
  /** Per-workspace embedding provider (same resolver the Brain/abilities use). */
  embeddingProvider?: (workspaceId: string) => EmbeddingProvider;
}

interface AtomCacheEntry {
  atoms: CapabilityAtom[];
  expiresAt: number;
}

const ATOMS_TTL_MS = 15_000;
/** Cap how many workflow graphs we walk for node/phase atoms per build. */
const MAX_WORKFLOWS_SCANNED = 200;
/** Node kinds that are pure canvas/boilerplate — never worth a search atom. */
const NOISE_NODE_KINDS = new Set(['sticky_note', 'trigger', 'return_output']);
/** Lexical prefilter width — how many candidates get semantically re-ranked. */
const SHORTLIST = 48;
/** Soft ranking bonus for atoms inside the caller's command scope (their domain). */
const SCOPE_BOOST = 0.12;

export class CapabilityIndex {
  readonly #atomCache = new Map<string, AtomCacheEntry>();
  /** urn → { hash, vector } embedding cache, keyed per workspace. */
  readonly #vecCache = new Map<string, Map<string, { hash: string; vec: number[] }>>();

  constructor(private readonly deps: CapabilityIndexDeps) {}

  /** Drop cached atoms/vectors for a workspace (call on mutation). */
  invalidate(workspaceId: string): void {
    this.#atomCache.delete(workspaceId);
    this.#vecCache.delete(workspaceId);
  }

  /** The compressed manifest — counts + sample titles. Cheap, no embeddings. */
  manifest(workspaceId: string): CapabilityManifest {
    const workspace = this.deps.db.select({ name: schema.workspaces.name }).from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId)).get();
    const atoms = this.#buildAtoms(workspaceId);
    const counts: Record<string, number> = {};
    for (const a of atoms) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
    const sample = (kind: CapabilityKind, n: number): string[] =>
      atoms.filter((a) => a.kind === kind).slice(0, n).map((a) => a.title);
    return {
      workspaceName: workspace?.name ?? workspaceId,
      counts,
      samples: { apps: sample('app', 5), workflows: sample('workflow', 6), agents: sample('agent', 6) },
    };
  }

  /** The formatted CAPABILITY MANIFEST prompt block (resident, ~constant size). */
  manifestBlock(workspaceId: string): string {
    try {
      return formatManifest(this.manifest(workspaceId));
    } catch (err) {
      this.deps.logger?.warn?.('capability_index.manifest_failed', { workspaceId, err: (err as Error).message });
      return '';
    }
  }

  /**
   * Rank capability atoms against an intent. Hybrid: lexical prefilter →
   * semantic re-rank of the shortlist. Never throws — degrades to lexical order.
   */
  async search(
    workspaceId: string,
    intent: string,
    opts: { kind?: CapabilityKind; limit?: number; scope?: { appIds?: string[]; workflowIds?: string[] } } = {},
  ): Promise<CapabilityAtom[]> {
    const query = (intent ?? '').trim();
    const limit = Math.max(1, Math.min(opts.limit ?? 8, 25));
    let atoms = this.#buildAtoms(workspaceId);
    if (opts.kind) atoms = atoms.filter((a) => a.kind === opts.kind);
    if (atoms.length === 0) return [];

    // Soft domain boost — rank the caller's own apps/workflows first WITHOUT
    // filtering (a manager can still reach anything in the workspace).
    const scopeApps = new Set(opts.scope?.appIds ?? []);
    const scopeWfs = new Set(opts.scope?.workflowIds ?? []);
    const hasScope = scopeApps.size > 0 || scopeWfs.size > 0;
    const inScope = (a: CapabilityAtom): boolean =>
      hasScope && ((a.appId != null && scopeApps.has(a.appId)) || (a.workflowId != null && scopeWfs.has(a.workflowId)));
    const boost = (a: CapabilityAtom): number => (inScope(a) ? SCOPE_BOOST : 0);

    if (!query) {
      return [...atoms].sort((a, b) => boost(b) - boost(a)).slice(0, limit).map((a) => ({ ...a, score: boost(a) }));
    }

    // 1) Lexical prescore (token overlap), tie-broken by domain scope, like CommandIndex.
    const qTokens = new Set(tokenize(query));
    const lexScored = atoms.map((a) => ({ atom: a, lex: lexicalScore(qTokens, a) }));
    lexScored.sort((l, r) => (r.lex - l.lex) || (Number(inScope(r.atom)) - Number(inScope(l.atom))));
    const shortlist = lexScored.slice(0, Math.max(SHORTLIST, limit)).map((s) => s.atom);

    // 2) Semantic re-rank of the shortlist (bounded + cached). Blend with lexical
    //    + the domain boost so an exact keyword hit is never buried by a mediocre
    //    embedding, and the manager's own domain surfaces first among near-ties.
    const provider = this.deps.embeddingProvider?.(workspaceId);
    if (!provider) {
      return shortlist.slice(0, limit).map((a) => ({ ...a, score: Number((normalizeLex(lexScored.find((l) => l.atom.urn === a.urn)?.lex ?? 0) + boost(a)).toFixed(4)) }));
    }
    try {
      const qVec = await embedText(provider, query);
      const vecStore = this.#vecStore(workspaceId);
      const ranked: Array<{ atom: CapabilityAtom; score: number }> = [];
      for (const atom of shortlist) {
        const vec = await this.#atomVector(provider, vecStore, atom);
        const semantic = vec ? (cosineSimilarity(qVec, vec) + 1) / 2 : 0; // → [0,1]
        const lex = normalizeLex(lexScored.find((l) => l.atom.urn === atom.urn)?.lex ?? 0);
        ranked.push({ atom, score: 0.75 * semantic + 0.25 * lex + boost(atom) });
      }
      ranked.sort((l, r) => r.score - l.score);
      return ranked.slice(0, limit).map((r) => ({ ...r.atom, score: Number(r.score.toFixed(4)) }));
    } catch (err) {
      this.deps.logger?.warn?.('capability_index.semantic_failed', { workspaceId, err: (err as Error).message });
      return shortlist.slice(0, limit).map((a) => ({ ...a, score: Number((normalizeLex(lexScored.find((l) => l.atom.urn === a.urn)?.lex ?? 0) + boost(a)).toFixed(4)) }));
    }
  }

  /** Fetch a single atom by URN for hydration (capability.load). */
  atomByUrn(workspaceId: string, urn: string): CapabilityAtom | undefined {
    return this.#buildAtoms(workspaceId).find((a) => a.urn === urn);
  }


  #vecStore(workspaceId: string): Map<string, { hash: string; vec: number[] }> {
    let store = this.#vecCache.get(workspaceId);
    if (!store) {
      store = new Map();
      this.#vecCache.set(workspaceId, store);
    }
    return store;
  }

  async #atomVector(
    provider: EmbeddingProvider,
    store: Map<string, { hash: string; vec: number[] }>,
    atom: CapabilityAtom,
  ): Promise<number[] | null> {
    const text = `${atom.title}. ${atom.purpose}`.slice(0, 2000);
    const hash = createHash('sha1').update(text).digest('hex').slice(0, 16);
    const cached = store.get(atom.urn);
    if (cached && cached.hash === hash) return cached.vec;
    const vec = await embedText(provider, text);
    store.set(atom.urn, { hash, vec });
    return vec;
  }

  #buildAtoms(workspaceId: string): CapabilityAtom[] {
    const cached = this.#atomCache.get(workspaceId);
    if (cached && cached.expiresAt > Date.now()) return cached.atoms;
    const atoms = this.#assembleAtoms(workspaceId);
    this.#atomCache.set(workspaceId, { atoms, expiresAt: Date.now() + ATOMS_TTL_MS });
    return atoms;
  }

  #assembleAtoms(workspaceId: string): CapabilityAtom[] {
    const db = this.deps.db;
    const atoms: CapabilityAtom[] = [];

    const apps = db.select({ id: schema.apps.id, name: schema.apps.name, description: schema.apps.description })
      .from(schema.apps).where(eq(schema.apps.workspaceId, workspaceId)).all();
    for (const a of apps) {
      atoms.push({ urn: appUrn(a.id), kind: 'app', title: a.name, purpose: oneLine(a.description ?? 'Agentic App') });
    }

    const workflows = db
      .select({ id: schema.workflows.id, title: schema.workflows.title, description: schema.workflows.description, graph: schema.workflows.graph, appId: schema.workflows.appId })
      .from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId))
      .orderBy(desc(schema.workflows.updatedAt)).all();
    let scanned = 0;
    for (const w of workflows) {
      const appId = w.appId ?? null;
      const graph = (w.graph ?? null) as WorkflowGraph | null;
      const inputDigest = graph?.inputContract?.fields?.length
        ? graph.inputContract.fields.map((f) => `${f.key}:${f.type}`).slice(0, 8).join(', ')
        : undefined;
      atoms.push({
        urn: workflowUrn(w.id, appId),
        kind: 'workflow',
        title: w.title,
        purpose: oneLine(w.description ?? ''),
        ...(inputDigest ? { inputDigest } : {}),
        workflowId: w.id,
        ...(appId ? { appId } : {}),
      });
      // Node + phase atoms — the deep-targeting layer. Bounded per build.
      if (graph && scanned < MAX_WORKFLOWS_SCANNED) {
        scanned += 1;
        for (const node of graph.nodes ?? []) {
          if (NOISE_NODE_KINDS.has(node.type)) continue;
          atoms.push({
            urn: nodeUrn(w.id, node.id, appId),
            kind: 'node',
            title: `${w.title} › ${node.title || node.id}`,
            purpose: oneLine(`${node.type} node in "${w.title}"`),
            inputDigest: node.type,
            workflowId: w.id,
            ...(appId ? { appId } : {}),
          });
        }
        for (const phase of graph.phases ?? []) {
          atoms.push({
            urn: phaseUrn(w.id, phase.id, appId),
            kind: 'phase',
            title: `${w.title} › ${phase.name}`,
            purpose: oneLine(phase.description ?? `phase (${phase.nodeIds.length} nodes) in "${w.title}"`),
            workflowId: w.id,
            ...(appId ? { appId } : {}),
          });
        }
      }
    }

    const agents = db
      .select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role, description: schema.agents.description, instructions: schema.agents.instructions, capabilityTags: schema.agents.capabilityTags })
      .from(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)).all();
    for (const g of agents) {
      const tags = Array.isArray(g.capabilityTags) ? (g.capabilityTags as string[]) : [];
      atoms.push({
        urn: agentUrn(g.id),
        kind: 'agent',
        title: g.name,
        purpose: oneLine([g.role, g.description ?? g.instructions ?? '', tags.slice(0, 4).join(' ')].filter(Boolean).join(' — ')),
      });
    }

    const extensions = db
      .select({ id: schema.extensions.id, name: schema.extensions.name, slug: schema.extensions.slug, runtime: schema.extensions.runtime })
      .from(schema.extensions).where(eq(schema.extensions.workspaceId, workspaceId)).all();
    for (const e of extensions) {
      atoms.push({ urn: skillUrn(e.slug || e.id), kind: 'skill', title: e.name, purpose: oneLine(`${e.runtime} extension`) });
    }

    return atoms;
  }
}

function oneLine(text: string): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

function tokenize(value: string): string[] {
  return (value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

function lexicalScore(qTokens: Set<string>, atom: CapabilityAtom): number {
  if (qTokens.size === 0) return 0;
  const text = `${atom.title} ${atom.purpose} ${atom.inputDigest ?? ''}`;
  const cand = new Set(tokenize(text));
  let hits = 0;
  for (const t of qTokens) if (cand.has(t)) hits += 1;
  return hits;
}

function normalizeLex(hits: number): number {
  // Squash raw token-overlap counts into a soft [0,1] weight.
  return hits <= 0 ? 0 : Math.min(1, hits / 4);
}

/** Render the manifest as the resident CAPABILITY MANIFEST prompt block. */
export function formatManifest(m: CapabilityManifest): string {
  const parts = Object.entries(m.counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : kind.endsWith('s') ? '' : 's'}`);
  if (parts.length === 0) {
    return 'CAPABILITY MANIFEST\nThis workspace has no apps, workflows, or agents yet. Build one with agentis.build_workflow.';
  }
  const lines: string[] = [
    'CAPABILITY MANIFEST',
    `Workspace "${m.workspaceName}" contains: ${parts.join(' · ')}.`,
    'You have COMPLETE awareness that these exist but hold none of them in context. To act:',
    '- agentis.capability.search(intent) — find the exact app/workflow/node/phase/agent by meaning (returns URNs).',
    '- agentis.capability.load(urns) — page in the full typed contract for the ones you pick.',
    '- agentis.capability.invoke(urn, input) — run it, down to a single node or phase (e.g. app:<id>/wf:<id>/node:<id>).',
  ];
  const samples: string[] = [];
  if (m.samples.apps.length) samples.push(`apps: ${m.samples.apps.join(', ')}`);
  if (m.samples.workflows.length) samples.push(`workflows: ${m.samples.workflows.join(', ')}`);
  if (m.samples.agents.length) samples.push(`agents: ${m.samples.agents.join(', ')}`);
  if (samples.length) lines.push(`For reference (not exhaustive) — ${samples.join(' | ')}.`);
  return lines.join('\n');
}
