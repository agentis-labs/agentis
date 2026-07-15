/**
 * Convergence + fan-out loop controller (extracted from WorkflowEngine).
 *
 * Owns the two agentic looping node kinds — `loop` (bounded fan-out over an
 * items array) and `converge`/`pursue` (iterate a cohort sub-graph until a
 * continuation policy, ASSESS/REFLECT stall detection, or a budget stops it).
 * The core engine no longer contains this logic; it delegates through a small
 * typed {@link LoopEngineHost} facade so the loop can drive node completion,
 *
 * This is the AGENT-COOPERATION-10X §Pillar 1 + COGNITIVE-LOOPING-RFC loop.
 */
import {
  AgentisError,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type WorkflowNode,
  type LoopNodeConfig,
  type ConvergeNodeConfig,
} from '@agentis/core';
import { detectStagnation, computeProgress, chooseReflection } from './pursuitControl.js';
import { evalCondition } from './SafeConditionParser.js';
import { readTemplatePath, type TemplateContext } from './templateResolver.js';
import { readDotPath } from './dotPath.js';
import { evaluateRunVerdict, unwrapReturnEnvelope, type VerdictProbeDeps } from '../services/workflow/workflowVerdict.js';
import { graphContentHash } from '../services/workflow/workflowCompass.js';
import { type WorkflowSpec } from '../services/workflow/workflowSpec.js';
import type { WorktreeHandle } from '../services/worktreeManager.js';
import type { EvaluationRuntime } from '../services/structuredEvaluatorRuntime.js';
// Type-only back-import: erased at compile time, so no runtime import cycle with
// the engine (which imports this controller as a value).
import type { RunningContext, EngineDeps, RunHandle, StartRunArgs } from './WorkflowEngine.js';

/**
 * The exact slice of engine capability the loop controller needs. The engine
 * supplies this as a facade of bound closures over its private methods, keeping
 * the engine's `#private` surface encapsulated.
 */
export interface LoopEngineHost {
  readonly deps: EngineDeps;
  startRun(args: StartRunArgs): Promise<RunHandle>;
  completeNode(ctx: RunningContext, nodeId: string, output: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  failNode(ctx: RunningContext, nodeId: string, error: string): Promise<void>;
  tick(ctx: RunningContext): Promise<void>;
  persistRun(ctx: RunningContext): Promise<void>;
  buildConditionScope(ctx: RunningContext, currentData: Record<string, unknown>): Record<string, unknown>;
  specForRun(ctx: RunningContext): WorkflowSpec | null;
  verdictProbeDeps(ctx: RunningContext, spec: WorkflowSpec): VerdictProbeDeps;
  resolveEvaluationRuntime(
    ctx: RunningContext,
    node: WorkflowNode,
    targetPath?: string,
  ): { runtime: EvaluationRuntime; agentId: string | null } | undefined;
  recordEvaluationTokens(
    ctx: RunningContext,
    nodeId: string,
    usage: { tokensIn: number; tokensOut: number } | null | undefined,
    agentId: string | null,
  ): void;
}

export class ConvergeLoopController {
  constructor(private readonly host: LoopEngineHost) {}

  async dispatchLoop(
    ctx: RunningContext,
    node: WorkflowNode,
    config: LoopNodeConfig,
    inputData: Record<string, unknown>,
    tctx: TemplateContext,
  ): Promise<void> {
    if (!this.host.deps.subflows) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'loop node present but SubflowExecutor not wired');
    }
    if (!config.bodyWorkflowId) {
      throw new AgentisError('VALIDATION_FAILED', 'loop node missing bodyWorkflowId');
    }
    // Resolve items array ? accept either a `{{path}}` template or a raw dot path.
    let items: unknown;
    if (config.itemsExpression?.includes('{{')) {
      // Stringified pass ? we need typed access, so read the path directly.
      const stripped = config.itemsExpression.replace(/^\{\{\s*|\s*\}\}$/g, '');
      items = readTemplatePath(tctx, stripped);
    } else if (config.itemsExpression) {
      items = readTemplatePath(tctx, config.itemsExpression) ?? readDotPath(inputData, config.itemsExpression);
    }
    if (!Array.isArray(items)) {
      throw new AgentisError('VALIDATION_FAILED', `loop.itemsExpression did not resolve to an array (got ${typeof items})`);
    }
    if (items.length === 0) {
      await this.host.completeNode(ctx, node.id, { [config.outputArrayKey]: [], count: 0 });
      return;
    }
    const concurrency = Math.max(1, Math.min(config.maxConcurrency ?? 1, 32));
    const chunkSize = Math.max(1, config.chunkSize ?? items.length);
    const errorPolicy = config.onIterationError ?? 'stop_all';

    ctx.state.activeExecutions[node.id] = {
      taskId: `loop:${node.id}`,
      nodeId: node.id,
      executorType: 'loop',
      executorRef: `${items.length} items, c=${concurrency}, chunk=${chunkSize}`,
      startedAt: new Date().toISOString(),
    };
    // Persist the dispatch transition so observers see the loop in flight
    // (same staleness class as agent_task/wait).
    await this.host.persistRun(ctx).catch(() => {});

    // Run loop fully async; complete/fail the node once all chunks settle.
    void this.#runLoop(ctx, node, config, items, concurrency, chunkSize, errorPolicy)
      .catch((err) => {
        delete ctx.state.activeExecutions[node.id];
        void this.host.failNode(ctx, node.id, (err as Error).message);
        void this.host.tick(ctx);
      });
  }

  async #runLoop(
    ctx: RunningContext,
    node: WorkflowNode,
    config: LoopNodeConfig,
    items: unknown[],
    concurrency: number,
    chunkSize: number,
    errorPolicy: 'stop_all' | 'continue' | 'collect_errors',
  ): Promise<void> {
    const results: unknown[] = new Array(items.length);
    const errors: Array<{ index: number; message: string }> = [];

    // Durable / idempotent resume (masterplan 1.4): crash recovery re-dispatches
    // an interrupted loop node, so we persist each iteration's result and SKIP it
    // on re-run — side effects fire at most once per iteration instead of the
    // whole loop replaying. `_loopState` is the persisted completed/failed map.
    const priorState = (ctx.state.nodeStates[node.id]?.outputData?._loopState ?? {}) as {
      completed?: Record<string, unknown>;
      failed?: Record<string, string>;
    };
    const completedMap: Record<string, unknown> = { ...(priorState.completed ?? {}) };
    const failedMap: Record<string, string> = { ...(priorState.failed ?? {}) };
    for (const [idx, value] of Object.entries(completedMap)) results[Number(idx)] = value;
    for (const [idx, message] of Object.entries(failedMap)) errors.push({ index: Number(idx), message });

    const persistLoopState = async (chunkEnd: number): Promise<void> => {
      const loopNs = ctx.state.nodeStates[node.id];
      if (!loopNs) return;
      loopNs.outputData = {
        ...(loopNs.outputData ?? {}),
        _loopState: { completed: completedMap, failed: failedMap },
        _loopProgress: { completed: chunkEnd, total: items.length, errors: errors.length },
      };
      await this.host.persistRun(ctx);
    };

    for (let chunkStart = 0; chunkStart < items.length; chunkStart += chunkSize) {
      const chunkEnd = Math.min(chunkStart + chunkSize, items.length);
      const chunkIndexes: number[] = [];
      for (let i = chunkStart; i < chunkEnd; i += 1) chunkIndexes.push(i);

      // Process this chunk with bounded concurrency.
      const pool: Array<Promise<void>> = [];
      const next = (async () => {
        let cursor = 0;
        const runOne = async (i: number): Promise<void> => {
          // Already settled on a prior attempt — reuse the persisted outcome.
          if (Object.prototype.hasOwnProperty.call(completedMap, String(i)) || Object.prototype.hasOwnProperty.call(failedMap, String(i))) {
            return;
          }
          try {
            const itemOutput = await this.#runLoopIteration(ctx, node, config, items[i], i);
            results[i] = itemOutput;
            completedMap[String(i)] = itemOutput;
          } catch (err) {
            const message = (err as Error).message;
            errors.push({ index: i, message });
            failedMap[String(i)] = message;
            if (errorPolicy === 'stop_all') throw err;
          }
        };
        const workers: Array<Promise<void>> = [];
        const launch = async (): Promise<void> => {
          while (cursor < chunkIndexes.length) {
            const my = chunkIndexes[cursor++]!;
            await runOne(my);
          }
        };
        for (let w = 0; w < Math.min(concurrency, chunkIndexes.length); w += 1) {
          workers.push(launch());
        }
        await Promise.all(workers);
      })();
      pool.push(next);

      try {
        await Promise.all(pool);
      } catch (err) {
        // stop_all: bubble up (persist what completed so a resume skips it).
        delete ctx.state.activeExecutions[node.id];
        await persistLoopState(chunkEnd);
        await this.host.failNode(ctx, node.id, `loop aborted on item ${errors.at(-1)?.index ?? '?'}: ${(err as Error).message}`);
        void this.host.tick(ctx);
        return;
      }

      this.host.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.LOOP_PROGRESS, {
        runId: ctx.runId,
        nodeId: node.id,
        completed: chunkEnd,
        total: items.length,
        errors: errors.length,
      });

      // Persist per-chunk so a crash-recovery re-dispatch resumes from here
      // (skipping completed iterations) instead of replaying the whole loop.
      await persistLoopState(chunkEnd);
    }

    delete ctx.state.activeExecutions[node.id];
    const output: Record<string, unknown> = {
      [config.outputArrayKey]: results,
      count: items.length,
    };
    if (errorPolicy === 'collect_errors' && errors.length > 0) {
      output['errors'] = errors;
    }
    await this.host.completeNode(ctx, node.id, output);
    void this.host.tick(ctx);
  }

  /**
   * Run a single loop iteration by delegating to SubflowExecutor.
   * Returns the child run's final output map.
   */
  async #runLoopIteration(
    ctx: RunningContext,
    node: WorkflowNode,
    config: LoopNodeConfig,
    item: unknown,
    index: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      void this.host.deps.subflows!.start({
        parentRunId: ctx.runId,
        parentNodeId: `${node.id}:item:${index}`,
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        userId: ctx.userId,
        childWorkflowId: config.bodyWorkflowId,
        inputs: { loop: { item, index } },
        resumeParent: async (output) => resolve(output ?? {}),
        failParent: async (msg) => reject(new Error(msg)),
        startChildRun: async (childArgs) => {
          const handle = await this.host.startRun(childArgs);
          return { runId: handle.runId };
        },
      });
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Convergence loop (`converge`) — AGENT-COOPERATION-10X §Pillar 1.
  // Iterate a cohort sub-graph until a continuation policy says stop. Stateful
  // across iterations via the blackboard, owns one isolated worktree for the
  // whole cohort (§Pillar 3), and stops on goal / stall / budget / ceiling with
  // an honest terminal verdict. No graph cycle — the body subflow is re-invoked.
  // ───────────────────────────────────────────────────────────────────────

  async dispatchConverge(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ConvergeNodeConfig,
    inputData: Record<string, unknown>,
    _tctx: TemplateContext,
  ): Promise<void> {
    if (!this.host.deps.subflows) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'converge node present but SubflowExecutor not wired');
    }
    if (!config.bodyWorkflowId) {
      throw new AgentisError('VALIDATION_FAILED', 'converge node missing bodyWorkflowId');
    }
    ctx.state.activeExecutions[node.id] = {
      taskId: `converge:${node.id}`,
      nodeId: node.id,
      executorType: 'converge',
      executorRef: config.bodyWorkflowId,
      startedAt: new Date().toISOString(),
    };
    // Persist the dispatch transition so observers see the converge in flight.
    await this.host.persistRun(ctx).catch(() => {});
    void this.#runConverge(ctx, node, config, inputData).catch((err) => {
      delete ctx.state.activeExecutions[node.id];
      void this.host.failNode(ctx, node.id, (err as Error).message);
      void this.host.tick(ctx);
    });
  }

  async #runConverge(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ConvergeNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    const stateKey = config.stateKey?.trim() || node.id;
    const maxIterations = Math.max(1, Math.min(config.maxIterations ?? 8, 100));
    const stallWindow = Math.max(1, config.stallPolicy?.window ?? 2);
    const carry = config.carryStrategy ?? 'accumulate';
    const startedAt = Date.now();

    // Durable resume — pick up persisted iteration state after a crash recovery.
    const priorState = (ctx.state.nodeStates[node.id]?.outputData?.['_convergeState'] ?? {}) as ConvergeRunState;
    const history: ConvergeIterationRecord[] = [...(priorState.history ?? [])];
    let iteration = priorState.history?.length ?? 0;
    const accumulated: Record<string, unknown> = { ...(priorState.accumulated ?? {}) };
    let lastSignature: string | undefined = priorState.lastSignature;
    this.host.deps.scratchpad.hydrate(ctx.runId);

    // §Pillar 3: one worktree the whole cohort shares for the loop lifetime.
    const worktree = await this.#acquireConvergeWorktree(ctx, node, config);
    if (worktree?.path) {
      this.host.deps.scratchpad.write(
        ctx.runId,
        `${stateKey}.workspace`,
        { path: worktree.path, mode: worktree.mode },
        { namespace: stateKey, identity: CONVERGE_IDENTITY },
      );
    }

    let verdictKind: ConvergeVerdict = 'max_iterations';
    let lastOutput: Record<string, unknown> = priorState.lastOutput ?? {};
    let stallStreak = priorState.stallStreak ?? 0;

    // ASSESS + REFLECT (COGNITIVE-LOOPING-RFC). `assess` off + `maxPivots` 0 →
    // exact `converge` parity; a `pursue` node turns both on via the normalizer.
    const assess = config.assess ?? false;
    // A graded done-check yields a real 0..1 progress (judge score / objective
    // acceptance-pass fraction) → enables the plateau (s3) + regression (s4)
    // stall signals. Deterministic/signal checks are binary, so they rely on s1/s5.
    const graded = config.continuation.type === 'judge' || config.continuation.type === 'objective';
    const maxPivots = Math.max(0, config.maxPivots ?? 0);
    const deltaTrajectory: number[] = [...(priorState.deltaTrajectory ?? [])];
    const reflections: string[] = [...(priorState.reflections ?? [])];
    const pivotsUsed: string[] = [...(priorState.pivotsUsed ?? [])];
    const signatureRing: string[] = [...(priorState.signatureRing ?? [])];
    let pendingReflection: string | undefined;

    try {
      // ASSESS on entry (RFC §7.4): on a durable resume, if the prior output
      // already satisfies the done-check, settle WITHOUT acting — the cheapest
      // iteration is the one we skip. Gated on real prior state so a fresh run
      // never pays for an extra evaluation (and `converge` never enters here).
      if (assess && (Object.keys(accumulated).length > 0 || Object.keys(lastOutput).length > 0)) {
        const seed = Object.keys(accumulated).length > 0 ? accumulated : lastOutput;
        const entry = await this.#evaluateConvergeContinuation(ctx, node, config, seed, iteration);
        if (!entry.continue) verdictKind = 'goal_met';
      }
      while (verdictKind !== 'goal_met' && iteration < maxIterations) {
        // Budget breaker — wall clock (always) + real recorded cost / tokens
        // across this run and its descendant cohort runs (when a spend resolver
        // is wired). Any crossed limit stops the loop with an honest verdict.
        if (this.#convergeBudgetExceeded(ctx, config.budget, startedAt)) {
          verdictKind = 'budget_exhausted';
          break;
        }

        const iterStart = Date.now();
        const iterInput: Record<string, unknown> = {
          ...inputData,
          converge: {
            iteration,
            stateKey,
            state: carry === 'replace' ? lastOutput : accumulated,
            workspace: worktree?.path ? { path: worktree.path, mode: worktree.mode } : undefined,
            // REFLECT rung 1: the previous stall's self-critique, so the body
            // changes tack this pass instead of repeating (RFC §8).
            reflection: pendingReflection,
          },
        };
        pendingReflection = undefined; // one-shot — consumed by this iteration

        const rawOutput = await this.#runConvergeIteration(ctx, node, config, iterInput, iteration);
        // The body must not feed our control envelope back into shared state — a
        // body that echoes its inputs would otherwise create a self-referential
        // cycle (state → converge → state) that breaks run-state serialization.
        const output = stripConvergeEnvelope(rawOutput);
        lastOutput = output;

        if (carry === 'accumulate') {
          Object.assign(accumulated, output);
        } else {
          for (const k of Object.keys(accumulated)) delete accumulated[k];
          Object.assign(accumulated, output);
        }

        // Record this iteration's output so the operator + next pass can read it.
        this.host.deps.scratchpad.write(ctx.runId, `${stateKey}.iteration.${iteration}`, output, {
          namespace: stateKey,
          iteration,
          identity: CONVERGE_IDENTITY,
        });

        const decision = await this.#evaluateConvergeContinuation(ctx, node, config, output, iteration);

        // ASSESS + multi-signal stagnation detection (RFC §3.2/§6). Measure the
        // distance-to-goal delta, then vote across structural repeat / oscillation
        // / progress plateau / regression. For a plain `converge` (assess off,
        // graded off) this collapses to the original single-signal behaviour.
        const signature = convergeStableSignature(output);
        const progress = computeProgress(decision);
        deltaTrajectory.push(progress);
        const stag = detectStagnation({
          signature,
          prevSignature: lastSignature,
          signatureRing,
          deltaTrajectory,
          window: stallWindow,
          prevStallStreak: stallStreak,
          assess,
          graded,
        });
        stallStreak = stag.stallStreak;
        signatureRing.push(signature);
        if (signatureRing.length > 8) signatureRing.shift();
        lastSignature = signature;

        const record: ConvergeIterationRecord = {
          iteration,
          durationMs: Date.now() - iterStart,
          continue: decision.continue,
          verdict: decision.verdict,
          score: decision.score,
          critique: decision.critique,
          stallStreak,
          progress: graded ? progress : undefined,
          stallReasons: stag.reasons.length ? stag.reasons : undefined,
        };
        history.push(record);
        iteration += 1;

        await this.#persistConvergeState(ctx, node, {
          history,
          accumulated,
          lastSignature,
          lastOutput,
          stallStreak,
          deltaTrajectory,
          reflections,
          pivotsUsed,
          signatureRing,
        });
        this.host.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.CONVERGE_ITERATION, {
          runId: ctx.runId,
          nodeId: node.id,
          ...record,
          // ASSESS — distance-to-goal, so the canvas can show "progress N%".
          delta: graded ? Math.max(0, 1 - progress) : undefined,
          pivots: pivotsUsed.length,
          spendMs: Date.now() - startedAt,
          maxIterations,
        });

        if (!decision.continue) {
          verdictKind = 'goal_met';
          break;
        }

        // A stall is actionable only when the author asked for it: a `converge`
        // node needs a stallPolicy (parity); a `pursue` node opts in via
        // maxPivots. On a stall we REFLECT (feed a self-critique forward and try
        // a different tack) up to the pivot budget, and only then settle
        // `stalled` — the "pivot, don't quit" rule (RFC §8).
        const stallActive = !!config.stallPolicy || maxPivots > 0;
        if (stallActive && stag.stalled) {
          if (pivotsUsed.length < maxPivots) {
            const reflection = chooseReflection(decision.critique, stag.reasons, pivotsUsed.length + 1);
            reflections.push(reflection);
            pivotsUsed.push('reflect');
            pendingReflection = reflection;
            this.host.deps.scratchpad.write(
              ctx.runId,
              `${stateKey}.reflection.${iteration - 1}`,
              { reflection, reasons: stag.reasons },
              { namespace: stateKey, iteration: iteration - 1, identity: CONVERGE_IDENTITY },
            );
            this.host.deps.logger.info('pursuit.reflect', {
              nodeId: node.id,
              iteration: iteration - 1,
              reasons: stag.reasons,
              pivot: pivotsUsed.length,
              maxPivots,
            });
            continue; // REFLECT → ACT
          }
          verdictKind = 'stalled';
          break;
        }
      }

      const preserveResult = worktree ? await worktree.release() : { preserved: false };
      delete ctx.state.activeExecutions[node.id];

      // Graduate the converged knowledge from the run-scoped blackboard to durable
      // workspace memory — but only when the goal was actually met, and only the
      // surviving (non-superseded) claims, gated by the Brain's formation judge.
      if (verdictKind === 'goal_met') {
        await this.#promoteConvergedKnowledge(ctx, node, stateKey, lastOutput);
      }

      const result: Record<string, unknown> = {
        converged: verdictKind === 'goal_met',
        verdict: verdictKind,
        iterations: iteration,
        history,
        output: lastOutput,
        state: accumulated,
        // ASSESS/REFLECT observability — the progress trajectory and any
        // self-critiques the Pursuit generated on the way (RFC §3.2/§8).
        ...(deltaTrajectory.length ? { deltaTrajectory } : {}),
        ...(reflections.length ? { reflections, pivots: pivotsUsed.length } : {}),
      };
      if (preserveResult.preserved) {
        result['branch'] = preserveResult.branch;
        if (preserveResult.prUrl) result['prUrl'] = preserveResult.prUrl;
        result['changedFiles'] = preserveResult.changedFiles;
      }

      this.host.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.CONVERGE_SETTLED, {
        runId: ctx.runId,
        nodeId: node.id,
        verdict: verdictKind,
        iterations: iteration,
        preserved: preserveResult,
      });
      await this.host.completeNode(ctx, node.id, result);
      void this.host.tick(ctx);
    } catch (err) {
      if (worktree) await worktree.release().catch(() => {});
      throw err;
    }
  }

  /** Run one convergence iteration by delegating the body cohort to SubflowExecutor. */
  async #runConvergeIteration(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ConvergeNodeConfig,
    inputs: Record<string, unknown>,
    iteration: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      void this.host.deps.subflows!.start({
        parentRunId: ctx.runId,
        parentNodeId: `${node.id}:iter:${iteration}`,
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        userId: ctx.userId,
        childWorkflowId: config.bodyWorkflowId,
        inputs,
        resumeParent: async (output) => resolve(output ?? {}),
        failParent: async (msg) => reject(new Error(msg)),
        startChildRun: async (childArgs) => {
          const handle = await this.host.startRun(childArgs);
          return { runId: handle.runId };
        },
      });
    });
  }

  /**
   * Decide whether the loop should run another iteration. Three pluggable
   * sources, one interface (deterministic | judge | signal). `continue: true`
   * means keep iterating; `false` means the goal is met.
   */
  async #evaluateConvergeContinuation(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ConvergeNodeConfig,
    output: Record<string, unknown>,
    iteration: number,
  ): Promise<{ continue: boolean; verdict: string; score?: number; critique?: string }> {
    const cont = config.continuation;

    if (cont.type === 'deterministic') {
      const expr = cont.expr.replace(/^\{\{\s*|\s*\}\}$/g, '');
      let keepGoing = false;
      try {
        keepGoing = evalCondition(expr, {
          ...this.host.buildConditionScope(ctx, output),
          body: output,
          iteration,
        });
      } catch (err) {
        // A broken predicate stops the loop (fail-safe) rather than spin forever.
        this.host.deps.logger.warn('converge.continuation.expr_failed', { nodeId: node.id, err: (err as Error).message });
        keepGoing = false;
      }
      return { continue: keepGoing, verdict: keepGoing ? 'open' : 'converged' };
    }

    if (cont.type === 'signal') {
      const channel = cont.channel?.trim() || 'converge';
      const msgs = this.host.deps.scratchpad.readChannel(ctx.runId, channel, 10);
      const done = msgs.some((m) => /^done\b|__converge_done__/i.test(m.message));
      return { continue: !done, verdict: done ? 'signalled_done' : 'open' };
    }

    if (cont.type === 'objective') {
      // P1 (RFC): the done-check IS the workflow's scoped Objective. Verify the
      // iteration output against the spec's acceptance checks through the SAME
      // world-probe path the run-settle verdict uses — no self-report trusted.
      const spec = this.host.specForRun(ctx);
      if (!spec || !spec.acceptance?.length) {
        this.host.deps.logger.warn('pursuit.objective.no_spec', { nodeId: node.id });
        // No scoped Objective to verify against — stop honestly rather than spin.
        return { continue: false, verdict: 'no_objective_spec' };
      }
      const nodeOutputs: Record<string, Record<string, unknown>> = {};
      for (const [nid, ns] of Object.entries(ctx.state.nodeStates)) {
        if (ns?.outputData && typeof ns.outputData === 'object') nodeOutputs[nid] = ns.outputData as Record<string, unknown>;
      }
      const verdict = await evaluateRunVerdict({
        spec,
        graphHash: graphContentHash(ctx.graph),
        output: unwrapReturnEnvelope(output),
        nodeOutputs,
        mode: 'full',
        deps: this.host.verdictProbeDeps(ctx, spec),
      });
      const total = verdict.checks.length || 1;
      const passed = verdict.checks.filter((c) => c.passed).length;
      const accomplished = verdict.outcome === 'accomplished';
      return {
        continue: !accomplished,
        verdict: verdict.outcome,
        // Progress = fraction of acceptance checks passing → a real distance-to-goal (0..10).
        score: Math.round((passed / total) * 100) / 10,
        critique: accomplished ? undefined : verdict.deficiencies.map((d) => d.detail).join('; ').slice(0, 400) || undefined,
      };
    }

    // judge
    const resolved = this.host.resolveEvaluationRuntime(ctx, node, cont.targetPath);
    const evaluator = resolved?.runtime;
    if (!evaluator) {
      this.host.deps.logger.warn('converge.continuation.no_evaluator', { nodeId: node.id });
      // Without a judge we cannot assess convergence — stop to avoid an unbounded loop.
      return { continue: false, verdict: 'no_evaluator' };
    }
    const target = readDotPath(output, cont.targetPath) ?? output;
    const verdict = await evaluator.evaluate({
      workspaceId: ctx.workspaceId,
      target,
      criteria: cont.criteria,
      rubric: cont.rubric,
      passThreshold: cont.passThreshold,
    });
    // Meter + attribute the convergence judge's model spend.
    this.host.recordEvaluationTokens(ctx, node.id, evaluator.lastUsage, resolved?.agentId ?? null);
    try {
      this.host.deps.sharedIntelligence?.applyEvaluatorVerdict({
        workspaceId: ctx.workspaceId,
        runId: ctx.runId,
        scopeId: null,
        agentId: null,
        verdict: verdict.passed ? 'pass' : 'fail',
        evaluatorConfidence: verdict.score,
        responseText: typeof target === 'string' ? target : JSON.stringify(target),
      });
    } catch {
      /* best-effort brain feedback */
    }
    return {
      continue: !verdict.passed,
      verdict: verdict.passed ? 'pass' : 'fail',
      score: verdict.score,
      critique: verdict.critique,
    };
  }

  /** Acquire the cohort's shared isolated worktree (or none for `isolation: 'shared'`). */
  async #acquireConvergeWorktree(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ConvergeNodeConfig,
  ): Promise<WorktreeHandle | undefined> {
    if (config.isolation === 'shared') return undefined;
    if (!this.host.deps.worktrees) return undefined;
    const baseCwd = this.#resolveConvergeBaseCwd();
    if (!baseCwd) return undefined;
    const preserve = config.preserve ?? 'discard';
    try {
      const handle = await this.host.deps.worktrees.acquire({
        baseCwd,
        taskId: `run-${ctx.runId.slice(0, 8)}-${node.id}`,
        preserve,
        branchName: preserve !== 'discard' ? `agentis/run-${ctx.runId.slice(0, 8)}` : undefined,
        commitMessage: `Agentis cooperative loop — ${node.title ?? node.id}`,
      });
      if (!handle.path) {
        await handle.release().catch(() => {});
        return undefined;
      }
      this.host.deps.logger.info('converge.worktree.acquired', {
        runId: ctx.runId,
        nodeId: node.id,
        mode: handle.mode,
      });
      return handle;
    } catch (err) {
      this.host.deps.logger.warn('converge.worktree.acquire_failed', { runId: ctx.runId, nodeId: node.id, err: (err as Error).message });
      return undefined;
    }
  }

  /** Pick a base repo cwd from any registered local adapter (single-operator OSS). */
  #resolveConvergeBaseCwd(): string | undefined {
    for (const reg of this.host.deps.adapters.list()) {
      const wd = this.host.deps.adapters.workdirOf(reg.agentId);
      if (wd) return wd;
    }
    return undefined;
  }

  /** Persist iteration state so a crash-recovery re-dispatch resumes mid-loop. */
  async #persistConvergeState(ctx: RunningContext, node: WorkflowNode, state: ConvergeRunState): Promise<void> {
    const ns = ctx.state.nodeStates[node.id];
    if (!ns) return;
    ns.outputData = {
      ...(ns.outputData ?? {}),
      _convergeState: state,
      _convergeProgress: {
        iterations: state.history?.length ?? 0,
        lastVerdict: state.history?.at(-1)?.verdict,
      },
    };
    await this.host.persistRun(ctx);
  }

  /**
   * Whether the loop has crossed any budget limit. Wall-clock is always enforced;
   * cost (cents) and tokens are enforced against REAL recorded spend across this
   * run and its descendant cohort runs when a spend resolver is wired.
   */
  #convergeBudgetExceeded(
    ctx: RunningContext,
    budget: ConvergeNodeConfig['budget'],
    startedAt: number,
  ): boolean {
    if (!budget) return false;
    if (budget.ms !== undefined && Date.now() - startedAt > budget.ms) return true;
    if (budget.usd === undefined && budget.tokens === undefined) return false;
    const spend = this.host.deps.resolveRunSpend?.(ctx.runId);
    if (!spend) return false; // No real signal → don't fabricate enforcement.
    if (budget.usd !== undefined && spend.costCents / 100 > budget.usd) return true;
    if (budget.tokens !== undefined && spend.tokens > budget.tokens) return true;
    return false;
  }

  /**
   * Promote a converged loop's surviving claims (and final result) from the
   * run-scoped blackboard into durable workspace memory, via the Brain's
   * formation gate (which rejects garbage). Best-effort: never blocks the run.
   */
  async #promoteConvergedKnowledge(
    ctx: RunningContext,
    node: WorkflowNode,
    stateKey: string,
    lastOutput: Record<string, unknown>,
  ): Promise<void> {
    if (!this.host.deps.sharedIntelligence) return;
    try {
      const entries = this.host.deps.scratchpad.listEntries(ctx.runId, { namespace: stateKey });
      const claimEntries = entries.filter((e) => e.kind === 'claim');
      // Drop disputed/revised claims — keep only the surviving truth.
      const superseded = new Set(claimEntries.map((e) => e.supersedes).filter((id): id is string => Boolean(id)));
      const survivingClaims = claimEntries
        .filter((e) => !superseded.has(e.id))
        .map((e) => String(e.value ?? ''))
        .filter((s) => s.trim());
      if (survivingClaims.length === 0 && Object.keys(lastOutput).length === 0) return;
      await this.host.deps.sharedIntelligence.promote({
        workspaceId: ctx.workspaceId,
        runId: ctx.runId,
        nodeId: node.id,
        taskTitle: `Converged: ${node.title ?? node.id}`,
        taskOutput: { convergedClaims: survivingClaims, result: lastOutput },
      });
    } catch (err) {
      this.host.deps.logger.warn('converge.promote.failed', { runId: ctx.runId, nodeId: node.id, err: (err as Error).message });
    }
  }
}

/** Honest terminal verdicts — never a fake green. */
type ConvergeVerdict = 'goal_met' | 'stalled' | 'budget_exhausted' | 'max_iterations';

/** The system identity stamped on controller-authored blackboard entries. */
const CONVERGE_IDENTITY = { runtime: 'system', label: 'Converge controller' } as const;

interface ConvergeIterationRecord {
  iteration: number;
  durationMs: number;
  /** Whether the controller decided to run another pass after this one. */
  continue: boolean;
  /** Continuation verdict: open | converged | pass | fail | signalled_done | … */
  verdict: string;
  score?: number;
  critique?: string;
  /** Consecutive no-change iterations leading up to (and including) this one. */
  stallStreak: number;
  /** ASSESS — distance-to-goal progress 0..1 for this iteration (graded checks only). */
  progress?: number;
  /** Which stagnation signals fired this iteration (RFC §6). */
  stallReasons?: string[];
}

/** Persisted controller state — enough to resume a loop mid-flight after a crash. */
interface ConvergeRunState {
  history?: ConvergeIterationRecord[];
  accumulated?: Record<string, unknown>;
  lastSignature?: string;
  lastOutput?: Record<string, unknown>;
  stallStreak?: number;
  /** ASSESS — progress 0..1 per iteration (the PRM-style trajectory). */
  deltaTrajectory?: number[];
  /** REFLECT — verbal self-critiques generated on stalls, fed forward. */
  reflections?: string[];
  /** REFLECT — pivots spent, so a resume respects the pivot budget. */
  pivotsUsed?: string[];
  /** Recent-K output signatures, for oscillation detection. */
  signatureRing?: string[];
}

/**
 * Remove the reserved `converge` control envelope from a body's output so it
 * never re-enters accumulated state (a body that echoes its inputs would create
 * a `state → converge → state` cycle).
 */
function stripConvergeEnvelope(output: Record<string, unknown>): Record<string, unknown> {
  if (!output || typeof output !== 'object' || !('converge' in output)) return output;
  const { converge: _omit, ...rest } = output;
  return rest;
}

/**
 * Order-independent structural signature of an iteration's output, used for
 * stall detection. Two iterations with the same signature made no material
 * progress.
 */
function convergeStableSignature(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
    );
  };
  try {
    return JSON.stringify(norm(value));
  } catch {
    return String(value);
  }
}
