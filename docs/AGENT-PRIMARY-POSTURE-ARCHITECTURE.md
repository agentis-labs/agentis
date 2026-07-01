# AGENT-PRIMARY POSTURE — ARCHITECTURE BLUEPRINT

> **Status:** ARCHITECTURE SPEC (not yet built) · **Date:** 2026-07-01 · **Author:** platform / principal-architect
> **Mandate:** invert the runtime so the **agent owns the loop** and the **graph is the plan it evolves**, without regressing to the free-wheeling agent that gutted the Fashion Store factory. Autonomy and unbreakability become the *same* mechanism.
> **Extends (does not fork):** [[AGENT-AUTONOMY-10X]] (agent-primary thesis, W5.1 `propose-graph-change` — declared done, proven unreachable) + [[UNBREAKABLE-WORKFLOW-CREATION-ARCHITECTURE]] (the three contracts + taxonomy) + [[AGENT-BUILD-LOOP-10X-MASTERPLAN]] (author→dry-run→debug→run). Honors [[feedback_no_duplication]].

---

## 0. The gap this closes (verified in code, 2026-07-01)

AGENT-AUTONOMY-10X (2026-06-17) declared its plan "functionally COMPLETE," including W5.1 `propose-graph-change` — "make the existing planner-splice *agent-initiated*." **It is not reachable.** Traced end-to-end:

- **In-process `agent_task` session** (`agentSessionRuntime.ts:814`, `CONTROL_TOOLS`): a **closed, hardcoded** tool set. It has `build_workflow` (author a *separate* workflow), `run_workflow` (run a *saved* one), `spawn_team`, and `flag_deviation` (record a *verdict*). It has **no tool that extends the graph it is running in.** `applyGraphPatch` is absent.
- **External harness over MCP** (Claude Code / Codex — the operator's literal example): `tools/list` *does* surface `agentis.workflow.patch` (`mcp.ts:156`, `mcpExposed`). But the live-run branch needs `runId + patch` (`build.ts:253`), and the harness MCP context carries `workspace / ambient / agent` headers and **no `runId`** (`mcpHarnessSession.ts:82`, `callMcpTool` has no runId in scope). So it can only replace a workflow *at rest*, never extend the **running** one it is a node inside.
- **Operating manual** (`agentOperatingManual.ts:24`): "Reflect & replan" means *reject bad input and re-scope* — it never grants "extend the live graph," and `agentis.workflow.patch` is never named.

**So the powerful primitive (`applyGraphPatch`: cycle-guarded, revision-guarded, already carries `reason: 'planner_replan'`) was plumbed only to the OPERATOR (REST + chat MCP).** The agent standing inside a run, discovering it needs a step, is handed a *verdict* tool where it needs an *authorship* tool. That is the whole gap — a missing wire, not a missing capability.

But the naive fix ("just expose the patch tool to the agent") is exactly what caused the Fashion Store disaster: an agent freely mutating a silent data-flow minefield produced five green-washed corpses. **The AUTONOMY plan and the UNBREAKABLE plan were written three weeks apart and never reconciled.** This document reconciles them.

---

## 1. The thesis: the contracts are the steering, not the cage

The two forces look opposed:

| Force | Wants | Source |
|---|---|---|
| **Autonomy** | agent discovers → decides → *extends the plan* | AGENT-AUTONOMY-10X |
| **Unbreakability** | no gutting, no shape-mismatch, no green-wash, no whack-a-mole | UNBREAKABLE-ARCHITECTURE |

They are the same mechanism seen from two sides. In the old posture the **operator** authors a graph and the contracts validate the *operator's* edits. **Agent-primary just changes who drives:** the **agent** proposes every evolution, and the **same contract transaction** validates the *agent's* edits — atomically, reversibly, with named regressions returned as the agent's next observation.

> **The Evolution Contract (Organ 3) is what makes it safe to hand the agent the wheel.** Without it, agent-driven evolution = whack-a-mole. With it, an edit that breaks a coupling, deletes a capability, or lowers the green ratchet is *rejected at the moment the agent proposes it*, with the reason, by name. The agent can no more corrupt the graph from inside a run than the operator can from the canvas.

This collapses build-time and run-time into **one loop**. The AGENT-BUILD-LOOP (author → dry-run → debug → run) stops being a thing the operator does *before* execution and becomes a thing the agent does *during* it, from inside, driven by what it discovered. Same validations, same typed feedback — different driver, different moment.

---

## 2. The inverted unit of authority

Today a node's contract is *"emit exactly this output shape, no matter what."* That is the cage. In agent-primary posture a node's contract is:

```
objective + success criteria  →  achieve it; if reality diverges from the plan, EVOLVE the plan.
```

The graph stops being a script the agent is trapped executing and becomes the agent's **durable, typed, externalized working memory of its plan** — the thing it holds in the "global" tier (Organ 5) and grows as it learns. The deterministic spine still dispatches; the difference is the agent may now *rewrite the spine ahead of itself* within the contracts.

This is not a second engine ([[feedback_no_duplication]]). It is the existing `WorkflowEngine` run loop plus one new agent move and the transaction that guards it.

---

## 3. The agent-primary run loop (the heart)

```
WAKE     objective + Intent Manifest + typed contract summary (global, small)
         + Node Process Briefing (local: typed input, required output, downstream reads)
  → THINK   one cognitive step
  → ACT     role tools · delegate · spawn_team · run_workflow · bridged MCP …
  → DISCOVER  a fact the current plan does not handle
              (an auth wall, a richer data shape, a needed extra stage)
  → EVOLVE  ← THE NEW MOVE: propose steps against the LIVE run graph
       └─ Evolution Transaction (Organ 3): apply to a copy →
            structural ✓  ·  data-coupling ✓ (Organ 1)  ·  intent ✓ (Organ 2)  ·  typed dry-run ✓
          ├─ COMMIT → inject the new green typed contract summary as the observation
          └─ REJECT → inject the named regressions ("you read .signals; entry-contract
                       produces .evidence.signals") — the agent adapts and retries
  → CONTINUE  until objective met, or a budget / approval / green boundary is hit
```

The `EVOLVE` step *is* `applyGraphPatch`, wrapped in the transaction, addressable at the **current run**, exposed as a first-class control tool, and taught in the manual. Everything under it already exists or is specified in UNBREAKABLE §4.

---

## 4. What must be built (six moves, in dependency order)

### M1 — Organ 3: the Atomic Evolution Engine *(the keystone — nothing else is safe without it)*
Wrap `applyGraphPatch` (already validate+persist+revision+audit) as the `EditTransaction` from UNBREAKABLE §4: `baseHash` optimistic concurrency → apply to a **copy** → run the four validations → **commit only if nothing regressed vs base; else reject with named regressions.** Add the **monotonic green ratchet** (`greenAt`) and a **rollback snapshot** per commit. Self-heal already routes through `applyGraphPatch` (`WorkflowEngine.ts:2285`), so it inherits transactional safety for free — a heal that regresses intent is auto-rolled-back instead of persisted. **This is the substrate; M2–M6 are inert and dangerous without it.**

### M2 — The missing wire: `runId` in context + an `evolve_plan` control tool
Two halves of the audit's finding:
- **In-process session:** add `evolve_plan` to `CONTROL_TOOLS` (`agentSessionRuntime.ts`) — a synchronous tool that calls the M1 transaction against `runCtx.runId` (already in scope). Result shape = `{ committed, newContractSummary }` or `{ rejected, regressions[] }`, injected as the tool observation. Symmetric with `flag_deviation`, but it *acts* instead of *recording*.
- **MCP harness:** inject the run handle into the harness context so an external Claude Code node can address its own run. Thread `x-agentis-run` alongside the existing `x-agentis-agent` header (`mcpHarnessSession.ts`) and resolve it in `callMcpTool` (`mcp.ts`), so `agentis.workflow.patch`'s live-run branch is finally addressable from inside a run — through the M1 transaction, never raw.

### M3 — Evolution authority policy *(reuse, don't invent)*
`settings.evolutionAuthority: 'operator' | 'agent_within_green' | 'agent'` — modeled exactly on the existing self-heal authority (`selfHeal.config`, autonomous vs approve). Governs the `evolve_plan` tool:
- `operator` — evolution proposals become approval requests (today's posture; correct for scheduled/audited pipelines).
- `agent_within_green` *(recommended default for agent-primary Apps)* — the agent commits freely **as long as the ratchet stays green and budget holds**; a green-degrade or an outward/irreversible new step hits approval (W6).
- `agent` — full autonomy within budget (exploratory / one-shot).

### M4 — The evolution doctrine in the operating manual
Add to `DEFAULT_CAPABILITIES_MANUAL` a bullet that grants and *bounds* the new power:
> **Evolve the plan, don't force-fit it.** When you discover the plan in front of you can't reach the objective — a stage is missing, the data is richer than assumed, an external surface changed — add the steps with `evolve_plan`. The contracts are your steering: a rejection tells you *by name* what you'd break (a shape you don't produce, a capability you'd delete) — fix that and re-propose. Never fabricate a value or gut a step to avoid evolving. A resource wall (rate-limit, auth) is not a logic bug — do not route around it.

This turns the manual from a description of powers-the-agent-has-but-never-uses into an operating doctrine, and hard-links the failure taxonomy (Organ 4) so "evolve" never means "delete the hard node."

### M5 — Two-tier context (Organ 5), surfaced for evolution
The agent reasons about *whether/how* to evolve over the **global tier** — the Intent Manifest + typed contract summary (node ids, kinds, output schemas, edge couplings; a few KB), not 71 node bodies. `buildNodeProcessBriefing` (already built) is the local tier. Correctness lives in the contracts, not the agent's context window, so evolution stays sound as the graph grows past what fits in context.

### M6 — Mode + UX
`settings.executionMode: 'deterministic' | 'agent_primary'` per App/workflow. Same graph artifact either way; the mode selects the default `evolutionAuthority` and how the run is narrated. Evolution streams into Mission Control on the **existing self-heal channel** (diagnosis · patch diff · which contracts it passed · one-click rollback to the last green hash). No new surface.

---

## 5. Sequencing & why

1. **M1 (Atomic Evolution Engine)** — keystone. Ship it *before* any agent can evolve, or you rebuild the Fashion Store disaster with a faster trigger. Highest-leverage, and self-heal hardens with it immediately.
2. **M2 (wire + tool)** — the literal gap. In-process half first (trivial, closed set); harness half second (header thread).
3. **M3 (authority policy)** + **M4 (doctrine)** — ship together; the tool is dangerous ungoverned and useless untaught.
4. **M5 (two-tier context)** — makes it scale to large graphs; half-built already.
5. **M6 (mode + UX)** — operator legibility and control; last because it's presentation over a working mechanism.

Every move extends a proven seam: `applyGraphPatch`, `CONTROL_TOOLS`, `selfHeal.config`, `agentOperatingManual`, `buildNodeProcessBriefing`, the Mission-Control self-heal stream. **No new runtime. No third engine.**

---

## 6. Non-negotiables (inherited + sharpened)

1. **No third runtime.** `evolve_plan` is one control tool on the existing session loop; `agent_task` stays one caller of the one `AgentSession`. (AUTONOMY #1)
2. **Every evolution passes the contracts.** No raw `applyGraphPatch` from an agent — always through the M1 transaction. Data-coupling, intent, green ratchet, dry-run: all four, every time.
3. **The green ratchet is a hard floor** in `agent_within_green`. An agent may grow the plan freely; it may not lower it below green without operator `--force-degrade`.
4. **Failure taxonomy is load-bearing** (Organ 4). `evolve_plan` may repair *logic*; a *resource* / *evidence* failure is quarantined — the agent is structurally forbidden from "evolving" a rate-limit away. This is the guard that keeps "autonomy" from becoming "gutting."
5. **Guardrails ship with the power** (W6): budget, depth/fan-out, approval for outward/irreversible new steps, full audit, reversible snapshots. Autonomy with a kill-switch and a ledger.
6. **Workflows remain first-class deterministic pipelines.** Agent-primary is a *mode*, opt-in; scheduled/audited automation keeps `operator` authority and a frozen graph. This elevates agents above the graph; it does not delete the graph. (AUTONOMY #4)

---

## 7. The honest ceiling

Agent-primary posture does **not** make the agent omniscient or the plan self-completing. It makes the agent's plan a **living, typed, intent-bound artifact the agent can safely grow** — and when it can't (a hostile external surface, exhausted credits, evidence that doesn't exist, an evolution that can't stay green within budget), it **stops with a truthful, typed, actionable blocker and escalates**, exactly as UNBREAKABLE §9 promises. The win is precise: *the agent stops being a boxed node executing someone else's frozen plan, and becomes an operator that grows its own plan under contracts that make corruption structurally impossible.* It never lies, never guts, never routes around reality — it either does the real work, grows the plan to do it, or tells the truth about why it can't.

---

## 8. Open decisions (operator)

- **D-mode default:** should a newly-created **App** default to `deterministic` (safe, today's behavior) or `agent_primary` (the posture)? Recommended: **deterministic default, agent-primary opt-in per App**, so the inversion is a deliberate choice, not a surprise on every existing pipeline.
- **D-authority default** for agent-primary Apps: `agent_within_green` (recommended — free growth, gated degrade/irreversible) vs `agent` (full-autonomy-within-budget).
- **D-harness parity:** ship `evolve_plan` to in-process sessions first and treat the MCP-harness `runId` wire (M2 half two) as a fast-follow, or gate the whole feature until both paths reach parity? (Recommended: in-process first — it's the majority path and de-risks M1.)

---

## 9. Implementation Log
*(Append per shipped move — [[feedback_masterplan_log]].)*
- **2026-07-01 — SPEC authored.** Grounded in a live code trace proving W5.1 `propose-graph-change` unreachable in-run (in-process `CONTROL_TOOLS` lacks the tool; MCP harness lacks `runId`; manual lacks the doctrine). Reconciles AGENT-AUTONOMY-10X (who drives) with UNBREAKABLE-ARCHITECTURE (what guards every edit): agent-driven evolution *is* the contract transaction with the agent as driver. Keystone = Organ 3 (Atomic Evolution Engine), still unbuilt — nothing here is safe to ship before it. NOT built: any of M1–M6.
- **2026-07-01 — M1+M2+M3+M4 core SHIPPED & tested e2e** (core+api typecheck clean; 10 new tests green — 5 ratchet + 5 engine/e2e; 51-test regression sweep across graphPatch/spawnTeam/agentSession/selfHeal/intentContract/validateExpressions green).
  - **M1 — Atomic Evolution core** (`services/atomicEvolution.ts`): `evaluateEvolution(base, merged, priorManifest)` = the pure green ratchet — a NEW coupling error (Organ 1 `analyzeEdgeCouplings` diffed against base, so pre-existing red is not a regression) or an approval bypass (Organ 2 `checkIntentIntegrity`) is a hard regression; a dropped capability is a warning. Plus `summarizeContract` (the Organ-5 global-tier string), `EvolutionAuthority`, and `get/setEvolutionConfig` (workspace_kv `evolution.config`, default `agent_within_green`) modeled on `selfHealSettings`.
  - **M1 commit — `WorkflowEngine.evolveGraph`** (extends, does not duplicate, `applyGraphPatch`): authority gate → override `baseGraphRevision` (the agent authors shape, not bookkeeping) + `reason:'agent_evolve'` → immutable-spine guard (never remove a RUNNING/COMPLETED node, ctx-or-persisted) → `mergeGraphPatch` on a copy → structural `validateWorkflowGraph` → the ratchet → commit via `applyGraphPatch` → **seed run bookkeeping for added nodes** (nodeState PENDING + a `waitingInputs` buffer keyed on incoming edges, pre-absorbing already-completed upstreams). Returns `{committed, newRevision, contractSummary, warnings}` or `{committed:false, rejected, regressions[]}` — a rejection is a typed instruction, never a throw.
  - **M2 — the wire.** `evolve_plan` added to the in-process `CONTROL_TOOLS` (`agentSessionRuntime.ts`) + `#execEvolvePlan` (synchronous; builds the patch, calls the engine, injects committed/rejected as the observation). New dep `evolvePlan`, late-bound in `bootstrap.ts` to `engine.evolveGraph` (mirrors the `agentRuntimeResolver` construction-order pattern). New honest patch reason `agent_evolve` (core type + zod enum). ⚠️ The **MCP-harness** half of M2 (thread `x-agentis-run` so Claude Code can address its own run) is NOT yet wired — in-process sessions only.
  - **M4 — doctrine.** "Evolve the plan, don't force-fit it" bullet in `DEFAULT_CAPABILITIES_MANUAL` (grants the power, binds it to the failure taxonomy: never evolve a resource wall away, never gut to pass a rejection).
  - **The true e2e** (`tests/engine/WorkflowEngine.evolveGraph.test.ts`): an `agent_session` inside a running workflow calls `evolve_plan` → the engine validates + commits → **the newly-authored node executes to COMPLETED in the same run.** The missing wire is closed; the loop from §3 runs.
  - **Root cause found & fixed while building:** a mid-run-added node was silently orphaned because the completion fan-out (`WorkflowEngine.ts` ~8846) only promotes a target that already has a `waitingInputs` buffer — evolved nodes had none. `evolveGraph` now seeds it (mirrors `buildInitialRunState`). This is exactly the "built-but-not-wired" class the platform-wire-gap audit catalogs.
- **2026-07-01 — M2 (harness) + M3 + M5 + M6 SHIPPED & tested** (api typecheck clean; 13 evolve tests green incl. 3 new — outward-guard, executionMode-sugar, rollback-checkpoint; broad engine/route regression sweep green).
  - **M2 harness half — solved WITHOUT a new header.** The audit's "harness has no `runId`" is closed by routing + prompt: (a) `agentis.workflow.patch`'s live-run branch (`build.ts`) now calls `engine.evolveGraph` (the contract transaction) instead of raw `applyGraphPatch`, so an external Claude Code / Codex node evolving over MCP gets the same green ratchet + authority as an in-process session — one commit path; (b) the runId is handed to the agent via the M5 `<live_plan>` block, so the harness self-addresses (no per-run MCP config needed). `evolveGraph` now normalizes a partial patch (harness may omit arrays).
  - **M3 — authority policy, surfaced.** `GET|PUT /v1/workspaces/:id/evolution` (workspace default authority, mirrors the self-heal route). Per-workflow `settings.evolutionAuthority` already wins via `resolveEvolutionAuthority`. **Outward guard**: under `agent_within_green`, an evolution that adds an outward/irreversible node (integration or HTTP write — reuses `workflowRobustnessAudit`'s conservative classifier via `isOutwardNode`) is refused (`rejected:'authority'`) — that step is an operator decision; full `agent` authority allows it.
  - **M5 — proactive global tier.** `#buildLivePlanBlock` injects a `<live_plan>` block into the run context (`#withWorkspaceContext`, all agent paths) carrying the Intent Manifest goal + `summarizeContract(graph)` + the runId + how to evolve — only when authority ≠ operator (deterministic runs are never told to reshape a frozen pipeline). The agent now reasons over the whole plan proactively, not just reactively from an evolve result.
  - **M6 — mode + rollback + stream.** `settings.executionMode` (`deterministic` → operator authority; `agent_primary` → workspace default) as sugar over `evolutionAuthority`, honored in `resolveEvolutionAuthority`. Every committed evolution writes a **rollback checkpoint** (`workflow_repair_checkpoints`, synthetic `incidentId:'evolve'` / `planId:'evolve:<patchId>'`) so the existing `rollbackSelfHeal` path gives one-click revert. The Mission-Control **evolution stream** is the existing `WORKFLOW_GRAPH_PATCHED` event + `workflow.graph_patched` activity, now distinguishable by `reason:'agent_evolve'`.
  - **NOT built (remaining follow-ups):** a full park-for-approval flow on an outward evolution (today it fails-closed with guidance rather than parking + resuming — the approval system exists to build on); a dedicated web UI panel for evolution authority / the Mission-Control evolution timeline (the route + event exist; the surface is presentation); and `updateNodes`/edge-rewire buffer reconciliation for evolutions that re-wire existing nodes (today's seeding covers added nodes, the dominant case).
