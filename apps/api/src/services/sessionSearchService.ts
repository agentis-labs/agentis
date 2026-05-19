import { sql } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';

export interface SessionSearchHit {
  source: 'ledger' | 'conversation';
  id: string;
  workspaceId: string;
  runId?: string | null;
  conversationId?: string | null;
  eventType?: string | null;
  authorType?: string | null;
  excerpt: string;
  createdAt: string;
}

export class SessionSearchService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {}

  search(args: { workspaceId: string; query: string; limit?: number }): SessionSearchHit[] {
    const query = sanitizeFtsQuery(args.query);
    if (!query) return [];
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const hits: SessionSearchHit[] = [];
    try {
      const ledgerRows = this.db.all<{
        id: string;
        workspaceId: string;
        runId: string;
        eventType: string;
        payload: unknown;
        createdAt: string;
        excerpt: string;
      }>(sql`
        SELECT ledger_events.id AS id,
               ledger_events.workspace_id AS workspaceId,
               ledger_events.run_id AS runId,
               ledger_events.event_type AS eventType,
               ledger_events.payload AS payload,
               ledger_events.created_at AS createdAt,
               snippet(ledger_events_fts, 1, '[', ']', '...', 12) AS excerpt
        FROM ledger_events_fts
        JOIN ledger_events ON ledger_events.rowid = ledger_events_fts.rowid
        WHERE ledger_events.workspace_id = ${args.workspaceId}
          AND ledger_events_fts MATCH ${query}
        ORDER BY ledger_events.created_at DESC
        LIMIT ${limit}
      `);
      hits.push(...ledgerRows.map((row) => ({
        source: 'ledger' as const,
        id: row.id,
        workspaceId: row.workspaceId,
        runId: row.runId,
        eventType: row.eventType,
        excerpt: row.excerpt || stringifyPayload(row.payload),
        createdAt: row.createdAt,
      })));
    } catch (err) {
      this.logger.warn('session_search.ledger_failed', { error: (err as Error).message });
    }

    try {
      const conversationRows = this.db.all<{
        id: string;
        workspaceId: string;
        conversationId: string;
        authorType: string;
        body: string;
        createdAt: string;
        excerpt: string;
      }>(sql`
        SELECT conversation_messages.id AS id,
               conversation_messages.workspace_id AS workspaceId,
               conversation_messages.conversation_id AS conversationId,
               conversation_messages.author_type AS authorType,
               conversation_messages.body AS body,
               conversation_messages.created_at AS createdAt,
               snippet(conversation_messages_fts, 0, '[', ']', '...', 12) AS excerpt
        FROM conversation_messages_fts
        JOIN conversation_messages ON conversation_messages.rowid = conversation_messages_fts.rowid
        WHERE conversation_messages.workspace_id = ${args.workspaceId}
          AND conversation_messages_fts MATCH ${query}
        ORDER BY conversation_messages.created_at DESC
        LIMIT ${limit}
      `);
      hits.push(...conversationRows.map((row) => ({
        source: 'conversation' as const,
        id: row.id,
        workspaceId: row.workspaceId,
        conversationId: row.conversationId,
        authorType: row.authorType,
        excerpt: row.excerpt || row.body,
        createdAt: row.createdAt,
      })));
    } catch (err) {
      this.logger.warn('session_search.conversations_failed', { error: (err as Error).message });
    }

    return hits
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}

function sanitizeFtsQuery(input: string): string {
  const tokens = input
    .toLowerCase()
    .match(/[a-z0-9_]+/g)
    ?.filter((token) => token.length > 1)
    .slice(0, 8) ?? [];
  return tokens.map((token) => `"${token}"*`).join(' OR ');
}

function stringifyPayload(payload: unknown): string {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload).slice(0, 500);
  } catch {
    return String(payload);
  }
}
