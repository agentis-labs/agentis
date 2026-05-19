import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { tokenize } from './knowledgeAutoLinker.js';

type EpisodeRow = typeof schema.memoryEpisodes.$inferSelect;

export type AppIntentHealthStatus = 'unanchored' | 'learning' | 'aligned' | 'watch' | 'drifting';

export interface AppIntentHealthSummary {
  status: AppIntentHealthStatus;
  score: number;
  episodeCount: number;
  alignedCount: number;
  driftCount: number;
  intentPresent: boolean;
  summary: string;
  signals: Array<{ label: string; value: string; tone: 'good' | 'warn' | 'danger' | 'muted' }>;
  topMatches: AppIntentHealthEpisode[];
  driftCandidates: AppIntentHealthEpisode[];
}

export interface AppIntentHealthEpisode {
  id: string;
  title: string;
  type: string;
  outcomeStatus: string | null;
  similarity: number;
  createdAt: string;
}

export function synthesizeAppIntentHealth(args: {
  db: AgentisSqliteDb;
  workspaceId: string;
  appId: string;
  intendedBehavior?: string | null;
  limit?: number;
}): AppIntentHealthSummary {
  const intent = args.intendedBehavior?.trim() ?? '';
  const rows = args.db
    .select()
    .from(schema.memoryEpisodes)
    .where(and(
      eq(schema.memoryEpisodes.workspaceId, args.workspaceId),
      eq(schema.memoryEpisodes.appId, args.appId),
      isNull(schema.memoryEpisodes.archivedAt),
    ))
    .orderBy(desc(schema.memoryEpisodes.createdAt))
    .limit(args.limit ?? 30)
    .all();

  if (!intent) {
    return {
      status: 'unanchored',
      score: 0,
      episodeCount: rows.length,
      alignedCount: 0,
      driftCount: 0,
      intentPresent: false,
      summary: 'No intended behavior is saved for this app yet.',
      signals: [
        { label: 'Intent', value: 'Missing', tone: 'warn' },
        { label: 'Runs reviewed', value: String(rows.length), tone: rows.length > 0 ? 'muted' : 'warn' },
      ],
      topMatches: [],
      driftCandidates: [],
    };
  }

  if (rows.length === 0) {
    return {
      status: 'learning',
      score: 0,
      episodeCount: 0,
      alignedCount: 0,
      driftCount: 0,
      intentPresent: true,
      summary: 'Intent is saved; this app needs runtime episodes before drift can be assessed.',
      signals: [
        { label: 'Intent', value: 'Saved', tone: 'good' },
        { label: 'Runs reviewed', value: '0', tone: 'muted' },
      ],
      topMatches: [],
      driftCandidates: [],
    };
  }

  const intentTokens = tokenize(intent);
  const scored = rows.map((row) => {
    const similarity = similarityScore(intentTokens, tokenize(episodeText(row)));
    return { row, similarity };
  });
  const alignedCount = scored.filter((entry) => entry.similarity >= 0.12).length;
  const driftEntries = scored.filter((entry) => entry.similarity < 0.04 || isNegativeOutcome(entry.row.outcomeStatus));
  const score = clamp01(scored.reduce((sum, entry) => sum + entry.similarity, 0) / scored.length);
  const negativeCount = scored.filter((entry) => isNegativeOutcome(entry.row.outcomeStatus)).length;

  const status: AppIntentHealthStatus =
    score >= 0.16 && negativeCount === 0 ? 'aligned'
      : score >= 0.08 || alignedCount > 0 ? 'watch'
        : 'drifting';

  return {
    status,
    score,
    episodeCount: rows.length,
    alignedCount,
    driftCount: driftEntries.length,
    intentPresent: true,
    summary: summaryFor(status, score, rows.length, driftEntries.length),
    signals: [
      { label: 'Intent match', value: `${Math.round(score * 100)}%`, tone: toneForScore(score) },
      { label: 'Aligned episodes', value: `${alignedCount}/${rows.length}`, tone: alignedCount > 0 ? 'good' : 'warn' },
      { label: 'Needs review', value: String(driftEntries.length), tone: driftEntries.length > 0 ? 'warn' : 'good' },
    ],
    topMatches: scored
      .filter((entry) => entry.similarity > 0)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, 5)
      .map(toHealthEpisode),
    driftCandidates: driftEntries
      .sort((left, right) => left.similarity - right.similarity)
      .slice(0, 5)
      .map(toHealthEpisode),
  };
}

function episodeText(row: EpisodeRow): string {
  return [row.title, row.summary, row.details].filter(Boolean).join('\n');
}

function similarityScore(intentTokens: Set<string>, episodeTokens: Set<string>): number {
  if (intentTokens.size === 0 || episodeTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of intentTokens) if (episodeTokens.has(token)) intersection += 1;
  const union = intentTokens.size + episodeTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isNegativeOutcome(outcome: string | null): boolean {
  return outcome === 'bad';
}

function toHealthEpisode(entry: { row: EpisodeRow; similarity: number }): AppIntentHealthEpisode {
  return {
    id: entry.row.id,
    title: entry.row.title,
    type: entry.row.type,
    outcomeStatus: entry.row.outcomeStatus,
    similarity: entry.similarity,
    createdAt: entry.row.createdAt,
  };
}

function summaryFor(status: AppIntentHealthStatus, score: number, episodeCount: number, driftCount: number): string {
  if (status === 'aligned') return `Recent memory episodes are tracking the saved intent across ${episodeCount} runs.`;
  if (status === 'watch') return `Recent runs are partially aligned with intent; ${driftCount} episodes should be reviewed.`;
  return `Recent memory episodes have low overlap with the saved intent (${Math.round(score * 100)}% average match).`;
}

function toneForScore(score: number): 'good' | 'warn' | 'danger' | 'muted' {
  if (score >= 0.16) return 'good';
  if (score >= 0.08) return 'warn';
  return 'danger';
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}