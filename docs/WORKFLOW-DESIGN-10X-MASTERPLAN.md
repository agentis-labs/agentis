# Workflow Design 10x — teaching agents to build robust, failure-aware workflows

## Problem

The agent produced naive, linear, happy-path workflows. Root cause was in the
**creation pipeline**, not the model:

- `planWorkflow` (creationPipeline.ts) hard-codes a 4-stage line `Gather → Analyze
  → Draft → Deliver` — no vocabulary for gates, reject loops, fallbacks, approvals,
  validation, or rollback.
- `classifyIntent` keyword-counts into 4 archetypes and is **blind** to robustness
  signals (qualification, approval, validation, irreversibility, recurring state, batch).
- The "Iron Rules" are structural hygiene; the reviewer and `preflightAndEnrich`
  audit hygiene, never robustness. Nothing demands a gate before an irreversible
  deploy, a fallback for a flaky fetch, dedup state for a recurring run, or a bound
  on a batch — so the agent never supplies them.

The reference: `~/.codex/skills/store-demo-protocol` — a real process that is ~80%
gates, reject/re-prospect loops, ~25 documented failure-modes-with-fallbacks,
approval-before-deploy, validate-before-`deployed`, per-brand state, bounded
parallelism, and rollback. That is what a *perfect* workflow encodes.

## Mechanism decision

Not a standalone external skill (Agentis agents don't run the Codex/Claude skill
harness — their behavior is the orchestrator prompt + the build pipeline + tools).
Not an ability (wrong layer — optional, agent-pinned). **The fix is the codebase
creation pipeline** (universal, every build, every agent) **plus a living, editable
Workflow Playbook** (the self-improving analog of the hand-maintained protocol).

## The five phases (all shipped 2026-06-25)

1. **Workflow Design Doctrine** — `workflowDesignDoctrine.ts`. A failure-mode-first
   design playbook (D1–D6) + named pattern catalog, injected into the synthesis
   preamble, the reviewer, and the orchestrator architecture knowledge (all three
   share `SYNTHESIS_ARCHITECT_PREAMBLE`). Teaches: add a reject branch (D1), gate
   irreversible actions (D2), give flaky fetches a fallback + result check (D3),
   keep dedup state on recurring runs (D4), bound batches (D5), validate-then-
   rollback (D6).

2. **Robustness audit + enforcement** — `workflowRobustnessAudit.ts`, wired into
   `createWorkflowFromDescription` after `preflightAndEnrich`. Deterministically
   flags MISSING_STATE / SINGLE_BRANCH_ROUTER / MISSING_DELIVERY_GUARD /
   NO_FAILURE_HANDLING and **auto-repairs** UNBOUNDED_BATCH (caps loop/swarm
   concurrency). The reviewer prompt now audits the doctrine (D1–D6), not just
   structure. So even a naive draft comes out more robust.

3. **Robustness-aware classifier + planner** — `classifyIntent` gains a
   `robustness` signal block (qualifies/approval/validates/irreversible/batch);
   `planWorkflow` emits real **gate / approval / validate** Phase Cards (with a
   `kind`), and `assembleGraphFromPlan` materializes them into checkpoint/evaluator
   nodes. `renderCreationBrief` surfaces a "ROBUSTNESS REQUIREMENTS" block so the
   synthesis model is told exactly which gates/state this request needs.

4. **Pattern library** — `workflowPatterns.ts` + the `agentis.workflow.patterns`
   tool. Six spliceable sub-graph fragments (qualify-or-reject-loop, fetch-with-
   fallback, approval-before-irreversible, validate-before-transition, bounded-
   parallel-batch, stateful-cursor-dedup) **including their reject/fallback/rollback
   branches** — the agent composes a proven shape instead of reinventing it.

5. **Self-improving Workflow Playbook** — `workflowPlaybook.ts` + the
   `agentis.workflow.learn` tool. Workspace-scoped `failure-mode → fix` lessons
   stored on the existing memory substrate (no migration), recalled into every
   synthesis brief and appended by the agent/repair loop after a novel run failure.
   The workspace gets smarter over time, like the hand-maintained protocol — but
   wired to real runs.

## Impl log — 2026-06-25

- New: `workflowDesignDoctrine.ts`, `workflowRobustnessAudit.ts`, `workflowPatterns.ts`,
  `workflowPlaybook.ts`.
- Changed: `agentisToolHandlers/build.ts` (doctrine injection into synthesis +
  reviewer; robustness audit in the build; `assembleGraphFromPlan` phase-kind
  materialization; `renderCreationBrief` robustness block; playbook recall into
  synthesis; new tools `agentis.workflow.patterns` + `agentis.workflow.learn`;
  `RepairAction` kind `robustness_bound`), `creationPipeline.ts` (`RobustnessSignals`
  on `IntentClassification`, detection in `classifyIntent`, `PlanPhaseKind` + guard
  phases in `planWorkflow`, robustness warning codes on `PreflightWarning`),
  `orchestratorPrompt.ts` (doctrine in `PLATFORM_ARCHITECTURE_KNOWLEDGE`),
  `chatToolCatalog.ts` (the two new tools).
- Verification: api typecheck clean; 61 tests green — new: workflowRobustnessAudit (7),
  workflowPlanRobustness (2), workflowPatterns (3), workflowPlaybook (2); no regressions
  in createWorkflowDelivery (17), agentisChatTools (11), appChatTools (6), mcpRpc (9),
  workflowIo (4).

## Impl log — 2026-06-25 (2): closed both deferrals

- **Non-linear plan assembly** (`assembleGraphFromPlan`, now exported): a gate/validate
  Phase Card materializes as an evaluator whose forward edge becomes a PASS branch
  (`type:'condition'` → auto-routes on the evaluator's `passed`) and that gains a FAIL
  branch — a clean "Rejected" terminal for a gate, or a rollback→terminal for a
  validate (`condition: 'output.passed == false'`). All forward + acyclic, so it passes
  `validateWorkflowGraph` (cycles always throw, even non-strict). Grounded in the engine:
  `shouldTraverseEdge` (implicit `passed`/explicit condition) + `SafeConditionParser`
  (supports `==`, `false`, dotted paths). Test: `assembleGraphFromPlan.test.ts` (4).
- **Auto-capture from `run.diagnose`**: the handler now runs `analyzeRunFailure`; when
  the cause is RECOGNIZED it records a `failure-mode → fix` playbook lesson (deduped on
  title, best-effort, never throws) and returns the grounded explanation/fixes. So the
  workspace learns from real failures without the agent having to remember to call
  `agentis.workflow.learn`. Test: `diagnoseAutoLearn.test.ts` (2).
- Verification: api typecheck clean; +6 tests (assembleGraphFromPlan 4, diagnoseAutoLearn 2).
