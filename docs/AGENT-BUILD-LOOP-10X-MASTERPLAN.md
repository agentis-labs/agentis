# AGENT BUILD LOOP — 10X MASTERPLAN

> **Status:** PLAN (not yet implemented) · **Date:** 2026-07-01 · **Owner:** platform
> **Thesis:** Agents can't reliably build workflows in Agentis because they build **blind**, across a **data-flow minefield of silent footguns**, with the **grammar deliberately withheld** from the exact harnesses we ship. Fix = give agents the developer loop they use for code — **author → dry-run → debug-run → observe → fix → learn** — and make the data-flow honest.
>
> Evidence base: 4 parallel code inspections (data-flow semantics, tool surface + self-heal, build guidance + primitives, dry-run/preflight inventory) + internet review (n8n, Temporal, LangGraph, Dagster). Every root cause below is cited to `file:line` and the load-bearing ones were re-verified against source.

---

## 0. Verdict

A developer's loop is *write → run → read the error → fix*. Agentis gives agents the **write** half and almost none of the **run/observe** half. Worse, the substrate they write into has at least six **silent** failure modes — no exception, no warning, just a quietly-empty object flowing downstream — and the one gate meant to catch them (`build_workflow`'s condition validator) validates against a scope the runtime never actually provides. The result is exactly what the operator reported: Opus 4.8 / GPT-5.5 patch the same node forever, each fix plausible, none working, because **there is no way for the model to see what the data actually did.**

This is not a model-capability problem. It is a **missing feedback loop + a dishonest substrate**. Both are fixable, mostly by *exposing and completing machinery we already have*.

---

## 1. Autopsy: the "Fashion Store Factory" failure, fully explained

The operator's workflow kept returning `{ "selected": null, "scoredCount": 0, "continueLoop": true }` forever. Every root cause below contributed, and together they explain 100% of the symptom:

1. **The scorer received an empty batch.** Candidates flowed from `normalize-prospect-batch`, but the scoring path either stripped them (`inputMapping` non-empty → strip-to-mapped, §2.C-1) or never received them because a **conditional edge silently evaluated to `false`** (§2.C-2). No error was thrown at either boundary.
2. **The empty result looked like success.** Self-heal only validates a node's **output** contract, never its **input** shape (§2.C-6). `scoredCount: 0` is a contractually-valid output, so the node "COMPLETED" and nothing healed it. There was no failure to chase — only a business-logic-shaped zero.
3. **The loop never terminated.** The `continueLoop` gate was a router/edge condition that silently resolved to `undefined → false`/`true` under the wrong runtime scope (§2.C-2/-5), so the loop's exit was never taken.
4. **The agent could not see any of this.** It had no `workflow.run` over MCP (§2.A), so it patched blind. When a human finally ran it, **self-heal masked the raw failure** (§2.E), so even the human's run reported the wrong story.

Every "fix" in the transcript (toggle `inputMapping`, add guard nodes, rewire edges) was a plausible guess at an *invisible* data-flow. The agent was debugging with the lights off.

---

## 2. Root-cause taxonomy (code-grounded)

### A. Blindness — agents can't run or observe what they build

The entire run/observe/diagnose tool family is registered **without `mcpExposed: true`**, so MCP-native harnesses (Claude Code / Codex — the modern, preferred integration) cannot call it. Author/validate tools *are* exposed; the asymmetry is total.

| Capability | Tool | `mcpExposed`? | Reachable by MCP agent? |
|---|---|:---:|:---:|
| Build / patch / validate | `build_workflow`, `workflow.patch`, `workflow.validate`, `workflow.patterns` | ✅ | yes |
| **Run** | `agentis.workflow.run` ([run.ts:23](apps/api/src/services/agentisToolHandlers/run.ts)) | ❌ | **no** |
| **Test-run (no save)** | `agentis.ephemeral.run` ([ephemeral.ts:17](apps/api/src/services/agentisToolHandlers/ephemeral.ts)) | ❌ | **no** |
| **Status / progress** | `workflow.status`, `run.status` | ❌ | **no** |
| **Diagnose** | `agentis.run.diagnose` | ❌ | **no** |
| **Replay from node** | `agentis.run.replay` | ❌ | **no** |

This exactly matches the transcript's *"this runtime does not expose workflow.run."* Note: legacy **text-marker** harnesses (Cursor/Antigravity/Hermes) *do* get these via the unfiltered `CHAT_TOOL_CATALOG` — only the MCP-native path is blind, which is the path the operator is using.

### B. No agent-facing test bench — but 70% of one already exists

[`workflowPreflight.ts:160` `simulateGraph`](apps/api/src/services/workflowPreflight.ts) is a genuine topological executor: it walks the graph in dependency order, threads each node's **real merged upstream output** into the next node's input, **executes `transform`/`filter` for real**, and does **contract-check-then-mock** for `integration`/`http_request`/`extension_task`. That is precisely "skip the AI/integration nodes, trace the whole I/O." Gaps:

- It is **not an agent-callable tool** — it only runs as a hidden side-effect of `build_workflow` and via HTTP-only canvas routes; not `mcpExposed`.
- Its local handler registry omits `registerUtilityNodeHandlers`, so ~13 **deterministic** kinds (`code`, `datetime`, `json_schema_validate`, non-LLM `router`, `guardrails`, `crypto_util`, `xml_parse`, `markdown`, `html_extract`, `error_trigger`, `stop_error`, …) are **mocked instead of executed**, despite the handlers existing and the real engine using them.
- Its output is a compacted health report (first-20-keys `compactOutput`), not a full **per-node I/O trace** with the resolved *input* retained.
- Contract assertion exists only for connector operations, not as a general "node A's real output shape vs. what node B dereferences."

Two more latent capabilities: [`WorkflowEngine.testNode`](apps/api/src/engine/WorkflowEngine.ts:936) (single-node *real* execution, canvas-only) and [`PartialReplayService`](apps/api/src/services/partialReplay.ts:58) (replay a real run from a node).

### C. The data-flow minefield — six silent, undocumented footguns

*(Load-bearing ones re-verified against source.)*

1. **`inputMapping` empty-vs-non-empty** (`extension_task`, `subflow`). [`mapInputs` WorkflowEngine.ts:9876](apps/api/src/engine/WorkflowEngine.ts): `if (Object.keys(mapping).length === 0) return inputData;` → empty `{}` passes the **whole** payload; any non-empty mapping returns a **new object with ONLY the mapped keys** — everything else becomes `undefined`, silently (never throws). Zero `.describe()` in the Zod schema; the grammar card never explains the branch. **This is the toggle the operator kept flipping.**
2. **Conditional-edge scope is 2 keys; the validator checks 10.** Runtime: [`shouldTraverseEdge` WorkflowEngine.ts:10963](apps/api/src/engine/WorkflowEngine.ts) → `evalCondition(cond, { output, scratchpad })`. Build-time: [`assertConditionSyntax` validateGraph.ts:527](apps/api/src/engine/validateGraph.ts) validates against `{ input, inputs, output, trigger, nodes, scratchpad, store, workspace, run, loop }`. So `nodes.x`/`trigger.x`/`input.x` in an edge condition **passes validation** (property access on `{}` = `undefined`, no throw) then **silently evaluates false forever** at runtime. A validation false-negative baked into the code. The platform's own worked example (`build.ts:2966`) models the broken pattern.
3. **`inputKeys` is inert on the common `agent_task` path.** [`#dispatchAgentTask`](apps/api/src/engine/WorkflowEngine.ts:4203) never reads `config.inputKeys`; `pickKeys` is only applied on the `agent_session`/`planner`/`code` paths. The field is accepted by Zod, shown in every worked example, and **silently ignored** for the default dispatch — training the model that it scopes input when it does nothing.
4. **`merge_keys` shallow-merge silently clobbers.** [`mergeBufferedInputs`](apps/api/src/engine/WorkflowEngine.ts:9995) default strategy `Object.assign`es upstream outputs in edge order; two branches emitting the same key → last wins, no warning.
5. **Router scope aliases `nodes`/`trigger` to the router's own input.** [`#executeRouter` WorkflowEngine.ts:6123](apps/api/src/engine/WorkflowEngine.ts): `trigger: inputData, nodes: inputData`. `nodes.otherNode.field` re-reads the router's input, not that node's output — "works" with one predecessor, fails silently with two. (Also: routers get 6 scope keys, plain edges get 2 — the *same* condition string behaves differently on a router branch vs. a conditional edge.)
6. **Self-heal covers OUTPUT contracts, never INPUT shape.** [`#completeNode`](apps/api/src/engine/WorkflowEngine.ts:8508) runs the whole heal ladder when a node's declared `outputKeys` are violated — but a node fed `{}` runs "successfully" with garbage and emits a valid-but-empty output that nothing heals. The run reports `COMPLETED`, not `FAILED`.

**The unifying defect:** what looks like one expression language is **four runtime dialects** (template `{{}}`, transform/code JS, router branch, conditional edge) plus a **fifth** build-time validation superset that matches none of them. Unify these and footguns #2 and #5 disappear.

### D. The grammar is withheld or wrong

- **MCP-native harnesses receive ZERO doctrine.** The Iron Rules, Expression Contract, and Design Doctrine are injected only when `toolSurface !== 'mcp_native'` ([orchestratorPrompt.ts:372](apps/api/src/services/orchestratorPrompt.ts)). Claude Code / Codex over MCP see bare tool descriptions — none of the grammar. **We are asking our best models to write in a language whose rules we hide from them.**
- **Iron Rule 15 is a documented lie.** It promises `nodes["id"].field` "resolves identically in routers"; §2.C-5 shows it doesn't. And the shipped [pattern library](apps/api/src/services/workflowPatterns.ts:50) uses the disclaimed `inputs["qualify"].pass` router form. Router conditions are the one expression surface `validateExpressions.ts` never lints.
- **Extension authoring guidance is inverted.** Tool description says "export async functions"; [`validateSource.ts`](apps/api/src/extensions/validateSource.ts) *blocks* `module.exports`/`exports`/`require`/`import`. The correct contract (top-level `async function name(inputs, ctx)`, `ctx.http.fetch` for network) appears only in post-failure remediation strings.
- **Abilities & Specialists have no Iron-Rules equivalent.** Three of five primitives get materially less proactive doctrine than workflows, and the extension doctrine that exists is wrong. Ability on-ramps (`examples`, `material`) exist in the service but aren't exposed as tool params.

### E. Self-heal fights the debugger

Self-heal is a **runtime** recovery system with two independent healers — [`#runSelfHeal`](apps/api/src/engine/WorkflowEngine.ts:1312) (gated by a per-*workspace* setting) and [`#recoverAgentNodeViaFallback`](apps/api/src/engine/WorkflowEngine.ts:8096) (**not** gated — always fires) — plus [`#orchestratorReplan`](apps/api/src/engine/WorkflowEngine.ts:1783), a full 8-turn orchestrator session, up to 3× per failed node. Conflicts with an agent debug loop:

- **Masks the raw failure:** rewrites the node at the `#completeNode` chokepoint *before* the run reports FAILED, so the agent's later `run.diagnose` sees a healed COMPLETED run, not the original error.
- **Two writers, no lock:** `#orchestratorReplan` patches node N while the agent independently patches the same workflow row.
- **Unrequested spend:** a "just show me what happened" run triggers up to 3 full repair cycles.
- **No debug signal exists:** `StartRunArgs`/`RunningContext` carry no `debugMode`; `executionMode` only knows `chat|plan`.

---

## 3. Prior art

**What Agentis already has (reuse, don't rebuild):** `simulateGraph` (topological mock-executor), `testNode` (single-node real exec), `dryRunGraphExpressions` (sample-thread expression lint), `PartialReplayService` (replay-from-node), `workflow.learn`/`workflowPlaybook` (durable lessons), `analyzeWorkflowReadiness` + `auditWorkflowRobustness` (pre-checks), the `NodeHandlerRegistry` seam.

**Internet review — the pattern each system proves, and our equivalent:**

| System | Mechanism | Principle | Agentis equivalent |
|---|---|---|---|
| **n8n** | Pin data + mock nodes (Code/Set) + "Execute Node" partial run | You must *see resolved I/O per node* before a full run; pinned fixtures make it repeatable | Per-node I/O trace + **pinned fixtures** on the workflow |
| **Temporal** | Deterministic workflow + **mocked activities** + replay tests | Isolate deterministic logic from side-effects; test logic with the side-effects mocked | **Mock the side-effecting node kinds**; golden replay tests |
| **LangGraph** | Checkpoints + **time-travel replay/fork/edit from any node** | Debugging = re-run from a checkpoint with edited state, deterministically | Extend `run.replay` into a first-class **debug-run** |
| **Dagster** | **Asset checks** + mock resources | Contracts between steps are *first-class, asserted* tests, not comments | **Node/edge contract assertions** in the dry-run |

Sources: [n8n pin & mock](https://docs.n8n.io/build/work-with-data/pin-and-mock-data), [Temporal testing suite](https://docs.temporal.io/develop/typescript/testing-suite), [LangGraph time-travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel), [Dagster unit testing](https://docs.dagster.io/guides/test/unit-testing-assets-and-ops).

---

## 4. Target doctrine — The Agentic Build Loop

Every agent that authors *any* Agentis primitive follows the same loop, and the platform makes each arrow cheap, honest, and observable:

```
        ┌─────────────────────────────────────────────────────────┐
        │                                                         ▼
   AUTHOR ──▶ VALIDATE ──▶ DRY-RUN ──▶ (red?) ─▶ FIX ─┐   DEBUG-RUN ──▶ OBSERVE ──▶ (bug?) ─▶ FIX ─┐
  (draft graph) (static)  (mock side-    │ (contract        │  (real, self-   (per-node       │        │
                          effects, trace  │  assertions)    │   heal OFF,      I/O + honest    │        │
                          whole I/O)      └─────────────────┘   raw errors)    failure)        └────────┘
                                                                                    │
                                                                              (green) ▼
                                                                        RUN (real, self-heal ON) ──▶ LEARN
```

- **DRY-RUN** = deterministic. Executes every pure node for real, mocks every AI/integration/agent node against its declared output shape, threads real I/O node-to-node, and evaluates **contract assertions**. No LLM, no external calls, no cost, milliseconds. This is the TDD inner loop.
- **DEBUG-RUN** = real execution with **self-heal suppressed**, surfacing the raw per-node `{input, output, error}`. This is where the agent sees ground truth. Distinct from a production RUN (self-heal ON).
- **Self-heal boundary:** healers are for *production autonomy*, never for *authoring*. A dry-run and a debug-run never invoke them; a production run does. They never collide because they never overlap.

---

## 5. The plan (phased by leverage)

### P0 — Kill the silent lies *(deterministic, engine-local, no LLM, highest leverage)*

Converts the dominant "silently wrong" failures into non-events. Ship first.

- **P0.1 Unify the condition/expression scope.** Make `shouldTraverseEdge` ([10963](apps/api/src/engine/WorkflowEngine.ts)) and the readiness-time evaluation build the **same real scope** as templates — `{ input, inputs, output, trigger(real), nodes(real per-id map), scratchpad, store, workspace, run, loop }` — sourced from `#buildTemplateContext`. Fix `#executeRouter` ([6123](apps/api/src/engine/WorkflowEngine.ts)) to stop aliasing `nodes`/`trigger` to `inputData`. Now the **runtime scope == the build-time validation scope** ([validateGraph.ts:527](apps/api/src/engine/validateGraph.ts)), and a condition means the same thing everywhere. *Kills #2 and #5.* Add router branch conditions to `validateExpressions.ts` lint coverage.
- **P0.2 Make `inputMapping` legible + safe.** Add `.describe()` to both Zod fields ("empty `{}` = pass entire input through; non-empty = ONLY these keys survive, all others become undefined"). Emit a structured `InputMappingWarning` (mirroring `TemplateWarning`) on the run bus whenever a mapped field resolves `undefined`. *Neutralizes #1.*
- **P0.3 Fix `inputKeys` on `agent_task`.** Apply `pickKeys(inputData, config.inputKeys)` in `#dispatchAgentTask` for parity with the session/planner/code paths **or** deprecate the field and strip it from `build.ts` worked examples. (Recommend parity — smaller, matches intent.) *Kills #3.*
- **P0.4 `merge_keys` collision warning** in `mergeBufferedInputs` when two sources define the same key with different values. *Neutralizes #4.*
- **P0.5 Input-reachability lint.** Extend `dryRunGraphExpressions` ([validateExpressions.ts:177](apps/api/src/engine/validateExpressions.ts)) to flag when node Y references field X (`{{}}`/expr) but Y's own `inputMapping`/`inputKeys` strips X and X isn't in `scratchpad`/`store`. Catches #1 and #3 **at build time, before any run.**

**Acceptance:** the exact Fashion-Store-shaped graph passes `build_workflow` only if its loop/gate conditions actually reference the runtime scope; a stripped candidate field is a build warning, not a silent zero.

### P1 — Give agents sight *(config flip + surgical flag)*

- **P1.1 Expose the run/observe family over MCP.** Set `mcpExposed: true` on `workflow.run`, `ephemeral.run`, `workflow.status`, `run.status`, `run.query`, `workflow.list`, `run.diagnose`, `run.replay`, `run.cancel`. This alone fixes the transcript's core complaint.
- **P1.2 Debug-run mode.** Thread `debugRun?: boolean` (default false → zero behavior change) through 7 touch points: `StartRunArgs`, `RunningContext`, `#runSelfHeal` (early return), `#recoverAgentNodeViaFallback` (early return — the ungated healer), the `#completeNode` contract branch (surface honest `{input, rawOutput, error, missingKeys}` instead of a heal-wrapped message), and the `workflow.run` + `ephemeral.run` handlers. `run.diagnose` reports `selfHealApplied: false` so the agent trusts the failure is raw. Deterministic zero-token repairs may stay on behind a sub-flag.
- **P1.3 Fence the two-writer race.** `workflow.patch`/`build_workflow` surface `selfHealInFlight: true` when a heal incident is `PLANNING/DIAGNOSING` for that workflow's live run.

**Acceptance:** an MCP-native agent can `ephemeral.run` a draft, read per-node state back, and get the *raw* first failure.

### P2 — The test bench: `agentis.workflow.dry_run`

- **P2.1 New tool `agentis.workflow.dry_run`** (`mcpExposed: true`, mirroring `workflow.validate`): accepts `graphDraft` + optional sample `inputs`, returns a full I/O trace. Thin wrapper over an extended `simulateGraph` — **do not build a second simulator.**
- **P2.2 Complete `simulateGraph`.** Wire `registerUtilityNodeHandlers` into its registry (1-line) so all deterministic kinds execute for real; add real execution for `code`, non-LLM `router`, `guardrails`, `error_trigger`/`stop_error`.
- **P2.3 Real I/O-trace type.** Per node: `{ nodeId, kind, status: executed|mocked|skipped|error, resolvedInput, output, contractViolations[], durationMs }`, retained un-truncated for the dry-run path.
- **P2.4 Mock-with-contract for every side-effecting kind.** Synthesize each mocked node's output to conform to its declared `outputKeys`/output contract (not `sample_<key>` strings), so a downstream `transform` doing `.map()`/numeric ops on a mocked agent output surfaces real shape errors instead of masking them.

**Acceptance:** dry-running the Fashion-Store graph shows `candidates.length === 4` arriving at the scorer, or a red contract violation naming the exact node that dropped them.

### P3 — TDD: fixtures + assertions + regression fence

- **P3.1 Pinned fixtures** (n8n parity): persist sample payloads per workflow input / per node on `workflow.settings.fixtures`; dry-runs replay against them for reproducibility. Seed from the existing `selectScenario` triage.
- **P3.2 Node/edge contract assertions** (Dagster asset-check parity): a declarative `assert` per node ("`candidates.length > 0` after `normalize`"), evaluated in the dry-run, reported as red/green. This is the operator's "TDD" ask made concrete.
- **P3.3 Loop closure:** on a dry-run/debug-run revealing a novel failure→fix, record a `workflow.learn` lesson (mechanism exists) so future builds design around it.
- **P3.4 Regression fence:** a committed engine test that dry-runs the full pattern library + a canonical complex (Fashion-Store-shaped) workflow and asserts green — so the P0 unification can never silently regress.

### P4 — Legible data-flow + honest, universal guidance

- **P4.1 Single source of truth:** `.describe()` across node-config Zod schemas (the agent introspects these).
- **P4.2 Fix `build.ts` grammar card + worked examples** (remove the broken edge-condition example; show the correct unified condition scope; explain `inputMapping`/`inputKeys`).
- **P4.3 Fix the pattern library** router/edge conditions ([workflowPatterns.ts:50,97](apps/api/src/services/workflowPatterns.ts)).
- **P4.4 Deliver the grammar to MCP-native harnesses.** Remove the `toolSurface !== 'mcp_native'` gate (or inject a compact **Build Contract Card** — Iron Rules + unified Expression Contract + the Build Loop — into the MCP server instructions/tool preamble). *This is the single highest-impact guidance fix for the operator's setup.*
- **P4.5 Carry the Build Contract Card into the runtime node briefing** so a node executing mid-run knows the expression contract, not just the build-time author.
- **P4.6 Correct extension authoring guidance** in the tool description ("top-level `async function <op>(inputs, ctx)`; no `module.exports`/`require`/`import`; use `ctx.http.fetch`").

### P5 — Extend the loop to the other primitives

- **P5.1 Extensions:** add a `test`-operation tool (run an extension op against sample inputs in the sandbox — reuse the extension runtime) + the corrected doctrine (P4.6). Author → validate (sandbox) → test → use.
- **P5.2 Abilities:** expose the `examples`/`material` on-ramps as `ability.create` params; add an **Ability Doctrine** (what makes a well-scoped, graduation-worthy ability); surface the existing self-eval to the agent.
- **P5.3 Specialists:** add a **Specialist Doctrine** (scope/boundaries/system-prompt quality); a create-time preflight reusing `checkAgentBindings` (has a runtime? has affordances?); tell the agent to consult `modelRoutingPolicy` before pinning a model.
- **P5.4 Brain:** disclose the two write tools' enforcement gap; route `agentis.memory.write` through the same scrub/gate as `data_promote_memory`; document workspace-vs-App recall scope.

---

## 6. Ship order & the acceptance bar

**Order:** **P0 → P1 → P2** first — together they convert the dominant silent failures into non-events *and* let the agent see and test. Then P3 (TDD rigor), P4 (guidance — cheap, do alongside), P5 (breadth).

**North-star acceptance (the operator's demand, made testable):**
> Take the real `Fashion Store Factory` workflow. An agent (a) builds it, (b) `dry_run`s it and sees `candidates` reach the scorer with contract assertions green, (c) `debug_run`s it once against real sources with self-heal off and reads the honest per-node trace, (d) fixes any red, (e) `run`s it **E2E green — with zero human edits.**

If that passes for three independently-generated complex workflows, Agentis is ready to operate.

---

## 7. Non-goals / anti-duplication guardrails

- **Do NOT build a second simulator.** Extend `simulateGraph`; the dry-run tool is a thin wrapper. (`feedback_no_duplication`.)
- **Do NOT branch on model family** anywhere in this work. (`feedback_model_agnostic_tools`.)
- **Do NOT weaken self-heal** — scope it out of authoring, don't remove it from production.
- **Do NOT claim green from piped output** in the P3.4 fence — capture the exit code, re-run typecheck/tests after each edit round. (`feedback_clean_no_loose_ends`.)
- Reuse `testNode`, `PartialReplayService`, `workflow.learn`, `analyzeWorkflowReadiness`, `auditWorkflowRobustness` — the loop is mostly *wiring existing organs together*, not new organs.

---

## 8. Implementation Log

*(Append one entry per shipped wave; keep reconciled with real code — `feedback_masterplan_log`.)*

- **2026-07-01 — PLAN authored.** Diagnosis verified against source (P0 engine bugs re-read and confirmed: `mapInputs:9881`, `shouldTraverseEdge:10963`, `assertConditionSyntax:527`, `#executeRouter:6123`).
- **2026-07-01 — P0–P5 core SHIPPED** (branch `feat/agent-build-loop`; api + core typecheck clean; 382 engine+service tests green incl. new regression tests).
  - **P0** — unified condition scope: new `#buildConditionScope`/`#buildConditionScopeBase` + `withCurrentData` in `WorkflowEngine.ts`; router (`#executeRouter`), both edge sites (`shouldTraverseEdge` at fan-out + readiness), and converge all share it, now matching `assertConditionSyntax`'s 10-var scope. `inputMapping`/`inputKeys` `.describe()`d in `packages/core/src/schemas/workflow.ts`. `inputKeys` now honored on `agent_task` (`#dispatchAgentTask` applies `pickKeys`). `analyzeInputReachability` lint added to `validateExpressions.ts` + wired into `build.ts`. (P0.4 merge-collision → folded into the Build Contract card.)
  - **P1** — `mcpExposed:true` on the whole run/observe/diagnose/replay family + `ephemeral.run` + `workflow.cancel`. `debugRun` flag: `StartRunArgs` + `#debugRuns` set + guards in `#runSelfHeal` and `#recoverAgentNodeViaFallback`, forwarded from `workflow.run` + `ephemeral.run` (+ `ephemeralWorkflowService`). (P1.3 `selfHealInFlight` fence deferred.)
  - **P2** — `agentis.workflow.dry_run` tool (mcpExposed) in `build.ts` over `preflightWorkflow`/`simulateGraph`; `registerUtilityNodeHandlers` wired into preflight's registry (13 deterministic kinds now execute for real, not mocked); per-node resolved `input` added to `NodeHealthResult` + recorded in `simulateGraph`. (P2.4 deeper per-kind mock-with-contract synthesis deferred.)
  - **P3** — regression tests: edge-condition-by-node-id routing (`WorkflowEngine.conditionEdges.test.ts`) + `analyzeInputReachability` (`validateExpressions.test.ts`, +4). (P3.1 pinned fixtures + P3.2 declarative assertion DSL deferred.)
  - **P4** — `AGENTIS_BUILD_CONTRACT` card injected for EVERY surface incl. `mcp_native` (orchestratorPrompt.ts:373); pattern-library router conditions fixed (`inputs[...]`→`nodes[...]`); Iron Rule 15 accuracy (adds "edge conditions"); extension authoring guidance corrected in `capability.ts` + `chatToolCatalog.ts`.
  - **P5** — `agentis.memory.write` discloses its ungated/workspace scope; `agentis.ability.create` exposes the `examples`/`material` on-ramps. (Specialist doctrine + extension test-tool deferred.)
  - ⚠️ The P0 edits shifted `WorkflowEngine.ts` line numbers (+~40) — anchor on symbols, not the numbers in §2. Working tree also carries unrelated in-flight adapter work; only build-loop files were changed.
- **2026-07-01 — deferred-items wave SHIPPED** (typecheck clean; preflight+patterns+utility+dataQuery 48 tests green): **P3.2** declarative contract assertions on `agentis.workflow.dry_run` — `[{ nodeId, expr, message }]` evaluated over the trace via `evalCondition` (scope: input/output/nodes/trigger), any failure → `ok:false`; the TDD red/green. **P2.4** typed mocks (`mockValueForKey` in `workflowPreflight.ts`) — collection/number/boolean output keys mock to real shapes (`[{}]`/`1`/`true`), not `sample_<key>`, so downstream deterministic nodes get realistic I/O. **P5** Primitive Authoring doctrine (specialists/abilities/extensions/brain) added to `PLATFORM_ARCHITECTURE_KNOWLEDGE`. STILL DEFERRED (low value / narrow): P1.3 `selfHealInFlight` fence, P3.1 pinned-fixture persistence, a dedicated extension test-tool.
