/**
 * brainAskService — Brain 10x §C4, cited-answer recall with honest abstention.
 *
 * The most important point from the source videos: "a confident answer with no
 * source is worse than useless." Frontier memory products return chunks; the
 * winner returns a WRITTEN, CITED answer that ADMITS IGNORANCE. This is the
 * surface that lets a user interrogate the workspace brain directly — "what did
 * we decide about the Salesforce project?" — and get a grounded, attributable
 * reply, or an honest "I don't have that in memory."
 *
 * Flow: B2 retrieval (searchAtoms — hybrid + rerank + MMR) → grounding floor →
 *   - nothing clears the floor → ABSTAIN (never hallucinate from lexical noise);
 *   - else grounded synthesis that cites each claim by its `[mem:id]` tag.
 * Without a synthesis model it degrades to a deterministic, fully-cited list of
 * the grounding atoms — still honest, still attributable.
 */

import type { Logger } from '../../logger.js';
import type { SharedIntelligenceService } from '../sharedIntelligence.js';
import type { StructuredCompleter } from '../structuredCompleter.js';
import { tokenize } from './brainText.js';

export interface BrainAskCitation {
  /** The short [mem:id] tag the answer cites. */
  tag: string;
  atomId: string;
  title: string;
  kind: string;
}

export interface BrainAskResult {
  answer: string;
  citations: BrainAskCitation[];
  abstained: boolean;
  confidence: number;
}

/** A hit must clear this relevance OR be high-confidence to ground an answer. */
const ASK_GROUNDING_FLOOR = 0.34;

export class BrainAskService {
  #completer: StructuredCompleter | null = null;
  #modelAssistedRuntimeEnabled: (workspaceId: string) => boolean = () => true;

  constructor(
    private readonly shared: SharedIntelligenceService,
    private readonly logger: Logger,
  ) {}

  setCompleter(completer: StructuredCompleter | null): void {
    this.#completer = completer;
  }

  setModelAssistedRuntimeEnabled(resolver: (workspaceId: string) => boolean): void {
    this.#modelAssistedRuntimeEnabled = resolver;
  }

  async ask(args: {
    workspaceId: string;
    scopeId?: string | null;
    query: string;
    limit?: number;
  }): Promise<BrainAskResult> {
    const query = (args.query ?? '').trim();
    if (!query) return abstain('Ask a question to interrogate the workspace memory.');

    const limit = Math.min(Math.max(args.limit ?? 6, 1), 12);
    const scopeId = args.scopeId ?? null;
    const hits = await this.shared.searchAtoms({
      workspaceId: args.workspaceId,
      scopeId,
      query,
      scope: scopeId ? 'both' : 'workspace',
      limit: Math.max(limit * 2, limit),
      minConfidence: 0,
    });

    // §C4 — ground on RELEVANCE to the question, not raw confidence: a confident
    // but topically-unrelated atom must NOT answer the question (that is the
    // abstention bug). Require real lexical overlap with the query; a strong
    // retrieval score can substitute, but a high-confidence-yet-irrelevant atom
    // is rejected so out-of-domain questions correctly abstain.
    const grounded = hits
      .filter((h) => {
        const overlap = queryOverlap(query, `${h.title} ${h.content}`);
        return overlap >= 0.12 && (h.score >= ASK_GROUNDING_FLOOR || overlap >= 0.2);
      })
      .slice(0, limit);

    // §C4 — honest abstention: candidates may have existed, but if none clears the
    // floor we say so rather than synthesize a confident answer from noise.
    if (grounded.length === 0) {
      this.logger.info('brain_ask.abstained', { workspaceId: args.workspaceId, candidates: hits.length });
      return abstain("I don't have that in memory — I searched the workspace brain and found nothing relevant enough to answer.");
    }

    const citations: BrainAskCitation[] = grounded.map((h) => ({
      tag: `mem:${h.id.slice(0, 8)}`,
      atomId: h.id,
      title: h.title,
      kind: h.kind,
    }));
    const confidence = grounded.reduce((s, h) => s + h.confidence, 0) / grounded.length;

    // Deterministic, fully-cited fallback when no synthesis model is wired.
    if (!this.#completer || !this.#modelAssistedRuntimeEnabled(args.workspaceId)) {
      const answer = grounded
        .map((h) => `- ${h.title}: ${oneLine(h.content)} [mem:${h.id.slice(0, 8)}]`)
        .join('\n');
      return { answer, citations, abstained: false, confidence };
    }

    const block = grounded
      .map((h) => `[mem:${h.id.slice(0, 8)}] (${h.kind}) ${h.title}: ${oneLine(h.content)}`)
      .join('\n');
    const system = [
      'You answer questions ONLY from the workspace memory provided — never from outside knowledge.',
      'Cite every factual claim inline with the matching [mem:id] tag.',
      'If the memory does not actually answer the question, set answered=false and say you do not know — do NOT guess.',
      'Be concise and direct.',
    ].join(' ');
    const user = [
      `QUESTION: ${query}`,
      '',
      'WORKSPACE MEMORY:',
      block,
      '',
      'Return JSON ONLY: {"answered": true|false, "answer": "<concise answer with [mem:id] citations, or a brief I-don\'t-know>"}',
    ].join('\n');

    try {
      const parsed = await this.#completer.completeStructured<{ answered?: boolean; answer?: string }>({
        system, user, workspaceId: args.workspaceId, maxTokens: 500, maxAttempts: 2,
      });
      const answer = typeof parsed?.answer === 'string' ? parsed.answer.trim() : '';
      if (!parsed?.answered || answer.length < 2) {
        return abstain("I don't have a grounded answer to that in memory.");
      }
      return { answer, citations, abstained: false, confidence };
    } catch (err) {
      this.logger.warn('brain_ask.synthesis_failed', { workspaceId: args.workspaceId, message: (err as Error).message });
      // Fall back to the deterministic cited list rather than failing the ask.
      const answer = grounded.map((h) => `- ${h.title}: ${oneLine(h.content)} [mem:${h.id.slice(0, 8)}]`).join('\n');
      return { answer, citations, abstained: false, confidence };
    }
  }
}

function abstain(answer: string): BrainAskResult {
  return { answer, citations: [], abstained: true, confidence: 0 };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Fraction of the query's content tokens that appear in the atom text (0..1). */
function queryOverlap(query: string, atomText: string): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const a = new Set(tokenize(atomText));
  let hits = 0;
  for (const t of q) if (a.has(t)) hits += 1;
  return hits / q.size;
}
