/**
 * ConversationSummaryService — long-horizon per-conversation memory (LIVING-APPS-10X
 * Phase 6 · G4).
 *
 * The channel turn only sees a fixed window (HISTORY_LIMIT=20) of the most recent
 * messages, so the agent forgets the middle of a month-long thread — the deal it
 * quoted three weeks ago, the constraint the customer mentioned and never repeated.
 * This service maintains ONE rolling "state of this relationship" summary per
 * conversation: a compact narrative of everything that has scrolled out of the
 * window. It is refreshed as messages accrue past the window and injected back
 * into every turn's context, so the relationship's middle survives.
 *
 * Model-agnostic by construction:
 *   - When a StructuredCompleter is available (the turn's own live adapter, or a
 *     configured workspace model), the older turns are summarized by the model.
 *   - When it is not (tests / model-free builds) or it fails, a DETERMINISTIC
 *     "last-N salient lines + per-author counts" summary is produced instead.
 * Either way the summary is never empty once messages exist beyond the window,
 * and a failure NEVER breaks the turn — every path is non-throwing.
 */

import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { StructuredCompleter } from './structuredCompleter.js';

/** One conversation message, reduced to what summarization needs. */
export interface SummaryMessage {
  /** 'user' = the contact/operator; 'assistant' = the resident agent. */
  role: 'user' | 'assistant';
  content: string;
}

export interface SummaryUpdateInput {
  conversationId: string;
  workspaceId: string;
  appId?: string | null;
  /**
   * The ordered conversation history (oldest → newest), already filtered to the
   * turns that matter (no bare system notices). The service decides which of
   * these have scrolled out of the live window and folds them into the summary.
   */
  messages: SummaryMessage[];
  /** The live turn window size — messages newer than this are NOT yet summarized. */
  windowSize: number;
  /** Optional model source for the rolling summary; falls back to deterministic. */
  completer?: StructuredCompleter | null;
  /** Abort an in-flight summarization when the turn is canceled. */
  signal?: AbortSignal;
}

export interface ConversationSummaryRow {
  conversationId: string;
  summary: string;
  coveredCount: number;
  source: string;
}

/** How many salient lines the deterministic fallback keeps. */
const DETERMINISTIC_LINES = 12;
/** Hard cap on the stored summary so it can never bloat the prompt. */
const MAX_SUMMARY_CHARS = 1800;
/** Re-summarize only after at least this many new out-of-window messages accrue. */
const RESUMMARIZE_EVERY = 6;

export class ConversationSummaryService {
  constructor(
    private readonly deps: { db: AgentisSqliteDb; logger?: Logger },
  ) {}

  /** The stored rolling summary for a conversation, or null when none exists yet. */
  current(conversationId: string): ConversationSummaryRow | null {
    try {
      const row = this.deps.db
        .select({
          conversationId: schema.conversationSummaries.conversationId,
          summary: schema.conversationSummaries.summary,
          coveredCount: schema.conversationSummaries.coveredCount,
          source: schema.conversationSummaries.source,
        })
        .from(schema.conversationSummaries)
        .where(eq(schema.conversationSummaries.conversationId, conversationId))
        .get();
      if (!row || !row.summary.trim()) return null;
      return row;
    } catch (err) {
      this.deps.logger?.warn?.('conversation.summary.read_failed', {
        conversationId,
        err: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Render the stored summary as an injectable system block, or null when there
   * is nothing beyond the window to remember. Bounded by MAX_SUMMARY_CHARS.
   */
  injectionBlock(conversationId: string): string | null {
    const row = this.current(conversationId);
    if (!row) return null;
    return [
      'CONVERSATION MEMORY (state of this relationship — earlier turns beyond the recent window):',
      row.summary.trim().slice(0, MAX_SUMMARY_CHARS),
    ].join('\n');
  }

  /**
   * Fold the messages that have scrolled out of the live window into the rolling
   * summary. A no-op (returns the existing row, possibly null) when the thread is
   * still entirely inside the window or too few new messages have accrued to be
   * worth a re-summarize. Never throws.
   */
  async maybeUpdate(input: SummaryUpdateInput): Promise<ConversationSummaryRow | null> {
    try {
      const total = input.messages.length;
      const outOfWindow = Math.max(0, total - input.windowSize);
      const existing = this.current(input.conversationId);
      // Nothing has scrolled out of the window yet — the live history covers it all.
      if (outOfWindow <= 0) return existing;
      // Throttle: only re-summarize once enough new out-of-window turns have
      // accrued past what we already captured (keeps cost flat over a long thread).
      const covered = existing?.coveredCount ?? 0;
      if (existing && outOfWindow - covered < RESUMMARIZE_EVERY) return existing;

      // The turns to fold: everything that has scrolled out of the live window.
      const older = input.messages.slice(0, outOfWindow);
      const { summary, source } = await this.#summarize(older, existing?.summary ?? null, input.completer ?? null, input.signal);
      if (!summary.trim()) return existing;

      const now = new Date().toISOString();
      const bounded = summary.trim().slice(0, MAX_SUMMARY_CHARS);
      this.deps.db
        .insert(schema.conversationSummaries)
        .values({
          conversationId: input.conversationId,
          workspaceId: input.workspaceId,
          appId: input.appId ?? null,
          summary: bounded,
          coveredCount: outOfWindow,
          source,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.conversationSummaries.conversationId,
          set: { summary: bounded, coveredCount: outOfWindow, source, updatedAt: now },
        })
        .run();
      return { conversationId: input.conversationId, summary: bounded, coveredCount: outOfWindow, source };
    } catch (err) {
      this.deps.logger?.warn?.('conversation.summary.update_failed', {
        conversationId: input.conversationId,
        err: (err as Error).message,
      });
      return this.current(input.conversationId);
    }
  }

  /**
   * Produce a fresh rolling summary from the out-of-window turns. Prefers the
   * model (incorporating the prior summary so the narrative is cumulative); falls
   * back to a deterministic last-N + counts digest when no completer is available
   * or the model fails/aborts.
   */
  async #summarize(
    older: SummaryMessage[],
    priorSummary: string | null,
    completer: StructuredCompleter | null,
    signal?: AbortSignal,
  ): Promise<{ summary: string; source: 'model' | 'deterministic' }> {
    if (completer && !signal?.aborted) {
      try {
        const transcript = older.map((m) => `${m.role === 'user' ? 'Contact' : 'Agent'}: ${oneLine(m.content)}`).join('\n');
        const result = await completer.completeStructured<{ summary?: unknown }>({
          system:
            'You maintain a rolling "state of this relationship" memory for a long-running conversation. ' +
            'Given the prior memory and the older turns that have scrolled out of the recent window, return ONE JSON object ' +
            '{"summary": string}. The summary must be a compact, factual digest the agent can rely on weeks later: who the contact is, ' +
            'their goals and constraints, decisions and commitments made, open threads, and anything quoted or promised. ' +
            'Preserve concrete details (names, numbers, dates, prices). Do not invent. Keep it under 1500 characters.',
          user: [
            priorSummary ? `PRIOR MEMORY:\n${priorSummary}` : 'PRIOR MEMORY: (none yet)',
            '',
            'OLDER TURNS (scrolled out of the recent window, oldest first):',
            transcript,
          ].join('\n'),
          maxTokens: 700,
          ...(signal ? { signal } : {}),
        });
        const summary = typeof result?.summary === 'string' ? result.summary.trim() : '';
        if (summary) return { summary, source: 'model' };
      } catch (err) {
        this.deps.logger?.warn?.('conversation.summary.model_failed', { err: (err as Error).message });
      }
    }
    return { summary: this.#deterministic(older, priorSummary), source: 'deterministic' };
  }

  /**
   * Deterministic fallback — no model required, so it runs in tests and model-free
   * builds. Keeps the most recent salient lines from the out-of-window turns plus
   * per-author counts, prefixed by any prior summary so the digest is cumulative.
   */
  #deterministic(older: SummaryMessage[], priorSummary: string | null): string {
    const contactCount = older.filter((m) => m.role === 'user').length;
    const agentCount = older.length - contactCount;
    const salient = older
      .map((m) => `${m.role === 'user' ? 'Contact' : 'Agent'}: ${oneLine(m.content)}`)
      .filter((line) => line.length > `${'Contact: '}`.length)
      .slice(-DETERMINISTIC_LINES);
    const parts: string[] = [];
    if (priorSummary && priorSummary.trim()) parts.push(priorSummary.trim());
    parts.push(
      `Earlier in this conversation (${older.length} turns beyond the recent window — ${contactCount} from the contact, ${agentCount} from the agent). Recent salient exchanges:`,
    );
    parts.push(...salient);
    return parts.join('\n');
  }
}

/** Collapse a message to a single bounded line for the digest. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

export const CONVERSATION_SUMMARY_RESUMMARIZE_EVERY = RESUMMARIZE_EVERY;
