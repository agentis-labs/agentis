# Agent Cooperation 10X — Convergence Loops, the Blackboard, and Isolated Workspaces

**Status:** PROPOSED — 2026-06-26
**Thesis:** Agentis already orchestrates *heterogeneous coding runtimes* (Opus, Codex, Cursor, Hermes…) as graph nodes — a capability most frameworks lack. What it does **not** yet have is a way for those runtimes to *cooperate tightly on a single objective*: iterate as a cohort until a goal is met, share a live working state, and edit code without clobbering each other — all under an operator's eye. This plan closes that gap with three interlocking primitives that are general to **every** agentic application, not just the bug-fix example.

> Motivating example (used throughout): *Opus 4.8 researches outstanding bugs → Codex 5.5 fixes them → re-check → repeat until zero bugs remain.* This is one shape of a universal pattern: **a cohort of specialists converging on a goal across iterations.**

---

## Part 0 — Reality audit (what actually exists today)

Per our masterplan convention, we start by correcting premises against real code. None of these three pillars is missing; two are built-but-under-wired, and the third is genuinely greenfield.

### A. Runtime isolation — BUILT, swarm-only
- [`WorktreeManager`](../apps/api/src/services/worktreeManager.ts) allocates per-task isolated dirs: `git_worktree` (`git worktree add --detach` of HEAD) when the base is a repo, else `temp_dir`, else `none`. Best-effort, never throws, idempotent `release()`.
- **Wired into only `agent_swarm`** — [`WorkflowEngine.ts:5686`](../apps/api/src/engine/WorkflowEngine.ts) (`#acquireSwarmWorktree`). `agent_task`, `agent_session`, `dynamic_swarm`, and **sequential** multi-runtime chains share one static `cwd`.
- Swarms **merge outputs, not files**; the worktree is discarded on release. No branch/PR preservation (the file's own header calls this "a later feature").
- Not surfaced to operators anywhere.

### B. Inter-agent shared state — BUILT, passive, ephemeral
- [`ScratchpadService`](../apps/api/src/services/scratchpad.ts): run-scoped KV (`read`/`write`/`delete`/`snapshotOf`) **plus** a run-scoped channel bus (`broadcast`/`readChannel`) — the "swarm gossip bus" from SMARTER-AGENTS-10X §VIII.
- Session tools already exist: `scratchpad_write`, `scratchpad_read`, `broadcast`, `read_channel` — [`agentSessionRuntime.ts:164`](../apps/api/src/services/agentSessionRuntime.ts).
- Emits `SCRATCHPAD_WRITTEN` on every write; read API at [`routes/scratchpad.ts`](../apps/api/src/routes/scratchpad.ts) (read-only snapshot).
- UI: a **"Working memory"** tab in [`RunModalProvider.tsx:441`](../apps/web/src/components/runs/RunModalProvider.tsx) — but it fetches **once on tab open** and does **not** subscribe to `SCRATCHPAD_WRITTEN`; channels are not rendered at all; entries carry no runtime/author identity.
- **In-memory `Map` per run** — cleared on `dispose(runId)`, lost on restart. The header notes a "Standard mode (later): Redis" but the durable path is unbuilt.

### C. Inter-agent state handoff between nodes — output-passing
- `#upstreamOutputs` ([`WorkflowEngine.ts:2078`](../apps/api/src/engine/WorkflowEngine.ts)) collects `nodeStates[source].outputData` along edges → becomes the next node's `inputData`. Discrete blob handoff, not a shared live surface.

### D. The loop — bounded retry only
- Graph is a strict **DAG**: `hasCycle()` throws `WORKFLOW_GRAPH_INVALID` ([`validateGraph.ts:451`](../apps/api/src/engine/validateGraph.ts)).
- `loop` node = **foreach** over `itemsExpression` → array, body = `bodyWorkflowId` ([`validateGraph.ts:392`](../apps/api/src/engine/validateGraph.ts), dispatch at [`WorkflowEngine.ts:3448`](../apps/api/src/engine/WorkflowEngine.ts)).
- `evaluator` node scores output, tracks `__evalIteration`, caps at `maxRetries ?? 3`, routes FAIL back to the upstream `agent_task`, feeds verdict to the Brain ([`WorkflowEngine.ts:6873`](../apps/api/src/engine/WorkflowEngine.ts)).
- `planner` / `dynamic_swarm` splice nodes at runtime.
- **No first-class iterate-until-convergence controller** that carries state across iterations, runs a *cohort* (not one node) per pass, and stops on goal / stall / budget.

**Verdict:** top-tier on heterogeneous-runtime orchestration; the cooperation layer is half-built and operator-invisible. This plan finishes and unifies it.

---

## The unifying doctrine

> A **cooperative loop** owns three things for the duration of a goal: an **isolated workspace** (so its agents edit code safely), a **shared blackboard** (so its agents see each other's work live), and a **convergence controller** (so it iterates until done, not a fixed N). Every agentic workflow that needs more than a single pass is expressed as one of these. Operators watch all three in real time.

The three pillars are designed to compose: **the loop controller is the owner of the isolation scope and the blackboard namespace.** A node in isolation alone, or a blackboard without a loop, are degenerate cases of the same model.

---

## Pillar 1 — The Convergence Loop (the controller)

### Goal
A first-class, stateful, budget-governed iterative controller that runs a **cohort sub-graph** repeatedly until a *continuation policy* says stop — replacing the fixed-N evaluator-retry as the general agentic loop primitive.

### Design
Introduce a node kind **`converge`** (working name; not a `loop` overload — `loop` stays foreach). It reuses the existing subflow machinery (`bodyWorkflowId` + `SubflowExecutor`) so we add **no graph cycle** and keep DAG validation intact — the controller re-invokes the body, exactly as `loop` re-invokes per item, but driven by a predicate instead of an array.

```
converge {
  bodyWorkflowId: string          // the cohort: e.g. research(Opus) → fix(Codex)
  continuation: ContinuationPolicy // when to keep going
  maxIterations: number           // hard ceiling (default 8)
  budget?: { usd?: number; ms?: number; tokens?: number }   // circuit breaker
  stallPolicy?: { window: number; on: 'no_progress' | 'oscillation' }  // novelty stop
  stateKey: string                // blackboard namespace carried across iterations
  carryStrategy: 'accumulate' | 'replace' | 'diff'  // how iteration N sees N-1
}
```

**`ContinuationPolicy`** is pluggable — three sources, same interface, so it stays model- and domain-agnostic:
- `deterministic` — a safe expression over the body's output (`{{ body.openBugCount }} > 0`). Reuses [`SafeConditionParser`](../apps/api/src/engine/SafeConditionParser.ts).
- `judge` — an LLM verdict against `criteria`/`rubric`. **Reuses the existing evaluator runtime resolution** (`#resolveEvaluationRuntime`) and feeds `applyEvaluatorVerdict` to the Brain — we extend the evaluator, we don't fork it.
- `signal` — a structured claim posted to the blackboard by an agent (`converge.done({ reason })`). Lets the agents themselves declare convergence.

**Why this beats today's retry:**
1. **Stateful across iterations** — each pass reads the prior pass's findings from the blackboard (Pillar 2), not a flattened blob. The bug list, the diffs tried, the dead-ends — all accumulate.
2. **Cohort, not one node** — the body is research→fix→verify, re-run as a unit. Today's evaluator re-runs a single upstream node.
3. **Stall detection** — `stallPolicy` borrows the novelty-based stop from `ChatProgressMonitor` (our chat intelligent-stop work): if two consecutive iterations produce no material change (or oscillate A→B→A), break with an honest "converged-by-stall" verdict instead of burning the full budget. **This is the efficiency the retry logic lacks.**
4. **Budget circuit breaker** — reuses the build-spend breaker pattern (`project_build_runaway_guard`); a loop can't run away.
5. **Honest terminal verdicts** — `goal_met` | `stalled` | `budget_exhausted` | `max_iterations`. Never a fake green (our truthful-preflight doctrine).

### Engine work
- New `#dispatchConverge` modeled on `#dispatchLoop` ([`WorkflowEngine.ts:3448`](../apps/api/src/engine/WorkflowEngine.ts)) + the subflow start path ([`WorkflowEngine.ts:3464`](../apps/api/src/engine/WorkflowEngine.ts)).
- Iteration state persisted on the run (durable resume): `convergeState[nodeId] = { iteration, history[], verdict, spend }`.
- `validateGraph` case for `converge` (require `bodyWorkflowId`, `continuation`, `stateKey`).
- Robustness audit + creation-pipeline awareness (`workflowRobustnessAudit.ts`, `creationPipeline.ts`) so the planner *emits* convergence loops where a goal is open-ended, and the playbook library learns the pattern.

---

## Pillar 2 — The Blackboard (operator-visible shared state)

### Goal
Promote `ScratchpadService` from an ephemeral KV into the **canonical, durable, identity-tagged inter-agent state bus** — and give operators a brilliant live view of it. This is where Opus and Codex "talk," and where the operator watches them think.

### Data model (durable)
Add a `blackboard_entries` table (SQLite migration) — the loop's cross-iteration memory survives restart and becomes auditable:

```
blackboard_entries
  id, run_id, workspace_id, namespace (= converge.stateKey | 'run')
  kind: 'fact' | 'message' | 'claim' | 'artifact_ref'
  key            -- for facts (KV semantics: latest wins, supersedes prior)
  channel        -- for messages (the gossip bus)
  author_agent_id, author_runtime ('opus' | 'codex' | …)  -- WHO + WHICH runtime
  iteration      -- which convergence pass produced it
  confidence     -- optional, for claims
  supersedes     -- id of the entry this revises (disagreement is visible)
  value (json), created_at
```

`ScratchpadService` keeps its in-memory fast path as a write-through cache; it gains a durable backing store and an `author/runtime/iteration` on every write. The existing session tools (`scratchpad_write`, `broadcast`, …) are unchanged at the call site — they just carry identity now. New tool: `claim`/`supersede` for structured disagreement, and `converge.done` (the `signal` continuation source).

### Operator UX/UI — the Blackboard panel
This is a first-class surface, not a buried tab. Design principles (every implementation gets a brilliant UX):

- **Live, not snapshot.** Subscribe the panel to `SCRATCHPAD_WRITTEN` / `BLACKBOARD_*` (fix the [`RunModalProvider.tsx:228`](../apps/web/src/components/runs/RunModalProvider.tsx) one-shot fetch). Entries stream in as agents write.
- **Per-runtime identity.** Each entry shows an avatar + color for its runtime (Opus / Codex / Cursor), so the operator instantly reads *who said what*. The handoff between runtimes is the story; make it legible.
- **Three views, one panel:**
  1. **Facts (KV)** — the current shared truth, with supersede history on hover.
  2. **Conversation (channels)** — the gossip bus as a chat-like timeline; this is the two agents "talking."
  3. **Claims ledger** — structured assertions with confidence and disagreements highlighted (Opus claims bug X fixed; Codex's verify disputes it → rendered as a contested row).
- **Iteration timeline** (ties to Pillar 1): a horizontal stepper of convergence passes; selecting a pass filters the blackboard to that iteration's deltas, and shows the verdict + spend for that pass. This is the operator's "watch them converge" view.
- **Surfaces beyond the modal.** Promote the live blackboard into the Realtime Workspace / Theater (`project_immersive_realtime`) so cooperation is visible without opening a run — and offer a read-only embed for an Agentic App surface (operators of a *deployed* app can watch its agents cooperate).

### Why durable + identity matters
The blackboard becomes the loop's working memory across iterations (Pillar 1's `carryStrategy` reads/writes here), the audit trail of a multi-runtime negotiation, and — when an entry is promoted — a candidate for the Brain (a converged claim graduates from run-scoped blackboard to workspace-scoped knowledge via the existing formation gate). **Blackboard = transient run cognition; Brain = durable workspace knowledge.** The promotion seam is explicit, reusing `brainFormation` so we don't write garbage atoms.

---

## Pillar 3 — Isolated Workspaces (general, reviewable, visible)

### Goal
Lift `WorktreeManager` from swarm-only to a **general isolation policy** any runtime-spawning node honors, scoped to the cooperative loop, with optional **branch/PR preservation** and operator-visible diffs.

### Design
- **Isolation scope = the loop cohort, not the node.** In the Opus↔Codex loop, both agents must edit the *same* tree (Codex fixes what Opus reviewed) but isolated from *other* concurrent runs. So the `converge` controller acquires **one** worktree and passes it to every node in its body for the duration of the loop; siblings/other runs get their own. Parallel swarms keep per-subtask worktrees (today's behavior) — same manager, different scope.
- **Policy, not hard-coding.** Add `isolation: 'auto' | 'shared' | 'worktree' | 'tempdir'` on the node/workflow. `auto` = worktree when the base is a repo and the node spawns a coding runtime; `shared` = legacy single-cwd. Wire `acquire()` into the `agent_task` / `agent_session` / `dynamic_swarm` dispatch paths (today only `#dispatchAgentSwarm` calls it). Thread the handle's `path` into `task.workdir` (the field already exists; adapters already honor it).
- **Branch/PR preservation** (the code's flagged TODO): a `preserve: 'discard' | 'branch' | 'pr'` mode. `branch` keeps the worktree's commits on `agentis/run-<id>` instead of discarding; `pr` opens a PR via the GitHub connector. This turns a cooperative coding loop into a **reviewable artifact** — the operator approves the convergence result, closing the trust loop.
- **Conflict semantics for shared-scope loops.** Sequential cohort nodes are safe (one writer at a time). If a body fans out to parallel coders on a *shared* worktree, fall back to per-branch worktrees + a merge step (reuse swarm output-merge), surfacing conflicts on the blackboard as contested claims.

### Operator UX/UI
- Each loop/run shows its **workspace**: mode (`git_worktree`/`temp_dir`), path, and a **live diff** of what the cohort changed this iteration (ties to the iteration timeline). The operator sees Codex's patch land against Opus's findings.
- On `preserve: 'pr'`, the run surfaces the PR link as the deliverable.

### Engine work
- Generalize the swarm worktree helpers ([`WorkflowEngine.ts:5679`–`5718`](../apps/api/src/engine/WorkflowEngine.ts)) into a scope-keyed acquire/release owned by the active `converge` frame (or the run, for top-level nodes).
- `release` honors `preserve` (commit→branch/PR before teardown).
- Never throws into the run (preserve the existing degradation contract).

---

## How the three compose — the motivating example, end to end

```
converge {
  stateKey: "bughunt",
  maxIterations: 8,
  budget: { usd: 5 },
  stallPolicy: { window: 2, on: "no_progress" },
  isolation: "worktree", preserve: "pr",
  continuation: { type: "deterministic", expr: "{{ body.openBugCount }} > 0" },
  body:  research(Opus 4.8) → fix(Codex 5.5) → verify(Opus 4.8)
}
```

1. Controller acquires **one git worktree** of HEAD (Pillar 3) and opens blackboard namespace `bughunt` (Pillar 2).
2. **Iteration 1:** Opus researches → writes `open_bugs` facts + a `claim` per bug to the blackboard. Codex reads the blackboard, fixes in the *same* worktree, commits, posts `patch` claims. Opus verifies, updates `openBugCount`. Operator watches all of this stream live with per-runtime avatars.
3. Controller evaluates continuation (`openBugCount > 0`) and **stall** (did anything change vs iteration 0?). Continue.
4. **Iteration N:** repeats, each pass reading the accumulated blackboard. If two passes make no progress → `stalled` verdict (honest), stop early — *this is the efficiency win*.
5. On `goal_met`, `release` preserves the branch and opens a **PR** (Pillar 3). The converged claims graduate to the Brain. Operator reviews the PR + the full iteration timeline.

No graph cycle, no fixed N, no clobbering, nothing hidden from the operator.

---

## Phasing

| Phase | Scope | Lands |
|---|---|---|
| **P0** | Blackboard durability + identity (`blackboard_entries`, write-through, author/runtime/iteration on existing tools) | Foundation everything else reads/writes |
| **P1** | `converge` node: engine dispatch, deterministic + judge continuation, maxIterations + budget breaker, durable iteration state, validateGraph | The general loop primitive |
| **P2** | Isolation generalization: policy field, wire `acquire()` into agent_task/session/dynamic_swarm, loop-scoped worktree | Safe multi-runtime coding |
| **P3** | Operator UX: live Blackboard panel (3 views) + iteration timeline + workspace diff; promote to Theater | "See it as operators" |
| **P4** | `signal` continuation + claims/supersede + stall/oscillation detection + Brain promotion seam | Cooperative intelligence + efficiency |
| **P5** | `preserve: branch/pr`, planner/robustness-audit emit convergence loops, playbook learns the pattern | Reviewable artifacts + self-improvement |

Each phase is independently shippable and leaves the system honest (truthful verdicts, no fake green, graceful degradation).

## Acceptance criteria
- A `converge` loop runs a heterogeneous cohort (Opus body node + Codex body node) to a deterministic *and* a judge stop condition; stalls early on no-progress; respects a USD budget; resumes durably after an API restart mid-loop.
- Two runtimes editing in one loop never clobber a sibling run; `preserve: pr` yields a real PR.
- An operator watching the run sees, live: per-runtime blackboard entries, the channel conversation, the iteration timeline with per-pass verdict + spend, and the workspace diff.
- Nothing is hard-coded to the bug example — the same primitives express a research-debate loop, a draft→critique→revise content loop, a plan→act→reflect agent loop.

---

## Open decisions (sensible defaults chosen; flag to change)
- **Node name `converge`** vs overloading `loop` with `strategy:'until'`. Default: a new kind, to keep `loop` = foreach unambiguous.
- **Durable store = SQLite `blackboard_entries`** (single-writer OSS posture, consistent with `project_postgres_portability`). Redis remains the later "standard mode" swap behind the same interface.
- **Default `maxIterations` = 8, default budget = none** (opt-in), default `stallPolicy.window = 2`.

---

## Implementation log
_(Append per our masterplan convention — keep reconciled with real code.)_

- 2026-06-26 — Plan authored. Reality audit grounded against `worktreeManager.ts`, `scratchpad.ts`, `WorkflowEngine.ts` (converge/loop/evaluator/swarm-worktree), `validateGraph.ts`, `agentSessionRuntime.ts`, `RunModalProvider.tsx`. Confirmed Pillars 1–3 status: blackboard + worktree are built-but-under-wired; convergence controller is greenfield.

- 2026-06-26 — **SHIPPED P0–P5 end-to-end** (typechecks clean; 20 new/updated tests green). What landed:
  - **P0 Blackboard durability + identity.** Migration v94 `blackboard_entries` (+ drizzle `blackboardEntries`). `ScratchpadService` rewritten as the durable, identity-tagged bus: every `write`/`broadcast`/new `claim` records an entry tagged with author `{agentId, runtime, label}`, `namespace`, `iteration`; durable write-through (best-effort) + in-memory mirror; `listEntries`/`hydrate`; emits new `BLACKBOARD_ENTRY` (kept `SCRATCHPAD_WRITTEN` for legacy). Wired `sqlite` into the service in `bootstrap.ts`. New events `BLACKBOARD_ENTRY`/`CONVERGE_ITERATION`/`CONVERGE_SETTLED`.
  - **P1 Convergence controller.** New `ConvergeNodeConfig` + `converge` node. Engine `#dispatchConverge`/`#runConverge`: re-invokes a body cohort via SubflowExecutor (no graph cycle), pluggable continuation (deterministic via `evalCondition` | judge via the existing evaluator runtime + `applyEvaluatorVerdict` | signal via the blackboard channel), `maxIterations` ceiling, `budget.ms` breaker, **stall/no-progress detection** via order-independent output signature, durable `_convergeState` resume, honest verdicts `goal_met|stalled|budget_exhausted|max_iterations`. `validateGraph` case + `SUPPORTED_NODE_KINDS` + `executorType` union. Fix: strip reserved `converge` envelope from body output to avoid a self-referential state cycle.
  - **P2 Isolation generalization.** Converge owns ONE cohort-shared worktree (`#acquireConvergeWorktree` + base-cwd resolution from the adapter registry); records the workspace path on the blackboard. `isolation: auto|shared|worktree|tempdir`.
  - **P3 Operator UX.** `RunModalProvider` "Working memory" tab → live **Blackboard** panel: subscribes to `BLACKBOARD_ENTRY`/`CONVERGE_ITERATION`/`CONVERGE_SETTLED`, three views (Facts/Conversation/Claims) with per-runtime identity chips + color, contested-claim styling, and a **convergence iteration timeline** (per-pass verdict/score/stall + preserved branch/PR). New `GET /v1/runs/:id/blackboard`. Canvas: `converge` added to nodeKindMeta/palette/explainer.
  - **P4 Cooperation tools.** Session tools `claim` (confidence + supersede → visible disagreement) and `converge_signal` (the `signal` continuation source); `scratchpad_write`/`broadcast` now identity-tagged via `resolveRuntimeLabel` (wired from the adapter registry in `bootstrap.ts`).
  - **P5 Reviewable artifacts.** `WorktreeManager` `preserve: discard|branch|pr` — commits the cohort's changes onto a durable branch (best-effort `gh pr create` for `pr`); `release()` returns `WorktreeReleaseResult`. Build-tool node grammar advertises `converge` so agents/planner can author it.
  - **Tests.** `WorkflowEngine.converge.test.ts` (goal_met / ceiling / stall / durable resume — real engine + subflow). `scratchpad.test.ts` extended (identity, claim/supersede, message entries). `worktreeManager.test.ts` updated for the new return + a real-git `preserve: branch` lifecycle test.
  - **Not done at first pass:** live visual verification of the panel; `budget.usd/tokens` (only `ms`+ceiling enforced); Brain-promotion seam from blackboard claims (designed, not wired).

- 2026-06-26 — **Agent discoverability wired (closes the "hidden feature" gap).** A primitive agents don't reach for is dead weight, so `converge` is now taught at every surface where an agent forms intent:
  - **Design doctrine** ([workflowDesignDoctrine.ts](../apps/api/src/services/workflowDesignDoctrine.ts)) — new clause **D7** ("iterate-until-done = converge, not fixed retry") + a `convergence loop` entry in the ROBUST PATTERN CATALOG. This doctrine is injected into synthesis + reviewer + orchestrator prompts.
  - **Orchestrator prompt** ([orchestratorPrompt.ts](../apps/api/src/services/orchestratorPrompt.ts)) — `converge` added to the node-kind list + new **Iron Rule 17** (open-ended/multi-runtime goals → converge with continuation + isolation:worktree + preserve:pr + the blackboard tools).
  - **Pattern library** ([workflowPatterns.ts](../apps/api/src/services/workflowPatterns.ts)) — new `convergence-loop` skeleton, retrievable via `agentis.workflow.patterns`; `suggestPatterns` gains an `iterative` signal.
  - **Synthesis requirement** ([build.ts](../apps/api/src/services/agentisToolHandlers/build.ts)) — when the request reads iterative, the synthesis prompt now *requires* a converge node (the active "emit" nudge); reviewer prompt audits D1–**D7**; build-tool grammar documents the node.
  - **Robustness audit** ([workflowRobustnessAudit.ts](../apps/api/src/services/workflowRobustnessAudit.ts)) — new **`MISSING_CONVERGENCE`** warning fires (low-false-positive: only on the explicit `iterative` signal + no converge node).
  - **Intent classification** ([creationPipeline.ts](../apps/api/src/services/creationPipeline.ts)) — `RobustnessSignals.iterative` derived from the request text.
  - **Operating manual** ([agentOperatingManual.ts](../apps/api/src/services/agentOperatingManual.ts)) — every agent now told to cooperate on the blackboard (`scratchpad_write`/`broadcast`/`claim`/`converge_signal`) when in a swarm/team/converge loop.
  - Tests: pattern library + robustness audit extended (D7 fires / stays quiet with a converge node / pattern retrievable + suggested). api+web typecheck clean.

- 2026-06-26 — **Closed the last two capability gaps (budget.usd/tokens + Brain promotion).**
  - **Real budget enforcement.** New engine dep `resolveRunSpend(rootRunId) → { costCents, tokens }`, wired in [bootstrap.ts](../apps/api/src/bootstrap.ts) to aggregate REAL spend across the run + its descendant subflow runs (cost from `auditEntries.costCents`, tokens from `agentSessions.totalTokensIn/Out`, BFS over `workflowRuns.parentRunId`). `#convergeBudgetExceeded` enforces `budget.ms` (always) + `budget.usd` + `budget.tokens` against that signal; absent resolver → only ms+ceiling (never fabricated enforcement).
  - **Brain promotion from claims.** On `goal_met`, `#promoteConvergedKnowledge` gathers the loop's SURVIVING (non-superseded) blackboard claims + final result and calls `sharedIntelligence.promote(...)` — gated by the existing FormationJudge (no garbage atoms). Best-effort; never blocks the run; only fires on real convergence (not stall/budget/ceiling).
  - Tests: 4 new converge cases (USD budget stop, token budget stop, promotes surviving claims on goal_met, does NOT promote when stalled) — all green (8/8). api+web typecheck clean.
  - **Remaining:** live visual verification of the operator panel (needs a seeded converge run on a real runtime).
