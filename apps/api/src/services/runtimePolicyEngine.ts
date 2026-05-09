/**
 * runtimePolicyEngine — AGENT-FIRST-ARCHITECTURE.md Plane 6.
 *
 * The control brain that prevents expensive wandering. On every interesting
 * runtime event (dispatch / retry / replan / terminal / budget / escalation)
 * the engine asks the policy engine for a verdict:
 *
 *   allow     — proceed normally
 *   warn      — proceed, log + activity entry
 *   pause     — wait for an approval
 *   escalate  — create an approval and stop the run
 *   degrade   — fall back to cheaper model class / partial outputs
 *   fail      — terminate the run with FAILED
 *
 * Verdicts are persisted to run_policy_events for auditability.
 *
 * Spec: docs/AGENT-FIRST-ARCHITECTURE.md §13.5.
 */

import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import {
  type AppRuntimeContract,
  type PolicyDecision,
  type PolicyEvaluation,
  type PolicyTrigger,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import type { AppContractRuntime } from './appContractRuntime.js';
import type { ApprovalInboxService } from './approvalInbox.js';

export interface PolicyEvaluateArgs {
  workspaceId: string;
  runId: string;
  trigger: PolicyTrigger;
  /** Caller-supplied context (capability tags, current cost, evaluator verdict, etc.). */
  context: Record<string, unknown>;
  /** Optional ambient/user info, used when escalating. */
  ambientId?: string | null;
  userId?: string;
}

export class RuntimePolicyEngine {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly contractRuntime: AppContractRuntime,
    private readonly approvals: ApprovalInboxService,
    private readonly logger: Logger,
  ) {}

  async evaluate(args: PolicyEvaluateArgs): Promise<PolicyEvaluation> {
    const contract = this.contractRuntime.forRun(args.runId);
    const decision = this.#decide(contract, args);
    await this.#record(args, decision);
    if (decision.decision === 'escalate' || decision.decision === 'pause') {
      // Side effect: create the approval so the operator sees the gate.
      if (args.userId) {
        await this.approvals.create({
          workspaceId: args.workspaceId,
          ambientId: args.ambientId ?? null,
          userId: args.userId,
          runId: args.runId,
          taskId: null,
          gatewayId: null,
          source: 'checkpoint',
          title: `Policy ${decision.decision}: ${decision.trigger}`,
          summary: decision.reason,
          confidence: null,
        });
      }
    }
    return decision;
  }

  // ── decision tree ────────────────────────────────────────

  #decide(contract: AppRuntimeContract, args: PolicyEvaluateArgs): PolicyEvaluation {
    const ctx = args.context;
    // Budget guard runs first — strict mode never lets a run continue past cap.
    const spend = this.contractRuntime.spendFor(args.runId);
    if (spend.cap !== undefined && spend.spent >= spend.cap) {
      if (contract.budgetPolicy.costMode === 'strict') {
        return {
          trigger: args.trigger,
          decision: 'fail',
          reason: `budget cap reached (spent ${spend.spent} / cap ${spend.cap})`,
          context: ctx,
        };
      }
      if (contract.budgetPolicy.costMode === 'adaptive') {
        return {
          trigger: args.trigger,
          decision: 'degrade',
          reason: `budget cap reached, falling back to ${contract.degradationPolicy.fallbackModelClass ?? 'small'}`,
          context: ctx,
        };
      }
      // warn mode: proceed but flag.
      return {
        trigger: args.trigger,
        decision: 'warn',
        reason: `budget cap reached (warn mode)`,
        context: ctx,
      };
    }

    if (args.trigger === 'budget' && contract.escalationPolicy.pauseOnBudgetRisk) {
      const headroom = spend.cap !== undefined ? spend.cap - spend.spent : Infinity;
      // Heuristic: less than 20% headroom triggers pause.
      if (spend.cap !== undefined && headroom < spend.cap * 0.2) {
        return {
          trigger: args.trigger,
          decision: 'pause',
          reason: `budget headroom below 20% (${headroom} / ${spend.cap})`,
          context: ctx,
        };
      }
    }

    // Escalation tags on dispatch.
    if (args.trigger === 'dispatch') {
      const tags = (ctx.capabilityTags as string[] | undefined) ?? [];
      const requireApproval = contract.escalationPolicy.requireApprovalFor;
      const matchedTag = tags.find((t) => requireApproval.includes(t));
      if (matchedTag) {
        return {
          trigger: args.trigger,
          decision: 'pause',
          reason: `capability '${matchedTag}' requires approval`,
          context: ctx,
        };
      }
    }

    // Replan cap.
    if (args.trigger === 'replan') {
      const replanCount = Number(ctx.replanCount ?? 0);
      const cap = contract.reliabilityPolicy.maxReplansPerRun;
      if (cap !== undefined && replanCount >= cap) {
        const violation = contract.reliabilityPolicy.onContractViolation;
        return {
          trigger: args.trigger,
          decision: violation === 'fail' ? 'fail' : violation === 'degrade' ? 'degrade' : 'escalate',
          reason: `replan cap reached (${replanCount} / ${cap})`,
          context: ctx,
        };
      }
    }

    // Terminal validation.
    if (args.trigger === 'terminal') {
      const verdict = ctx.evaluatorVerdict as string | undefined;
      if (verdict === 'fail') {
        const violation = contract.reliabilityPolicy.onContractViolation;
        return {
          trigger: args.trigger,
          decision: violation === 'fail' ? 'fail' : violation === 'degrade' ? 'degrade' : 'escalate',
          reason: `terminal evaluator verdict failed`,
          context: ctx,
        };
      }
    }

    // Default — allow.
    return {
      trigger: args.trigger,
      decision: 'allow',
      reason: 'no policy gate triggered',
      context: ctx,
    };
  }

  async #record(args: PolicyEvaluateArgs, evaluation: PolicyEvaluation): Promise<void> {
    this.db
      .insert(schema.runPolicyEvents)
      .values({
        id: randomUUID(),
        workspaceId: args.workspaceId,
        runId: args.runId,
        trigger: evaluation.trigger,
        decision: evaluation.decision,
        reason: evaluation.reason,
        context: evaluation.context,
      })
      .run();
    if (evaluation.decision !== 'allow') {
      this.logger.info('policy.decision', {
        runId: args.runId,
        trigger: evaluation.trigger,
        decision: evaluation.decision,
        reason: evaluation.reason,
      });
    }
  }
}
