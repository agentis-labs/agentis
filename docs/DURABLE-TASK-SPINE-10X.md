# Durable Task Spine — the living contract for a task an agent accepts

**Thesis (operator + architect, 2026-06-17):** When a person hands an agent a big
task, the task itself has **no durable, typed, operator-inspectable home**. Its
state is smeared across four slices that each see only part of it. The fix is **not
a new entity** — it is to lift the object we already have (`ChatPlan`) to the right
altitude and connect it to execution. This is the missing *coordination layer*
between a conversational intent and a workflow run.

> Status: **PLAN**. Grounded in the current code (file refs below). Honors
> [[feedback_no_duplication]] (extend `planService`, don't fork a third plan model)
> and the AGENT-AUTONOMY non-negotiable **"no third runtime."** This doc reconciles
> against and *depends on* [[project_agent_autonomy_10x]] (`docs/AGENT-AUTONOMY-10X.md`),
> most of whose capabilities are already shipped.

---

## 0. Why this is not "temporary workflows"

The operator's question was: *should we build temporary workflows for tasks people
ask agents, so the agent always knows what it's doing and the operator can always
track it — without building something a better model makes obsolete?*

A temporary workflow is the wrong shape: a workflow is a **prescription authored
before reality**, and it becomes a lie the moment the agent meets something it
didn't imagine at step zero. What's actually missing is a **living contract**,
co-authored by the agent and the operator *as execution proceeds*: objective,
verifiable "done," decisions made, deviations from plan, and where execution is
right now. A typed DB row — not a graph, not a trace, not a context window.

Crucially, this object must sit **above the harness/adapter boundary** (Claude
Code / Codex / Cursor / Hermes today, **our own harness tomorrow**). A harness then
becomes *one executor that reports into the contract* — the contract is unchanged
when the harness changes. That is the real forward-compatibility: the spine is
orthogonal to whatever is executing beneath it, so model/harness churn can't make
it obsolete.

---

## 1. What exists today (verified)

| Slice of "the task" | Where | What it sees / misses |
|---|---|---|
| Agent working memory | `AgentSession` persona/task/**plan**/observations blocks ([agentSession.ts:27](../apps/api/src/services/agentSession.ts)) | **opaque free text**, agent-private, **per-session**. A task spanning multiple sessions/runs has no home. `reconstructContext` already rebuilds the window from blocks, not chat ([agentSession.ts:362](../apps/api/src/services/agentSession.ts)). |
| Execution state | `WorkflowRunState` node states, `EphemeralWorkflow` | a **trace**, per run. Not "the task." |
| Deviations | `flag_deviation` ([agentSessionRuntime.ts:540](../apps/api/src/services/agentSessionRuntime.ts)) | **shipped (W5.1)** — but writes to the **run-scoped scratchpad** + broadcasts a `deviations` channel. Ephemeral, run-bound, not a durable row on the task. |
| The plan | `ChatPlan` ([plan.ts:68](../packages/core/src/types/plan.ts)) | already has `objective`, **`acceptanceCriteria`**, `assumptions`, `PlanStatus: draft→ready→approved→executing→completed→failed`, versioned nodes w/ approval. But **`conversationId`-bound, authored before execution, dies when execution starts.** |
| Autonomy capabilities | Agent Autonomy 10x (**shipped**) | `spawn_team`, `run_workflow`, `build_workflow`, `flag_deviation`, self-heal, operating manual. The agent *can already* deviate, replan, spawn teams, run workflows-as-tools. |

**The gap is not capability and not primitives — it is durability + altitude.**
`ChatPlan` already models objective / criteria / steps / status / approval. It is
simply trapped at conversation scope, authored once, disconnected from the runs
that execute it, and its "done" is asserted, not verified.

---

## 2. The reframe

**Don't add an `Intent`. Promote `ChatPlan` into a durable Task Spine** that
outlives the conversation and binds the runs + sessions beneath it. The spine needs
exactly **four** things it doesn't have today — and only four:

1. **Durable identity above the conversation** — `conversationId` becomes optional;
   add the binding edges `runIds[]`, `sessionId`. A task accepted from a *channel*
   or a *schedule* (no chat) still gets the object.
2. **A live status fed by execution, not assertion** — `WorkflowRunState`
   completion and `AgentSession` status feed the spine's status; add `blocked` /
   `verifying` to `PlanStatus`.
3. **Acceptance criteria as a completion *gate*** — `acceptanceCriteria` is today a
   string array nobody enforces. Make `complete_task` *verify* against it via a
   cheap grounded judge (reuse FormationJudge / the self-heal intent-judge
   discipline). "Done" is earned, not claimed — the cure for hallucinated
   completion.
4. **The Correction Protocol on a durable surface** — promote `flag_deviation`'s
   scratchpad write into a **row on the spine**; add a `record_decision` sibling;
   an operator-facing inspector reads **one row** and can redirect-without-cancel
   (reuse the existing `wake()` + observations-injection + `request_approval`
   machinery, [agentSession.ts:271](../apps/api/src/services/agentSession.ts)).

`planBlock` stops being the source of truth and becomes a **projection/pointer**
into the spine — the contract is the source, the memory block is the cheap
re-readable view.

---

## 3. Why NOT the `intent`/`intent_steps` design

The "Intent Layer" proposal (`intent_layer_architecture.md`) reaches the right
diagnosis but proposes a **parallel subsystem** that duplicates what ships today:

| Proposed as new | Already exists |
|---|---|
| `intents` + `intent_steps` tables | `ChatPlan` + `PlanNode`/`PlanEdge` (`planService`) |
| `Intent.objective / acceptanceCriteria / constraints` | `ChatPlan.objective / acceptanceCriteria / assumptions` |
| `IntentStatus` | `PlanStatus` (near-identical lifecycle) |
| `IntentStep{status, dependsOn, runId, result}` | `PlanNode` + `PlanEdge` + live-graph-splice + `EphemeralWorkflow` |
| `IntentDeviation` log | `flag_deviation` + scratchpad (**shipped, W5.1**) |
| `task_accept` + `step_*` + `record_decision` tools | `spawn_team`/`run_workflow`/`build_workflow`/`flag_deviation` (**shipped**) |

Building it as written creates a **third plan-like object** next to `ChatPlan` and
`WorkflowGraph`, and couples the task contract to **session control tools** — which
re-derives the moment the harness changes. That is precisely the "garbage in a
month" outcome. The spine reuses `planService`, the plan-canvas UI, the approval
lifecycle, and the autonomy tools, and adds *only* durability + cross-run binding +
the verification gate.

---

## 4. Workstreams

- **S0 — Promote `ChatPlan` to a durable Task.** `conversationId` optional; add
  `runIds[]`, `sessionId`, `blocked`/`verifying` to `PlanStatus`, durable
  `decisions[]` / `deviations[]`. Migration on the existing plan table — **no new
  parallel table.**
- **S1 — Bind execution into status.** Run/session completion writes back into the
  spine; `planBlock` becomes a projection of the spine, not the source.
- **S2 — Acceptance-criteria gate (highest leverage).** `complete_task` verifies
  against criteria via a grounded judge; failure → `verifying`/`blocked`, never a
  silent "done." Anti-hallucination discipline from W7 / FormationJudge.
- **S3 — Durable decision/deviation rows.** Promote `flag_deviation` and add
  `record_decision` to write rows on the spine instead of the run scratchpad.
- **S4 — Inspector + Correction Protocol.** Operator view reads one row; "redirect"
  injects a correction through the existing wake/observations path; pause/abandon.

**Sequencing:** S0 → S1 → **S2** (the real value: verified completion) → S3 → S4.

## 5. Non-negotiables

1. **No third plan model.** Evolve `ChatPlan`/`planService`; do not add `intents`.
2. **Harness-agnostic.** The spine is a DB row + verification contract *above* the
   adapter boundary; every harness (current + our own) reports into it.
3. **Verified, not asserted.** Completion gates on grounded acceptance criteria.
4. **Grounded corrections.** Deviations/decisions cite real evidence; operator
   redirect is audited and reversible (reuse W7 R1–R7 discipline).
5. **Reconcile, don't re-propose.** The autonomy *capabilities* are shipped; this
   doc connects them to a durable object, it does not rebuild them.

## 6. Open decision

**The one real fork:** widen `ChatPlan` itself into the spine (cheaper; reuses the
plan canvas + approval lifecycle wholesale) **vs.** a thin durable Task *parent*
that `ChatPlan` projects from (cleaner separation from conversation-authoring
baggage — viewport, node positions). **Lean: widen `ChatPlan` first; split out a
parent only if conversation-coupling actually bites.** Confirm before S0.

## 7. Implementation log

_(append here as workstreams land, per [[feedback_masterplan_log]])_

- **2026-06-17 - S0/S1/S2/S3 backend spine landed.** `ChatPlan` is now widened
  into a durable task spine: optional `conversationId`, `runIds[]`, `sessionId`,
  `blocked`/`verifying` statuses, durable `decisions[]`, `deviations[]`, and a
  verification receipt. SQLite fresh schema, embedded drift normalization, and
  versioned migration `74_durable_task_spine` keep existing databases aligned.
  `PlanService` now owns task acceptance, run/session binding, status reporting,
  decision/deviation records, and completion verification. `AgentSessionRuntime`
  gates `complete_task` through the spine when bound, records `flag_deviation`
  durably, and exposes `record_decision`. `WorkflowEngine` reports run/session
  edges and terminal status into the spine while keeping workflows as tools.
  Platform tools added: `agentis.task.accept`, `agentis.task.inspect`,
  `agentis.task.bind_run`, `agentis.task.record_decision`,
  `agentis.task.flag_deviation`; `agentis.workflow.run` accepts `taskId`/`planId`.
  Operator inspector backend added at `/v1/tasks/spines`, including
  `/v1/tasks/spines/:id/redirect` to audit the redirect and inject it into the
  live session observations path. Focused coverage:
  `WorkflowEngine.agentSession.test.ts` verifies rejected completion retry +
  durable decision/deviation rows; `tasks.test.ts` verifies redirect injection;
  DB migration tests pass.
- **2026-06-17 - Realtime visibility landed.** The task spine now emits a closed
  realtime event family on the workspace room: accepted, updated, bound,
  verifying, verified, completed, blocked, failed, decision recorded, deviation
  recorded, and redirected. `PlanService` publishes these events from the durable contract
  layer, so Mission Control / canvas subscribers observe task truth without
  coupling to a specific harness. The workspace canvas SSE mapper translates task
  spine progress and attention events; the web realtime activity mapper includes
  them in the Mission Control feed and liveness model. Focused coverage verifies
  verification events from `complete_task`, redirect events from the inspector,
  and web mapping for verifying/blocked task activity.
