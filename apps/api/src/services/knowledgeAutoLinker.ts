/**
 * KnowledgeAutoLinker — when a new knowledge atom is written (uploaded doc
 * chunk, ingested kb chunk, promoted episode, etc.), this service mines the
 * collective brain for the most similar existing atoms and writes
 * `knowledge_links` rows so the graph is never "0 links" again.
 *
 * Spec: docs/UIUX-refactor/BRAIN-PAGE-REDESIGN.md §5 (Auto-Linking on
 * Document Upload).
 *
 * Strategy (V1, lexical):
 *   1. Tokenise the candidate text (shared tokeniser with KnowledgeStore).
 *   2. Compute Jaccard similarity vs every active atom in the workspace
 *      (bounded by MAX_CANDIDATES — uses CollectiveBrainService.loadAtoms).
 *   3. Take the top-N matches over MIN_SIMILARITY and write
 *      `relation: 'co_observed'` links via CollectiveBrainService.createLink.
 *
 * Sibling-chunk pass: when many chunks land in a single upload, the linker
 * also draws `derived_from` edges from each chunk to chunk 0 of the same
 * document so a document never appears as a disconnected cloud of orphans.
 */

import type { KnowledgeAtomKind } from '@agentis/core';
import type { Logger } from '../logger.js';
import type { CollectiveBrainService } from './collectiveBrain.js';

export interface AutoLinkInput {
  workspaceId: string;
  appId?: string | null;
  sourceId: string;
  sourceKind: KnowledgeAtomKind;
  sourceTitle: string;
  sourceContent: string;
  /** When provided, also link siblings together with `derived_from`. */
  siblingHeadId?: string | null;
  siblingHeadKind?: KnowledgeAtomKind | null;
  agentId?: string | null;
  adapterType?: string | null;
  runId?: string | null;
}

const MIN_SIMILARITY = 0.18;
const TOP_N = 4;
const MAX_CANDIDATES = 200;

const STOP_WORDS = new Set([
  'a','an','and','are','as','at','be','but','by','for','from','has','have',
  'i','in','into','is','it','its','of','on','or','that','the','their','this',
  'to','was','were','will','with','you','your','we','our','they','them','these',
  'those','do','does','did','if','then','than','so','too','can','could','would',
  'should','about','after','before','between','during','over','under','out','off',
]);

export class KnowledgeAutoLinker {
  constructor(
    private readonly collectiveBrain: CollectiveBrainService,
    private readonly logger: Logger,
  ) {}

  /**
   * Write links from the newly persisted atom to similar existing atoms.
   * Best-effort: failures are logged and swallowed so the calling write path
   * (e.g. document upload) never fails because of brain plumbing.
   */
  autoLink(input: AutoLinkInput): number {
    let linked = 0;
    try {
      const candidates = this.collectiveBrain.listLinkCandidates(input.workspaceId, {
        appId: input.appId ?? null,
        limit: MAX_CANDIDATES,
      });
      const sourceTokens = tokenize(`${input.sourceTitle} ${input.sourceContent}`);
      if (sourceTokens.size === 0) {
        // Still draw a sibling edge if requested so the chunk is not orphaned.
        if (input.siblingHeadId && input.siblingHeadKind && input.siblingHeadId !== input.sourceId) {
          const ok = this.collectiveBrain.createLink({
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            sourceKind: input.sourceKind,
            targetId: input.siblingHeadId,
            targetKind: input.siblingHeadKind,
            relation: 'derived_from',
            confidence: 0.6,
            agentId: input.agentId ?? null,
            adapterType: input.adapterType ?? null,
            runId: input.runId ?? null,
            appId: input.appId ?? null,
          });
          if (ok) linked += 1;
        }
        return linked;
      }

      const scored = candidates
        .filter((candidate) => !(candidate.kind === input.sourceKind && candidate.id === input.sourceId))
        .map((candidate) => ({
          candidate,
          score: jaccard(sourceTokens, candidate.tokens),
        }))
        .filter((entry) => entry.score >= MIN_SIMILARITY)
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_N);

      for (const entry of scored) {
        const ok = this.collectiveBrain.createLink({
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          sourceKind: input.sourceKind,
          targetId: entry.candidate.id,
          targetKind: entry.candidate.kind,
          relation: 'co_observed',
          confidence: clamp01(0.45 + entry.score * 0.5),
          agentId: input.agentId ?? null,
          adapterType: input.adapterType ?? null,
          runId: input.runId ?? null,
          appId: input.appId ?? null,
        });
        if (ok) linked += 1;
      }

      if (input.siblingHeadId && input.siblingHeadKind && input.siblingHeadId !== input.sourceId) {
        const ok = this.collectiveBrain.createLink({
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          sourceKind: input.sourceKind,
          targetId: input.siblingHeadId,
          targetKind: input.siblingHeadKind,
          relation: 'derived_from',
          confidence: 0.65,
          agentId: input.agentId ?? null,
          adapterType: input.adapterType ?? null,
          runId: input.runId ?? null,
          appId: input.appId ?? null,
        });
        if (ok) linked += 1;
      }
    } catch (error) {
      this.logger.warn('knowledge_auto_linker.failed', {
        workspaceId: input.workspaceId,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return linked;
  }

  /**
   * Suggest (without persisting) up to TOP_N candidate links for a given
   * atom. Powers the inspector's "Suggested links" affordance.
   */
  suggestLinks(args: {
    workspaceId: string;
    appId?: string | null;
    sourceKind: KnowledgeAtomKind;
    sourceId: string;
    sourceTitle: string;
    sourceContent: string;
  }): Array<{ id: string; kind: KnowledgeAtomKind; label: string; score: number; suggestedRelation: 'co_observed' | 'supports' }> {
    const candidates = this.collectiveBrain.listLinkCandidates(args.workspaceId, {
      appId: args.appId ?? null,
      limit: MAX_CANDIDATES,
    });
    const sourceTokens = tokenize(`${args.sourceTitle} ${args.sourceContent}`);
    if (sourceTokens.size === 0) return [];
    return candidates
      .filter((candidate) => !(candidate.kind === args.sourceKind && candidate.id === args.sourceId))
      .map((candidate) => ({ candidate, score: jaccard(sourceTokens, candidate.tokens) }))
      .filter((entry) => entry.score >= MIN_SIMILARITY)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_N)
      .map((entry) => ({
        id: entry.candidate.id,
        kind: entry.candidate.kind,
        label: entry.candidate.label,
        score: entry.score,
        suggestedRelation: entry.score >= 0.45 ? 'supports' : 'co_observed',
      }));
  }
}

export function tokenize(input: string): Set<string> {
  if (!input) return new Set();
  const out = new Set<string>();
  const cleaned = input.toLowerCase().replace(/[^a-z0-9_\s]+/g, ' ');
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw || raw.length < 3) continue;
    if (STOP_WORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const value of a) if (b.has(value)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
