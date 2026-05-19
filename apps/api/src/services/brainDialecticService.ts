import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import type { CollectiveBrainService } from './collectiveBrain.js';
import type { PeerRepresentationService } from './peerRepresentationService.js';
import type { SessionAtomService } from './sessionAtomService.js';

export interface DialecticTurnResult {
  injectedMessage: string;
  injection: string;
  systemInjection: string;
  atomIds: string[];
  sessionAtomIds: string[];
  dialecticFired: boolean;
}

export class BrainDialecticService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly brain: CollectiveBrainService,
    private readonly peers: PeerRepresentationService,
    private readonly sessionAtoms: SessionAtomService,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  async buildTurn(args: {
    workspaceId: string;
    appId: string;
    sessionId: string;
    userId: string;
    agentId?: string | null;
    turnCount: number;
    userMessage: string;
    recentMessages: string[];
    forceRefresh?: boolean;
  }): Promise<DialecticTurnResult> {
    const settings = this.#settings(args.workspaceId);
    const shouldInject = args.forceRefresh || args.turnCount === 1 || args.turnCount % settings.contextCadence === 0;
    const shouldSynthesize = args.turnCount > 0 && args.turnCount % settings.dialecticCadence === 0;
    const observerScope = args.agentId ?? 'global';
    const systemInjection = this.peers.renderSystemInstructions(args.workspaceId, 'user', args.userId, observerScope);
    if (!shouldInject && !shouldSynthesize) {
      return { injectedMessage: args.userMessage, injection: '', systemInjection, atomIds: [], sessionAtomIds: [], dialecticFired: false };
    }

    const topic = [...args.recentMessages.slice(-3), args.userMessage].join('\n').trim() || args.userMessage;
    const freshAtoms = shouldInject
      ? await this.brain.searchAtoms({
          workspaceId: args.workspaceId,
          appId: args.appId,
          scope: 'both',
          query: topic,
          limit: 3,
          minConfidence: 0.45,
        })
      : [];
    const sessionAtoms = shouldInject
      ? this.sessionAtoms.query({
          workspaceId: args.workspaceId,
          sessionId: args.sessionId,
          query: topic,
          limit: 2,
        })
      : [];
    const peerSummary = this.peers.getSummary(args.workspaceId, 'user', args.userId, observerScope);
    const peerFacts = this.peers.renderContextFacts(args.workspaceId, 'user', args.userId, observerScope);
    const peerStats = this.peers.getPeerCardStats(args.workspaceId, 'user', args.userId, observerScope);
    const conclusions = this.peers.getConclusions(args.workspaceId, args.userId, {
      observerScope,
      limit: 10,
      includeSuperseded: false,
    });
    const summary = this.brain.summarize({ workspaceId: args.workspaceId, appId: args.appId, sessionId: args.sessionId });

    const sections: string[] = [];
    if (shouldInject) {
      sections.push(renderContextBundle({
        peerSummary,
        peerFacts,
        peerStats,
        atoms: freshAtoms,
        sessionAtoms,
        workspaceCount: summary.workspaceBrain.count,
        appCount: summary.appBrain.count,
      }));
      this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BRAIN_CONTEXT_INJECTED, {
        workspaceId: args.workspaceId,
        appId: args.appId,
        sessionId: args.sessionId,
        turnCount: args.turnCount,
        atomIds: freshAtoms.map((atom) => atom.id),
        sessionAtomIds: sessionAtoms.map((atom) => atom.id),
      });
    }

    if (shouldSynthesize) {
      const dialectic = synthesizeDialectic(peerSummary, conclusions.map((c) => c.content), args.recentMessages.slice(-6));
      sections.push(`APP BRAIN DIALECTIC\n${dialectic}`);
      this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BRAIN_DIALECTIC_SYNTHESIZED, {
        workspaceId: args.workspaceId,
        appId: args.appId,
        sessionId: args.sessionId,
        turnCount: args.turnCount,
      });
    }

    const injection = sections.filter(Boolean).join('\n\n');
    this.logger.info('brain_dialectic.injected', {
      workspaceId: args.workspaceId,
      appId: args.appId,
      sessionId: args.sessionId,
      turnCount: args.turnCount,
      atomCount: freshAtoms.length,
      sessionAtomCount: sessionAtoms.length,
      dialecticFired: shouldSynthesize,
    });
    return {
      injectedMessage: injection ? `${injection}\n\nUSER MESSAGE\n${args.userMessage}` : args.userMessage,
      injection,
      systemInjection,
      atomIds: freshAtoms.map((atom) => atom.id),
      sessionAtomIds: sessionAtoms.map((atom) => atom.id),
      dialecticFired: shouldSynthesize,
    };
  }

  #settings(workspaceId: string): { contextCadence: number; dialecticCadence: number; dialecticDepth: number } {
    const row = this.db.select({ brainSettings: schema.workspaces.brainSettings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    const settings = parseRecord(row?.brainSettings);
    return {
      contextCadence: clampInt(settings.contextCadence, 3, 1, 20),
      dialecticCadence: clampInt(settings.dialecticCadence, 6, 2, 50),
      dialecticDepth: clampInt(settings.dialecticDepth, 1, 1, 3),
    };
  }
}

function renderContextBundle(args: {
  peerSummary: string | null;
  peerFacts: string[];
  peerStats: { count: number; byCategory: Record<string, number> };
  atoms: Array<{ id: string; title: string; content: string; confidence: number }>;
  sessionAtoms: Array<{ id: string; content: string; confidence: number }>;
  workspaceCount: number;
  appCount: number;
}): string {
  const lines = [
    `APP BRAIN CONTEXT [workspace atoms: ${args.workspaceCount} | app atoms: ${args.appCount} | session-local: ${args.sessionAtoms.length}]`,
    `PEER CARD [${args.peerStats.count} facts | ${args.peerStats.byCategory.INSTRUCTION ?? 0} INSTRUCTION | ${args.peerStats.byCategory.PREFERENCE ?? 0} PREFERENCE | ${args.peerStats.byCategory.TRAIT ?? 0} TRAIT | ${args.peerStats.byCategory.CONTEXT ?? 0} CONTEXT | ${args.peerStats.byCategory.BELIEF ?? 0} BELIEF]`,
  ];
  if (args.peerFacts.length > 0) {
    lines.push('Operator peer facts:');
    for (const fact of args.peerFacts) lines.push(`- ${fact}`);
  } else if (args.peerSummary) {
    lines.push(`Operator peer card: ${args.peerSummary}`);
  }
  if (args.atoms.length > 0) {
    lines.push('Relevant durable atoms:');
    for (const atom of args.atoms) {
      lines.push(`- ${atom.title}: ${atom.content} [confidence ${atom.confidence.toFixed(2)}]`);
    }
  }
  if (args.sessionAtoms.length > 0) {
    lines.push('Session-local atoms:');
    for (const atom of args.sessionAtoms) {
      lines.push(`- ${atom.content} [confidence ${atom.confidence.toFixed(2)}]`);
    }
  }
  return lines.join('\n');
}

function synthesizeDialectic(summary: string | null, conclusions: string[], recentMessages: string[]): string {
  const signals = [summary, ...conclusions.slice(0, 4)].filter((line): line is string => Boolean(line && line.trim()));
  if (signals.length === 0) return '- No stable operator model yet. Ask concise clarifying questions and learn from corrections.';
  const recent = recentMessages.at(-1);
  const focus = recent ? ` Current conversational focus: ${recent.slice(0, 180)}` : '';
  return [`- What matters now: ${signals[0]}`, ...signals.slice(1, 3).map((line) => `- Remember: ${line}`), focus ? `- ${focus.trim()}` : ''].filter(Boolean).join('\n');
}

function parseRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
