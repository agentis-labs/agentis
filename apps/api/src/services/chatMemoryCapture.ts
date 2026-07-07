import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { CognitivePromotionQueueWorker } from './cognitivePromotionQueueWorker.js';
import type { MemoryStore } from './memoryStore.js';
import type { PeerProfileService } from './peerProfileService.js';
import type { SessionMomentService } from './sessionMomentService.js';
import { classifyPacer } from './brainPacer.js';
import { extractOperatorCandidates } from './brainFormation.js';
import { looksSensitive } from './brainText.js';

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
  /**
   * §B7.3 — when the turn is about a specific workflow/node (the operator is
   * discussing or editing it), a captured correction is scoped to that context
   * via `appliesTo`, so it never pollutes unrelated tasks. Absent → workspace
   * scope (the default). The chat surface threads these when it has them.
   */
  activeWorkflowId?: string | null;
  activeNodeId?: string | null;
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

    try {
      result.peerUpdateJobIds.push(...this.#enqueuePeerUpdates(args));
    } catch (err) {
      this.deps.logger.warn('chat.memory_capture.peer_failed', {
        workspaceId: args.workspaceId,
        conversationId: args.conversationId,
        message: (err as Error).message,
      });
    }

    // The full turn is kept as an episodic trace (session search / peer profiles);
    // durable memory is formed below, so we no longer auto-promote moments here.
    try {
      result.sessionMomentId = this.#captureSessionMoment(args, []);
    } catch (err) {
      this.deps.logger.warn('chat.memory_capture.session_moment_failed', {
        workspaceId: args.workspaceId,
        conversationId: args.conversationId,
        message: (err as Error).message,
      });
    }

    if (this.deps.brainQueue) {
      // PRIMARY PATH — route the turn through the SAME formation pipeline runs use
      // (cognitive promotion queue → SharedIntelligence.promote → FormationJudge):
      // the operator's words are mined permissively (extractOperatorCandidates) and
      // reconciled against existing memory (ADD/UPDATE/NOOP), so restating a rule
      // UPDATEs it instead of writing a duplicate, and durable even without a model.
      const operatorCandidates = extractOperatorCandidates(userMessage);
      // BRAIN-BLUEPRINT-10X — the AGENT's own discoveries form memory too, not just
      // operator statements. A work turn whose answer carries a learning shape
      // ("root cause was…", "turns out…", "for future runs…") goes through the SAME
      // formation pipeline (judge dedupes/reconciles), so what an agent learns in
      // one run exists for the next one. This was the biggest silent leak: only
      // operator text was ever mined, so agents never remembered their own work.
      const agentLearning = extractAgentLearningSignal(args.assistantMessage ?? '');
      result.signals = operatorCandidates.length + (agentLearning ? 1 : 0);
      if (operatorCandidates.length > 0 || agentLearning) {
        try {
          this.deps.brainQueue.enqueue({
            workspaceId: args.workspaceId,
            itemType: 'atom_promotion',
            priority: 'normal',
            payload: {
              workspaceId: args.workspaceId,
              agentId: args.agentId,
              // Operator statements belong to the workspace mind (all agents recall
              // them); the judge may still scope a memory to the agent.
              scopeId: operatorCandidates.length > 0 ? null : args.agentId,
              memoryPolicy: 'form',
              originSurface: operatorCandidates.length > 0 ? 'operator_chat' : 'agent_chat_learning',
              operatorText: userMessage,
              taskOutput: (args.assistantMessage ?? '').trim(),
              taskTitle: `Operator chat${args.userDisplayName ? ` with ${args.userDisplayName}` : ''}`,
              taskInput: {
                source: 'operator_chat',
                conversationId: args.conversationId,
                activeWorkflowId: args.activeWorkflowId ?? null,
                activeNodeId: args.activeNodeId ?? null,
              },
            },
          });
        } catch (err) {
          this.deps.logger.warn('chat.memory_capture.formation_enqueue_failed', {
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
            message: (err as Error).message,
          });
        }
      }
    } else {
      // FALLBACK (no promotion queue wired) — preserve durable capture with the
      // legacy regex extractor + direct write so chat never silently stops learning.
      const signals = extractOperatorSignals(userMessage, displayName(args));
      result.signals = signals.length;
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
    }

    if (
      result.peerUpdateJobIds.length > 0 ||
      result.sessionMomentId ||
      result.workspaceMemoryIds.length > 0 ||
      result.signals > 0
    ) {
      this.deps.logger.info('chat.memory_capture.completed', {
        workspaceId: args.workspaceId,
        agentId: args.agentId,
        conversationId: args.conversationId,
        peerUpdates: result.peerUpdateJobIds.length,
        sessionMoment: Boolean(result.sessionMomentId),
        formationEnqueued: Boolean(this.deps.brainQueue),
        workspaceMemories: result.workspaceMemoryIds.length,
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
    // §B7.3 — narrow-write: a correction made while discussing a specific
    // workflow/node is scoped to that context via appliesTo (+ a scope tag), so
    // it is not injected into unrelated tasks. Generalization to broader scope is
    // earned later by the reflection engine, never assumed here.
    const appliesTo = [args.activeWorkflowId, args.activeNodeId].filter((v): v is string => Boolean(v));
    return memory.write({
      workspaceId: args.workspaceId,
      scopeId,
      kind: signal.kind,
      source: 'operator',
      title: signal.title,
      content: signal.content,
      trust: signal.confidence,
      importance: signal.importance,
      appliesTo,
      tags: [...signal.tags, `pacer:${pacer.pacerClass}`, ...(appliesTo.length > 0 ? ['scope:workflow'] : [])],
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
    // §B4 — read through the unified MemoryStore facade (one substrate).
    const memory = this.deps.memory;
    if (!memory) return false;
    const key = normalizeKey(content);
    const rows = memory.list({ workspaceId, scopeId, limit: 200 });
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
    // §B7.1/§B7.3 — narrow-write principle: a one-shot task command ("create a
    // workflow that watches AI posts", "remember to email the report") is
    // orchestrator work to be DONE, not durable memory to be remembered. Drop it
    // so it never pollutes the workspace brain as a standing rule. A standing
    // policy ("always create a backup before deploy") carries modality and is
    // kept.
    if (looksLikeTaskCommand(text)) continue;

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

/**
 * BRAIN-BLUEPRINT-10X — does the AGENT's answer carry a durable learning?
 * Deterministic and conservative: the text must be substantive (≥120 chars — a
 * real work summary, not chatter) AND contain an explicit learning shape. The
 * FormationJudge downstream still reconciles/dedupes/rejects, so this gate only
 * decides whether the turn is WORTH judging — false negatives lose a lesson,
 * false positives cost one queue item.
 */
export function extractAgentLearningSignal(assistantText: string): boolean {
  const text = (assistantText ?? '').trim();
  if (text.length < 120) return false;
  return /\b(root cause|the (real|actual) (problem|issue|cause) (was|is)|the fix (was|is)|turns out|discovered that|learned that|lesson[:\s]|note for (the )?future|for future runs|next time (we|i) should|going forward (we|i) (should|will|must))\b/i.test(text);
}

/**
 * §B7.1 — distinguish a transient TASK COMMAND from a durable STANDING POLICY.
 * An imperative verb targeting a deliverable ("create a workflow", "send the
 * report", "remember to scrape X") is work the orchestrator performs now, not
 * knowledge the brain should remember. It is a command EVEN when phrased
 * "remember to …". A command that also carries standing modality
 * ("always create a backup before deploy") is a recurring rule and is kept.
 */
export function looksLikeTaskCommand(text: string): boolean {
  const t = text.trim().toLowerCase()
    .replace(/^(please|kindly|can you|could you|would you|now|go ahead and|i need you to|i want you to|remember to|remind me to|don'?t forget to)\s+/i, '');
  const TASK_VERB = /^(create|build|make|set ?up|add|generate|watch|monitor|schedule|draft|write|design|deploy|run|fetch|scrape|email|send|post|publish|find|search|look up|check|update|delete|remove|configure|connect|integrate|summari[sz]e|analy[sz]e|review|compile|export|import|download|upload|set)\b/;
  if (!TASK_VERB.test(t)) return false;
  const STANDING = /\b(always|never|every time|whenever|each time|by default|going forward|from now on|any time)\b/;
  return !STANDING.test(t);
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
