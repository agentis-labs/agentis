# Workflow Reliability 10x

Make every workflow run, explain itself, and set up once.

This document is the single reliability program for Agentis workflow execution. It exists to stop us from fixing one broken workflow at a time and to force every repair through shared engine contracts.

## 2026-06-10 Program Reset

The scope is broader than one failing workflow. Agentis has to be reliable across:

- every node contract;
- every trigger path: `manual`, `cron`, `webhook`, `persistent_listener`;
- every extension/runtime boundary;
- every workflow deployment and reactivation path;
- every orchestrator-to-canvas build assumption;
- every API boundary where invalid graphs can still enter the system.

### Non-negotiable rules

1. No case-specific fixes. Every change must strengthen a shared contract, normalize legacy input, or add regression coverage around an engine invariant.
2. No duplicate architecture. Reuse these choke points first:
   - `workflowGraphNormalization`
   - `validateWorkflowGraph`
   - `validateGraphReferences`
   - `workflowReadiness`
   - `workflowTriggerDeployment`
3. Use n8n as a reference, not a blueprint. Compare execution rigor, trigger discipline, and coverage expectations without copying its data model blindly.
4. Reliability beats convenience. A structurally invalid graph should fail at authoring, import, or publish time, not after a long run.

### Current architecture-strengthening batch

1. Canonical graph normalization
   - Repair legacy router branch shape (`id` -> `branchId`).
   - Normalize template/JS router conditions into the safe engine grammar.
   - Normalize stored workflows on read as well as write so older graphs stop breaking new runs.
2. Runtime input-shape hardening
   - Persistent listeners expose a stable single-event payload shape: root fields, `event`, `item`, `events`, `count`.
   - Router conditions execute with the semantic scope the rest of the engine expects: `input`, `inputs`, `output`, `trigger`, `nodes`, `scratchpad`.
3. Validation boundary hardening
   - Invalid router and edge conditions are rejected by `validateWorkflowGraph`.
   - Dangling template references are treated as validation failures instead of silently resolving to empty runtime input.
   - Forward/self references remain warnings in lenient authoring mode so drafting still works.
4. Synthesis contract hardening
   - Builder/orchestrator instructions explicitly forbid `{{...}}`, `===`, and `!==` inside router conditions.
   - Listener-source payload expectations are explicit so persistent listeners stop being inferred incorrectly.

### Reliability audit harness

Entry point:

```bash
pnpm workflow:audit
```

The audit now:

- inventories Agentis workflow node kinds and trigger kinds from the real core types;
- scans API tests for direct coverage mentions by node/trigger kind;
- checks that critical engine/reliability surfaces exist and have paired tests;
- inspects the local `n8n` repo for the execution-engine files and node surface we are benchmarking against;
- writes the latest report to `docs/reports/workflow-reliability-audit.md`.

This gives us one living baseline for the hardening program instead of scattered terminal notes.

### Acceptance criteria for the next waves

- A malformed graph is blocked before run or publish.
- A persistent listener is publishable, activatable, reconnectable, and inspectable without manual surgery.
- The orchestrator reuses an existing eligible extension instead of generating duplicates.
- Trigger deployment stays singular per workflow and idempotent across republish/reactivate flows.
- Every supported node kind has explicit engine coverage, not accidental coverage through unrelated tests.

### Reliability waves

1. Boundary wave
   - validation, normalization, import/publish gates, condition grammar, reference integrity.
2. Trigger/runtime wave
   - cron, webhook, listener activation, reconnect semantics, health/reporting, backend availability.
3. Extension/connectivity wave
   - extension identity resolution, listener-source eligibility, dedupe, runtime I/O contracts.
4. Orchestrator awareness wave
   - reuse-vs-create decisions, existing asset discovery, trigger/persistent-listener authoring correctness.
5. Parity wave
   - compare Agentis support and invariants against the local n8n trigger/deployment/execution reference and close material gaps.

## Existing Reliability Fronts

### A. Execution robustness

Root cause already identified and fixed:

- Transform/filter expressions used to assume a single JS expression.
- LLM-synthesized workflows often emit function bodies with `return`.
- That mismatch caused valid generated workflows to die with syntax errors.

Shipped:

- Dual-mode expression evaluation in [apps/api/src/engine/safeExpression.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/engine/safeExpression.ts) to support both expression and function-body forms.
- Tests covering `return`, multi-statement bodies, context access, and blocked tokens.

Next:

- Build-time expression validation so invalid transforms/filters/evaluators are caught before run time.
- Continued failure taxonomy so the next engine-wide breakages are found empirically.

### B. Credentials

Problem:

- Re-entering the same credentials per workflow is needless friction.

Direction:

- Inline "save this key to my workspace" opt-in at the point of need.
- Dedicated settings surface for stored credentials, masking, rotation, deletion, and auditability.
- Reuse the existing encrypted vault, never a separate plaintext path.

### C. Auto-diagnosis

Problem:

- A failed run should come with a grounded explanation by default, not a dead-end button.

Shipped:

- Deterministic failure analyzer wired into failure cards.
- Auto-explained failures instead of generic "diagnose" prompts.

Next:

- Workspace toggle for auto-diagnosis.
- Fix remaining card actions so `Open workflow` and related actions are always live.

### D. Integrations

Problem:

- Synthesized `operationId` values can be incompatible with the actual connector.
- Failure handling previously allowed dead branches to leave runs stuck in waiting states.

Shipped:

- Integration operation normalization against the real connector catalog.
- Readiness warnings for unsupported operations before run time.
- Success-branch skipping after handled failures so runs reach a real terminal state.

Next:

- Feed per-integration operation catalogs and required params directly into synthesis so new builds start valid instead of being repaired later.

---

## 2026-06-29 — The Contract Unification Program (10x wave)

> **Thesis.** Workflows do not fail because the engine is weak or self-healing is
> under-powered. They fail because **there is no single, validated expression contract**.
> We expose *three* divergent reference vocabularies, validate *none* of the JS ones before
> a run, and escalate one-token typos straight to an expensive LLM repair. 70% node failure,
> self-heal burning tokens and still failing, the black-box run, the missing Run button —
> all cascade from that one root. This wave continues the 2026-06-10 program through its
> existing choke points (`validateWorkflowGraph`, `validateGraphReferences`,
> `workflowReadiness`, `safeExpression`, `SafeConditionParser`, `templateResolver`); it
> adds **no parallel subsystem**.

### Why the 2026-06-10 work didn't close it

The Boundary wave gave **router conditions** the scope `input, inputs, output, trigger,
nodes, scratchpad` (see "Runtime input-shape hardening" above) but left
`safeExpression.ts` — which powers `transform`/`filter`/`code`/`{{= …}}` — on a *different*
vocabulary (`input, $input, $json, ctx, nodes`, **no `inputs`**). That *widened* the gap:
`inputs["id"].field` is now legal in a router and a **fatal `inputs is not defined`** in a
transform. The doctrine then teaches the router form (Iron Rule 15,
`orchestratorPrompt.ts:148`) while the transform examples use `input`/`nodes` — so the model
mixes them and ~1 in 3 nodes ships a reference legal nowhere it ran. The screenshot failure
("Persist Rejected Prospects … `inputs is not defined`") is exactly this, and self-heal
can't fix it because (a) it's taught the same wrong token and (b) `validateWorkflowGraph`
checks *structure*, not expression executability — the "Build-time expression validation"
listed as **Next** under Front A was never shipped.

### The three vocabularies (code-grounded)

| Site | Evaluator | `inputs`? | `$json`? |
|---|---|---|---|
| `{{path}}` templates | `templateResolver.ts` | ❌ | ❌ (only inside `{{= …}}`) |
| Router / edge conditions | `SafeConditionParser.ts` | ✅ | ❌ |
| `transform` / `filter` / `code` JS | `safeExpression.ts` | ❌ **fatal** | ✅ |

### How n8n avoids it (reference, not blueprint)

n8n runs with **no LLM in the failure path**: one item data model; one expression language
in fields *and* the Code node ([referencing nodes](https://docs.n8n.io/data/data-mapping/referencing-other-nodes/),
[expression reference](https://docs.n8n.io/data/expression-reference/)); an editor that
shows resolved values before you run; [partial execution + pinned
data](https://docs.n8n.io/workflows/executions/manual-partial-and-production-executions/)
to test one node without re-running 50; live data on the canvas; and deterministic
[error handling](https://docs.n8n.io/flow-logic/error-handling/) (Retry on Fail / Continue
on Fail / Error Trigger). Each pillar maps to one Agentis gap below.

### Phases

**Phase 0 — Unify the expression contract (AEC).** One alias table valid at every site,
factored out of `safeExpression.ts` and shared by `SafeConditionParser.ts` +
`templateResolver.ts`: `input ≡ $json ≡ $input`; `nodes ≡ $nodes ≡ inputs` (per-node
outputs by id); `trigger/scratchpad/store/workspace/run/loop` (+ `$`-prefixed) identical
everywhere. Collapse Iron Rule 15 + transform guidance into one "Expression Contract" card.
_Acceptance: the screenshot graph runs green with zero edits._

**Phase 1 — Validate the contract at BUILD time** *(this is Front A's unshipped "Next")*.
Inside `build_workflow`, before persist/return: (1) a pure **expression linter** that parses
every `transform`/`filter`/`code`/router/`{{=}}` expression and checks free identifiers
against the AEC — extend `validateGraphReferences` (today: templates only) to JS
expressions; (2) a deterministic **codemod** for the mechanical mistakes (legacy `inputs`,
`===`→`==`); (3) a **build-time node smoke test** — thread a representative sample item
through the graph and actually evaluate each pure node in the sandbox (n8n "Execute node",
run automatically). _Acceptance: a corpus of known-bad graphs is caught at build; a
throwing transform blocks the build with a node-scoped message._

**Phase 2 — Deterministic-first recovery ladder.** Beneath the LLM replan: (1) universal
per-node `onError: stop|continue|route` + `retry: { maxAttempts, backoffMs }` (generalize
the ad-hoc http/evaluator/loop retry); (2) **Rung 0** — run the Phase-1 linter/codemod on
the *failed* node before any model call (`inputs`→rewrite→re-dispatch, 0 tokens); (3) the
existing `#orchestratorReplan` runs only after, now given the AEC card **and a dry-run
gate** so its repair is proven executable before the intent judge certifies. _Acceptance:
the `inputs` class resolves with zero model calls; self-heal token spend drops an order of
magnitude._

**Phase 3 — First-class Run + live runs in the App.** (1) A real **Run** control on the App
and each workflow, inputs form from the trigger/input contract, a launcher when an App owns
several workflows; (2) make `apps.ts` `kind:"workflow"` async — start the run, return
`{ runId }`, subscribe the App to the **same** `REALTIME_ROOMS.run` room the workflow
sub-page already uses (instead of `await runPublishedWorkflow → blob` at `apps.ts:1170`);
(3) an in-App live run feed reusing run-detail components. _Acceptance: Run shows
node-by-node progress in the App in <1s — no terminal spinner._

**Phase 4 — Author like an n8n power user.** Extend the [WORKFLOW-DESIGN-10X] planner /
`workflowPatterns.ts` / Playbook (do not rebuild): contract-first node grammar cards
enforced by the Phase-1 gate; sample-data threading through the build (our "pinned data");
verified building blocks that must pass the dry-run gate.

### Sequencing

Ship **Phase 0 + Phase 1 + Rung 0 of Phase 2** first — mostly pure/deterministic, and
together they convert the dominant failure into a non-event. Then Phase 2 (error policy),
Phase 3 (Run/realtime UX), Phase 4 (durable authoring quality).

### Implementation Log

_(append per-phase as code lands)_

- 2026-06-29 — Wave planned from a code-grounded audit (safeExpression / SafeConditionParser
  / templateResolver / validateGraph / workflowSelfHeal / orchestratorPrompt / apps.ts).
  Root cause: the 2026-06-10 router-scope change widened the expression-vocabulary gap; the
  unshipped build-time expression validation (Front A "Next") is the centerpiece.
- 2026-06-29 — **Phases 0–3 SHIPPED** (api + web, typecheck clean, ~162 tests green):
  - **P0 (contract):** `safeExpression.ts` now exposes `inputs`/`$inputs`/`output`/`$output`
    (≡ `input`, mirroring the router runtime) so any condition-valid expression is
    transform-valid — the `inputs is not defined` class is gone. Doctrine rewritten:
    Iron Rule 15 now teaches the portable `nodes["id"].field`, plus a new unified
    "Expression Contract" card in `orchestratorPrompt.ts`. Regression test in
    `safeExpression.test.ts`.
  - **P1 (build gate):** new `engine/validateExpressions.ts` — `analyzeExpression` probe
    (compile + reference classification, zero false positives on data-shape errors),
    `validateGraphExpressions`, and a transposition-aware near-miss codemod
    (`repairExpressionReferences`/`repairGraphExpressions`). Wired into `build.ts` after the
    integration-op repair: auto-repairs `transform`/`filter` bodies, surfaces residual
    contract violations as `INVALID_EXPRESSION` preflight warnings. `validateExpressions.test.ts`.
  - **P2 (recovery):** `WorkflowEngine.#repairAndRetryPureNode` runs the codemod on a thrown
    pure node and retries in-place with **zero tokens** before any self-heal/LLM rung
    (audited as `self_heal.expression_repaired`). E2e proof in
    `WorkflowEngine.expressionRepair.test.ts`. (Per-node retry already existed —
    `WorkflowEngine.retryPolicy` — so it was reused, not duplicated.)
  - **P3 (run UX):** `runPublishedWorkflow.ts` split out `startPublishedWorkflow` (async
    start → `runId`); the App `kind:"workflow"` action (`apps.ts`) now uses a 2.5s budget
    instead of the 60s blackbox; the App engine modal's per-workflow table gained a **Run**
    button that calls `POST /v1/workflows/:id/run` and opens the live streaming run modal.
  - **Deferred:** P3 in-App embedded run feed (vs. the run modal) + a richer inputs form;
    P4 (contract-first node cards, sample-data threading, verified pattern blocks).
- 2026-06-29 — **Phase 4 + P3 remainder SHIPPED** (typecheck clean, full affected suite green):
  - **P4.1 (sample-data threading):** `dryRunGraphExpressions` in `validateExpressions.ts`
    synthesizes a sample from the `inputContract` + each node's declared output keys, threads
    it through the graph in topological order, and evaluates every expression against
    realistic upstream data — **unmasking reference errors hidden behind a data access** on
    empty input (the static probe's blind spot). Wired into `build.ts` (replaces the
    empty-probe call). Still zero false positives. Tests in `validateExpressions.test.ts`.
  - **P4.2 (verified blocks):** `workflowPatterns.test.ts` now asserts every pattern's router
    conditions parse under the safe-condition grammar and every JS/`{{=}}` expression is
    on-contract — the planner can only compose from dry-run-clean blocks.
  - **P4.3 (node grammar cards):** the build gate's reference message now carries the
    per-node-kind contract (`nodeContractCard`) plus a "Did you mean …?" near-miss suggestion,
    so a flagged expression tells the agent exactly what to use.
  - **P3 inputs form:** the App engine Run button now fetches the workflow's `inputContract`
    (`GET /v1/workflows/:id`) and, when it declares fields, collects type-coerced inputs in an
    inline form before running (instead of `{}`), so input-requiring workflows aren't blocked
    by the run-gate. No-contract workflows still run in one click.
  - **Remaining (intentional):** an embedded-in-surface run feed is satisfied by the live
    streaming run modal (`openRunModal`); duplicating that component into the sandboxed App
    iframe was judged not worth the complexity. **The masterplan is complete.**

---

## Runtime reliability pass — 2026-06-29 (medium workflows still dying mid-run)

Earlier phases hardened **build-time** expression contracts. But live-DB evidence (last 120
runs: 24 FAILED) showed medium workflows still dying at **runtime**, from a few concrete causes
amplified by cascade (219× "Skipped because an upstream node failed"). Root causes, evidence-ranked:

1. **Agent node "did not produce declared output"** — dominant. The bound agent/harness returned
   EMPTY (inspected run: `node.started → self_heal.escalated`, zero tokens, no agent_session), yet
   the error blamed the declared-output contract → self-heal burned 3 attempts on output-extraction
   that could never work → run died. (Agent was an online codex orchestrator with an aspirational
   model pin `gpt-5.5` — the dispatch returned nothing.)
2. **`claude_code exited 1`** — harness crash; `notifyTaskFailed → #failNode` was terminal.
3. **`evaluator: targetPath '{{nodes.X}}' did not resolve`** — hard-threw instead of degrading.
4. **`evaluator node present but EvaluatorRuntime not wired`** — terminal instead of degrade.
5. **Mid-run OOM** — a malformed surface view tree (recursive `z.union` `viewNodeSchema`) produced
   a multi-hundred-MB ZodError and OOM-killed the API mid-run. Fixed separately (discriminatedUnion).

### Shipped (WorkflowEngine.ts; tests in `WorkflowEngine.reliability.test.ts`, 4 green)
- **P0 — agent output: recover → honest-fail.** New `#recoverAgentNodeViaFallback`: when an agent
  node returns EMPTY output (self-heal exhausts → `none`+reason in `#completeNode`) OR the harness
  hard-fails (`notifyTaskFailed`), re-run the task **once** on a guaranteed workspace runtime
  (`resolveEvaluatorRuntime('synthesis') ?? evaluatorRuntime`, `completeStructured`) with the same
  prompt+contract; if it satisfies the declared keys, complete the node instead of cascade-killing
  the run. One-shot per node (`ctx.nodeFallbackAttempted`); input captured at dispatch
  (`ctx.nodeLastInput`). Honest diagnosis (`agentOutputFailureReason`): EMPTY output now reads
  "agent produced no usable output — its runtime returned empty or failed", not "missing keys".
- **P1 — evaluator degrades (`#executeEvaluator`).** No evaluation runtime → deterministic PASS
  (audit + loud critique) so the run continues. Unresolved `targetPath` → degrade to evaluating the
  node's whole input (warn) instead of throwing `did not resolve`. (The converge/continuation
  evaluator already degraded.)
- Conservative: nodes RECOVER; cascade/skip semantics unchanged (don't mask real failures). No
  schema/migration. Full engine suite (318 tests / 61 files) green.

### Follow-up — both remaining items shipped (same day, e2e)
- **Empty-output short-circuit** (`#completeNode`): when an agent node produced NO usable output,
  go straight to the guaranteed-runtime fallback BEFORE the (pointless-for-empty) extraction
  self-heal — skipping ~3 wasted LLM repair attempts. If the fallback recovers, self-heal is
  skipped; if not, the existing self-heal ladder still runs (one-shot guard stops a double
  fallback). Strictly faster on the common case, no worse otherwise.
- **Preflight agent-binding guard** (`workflowPreflight.ts` `checkAgentBindings`): an agent node
  explicitly pinned to a MISSING agent (`AGENT_NOT_FOUND`) or a non-functional `http` stub with no
  model/runtime (`AGENT_NO_RUNTIME`) now surfaces a WARNING in the Health tab BEFORE a run — the
  honest "this step would produce no output; connect a model" signal the runtime fallback otherwise
  papers over. Warning, not error; role-resolved nodes and agents with a model are left alone.
  Tests: `workflowPreflight.test.ts` (+3) + `WorkflowEngine.reliability.test.ts`; full suite green.
- **Intentionally NOT done:** rewriting the planner to cap output-key contracts / forbid pinning a
  worker to the orchestrator — too subjective, and the runtime fallback + preflight warning already
  neutralize the failure. Model-pin VALIDITY (e.g. `gpt-5.5` resolving to empty) is only knowable by
  actually calling the model — the runtime fallback is the right layer for that, not a static gate.

---

## Tool-contract pass — 2026-06-30 (the "workflow completed but produced pass:false" case)

A `Fashion Store Factory` run (56 nodes) **COMPLETED** — the ~45 `engine.node.skipped {"branch
condition not met"}` lines are normal branch routing, NOT failures, and the engine reliability work
above held. The real failure was the **agent fighting the TOOL layer**, producing a `pass:false`
blocked business outcome. Root causes (code-confirmed), and the n8n lesson behind the fix:

> n8n workflows "just work" because every node parameter is ONE declarative typed schema
> (`INodeProperties`) that is simultaneously the UI form, the validator, the expression context, AND
> (via `usableAsTool`/`$fromAI`) the AI-tool schema — **zero drift between what the author/agent is
> told and what executes**, and required context (credentials/connection) is **injected, not guessed**.
> Agentis's failures were exactly those two gaps.

### Shipped (tests: `agentisDataToolContract.test.ts` +4, all green; CodexAdapter 25/25; app suites 11/11)
- **Killed tool-schema drift.** `agentis.data.query` advertised `sort: { type:'array' }` but enforced
  `z.array({field,dir})` → the agent sent `["field"]` → `INTERNAL_TOOL_ERROR`. Advertised schema now
  mirrors the enforced zod exactly (`sortProp`/`filterProp` with item shapes + examples), in
  `agentisToolHandlers/appData.ts`. Drift is pinned by a contract test.
- **Instructive tool errors.** `agentisToolRegistry.execute` now renders a handler-side `ZodError` as
  one actionable line — `"<field>: expected object, received string … fix and retry"` — instead of the
  raw multi-line JSON dump, so a CLI harness self-corrects its next call (`formatZodIssues`).
- **App context without hunting.** `resolveAppId` (now a closure over the app store) auto-resolves the
  App when the workspace has exactly one, else throws an instructive error listing the apps + ids —
  killing the "no App in context" turns-wasted-discovering loop. Runs for every transport (mcp/workflow/chat).
- **Codex stdout hygiene.** The JSONL reader skips non-JSON lines (Windows `taskkill`/`ÊXITO` process
  noise) instead of warning `codex.malformed_jsonl` per line.

### Open / deferred
- Zero-friction per-dispatch App injection into the **HTTP MCP route** a CLI harness uses (it's
  stateless per-workspace; resolving the agent's active run is racy). The `resolveAppId` fallback
  (auto-single + instructive list) covers it robustly without the racy coupling.
- P2 "tool-contract card" in the agent_task preamble + deriving every tool's advertised schema from its
  zod (single source of truth) — the systemic version of the per-tool fixes above.
- ⚠️ Pre-existing unrelated failure: `OpenClawAdapter.test.ts` (2/3) — untouched by this pass.
