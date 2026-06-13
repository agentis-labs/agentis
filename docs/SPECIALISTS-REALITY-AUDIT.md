# Specialists / Smarter-Agents — Reality Audit (doc vs. real code)

> Date: 2026-06-06. Reconciles `SPECIALISTS-10X-ARCHITECTURE-PLAN.md` and
> `SMARTER-AGENTS-10X.md` against the actual codebase. Both docs' implementation
> logs claim near-total completion. **They are right that the code was built — and
> wrong that it is in use.** This audit separates "exists in the repo" from "runs
> when you actually use Agentis." Evidence is cited as `file:line`.

## TL;DR

The 10x runtimes are **real code that is tested but bypassed by the default path.**
A specialist `agent_task` — what *every AI-built workflow* uses — is a **single,
tool-less LLM completion with a rich context prompt.** It is exactly the
"sophisticated function call, not a decision-maker" that `SMARTER-AGENTS-10X.md`
opens by decrying. The autonomous runtime that fixes this (`agent_session`:
tools, delegation, memory blocks, yield/sleep, multi-step) **exists and passes its
tests**, but:

1. the **workflow builder can't emit it** — `agent_session` / `planner` /
   `dynamic_swarm` are missing from the synthesis grammar
   (`build.ts:1977-1982`), so the architect LLM only ever produces `agent_task`;
2. the **dispatch adapter passes no tools** — `HermesAdapter.#runTask` sends
   `{ messages, max_tokens }` with no `tools` field (`HermesAdapter.ts:392-403`),
   so a dispatched specialist *cannot call a tool even if it wanted to*; only the
   chat path (`chat()`, `:210`) is tool-capable;
3. the **specialist "brain" subsystems** (demand router, profiles, cards, eval,
   Studio) are **side systems** the default build→run path never invokes.

So your intuition is correct and now has a mechanism: specialists are *well-briefed
single-shot text generators*, not autonomous agents. (Until the dispatch fix landed
this session, they didn't even run — `taskId`≠`nodeId` left them hung, on top of
having no model.)

## What IS real and DEFAULT (genuinely wired into every agent_task)

`WorkflowEngine.#withWorkspaceContext` (`:2202`) assembles, for every dispatched
agent task, a layered context prompt — and this part of the SPECIALISTS plan is
genuinely live:

- **Role identity / persona** via `#specialistDef` (built-in → library → generic).
- **Specialist Mind** injection — `specialistMind.contextBlock(...)` (`:2290-2294`).
- **Ability loadout** — `#buildAbilityBlock` resolves the role's
  required/preferred/forbidden abilities (`:2380-2413`).
- **Workspace Brain, agent memory, personal brain, space context** — all folded in.
- **Layer 0/1 (this session):** agent_task now actually runs on an inherited
  runtime, completion maps back (`taskId=node.id`), and reasoning streams live.

So a specialist is **deeply briefed**. What it lacks is **agency**.

## What is BUILT but OPT-IN / unreachable by the builder

| Capability (doc) | Code exists? | Reachable by the AI builder? |
|---|---|---|
| `agent_session` autonomous runtime (tools, yield, memory blocks, sleep/wake) | ✅ `agentSessionRuntime.ts`, tests green | ❌ not in synthesis grammar; only manual canvas node or `useSession` |
| `delegate_task` / `await_event` / `sleep_until` / `request_approval` yields | ✅ engine handles them | ❌ only inside a session (above) |
| `planner` node (dynamic graph) | ✅ runs steps; `applyGraphPatch` splice deferred | ❌ not in grammar |
| `dynamic_swarm` node | ✅ exists | ❌ not in grammar |
| In-engine role-tools ReAct loop (`#maybeRunAgentToolLoop`) | ✅ exists | ⚠️ only if `useRoleTools` set AND an evaluator runtime is configured — builder never sets `useRoleTools` |
| `evaluator` / `loop` self-correction nodes | ✅ exist | ⚠️ builder rarely emits; no default quality loop |

Net: the autonomy layer is a **parallel runtime the default product never selects.**

## What is BUILT but a SIDE SYSTEM (not in the default flow)

These exist (services, tables, routes, some UI) but the normal "ask the orchestrator
to build & run a workflow" path does **not** invoke them; they're reachable only via
explicit tools/API:

- **SpecialistDemandRouter** (`POST /v1/specialists/request`,
  `agentis.specialist.request`) — scores/selects/commissions specialists. The
  builder uses `materializeCast` (role→`ensureRole`) instead, so routing/explanation
  never happens in practice.
- **SpecialistProfile / Card / RuntimeProfile** (migrations v56/v58) — durable
  definitions + A2A-aligned cards. Largely metadata; the runtime contract
  (autonomy/budget/tools) is not enforced on the default dispatch.
- **Specialist Mind ingestion UI + Eval Lab + Live Cast (Studio)** — present on the
  agent detail page for specialist roles, but mind is rarely populated and evals are
  deterministic stubs; nothing gates "ready" in the default flow.
- **Specialist tables for eval/quality/runs** — written by the side flows, not by a
  normal workflow run.

## The three concrete reasons agent_task feels weak

1. **Single-shot by construction.** The builder emits `agent_task`; the grammar
   hides `agent_session`. One node = one completion. No think→act→observe loop.
2. **Tool-less by dispatch.** `#runTask` sends no `tools`; the rich `toolManifest`
   on the task is, by its own comment, "awareness only." The agent is *told* tools
   exist but is given no way to call them.
3. **Agency subsystems unused.** Delegation, memory blocks, run-awareness, demand
   routing, evaluation loops — all built, none on the path a user actually triggers.

## The real gap to close (recommendation, not yet implemented)

Make the autonomy layer the **default for reasoning-heavy work**, not an opt-in
buried behind a node kind the builder can't name. Highest-leverage, in order:

1. **Auto-upgrade dispatch to a tool-capable loop.** When a dispatched agent has
   tools/role-tools available, run a bounded ReAct loop (reuse
   `#maybeRunAgentToolLoop` / the session runtime) instead of a single `#runTask`
   completion — so a specialist can actually *act*. This is the single biggest
   power unlock and is mostly wiring existing pieces.
2. **Teach the builder the autonomous nodes.** Add `agent_session` (and
   `planner` / `dynamic_swarm` / `evaluator` / `loop`) to the synthesis grammar
   (`build.ts:1977`) with guidance: use `agent_session` for any task that needs
   tools, delegation, or multi-step reasoning; keep `agent_task` for one-shot
   transforms. Then "build me a workflow that researches X and decides Y" yields
   real agents.
3. **Pass tools on dispatch + enforce the runtime profile.** Give `#runTask` (and
   the other adapters' task path) the role's tool manifest + `tool_choice`, and
   honor `SpecialistRuntimeProfile` (model policy, budget, autonomy) at dispatch.
4. **Route, don't hardcode.** Have the builder/engine consult the
   `SpecialistDemandRouter` (which already exists) so specialist selection is
   scored + explainable, instead of bare role materialization.
5. **Close the loop with evals** only after 1–4 — otherwise eval is theater.

None of this requires net-new architecture — it requires **connecting the built
runtime to the default path**. The docs' logs measured "did we write the code";
the missing measure was "does the thing a user actually does invoke it."

## Resolution — gap fixes shipped (2026-06-06)

The disconnect is now closed; the built runtime is wired to the default path.

- **A. `agent_task` is agentic by default.** `#maybeRunAgentToolLoop` no longer
  requires `useRoleTools`/a platform role: ANY agent task whose specialist has a
  tool manifest runs the bounded reason→act→observe loop (`AgentToolLoop`) on the
  manifest-enforced runtime, completing synchronously and **streaming its reasoning
  + tool calls** into the run activity spine (so it shows in the monitor / triage /
  canvas). Custom/generated specialists now get a **universal default toolbox**
  (`DEFAULT_SPECIALIST_TOOLS` / `effectiveSpecialistTools` — web, knowledge, memory,
  workflow state, compute, call_workflow) instead of an empty toolbox. The runtime
  honors an explicit granted set (`AgentToolContext.grantedTools`) so custom roles
  can act while platform roles keep their manifest. External dispatch remains the
  fallback when there is no tool runtime/eval model, the task opts out
  (`useRoleTools: false`), the task requires affordances the platform loop cannot
  satisfy, or the assigned adapter already owns an agentic harness loop
  (`marker_protocol`, `mcp_native`, `session_event`). Tests: a PLAIN agent_task
  (no flag) runs the loop; a custom role (`tax_analyst`) calls a tool; a Codex-style
  adapter is not bypassed.
- **B. The builder reaches the autonomous runtime.** The synthesis grammar now
  exposes `agent_session` (delegation / persistent memory / yield-sleep),
  `dynamic_swarm`, and `planner` with **configs that match the validator exactly**
  (`agent_session.prompt`; `dynamic_swarm.goal/outputKey/maxTasks`;
  `planner.goal`), plus selection guidance and an upgraded `agent_task`
  description ("a real tool-using agent — give it an ambitious mission").
  `materializeCast` already commissions agents for these kinds.
- **C. Tools-on-dispatch + router.** Subsumed by A (the loop carries tools, so the
  toolless `#runTask` path is only the no-runtime fallback). The
  `SpecialistDemandRouter` was already connected to its proper surface
  (`agentis.specialist.request` / `POST /v1/specialists/request`) — the gap was
  agent_task autonomy and builder reach, both now closed. (Per-task model from
  `SpecialistRuntimeProfile` remains a future refinement; the loop uses the
  workspace evaluation model today.)

Net: a specialist is now **a tool-using, multi-step agent by default**, observable
live, and the orchestrator can build workflows that delegate, swarm, and self-plan.

## Resolution Round 2 — autonomy is now the DEFAULT, not opt-in (2026-06-08)

The 06-06 round made `agent_task` *tool-capable* but left the genuinely powerful
layers (full session, delegation, scored routing, live planner) opt-in or
side-system. This round wires them into the default path. All in
`apps/api/src/engine/WorkflowEngine.ts` unless noted; API typecheck clean; the 15
session/delegation engine tests green.

- **A. `agent_task` runs as a full AgentSession by default.** New
  `#shouldRunAsSession` gate: when the session runtime is wired, a
  role/capability-resolved `agent_task` now runs the persistent cognitive loop
  (working memory blocks, `delegate_task` to sub-specialists, `await_event` /
  `sleep_until` / `request_approval` yields, compaction) — the same runtime as
  `agent_session`. `agent_task` and `agent_session` have **converged**. Opt out
  with `useSession:false` / `useRoleTools:false` for a deterministic one-shot
  transform; an explicit `agentId` bound to a connected runtime (Codex/Claude
  CLI/HTTP) keeps its own adapter loop and is never downgraded to the shared
  session LLM. When the session runtime is NOT wired (no evaluation model), the
  bounded tool loop remains the fallback.
- **B. The SpecialistDemandRouter is on the dispatch path.** New
  `#maybeRouteSpecialist`: an `agent_task` that names no concrete specialist (no
  `agentId`, only a generic/empty role) now consults `SpecialistDemandRouter`
  for a scored selection and records an explainable `specialist.routed` activity
  event ("Selected Frontend Architect because …") instead of silently falling
  back to a bare `specialist`. Wired via a narrow `SpecialistRouterPort` in
  `EngineDeps` + `bootstrap.ts`. No-op when the router is unwired or the task
  already names a real specialist.
- **C. The `planner` node rewrites the live graph.** `#runPlanner` →
  `#splicePlanIntoGraph`: the planner now synthesizes `agent_session` worker
  nodes and **splices them into the running graph** via `applyGraphPatch`
  (planner → step1 → … → stepN, with the planner's former successors re-routed to
  the tail), emitting `CANVAS_NODE_PLACED` / `CANVAS_EDGE_CONNECTED` so the plan
  materializes on the canvas and each step executes through the normal tick. Falls
  back to the prior inline-sequential execution if the spliced graph fails
  validation (e.g. a terminal planner). The deferred splice is no longer deferred.

Net: the autonomy runtime is the product's default behavior, not a parallel
system the default path skips. Remaining genuine gaps (honest): **session
restart-durability** (wake registrations for parked sessions are still in-memory,
so a process restart drops `await_event`/`sleep_until`/approval parks) and
per-task enforcement of `SpecialistRuntimeProfile` model/budget policy on dispatch.

## Resolution Round 3 — zero-config model + session durability (2026-06-08)

Round 2 made autonomy the default *when a model is configured*. The remaining
friction: that gating required `.env` (`AGENTIS_EVALUATOR_*`), and parked sessions
didn't survive a restart. Both fixed.

- **A. Zero-config model — no `.env` required.** The session/evaluation model now
  resolves **per-workspace** through `OrchestratorModelRouter` with precedence
  Settings (`/v1/orchestrator/models`) → env → **first connected agent runtime**.
  New `PlatformModelService` derives a `{ baseUrl, model, apiKey }` profile from
  the workspace's first `http` agent (cached 15s); wired as the router's
  `fallbackProvider`. `AgentSessionRuntime` gained `resolveAdapter(workspaceId)` +
  `canRun(workspaceId)`; the engine's `#shouldRunAsSession` consults `canRun` so a
  workspace with NO model anywhere degrades cleanly to the tool loop / single-shot
  instead of failing at the first step. `bootstrap.ts` no longer gates
  `sessionRuntime` on env — it's always constructed and resolves live, so
  connecting one agent (or setting a model in Settings) lights up the whole
  autonomy stack with no restart. (`engine.sessions.disabled` log is gone.)
- **B. Parked sessions survive a restart.** The wake condition was already
  persisted on the session row (`status='waiting'`, `wakeCondition`,
  `suspendPayload.toolCallId`), but boot recovery never re-armed it — a run parked
  only on `await_event`/`sleep_until`/session-`request_approval` stayed WAITING
  forever. `recoverInterruptedRuns` now calls `#recoverParkedSessions`:
  `AgentSessionService.listWaiting()` → rehydrate each run's ctx → re-register the
  wake by kind (event waiter / re-armed timer firing immediately if elapsed /
  pending-approval link with kind `session`). Session approvals are excluded from
  the checkpoint-recovery pass (matched by a waiting `approval:*` session on the
  same node) so they're not mis-registered. Covered by a new e2e test: park on
  engine A, recover + resume on a fresh engine B.
- **C. The 26 "failures" were flaky, not regressions.** Triaged: every failing
  engine test (`workspaceBudget`, `tier3Audit`, …) is **green in isolation** and
  fails only in the full parallel suite. Cause: each test uses an isolated
  `:memory:` DB (no shared state), but the `run()` helpers wait up to **15s** for a
  terminal event while vitest's `testTimeout` was **10s** — under full-suite CPU
  saturation (forks pool + per-test RSA keygen + esbuild) a slow-but-correct run
  is aborted before its own deadline. Fixed by raising `testTimeout`/`hookTimeout`
  to 30s in `vitest.config.ts`. Not a product bug, not caused by Rounds 1–3.
- **D. Settings surfaces the autonomy state.** `GET /v1/orchestrator/models` now
  returns `autonomy: { enabled, model }` (mirrors the engine's `canRun`:
  evaluation → conversation incl. the first-agent fallback). `OrchestratorModelsPanel`
  shows a warning banner — "No autonomy model is configured … specialists fall back
  to single-shot" — when it's false, pointing the operator to connect an agent or
  set a Conversation/Evaluation model. Never asks them to edit `.env`. Tests: API
  route (5) + web panel (4, incl. banner show/hide) green.

## Verification method

Read paths: `WorkflowEngine.#dispatchAgentTask` / `#withWorkspaceContext` /
`#maybeRunAgentToolLoop` / `#runAgentSession`; `HermesAdapter.#runTask` vs `chat()`;
`build.ts` synthesis grammar + `materializeCast`; `agentSessionRuntime.ts`;
`specialists.ts` routes + `SpecialistDemandRouter`. Cross-checked the docs'
implementation logs claim-by-claim against these.
