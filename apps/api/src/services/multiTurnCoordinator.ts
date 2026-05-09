/**
 * MultiTurnCoordinator — AGENT-FIRST-ARCHITECTURE.md Plane 3.
 *
 * Owns the multi-turn loop for agent_task nodes. Sits between the adapter's
 * task.completed event and the engine's notifyTaskCompleted call: when the
 * adapter signals a turn boundary (status: 'continue') the coordinator
 *
 *   1. records the turn in turnStateStore
 *   2. checks turn cap + reliability policy
 *   3. either dispatches the next turn or escalates / fails
 *
 * The engine treats single-turn agent_task as the default; multi-turn is
 * opt-in per node via AgentTaskRuntimePolicy.multiTurn.
 *
 * Spec: docs/CHAT-TASKS.md.
 */

import type {
  AgentTaskRuntimePolicy,
  AppRuntimeContract,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import type { TurnStateStore } from './turnStateStore.js';
import type { ApprovalInboxService } from './approvalInbox.js';

/** Outcome the coordinator returns to the engine after a turn boundary. */
export type TurnOutcome =
  | { kind: 'complete'; finalOutput: Record<string, unknown>; totalTurns: number }
  | { kind: 'continue'; turnIndex: number; nextPrompt: string }
  | { kind: 'cap_reached'; action: 'escalate' | 'fail' | 'replan'; turnIndex: number }
  | { kind: 'error'; reason: string };

export interface TurnAdvanceArgs {
  workspaceId: string;
  runId: string;
  nodeId: string;
  ambientId: string | null;
  userId: string;
  /** Adapter's signalled status. */
  status: 'continue' | 'done' | 'blocked';
  /** Compact summary of the work done this turn (from the adapter or evaluator). */
  summary?: string;
  /** Last response payload (cost, blockers, structured output, etc.). */
  payload?: Record<string, unknown>;
  blockers?: string[];
  costCents?: number;
  /** Final output when status === 'done'. */
  finalOutput?: Record<string, unknown>;
  /** Per-node policy. Defaults pulled from contract.reliabilityPolicy. */
  policy?: AgentTaskRuntimePolicy;
  contract?: AppRuntimeContract;
}

export class MultiTurnCoordinator {
  constructor(
    private readonly turns: TurnStateStore,
    private readonly approvals: ApprovalInboxService,
    private readonly logger: Logger,
  ) {}

  /**
   * Records the turn and tells the engine what to do next.
   * Multi-turn is gated on policy.multiTurn — if false, this returns 'complete'
   * immediately so the engine's existing single-shot path keeps working.
   */
  async advance(args: TurnAdvanceArgs): Promise<TurnOutcome> {
    if (!args.policy?.multiTurn) {
      // Legacy single-shot. The engine will mark the node complete with output.
      return {
        kind: 'complete',
        finalOutput: args.finalOutput ?? args.payload ?? {},
        totalTurns: 1,
      };
    }

    const turn = this.turns.append({
      workspaceId: args.workspaceId,
      runId: args.runId,
      nodeId: args.nodeId,
      summary: args.summary,
      payload: args.payload,
      blockers: args.blockers,
      costCents: args.costCents,
    });

    if (args.status === 'done') {
      return {
        kind: 'complete',
        finalOutput: args.finalOutput ?? args.payload ?? {},
        totalTurns: turn.turnIndex + 1,
      };
    }

    // Determine the cap. Per-node maxTurns wins, otherwise the contract's
    // reliability policy, otherwise a conservative default of 12.
    const cap =
      args.policy.maxTurns ??
      args.contract?.reliabilityPolicy?.maxTurnsPerAgentTask ??
      12;

    if (turn.turnIndex + 1 >= cap) {
      const action = args.policy.onTurnCap ?? 'escalate';
      this.logger.warn('turn.cap_reached', {
        runId: args.runId,
        nodeId: args.nodeId,
        cap,
        action,
      });
      if (action === 'escalate') {
        await this.approvals.create({
          workspaceId: args.workspaceId,
          ambientId: args.ambientId,
          userId: args.userId,
          runId: args.runId,
          taskId: null,
          gatewayId: null,
          source: 'checkpoint',
          title: `Multi-turn agent task hit turn cap (${cap})`,
          summary: `Run ${args.runId} node ${args.nodeId} reached the turn cap. Approve to extend, reject to fail the node.`,
          confidence: null,
        });
      }
      return { kind: 'cap_reached', action, turnIndex: turn.turnIndex };
    }

    if (args.status === 'blocked') {
      return {
        kind: 'cap_reached',
        action: 'escalate',
        turnIndex: turn.turnIndex,
      };
    }

    // Build the next prompt suffix from the running summary so the next turn
    // is anchored on what's been done. Adapters compose their own prompt; we
    // just expose the compact summary so they can splice it in.
    const nextPrompt = args.summary ?? '';
    return { kind: 'continue', turnIndex: turn.turnIndex + 1, nextPrompt };
  }

  /** Read-only convenience: how many turns have been recorded for a node. */
  count(runId: string, nodeId: string): number {
    return this.turns.count(runId, nodeId);
  }
}
