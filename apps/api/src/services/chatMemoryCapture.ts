import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { CognitivePromotionQueueWorker } from './cognitivePromotionQueueWorker.js';
import type { MemoryStore } from './memoryStore.js';
import type { PeerProfileService } from './peerProfileService.js';
import type { SessionMomentService } from './sessionMomentService.js';
import { classifyPacer } from './brainPacer.js';

type CapturedMemoryKind = 'fact' | 'preference' | 'rule' | 'lesson';

interface OperatorMemorySignal {
  kind: CapturedMemoryKind;
  title: string;
  content: string;
  confidence: number;
  importance: number;
  tags: string[];
}

export interface ChatMemoryCaptureDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  peerProfiles?: PeerProfileService;
  sessionMoments?: SessionMomentService;
  brainQueue?: CognitivePromotionQueueWorker;
  memory?: MemoryStore;
}

export interface CaptureChatTurnArgs {
  workspaceId: string;
  conversationId: string;
  userId: string;
  agentId: string;
  userDisplayName?: string | null;
  userMessage: string;
  assistantMessage?: string | null;
  finishReason?: string | null;
}

export interface CaptureChatTurnResult {
  peerUpdateJobIds: string[];
  sessionMomentId: string | null;
  promotedSessionMoments: number;
  workspaceMemoryIds: string[];
  signals: number;
}

export class ChatMemoryCaptureService {
  constructor(private readonly deps: ChatMemoryCaptureDeps) {}

  async captureTurn(args: CaptureChatTurnArgs): Promise<CaptureChatTurnResult> {
    const result: CaptureChatTurnResult = {
      peerUpdateJobIds: [],
      sessionMomentId: null,
      promotedSessionMoments: 0,
      workspaceMemoryIds: [],
      signals: 0,
    };

    const userMessage = args.userMessage.trim();
    if (!userMessage) return result;

    const signals = extractOperatorSignals(userMessage, displayName(args));
    result.signals = signals.length;

    try {
      result.peerUpdateJobIds.push(...this.#enqueuePeerUpdates(args));
    } catch (err) {
      this.deps.logger.warn('chat.memory_capture.peer_failed', {
        workspaceId: args.workspaceId,
        conversationId: args.conversationId,
        message: (err as Error).message,
      });
    }

    try {
      result.sessionMomentId = this.#captureSessionMoment(args, signals);
      if (result.sessionMomentId && signals.length === 0 && this.deps.sessionMoments) {
        result.promotedSessionMoments = this.deps.sessionMoments.promoteEligible({
          workspaceId: args.workspaceId,
          sessionId: args.conversationId,
          queue: this.deps.brainQueue,
        }).enqueued;
      }
    } catch (err) {
      this.deps.logger.warn('chat.memory_capture.session_moment_failed', {
        workspaceId: args.workspaceId,
        conversationId: args.conversationId,
        message: (err as Error).message,
      });
    }

    for (const signal of signals) {
      try {
        const memoryId = this.#writeWorkspaceMemory(args, signal);
        if (memoryId) result.workspaceMemoryIds.push(memoryId);
      } catch (err) {
        this.deps.logger.warn('chat.memory_capture.workspace_memory_failed', {
          workspaceId: args.workspaceId,
          conversationId: args.conversationId,
          message: (err as Error).message,
        });
      }

    }

    if (
      result.peerUpdateJobIds.length > 0 ||
      result.sessionMomentId ||
      result.workspaceMemoryIds.length > 0
    ) {
      this.deps.logger.info('chat.memory_capture.completed', {
        workspaceId: args.workspaceId,
        agentId: args.agentId,
        conversationId: args.conversationId,
        peerUpdates: result.peerUpdateJobIds.length,
        sessionMoment: Boolean(result.sessionMomentId),
        promotedSessionMoments: result.promotedSessionMoments,
        workspaceMemories: result.workspaceMemoryIds.length,
        signals: result.signals,
      });
    }

    return result;
  }

  #enqueuePeerUpdates(args: CaptureChatTurnArgs): string[] {
    const peerProfiles = this.deps.peerProfiles;
    if (!peerProfiles) return [];
    const ids: string[] = [];
    const globalId = peerProfiles.enqueueSessionUpdate({
      workspaceId: args.workspaceId,
      sessionId: args.conversationId,
      peerId: args.userId,
      peerType: 'user',
      observerPeerId: null,
    });
    if (globalId) ids.push(globalId);

    if (args.agentId && args.agentId !== args.userId) {
      const directionalId = peerProfiles.enqueueSessionUpdate({
        workspaceId: args.workspaceId,
        sessionId: args.conversationId,
        peerId: args.userId,
        peerType: 'user',
        observerPeerId: args.agentId,
      });
      if (directionalId) ids.push(directionalId);
    }
    return ids;
  }

  #captureSessionMoment(args: CaptureChatTurnArgs, signals: OperatorMemorySignal[]): string | null {
    const sessionMoments = this.deps.sessionMoments;
    if (!sessionMoments) return null;
    const content = buildSessionMomentContent(args, signals);
    if (!content) return null;
    const moment = sessionMoments.add({
      workspaceId: args.workspaceId,
      sessionId: args.conversationId,
      scopeId: args.agentId,
      content,
      confidence: signals.length > 0 ? 0.78 : 0.62,
    });
    return moment.id;
  }

  #writeWorkspaceMemory(args: CaptureChatTurnArgs, signal: OperatorMemorySignal): string | null {
    const memory = this.deps.memory;
    if (!memory) return null;
    const scopeId = null;
    if (this.#workspaceMemoryExists(args.workspaceId, scopeId, signal.content)) return null;
    // PACER (Phase 1): operator-authored workspace memory is constitutional. Tag
    // its class so the constitutional retrieval tier + UI can reason about it.
    const pacer = classifyPacer({
      text: signal.content,
      surface: 'operator_chat',
      tags: [signal.kind],
    });
    return memory.write({
      workspaceId: args.workspaceId,
      scopeId,
      kind: signal.kind,
      source: 'operator',
      title: signal.title,
      content: signal.content,
      trust: signal.confidence,
      importance: signal.importance,
      tags: [...signal.tags, `pacer:${pacer.pacerClass}`],
      provenance: {
	        source: 'chat_memory_capture',
	        conversationId: args.conversationId,
	        agentId: args.agentId,
	        userId: args.userId,
	        userDisplayName: displayName(args),
	        pacerClass: pacer.pacerClass,
	        originSurface: 'operator_chat',
	      },
    });
  }

  #workspaceMemoryExists(workspaceId: string, scopeId: string | null, content: string): boolean {
    const key = normalizeKey(content);
    const rows = this.deps.db.select({
      title: schema.workspaceMemory.title,
      content: schema.workspaceMemory.content,
    })
      .from(schema.workspaceMemory)
      .where(and(
        eq(schema.workspaceMemory.workspaceId, workspaceId),
        scopeId == null ? or(isNull(schema.workspaceMemory.scopeId), eq(schema.workspaceMemory.scopeId, ''))! : eq(schema.workspaceMemory.scopeId, scopeId),
      ))
      .orderBy(desc(schema.workspaceMemory.updatedAt))
      .limit(200)
      .all();
    return rows.some((row) => normalizeKey(row.content) === key || normalizeKey(row.title) === key);
  }

}

function extractOperatorSignals(message: string, actorLabel: string): OperatorMemorySignal[] {
  const signals: OperatorMemorySignal[] = [];
  const parts = splitStableSignalCandidates(message);
  for (const raw of parts) {
    const text = cleanSignal(raw);
    if (!text || looksSensitive(text) || isQuestion(text)) continue;

    const kind = classifySignal(text);
    if (!kind) continue;

    signals.push({
      kind,
      title: titleForSignal(kind, text, actorLabel),
      content: text.slice(0, 500),
      confidence: kind === 'rule' ? 0.86 : kind === 'preference' ? 0.8 : 0.74,
      importance: kind === 'rule' ? 0.82 : kind === 'preference' ? 0.72 : 0.64,
      tags: ['chat', 'operator_signal', kind],
    });
  }

  const seen = new Set<string>();
  const unique: OperatorMemorySignal[] = [];
  for (const signal of signals) {
    const key = `${signal.kind}:${normalizeKey(signal.content)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(signal);
  }
  return unique.slice(0, 5);
}

function splitStableSignalCandidates(message: string): string[] {
  return message
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8 && part.length <= 700);
}

function classifySignal(text: string): CapturedMemoryKind | null {
  const lower = text.toLowerCase();
  if (/\b(correction|actually|not what i meant|instead of|next time)\b/.test(lower)) return 'lesson';
  if (/\b(always|never|must|do not|don't|dont|from now on|going forward|remember to|make sure to)\b/.test(lower)) return 'rule';
  if (/\b(i|we)\s+(prefer|like|dislike|hate|usually|tend to)\b/.test(lower)) return 'preference';
  if (/\b(my|our)\s+(preference|preferred default)\b/.test(lower)) return 'preference';
  if (/\b(i am|i'm|my role is|my title is|our company|my company|i work as|founder of)\b/.test(lower)) return 'fact';
  if (/^remember\b/i.test(text)) return 'rule';
  return null;
}

function cleanSignal(text: string): string {
  return text
    .replace(/^[-*>\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleForSignal(kind: CapturedMemoryKind, content: string, actorLabel: string): string {
  const prefix: Record<CapturedMemoryKind, string> = {
    fact: `${actorLabel} fact`,
    preference: `${actorLabel} preference`,
    rule: `${actorLabel} rule`,
    lesson: `${actorLabel} correction`,
  };
  return `${prefix[kind]}: ${truncate(content, 80)}`;
}

function buildSessionMomentContent(args: CaptureChatTurnArgs, signals: OperatorMemorySignal[]): string | null {
  const operator = args.userMessage.trim().replace(/\s+/g, ' ');
  const assistant = (args.assistantMessage ?? '').trim().replace(/\s+/g, ' ');
  const actorLabel = displayName(args);
  if (!operator) return null;
  if (signals.length === 0 && operator.length < 24 && assistant.length < 40) return null;

  const signalText = signals.length > 0
    ? `Memory signals: ${signals.map((signal) => `${signal.kind}: ${signal.content}`).join(' | ')}`
    : null;
  const parts = [
    signalText,
    `${actorLabel}: ${truncate(operator, 360)}`,
    assistant ? `Assistant: ${truncate(assistant, 360)}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join('\n');
}

function displayName(args: CaptureChatTurnArgs): string {
  const trimmed = args.userDisplayName?.trim();
  return trimmed || 'Operator';
}

/**
 * A question is not a stated preference/rule/fact, even when it contains
 * trigger words ("how do I like responses?" embeds "I like"). We treat a
 * candidate as a question when it ends with `?` or opens with an
 * interrogative — but never when it opens with an imperative ("do not …",
 * "don't …"), which is a rule, not a question.
 */
function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (/\?\s*$/.test(trimmed)) return true;
  if (/^(do not|don'?t)\b/i.test(trimmed)) return false;
  return /^(how|what|why|when|where|who|which|whose|whom|do|does|did|is|are|was|were|can|could|would|should|will|shall|may|might|am)\b/i.test(trimmed);
}

function looksSensitive(text: string): boolean {
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /\b(?:sk|pk|ghp|gho|xoxb|xoxp)_[A-Za-z0-9_-]{16,}\b/.test(text)
    || /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/.test(text);
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trim()}...`;
}
