# SWIFT — Enforced Workflow Quality: from COMPLETED to ACCOMPLISHED

> **Status:** PLAN v2 → implementing · **Date:** 2026-07-02 · **Owner:** platform
> **Trigger (operator):** "A workflow that runs is a thing; a workflow that runs and gets **exactly what we need** is a successful run." SWIFT (Scoping, Workflow, Iterate, Formalize, Trigger) as the enforced lifecycle — but the currency of every gate is **verified accomplishment**, not completion.
> **v2 correction:** v1 gated on completion evidence (dry-run green, debug COMPLETED). The platform's own failure history proves completion lies: the Fashion Store run COMPLETED with gutted stubs; a release-validator COMPLETED outputting "run vercel deploy"; contract violations "complete" with typed-empty keys. This revision makes the outcome the first-class object.

---

## 0. The three layers of run truth

| Layer | Question | Status in the tree |
|---|---|---|
| 1. **Mechanical** | did the nodes run, did edges route? | ✅ run `status`, skip propagation, failure taxonomy (POLICY/RESOURCE/LOGIC) |
| 2. **Contractual** | do outputs have the right shape? | ✅ `graph.inputContract`, node `outputKeys`, typed-empty defaults, `COMPLETED_WITH_CONTRACT_VIOLATION` |
| 3. **Outcome** | does the **world** now contain what was asked, with evidence? | ❌ **missing — this plan** |

**Layer-3 doctrine: never trust the run's self-report.** The platform already learned this at build time (preflight lied → real `validateExtensionSource`; MCP verify = real `tools/list` handshake — no green without a handshake). The same law at run end: an agent saying "deployed ✓" is not evidence. Evidence is a 200 from the deployment URL, a row count from the datastore, a screenshot of the live page, a judge's rubric score over those artifacts.

### 0.1 Ground truth — verified seams (2026-07-02)

Everything needed to *verify outcomes* already exists as disconnected organs; none of it runs at the workflow boundary:

- **Judge:** `#executeEvaluator` → `evaluator.evaluate({criteria, rubric})` → `{passed, score, critique, dimensionScores}` (engine ~7560); evaluator degradation + honest fallbacks shipped.
- **Probes:** `browserPool.navigate/screenshot/extractText` (headless Chromium); SSRF-guarded `executeHttpRequest`; `agentis.integration.call` / `agentis.mcp.call` (query Supabase, hit Vercel `get_deployment`, etc. — vault-resolved).
- **Honest loops:** converge node's terminal-verdict machinery (`max_iterations`/`budget_exhausted` — never a fake success); loop-with-judge ("continues while the verdict FAILS").
- **Lifecycle rail:** compass `LoopStage` + hash-keyed `stampBuildLoop`; pinned `settings.workflowTest` + `evalCondition` assertions in dry_run; `debugRun:true` = heal OFF; `WorkflowTriggerDeployment.activate()` already preflight-gated; YAML export; Sentinel (`InstinctEngine` + IssueService) files deduped Issues on failed production runs; `workflow.learn` playbook; run analytics on all exec paths.
- **Where the verdict lives:** `workflow_runs.runState` (JSON) — no migration needed; run detail already renders from it.

**The five real gaps:**
1. **No acceptance definition.** Nothing captures *how we will know it worked* — machine-verifiable claims with verification methods.
2. **No verdict.** No post-run layer that probes the world and stamps `accomplished | partial | hollow | failed` with evidence and named deficiencies.
3. **No outcome pursuit.** A run that produced a deficient result settles anyway; nothing re-works the responsible nodes against the named deficiency.
4. **Hollowness is masked.** Typed-empty contract fills *prevented crashes* (right) but count as success (wrong); no stub detection; no sufficiency floors (`nonEmpty`, `minItems`).
5. **No ratchet.** Compass describes stages; nothing enforces them. Unhardened workflows can arm cron triggers; hardening (v1) would have gated on mere completion.

---

## 1. Architecture — outcome truth as the spine

```
 S — Scoping              W — Workflow            I — Iterate                F — Formalize            T — Trigger
┌───────────────────┐  ┌──────────────────┐  ┌─────────────────────┐  ┌────────────────────┐  ┌─────────────────────┐
│ settings.spec      │─▶│ synthesis under  │─▶│ dry-run suite green │─▶│ harden gate:        │─▶│ arm gate: hardened  │
│  objective         │  │ constraints;     │  │ debug run           │  │  ACCOMPLISHED debug │  │ verdict every prod  │
│  outputContract    │  │ mid-run          │  │  ACCOMPLISHED       │  │  + suite + spec     │  │ run; Sentinel       │
│  + sufficiency     │  │ sufficiency      │  │ (verdict engine:    │  │  reconciled;        │  │ demotes on          │
│  acceptance[] ←────┼──┤ tripwires at     │  │  probes + judge +   │  │  frozen YAML;       │  │ un-accomplished;    │
│  "how will we      │  │ producer edges   │  │  evidence)          │  │  playbook entry     │  │ accomplishment rate │
│   KNOW?"           │  └──────────────────┘  └─────────────────────┘  └────────────────────┘  │ = health metric     │
│  constraints       │            ▲                      ▲                                      └──────────┬──────────┘
└───────────────────┘            │                      │                                                 │
                                 │        outcome heal: deficiency → re-work producing nodes ◀────────────┤
                                 └────────────── regression: pin deficiency as suite case ◀───────────────┘
```

**Design laws** (carried from v1, plus the new one):

- **Extend, never duplicate:** verdict engine reuses `evaluator.evaluate`, browserPool, `executeHttpRequest`, `agentis.integration.call`; criteria exprs reuse `evalCondition`; lifecycle extends `BuildLoopState`/`LoopStage`; verdict lives in `runState`.
- **Evidence or it didn't happen:** every acceptance check yields evidence (HTTP status + body excerpt, probe payload, screenshot asset id, judge critique). Verdicts render with their evidence.
- **Deterministic first, judge last:** sufficiency floors (free) → expr checks (free) → world probes (cheap) → LLM judge (routed minimum-sufficient tier) only for claims that need judgment.
- **Gates bite only at autonomy doors** (harden, arm). Manual/simple flows pay zero ceremony.
- **All evidence hash-keyed** to `graphContentHash` — edits demote honestly.
- **Heal symmetry:** self-heal (mechanical) is OFF in debug, ON in production. Outcome re-work follows the same law: debug surfaces raw deficiencies to the iterating agent; production pursues the outcome autonomously (bounded).

### 1.1 Persisted shapes

```ts
// settings.spec — the Scope artifact. THE question it must answer: "how will we KNOW it worked?"
interface WorkflowSpec {
  version: 1;
  objective: string;                       // one sentence, frozen at scope time
  // inputs stay on graph.inputContract (single source of truth — not duplicated here)
  outputContract: Array<{                  // workflow-boundary shape + SUFFICIENCY floors
    key: string;
    type: 'string'|'number'|'boolean'|'object'|'array';
    required?: boolean;
    nonEmpty?: boolean;                    // '' / [] / {} / typed-empty fill ⇒ deficiency
    minItems?: number;                     // arrays: "at least 10 products"
    minLength?: number;                    // strings
    format?: 'url'|'email'|'iso_date';     // cheap shape probes
    description?: string;
  }>;
  /** Machine-verifiable claims — each names its verification METHOD. */
  acceptance: AcceptanceCheck[];
  constraints: {                           // unchanged from v1 — compiled to enforcement
    allowedServices?: string[];
    maxMutatingCalls?: number;
    requireApprovalFor?: ('delivery'|'payment'|'destructive_data')[];
    maxDurationMs?: number;
    maxCostCents?: number;
  };
  /** Outcome re-work budget for production runs (debug: always 0 — raw truth). */
  reworkBudget?: number;                   // default 1
  createdAt: string;
  reconciledHash?: string;
}

type AcceptanceCheck = { id: string; claim: string } & (
  | { verify: 'expr';          expr: string }                                    // over terminal output (evalCondition)
  | { verify: 'http_probe';    url: string;                                      // may template from output: '{output.storeUrl}'
      expectStatus?: number; expectContains?: string }
  | { verify: 'browser_probe'; url: string; expectSelector?: string;
      expectText?: string; screenshot?: boolean }                                // screenshot ⇒ evidence asset
  | { verify: 'data_probe';    integration: string; operation: string;           // e.g. supabase.select / vercel.get_deployment
      params: Record<string, unknown>; expr: string }                            // expr over the probe result
  | { verify: 'judge';         rubric: string; minScore?: number }               // evaluator seam, evidence-grounded
);

// The verdict — stamped into runState.verdict on EVERY verified run (debug + production).
interface RunVerdict {
  outcome: 'accomplished' | 'partial' | 'hollow' | 'failed_checks';
  at: string;
  graphHash: string;
  checks: Array<{
    checkId: string; claim: string; passed: boolean;
    evidence: string;                      // "GET https://… → 200, contains 'Nova Store'" / "judge 8.5/10: …" / "probe: 14 rows"
    evidenceAssetId?: string;              // screenshot / probe payload persisted as asset
  }>;
  deficiencies: Array<{
    checkId: string; claim: string; detail: string;
    producingNodeIds: string[];            // mapped via outputContract key → terminal producer(s)
  }>;
  sufficiency: { typedEmptyFills: string[]; stubSuspects: string[] };  // anti-hollow findings
  rework?: { attempts: number; nodesReworked: string[] };
}

// settings.workflowTests — suite cases now assert OUTCOMES, not just node shapes.
interface WorkflowTestCase {
  id: string; name: string;
  kind: 'happy' | 'edge' | 'adversarial' | 'regression';
  inputs: Record<string, unknown>;
  assertions: Array<{ nodeId: string; expr: string; message?: string }>;   // dry-run layer (exists)
  /** NEW — expected outcome when this case runs live: happy ⇒ 'accomplished';
   *  adversarial may expect graceful 'failed_checks' with SPECIFIC deficiencies. */
  expectOutcome?: { verdict: RunVerdict['outcome']; expectDeficiencies?: string[] /* checkIds */ };
  origin: 'authored' | 'generated' | 'from_failed_run';
}

// settings.buildLoop — extended; LoopStage extended.
interface BuildLoopState {
  dryRun?: BuildLoopDryRunStamp;                                            // exists
  suite?: { at: string; graphHash: string; total: number; passed: number; ok: boolean };
  debugRun?: BuildLoopRunStamp & { verdict?: RunVerdict['outcome'] };       // stamp gains verdict
  hardened?: { at: string; graphHash: string; specHash: string; exportRef?: string };
  productionRun?: BuildLoopRunStamp & { verdict?: RunVerdict['outcome'] };
  /** rolling accomplishment health — feeds demotion + the web health metric */
  outcomeHealth?: { window: number; accomplished: number; lastDeficientRunId?: string };
}

type LoopStage = 'scoped' | 'authored' | 'dry_run_red' | 'dry_run_green'
  | 'suite_red' | 'suite_green' | 'debug_failed' | 'debug_completed_unverified'
  | 'debug_accomplished'                    // ← the gate currency: verdict, not status
  | 'hardened' | 'production';
```

---

## 2. Stage blueprints

### S — Scoping: capture how we will KNOW

1. **`agentis.plan_workflow` extended:** result gains `specDraft` — structured completer derives `objective`, `outputContract` **with sufficiency floors**, `constraints`, and **acceptance checks with methods**. Derivation is deterministic where possible: description says "deploy" + Vercel available ⇒ `http_probe` on `{output.deploymentUrl}` expect 200 + `data_probe vercel.get_deployment` expect `readyState=READY`; "save to Supabase" ⇒ `data_probe supabase.select count ≥ N`; "write a report" ⇒ `judge` with a rubric + `minLength` floor. Templates per claim family live in a small catalog (`acceptanceCheckTemplates.ts`) keyed off connector/MCP services present.
2. **`agentis.workflow.scope`** — NEW tool: validates + persists the spec. Mechanical validation: exprs dry-parse under `evalCondition`; probe `url` templates reference keys that exist in `outputContract`; `data_probe` services exist in `connectorCatalog()`/MCP mounts; judge checks have a non-empty rubric. **Elicitation guardrail:** when acceptance can't be derived (no verifiable claim found), the tool returns the ONE pointed question to ask the operator — "when this run ends, what URL/record/artifact proves it worked?" — instead of letting a vibes-only workflow through to hardening.
3. Readiness gains `spec` requirement kind: missing/stale spec (hash mismatch) surfaces exactly like a missing credential.

### W — Workflow: verification woven into the topology

1. **Constraint-aware synthesis** (v1, kept): `allowedServices` filters the offered catalog; `requireApprovalFor` makes D2 delivery-guard blocking; out-of-scope authoring requires an audited spec widening.
2. **Deterministic-first audit D3** (v1, kept): `agent_task` naming a single known connector/MCP op ⇒ suggest the deterministic node.
3. **NEW — mid-run sufficiency tripwires:** synthesis (and `workflow.harden`'s checker) marks *producer edges* — where a node's output feeds substantial downstream work — with the outputContract floors that apply (e.g. curator → builder edge carries `products minItems 1`). The engine checks the floor **at edge traversal**: a hollow payload trips a LOGIC failure *now* with the named deficiency ("curator produced 0 products; acceptance requires ≥10") instead of 20 nodes later. Implementation: extend the existing edge-coupling validation (Organ 3 runs at build time) with a run-time `sufficiency` variant — same shape checks, live data.

### I — Iterate: green means ACCOMPLISHED

1. **Suite** (v1 S3, upgraded): `agentis.workflow.test` runs cases through dry-run (assertions layer, exists) **and** evaluates spec `expr`-checks + sufficiency floors against the terminal trace (probes/judge are skipped in dry mode — the world isn't touched; they're marked `deferred_to_live`). Suite stamp keyed to hash.
2. **Debug run = full verdict.** `debugRun:true` keeps heal OFF and rework OFF, then the **verdict engine runs in full** (probes + judge). The compass points from `debug_completed_unverified` → nothing: the verdict runs automatically at settle; stage lands `debug_accomplished` or `debug_failed` (with deficiencies as the agent's work list).
3. **Fixture generation** (v1 S4, kept): mechanical edge cases from `inputContract` types + LLM domain cases, `origin:'generated'`, non-gating until kept. Adversarial cases may pin `expectOutcome: { verdict:'failed_checks', expectDeficiencies:[…] }` — *graceful failure is a tested behavior*.
4. **Failed/deficient run → regression case:** `run.diagnose` gains the one-call pin: trigger inputs + the violated checks become a `regression` case.

### F — Formalize: hardening = proven accomplishment

`agentis.workflow.harden` predicates (all at current hash):
- spec present + reconciled; acceptance non-empty (≥1 non-judge check — at least one *worldly* verification);
- dry-run green; suite green (≥1 happy + ≥1 non-happy case);
- **latest debug run verdict = `accomplished`** ← the teeth;
- zero blocking readiness; `requireApprovalFor` audits acked.

On pass: `hardened` stamp {graphHash, specHash, exportRef→frozen YAML asset} + Playbook entry (objective, contracts, acceptance, dependencies, suite summary). On fail: unmet predicates each with the compass call that clears it — deficiencies verbatim so the agent knows *what to fix*, not just *that it failed*. Efficiency audit E1 (identical-transform agent nodes → demotion suggestions) reported as non-blocking `optimizations[]`.

### T — Trigger: the world keeps being checked

1. **Arming gate** (v1, kept): unattended triggers require stage ∈ {hardened, production} → `BLOCKED_LIFECYCLE_NOT_HARDENED` + compass; `override:{ack}` audited.
2. **Verdict on every production run** at settle: sufficiency (free) + probes (cheap) always; judge per spec (default ON; operator may set `verification: 'probes_only'` for high-frequency crons). Verdict + evidence stamped in `runState.verdict`, rolls `outcomeHealth`.
3. **Outcome heal (production only):** verdict ≠ accomplished && `reworkBudget > 0` ⇒ map `deficiencies[].producingNodeIds` (outputContract key → terminal producer via the existing output-surface resolution), re-dispatch those nodes with the deficiency briefing appended (the same mechanism as `buildNodeProcessBriefing` + failure context), re-run the verdict. Bounded, cost-capped by `constraints.maxCostCents`, every attempt audited (`run.outcome_rework`). Converge-style honesty: budget exhausted ⇒ verdict stands, never faked.
4. **Auto-demotion:** Sentinel (extended) on a hardened workflow's un-accomplished production run: file Issue (deficiencies + evidence + pin-as-regression affordance), demote `hardened` at that hash, pause unattended triggers when the deficiency class is LOGIC/POLICY (RESOURCE = transient; retry policy owns it). The loop closes: production deficiency ⇒ demote ⇒ Iterate (regression case waiting) ⇒ re-harden ⇒ re-arm.
5. **Learning on outcomes:** InstinctEngine ingests deficiency patterns (it already scans failures — verdicts join the scan window); repeated deficiency ⇒ lesson + proposal. `workflow.learn` prompted from verdict Issues. Analytics: **accomplishment rate** (not run count) becomes the workflow health number.

---

## 3. The meta-agent runbook (compass-carried, unchanged mechanics)

```
plan_workflow        → phases + cost + specDraft (acceptance derived)     compass: scope
workflow.scope       → spec persisted; or ONE pointed question            compass: author
build_workflow       → constraint-filtered synthesis, tripwires marked    compass: dry_run
workflow.dry_run     → trace green                                        compass: suite
workflow.test        → suite green (expr+floors; probes deferred)         compass: debug run
run(debugRun:true)   → COMPLETED → verdict engine: probes+judge
                       → ACCOMPLISHED (evidence attached)                 compass: harden
                       → deficiencies[] (the work list)                   compass: fix + re-run
workflow.harden      → predicates pass; YAML frozen; playbook             compass: arm
trigger activate     → gate passes                                        …unattended
  ↺ prod run verdict: partial — "storeUrl 404" (evidence)
    → outcome heal: re-work deploy node (budget 1) → re-verify → accomplished
  ↺ prod run verdict: hollow — "products []" (LOGIC)
    → Sentinel: Issue + demote + pause cron + regression case             compass: iterate
```

Every gate failure names deficiencies with evidence and the calls that clear them. An agent cannot claim success; the world gets asked.

---

## 4. Slices

| # | Slice | Files (extend) | Fences |
|---|---|---|---|
| **V1** | Spec v2 + `workflow.scope` + `plan_workflow.specDraft` + `acceptanceCheckTemplates.ts` + readiness `spec` kind | new `workflowSpec.ts`, `build.ts`, `workflowReadiness.ts` | expr/probe/service validation; stale hash; derivation for deploy/data/report archetypes; elicitation question when underivable |
| **V2** | **Verdict engine** `workflowVerdict.ts`: sufficiency → expr → http/browser/data probes → judge; evidence assets; stamped in `runState.verdict` + buildLoop; runs at settle for debug + production | new service, `WorkflowEngine.ts` settle path (~10022, beside buildLoop stamping) | each check kind verified with injected fetch/browser/connector fakes; typed-empty ⇒ deficiency; verdict taxonomy; evidence persisted; self-report never consulted |
| **V3** | Ratchet re-keyed: LoopStage v2 (`debug_accomplished`…), harden gate on verdicts, arm gate + audited override | `workflowCompass.ts`, `build.ts` (harden), `workflowTriggerDeployment.ts` | unmet predicates named; COMPLETED-but-unverified ≠ hardenable; unhardened cron blocks; override audited; edit demotes |
| **V4** | Outcome heal: deficiency→producing-node mapping, briefing re-dispatch, budget/cost caps, converge-honest exhaustion; OFF in debug | `WorkflowEngine.ts` | deficient run re-works only named nodes then re-verifies; budget exhausted ⇒ honest verdict; debug never reworks |
| **V5** | Suite v2 + generator + regression pin (cases carry `expectOutcome`; legacy pin = first happy case) | `build.ts`, new `workflowTestGenerator.ts`, `run.ts` (diagnose) | 2-case suite one failing; adversarial expects graceful `failed_checks`; back-compat; pin from deficient run |
| **V6** | Anti-hollow: sufficiency floors in contracts + **run-time edge tripwires** + stub detector (placeholder/lorem/echo heuristics) | `WorkflowEngine.ts` (edge traversal), contract layer | 0-item payload trips LOGIC at the edge with named deficiency; stub output flagged; floors enforced |
| **V7** | Sentinel/learning on outcomes: demote+pause+Issue on un-accomplished prod; InstinctEngine ingests deficiencies; accomplishment analytics | sentinel/instinct services, `runAnalytics.ts` | violation demotes+pauses+files with evidence; repeated deficiency → lesson; rate computed |
| **V8** | Constraint enforcement (v1 S2 unchanged): allowedServices dispatch guard `BLOCKED_POLICY_SERVICE`, mutating-call budget, D2 blocking | `WorkflowEngine.ts`, `build.ts`, `workflowRobustnessAudit.ts` | out-of-scope service blocks (skips heal — policy class); budget exhaustion |
| **V9** | Web: verdict banner with evidence (screenshots, probe results, judge critique) on run detail; accomplishment rate on `WorkflowHealthIndicator`; harden checklist; suite panel | `apps/web` | build green; typecheck |
| **V10** | Audits D3 (deterministic-first) + E1 (efficiency demotion) | `workflowRobustnessAudit.ts` | D3 flags single-op agent_task; E1 suggests demotion |

**Order:** V1 → V2 → V3 (the outcome spine end-to-end: define → verify → gate) → V6 → V4 → V5 → V7 → V8 → V9 → V10. Every slice: `tsc` clean + vitest fences before the next.

## 5. What we are NOT building

- No new judge (evaluator seam), no new expression DSL (`evalCondition`), no new probe clients (browserPool/http/connector-call), no run-table migration (`runState.verdict`), no special meta-agent runtime (compass), no ceremony for manual flows (gates only at harden/arm).
- Honest limits: probes verify *reachable* world state — a claim with no derivable verification stays a `judge` check and says so; judge verdicts are graded evidence, not ground truth (which is why harden requires ≥1 non-judge check). Deferred: cross-workflow (App-level) acceptance; per-node latency SLOs; sampled verification for high-frequency crons beyond the `probes_only` switch.

---

## 6. Implementation Log
*(Append per shipped slice — keep reconciled with real code.)*

- **2026-07-02 — PLAN v1 authored** after code audit: lifecycle organs (~70%) existed disconnected; plan wired gates + ratchet keyed to completion evidence.
- **2026-07-02 — PLAN v2 (this doc): operator correction — "runs ≠ got what we need".** Re-centered on outcome truth: spec captures verifiable acceptance (methods, not vibes); verdict engine probes the world at settle (evidence, never self-report); gates re-keyed to ACCOMPLISHED; hollow output counted honestly (typed-empty = deficiency, stub detector, edge tripwires); deficiency-driven outcome heal (prod-only, budgeted, converge-honest); Sentinel demotes + accomplishment rate as health. Audited first: judge/probe/loop seams all real (`#executeEvaluator` ~7560, browserPool, integration.call, converge verdicts) — v2 connects them at the workflow boundary.
- **2026-07-02 — V1–V10 SHIPPED e2e** (api tsc clean; web tsc + build green; fences: workflowSpec 10, workflowVerdict 8, swiftLifecycle 9, WorkflowEngine.verdict 7, compass 21, sentinel 5 — all green).
  - **V1 `services/workflowSpec.ts`** — `WorkflowSpec` (objective, `acceptance[]` w/ verify methods, `sufficiency[]` floors, constraints, reworkBudget, verification mode), mechanical `validateWorkflowSpec` (exprs dry-parse under `evalCondition`; data_probe services checked against runnable connectors + MCP mount slugs; probe `{output.key}` templates checked against `graph.outputContract`), deterministic `deriveSpecDraft` (deploy→http_probe+url floor; "at least N X"→expr+minItems; persist+data-service→data_probe; judge appended last; **elicitation question** returned when nothing worldly derivable). `agentis.workflow.scope` tool persists + reconciles to graph hash; `plan_workflow` result now carries `specDraft` (+`specQuestion`).
  - **V2 `services/workflowVerdict.ts`** — `evaluateRunVerdict`: sufficiency (typed-empty fills, stub/advisory detector incl. the "run vercel deploy" pathology, floors) → expr → http_probe (SSRF-guarded, status+contains, evidence string) → browser_probe (render, text/selector, screenshot→artifact evidence) → data_probe (connector call, expr over `probe.*`) → judge LAST (evaluator seam, evidence-grounded target = objective+terminal output, `minScore`), each check → `{passed, evidence, unavailable?}`. Outcome taxonomy: real failure→`failed_checks`; clean checks+hollow output→`hollow`; unverifiable probe→`partial`; else `accomplished`. Deficiencies map to producing nodes via output-key → nodeOutputs. **`unwrapReturnEnvelope`**: `return_output` wraps payload as `{renderAs,value}` — the verdict (and the suite runner) unwrap it; without this, expr checks silently miss the data (found by the engine fence).
  - **Engine wiring** (`WorkflowEngine.ts`): verdict runs at `#transitionRunStatus` for every COMPLETED-ish settle when a spec exists → `runState.verdict`; buildLoop run stamps gain `verdict`; production rolls `outcomeHealth.recent` (cap 20). `#specForRun` cached per run context. **V4 outcome heal** `#healDeficientOutcome`: production-only (debug inherits `#runSelfHeal`'s no-op — symmetry for free), first deficient producing self-healable node re-worked with the deficiency briefing, bounded by `reworkBudget` (default 1), converge-honest on exhaustion, audited `run.outcome_rework`. **V6 tripwire** in `#completeNode`: floored keys checked at producer completion (control-flow kinds exempt; `allowEmptyOutput` opt-out) → `SUFFICIENCY_FLOOR:` LOGIC failure NOW, not 20 nodes later. **V8 constraints** `#enforceSpecConstraints` at integration+mcp dispatch: `BLOCKED_POLICY_SERVICE` (POLICY class → skips heal) + `BLOCKED_POLICY_BUDGET` external-call counter. **V7 demotion**: hardened@hash + un-accomplished production run ⇒ clear hardened stamp + audit `workflow.demoted` + `deps.onWorkflowDemoted` (bootstrap pauses non-manual active triggers via TriggerRuntime) + `instincts.onRunDeficient` files the deduped verdict Issue (evidence + pin-as-regression affordance).
  - **V3 ratchet** (`workflowCompass.ts`): `LoopStage` v2 = authored → dry_run → **suite_red/green** → debug_failed / **debug_completed_unverified** / **debug_accomplished** → **hardened** → production; deficient verdict outranks COMPLETED (→debug_failed); all stamps hash-keyed. Compass rewires: dry_run_green→suite; unverified→scope; accomplished→harden; hardened→run/arm. `agentis.workflow.harden`: predicates (spec reconciled + ≥1 worldly check + dry green + suite green + ≥1 happy & ≥1 non-happy KEPT case + debug verdict ACCOMPLISHED + readiness) → frozen YAML artifact (workflowIo `WorkflowFile` via `yaml.stringify`) + playbook entry + hardened stamp; failure returns each unmet predicate WITH the clearing call. **Arming gate** in `WorkflowTriggerDeployment.activate()`: non-manual triggers require stage ∈ {hardened, production} → `BLOCKED_LIFECYCLE_NOT_HARDENED`; `override:{ack}` writes `trigger.armed_unhardened` to audit_entries; threaded through `POST /:id/activate`.
  - **V5 suite** — `settings.workflowTests[]` (legacy `workflowTest` pin = first happy case), `agentis.workflow.test` action run|generate|add|remove|keep|list; runner = `preflightWorkflow` per case + assertions + spec expr/floors over the unwrapped terminal trace; `expectOutcome` lets adversarial cases EXPECT graceful `failed_checks`; generated (`origin:'generated'`) cases run but never gate until kept; suite stamp hash-keyed. `services/workflowTestGenerator.ts`: mechanical battery from `graph.inputContract` (missing required/optional, empty string/array, zero).
  - **V9 web** — `RunVerdictBanner.tsx` (outcome chip + per-check evidence + hollow findings + rework badge) mounted in `WorkflowMonitorCard` on terminal runs; run detail API exposes `run.verdict`; `WorkflowHealthIndicator` shows the v2 stage chips (Accomplished ✓ / Hardened / Unverified…) + **accomplishment %** from `outcomeHealth`; `/loop-status` returns suite/hardened evidence + outcomeHealth.
  - **V10 audits** — D8 `AGENT_FOR_KNOWN_OPERATION` (agent_task prompt naming exactly one runnable service + an op verb → suggest deterministic node; `knownServices` option) + E1 `AGENT_FOR_PURE_RESHAPE` (reshape verbs, no judgment verbs → suggest transform/code). Advisory codes added to the PreflightWarning union.
  - Honest deferrals: E1 run-history variant (identical-transform detection over analytics) — prompt-heuristic shipped; suite live-mode (real side effects per case) — dry suite + accomplished debug run cover the risk; `workflow.scope` LLM-assisted derivation beyond the deterministic templates (structured completer can be layered on the same seam); synthesis-side `allowedServices` catalog filtering — the ENGINE dispatch guard is the hard guarantee and D8 steers authoring, so the filter is an optimization, not a gap.
  - Also threaded: `agentis.run.status` result + its compass now carry `verdict` (an agent sees "COMPLETED but HOLLOW" with evidence, never a green lie); run detail API exposes `run.verdict`; `instinctSentinel` fence covers the deduped verdict Issue.
- **2026-07-03 — DELIVER ORCHESTRATOR (operator: "build the entire enforcement with the deliver orchestrator — amazing architecture that works perfectly on daily usage").** The capstone: SWIFT was an agent-orchestrated multi-tool dance across many turns, and agents got lost / hit the 80 tool-call cap / did one pass. `services/workflowDeliveryOrchestrator.ts` + `agentis.workflow.deliver(goal | workflowId, inputs?, maxIterations?, maxWallMs?)` take the loop OFF the agent: one call runs scope→build→dry-run→debug-run(heal off, verdict on)→classify→repair→repeat, bounded (default 3 iters / 8 min, capped 5 / 20 min), and returns EXACTLY ONE honest outcome — `accomplished` (built + ran + world-VERIFIED), `blocked_on_human` (an approval / missing credential / rate-limit only the operator can clear, with the exact `humanAction` — classified via `classifyFailure`/`capabilityGapReason`, and it does NOT waste iterations on a human blocker), `unverifiable` (ran but no worldly acceptance — completion ≠ proof), or `failed` (budget exhausted, with the last verdict + deficiencies + the run to diagnose). It NEVER loops forever and NEVER fakes success — every exit is grounded in a real settled run + its verdict. Debug runs are awaited by polling the persisted run row (a debug run legitimately executes for minutes); WAITING+approval → blocked, WAITING+blockedReason → resource block, deadline → cancel+timeout. Default repair re-synthesizes the NAMED deficient producing nodes with the verdict evidence as context (injectable for tests). Lazy `import()` of build.ts avoids the module cycle. Blocklisted for IN-workflow agents (recursion/runaway) in both WorkflowEngine + bootstrap; the top-level chat orchestrator keeps it. Fences: `workflowDeliveryOrchestrator.test.ts` (7) — accomplished / repair-then-accomplished / blocked-credential(no wasted iters) / blocked-approval / failed-after-budget / unverifiable / input-validation — all via a scripted fake engine; api tsc clean. Fixed a pre-existing operator-WIP typecheck blocker (`approvalInbox.ts` redactForApprovalReview return `as Record`). ⭐The daily-usage shape: an agent (or the operator) says "deliver an app that does X" → ONE call → verified app or an honest, human-actionable blocker. That is SWIFT enforced by construction.
- **2026-07-03 — ENFORCEMENT (operator: "SWIFT clearly isn't working — agents can't go through it and produce a workflow/app that produces the expected result").** Root cause found in code: SWIFT was OPT-IN and INVISIBLE on the common path. `build_workflow` never attached a spec (`deriveSpecDraft` was only used by the separate `plan_workflow` inspect tool), so a normally-built workflow had NO acceptance criteria → the verdict engine never ran on it; and the run result led with `status: COMPLETED`, so an agent polling `run.status` saw COMPLETED and reported success over an empty world. The only gates that bit were harden/arm — doors agents never reach on build→run→"done". Two changes flip it to ALWAYS-ON + UNMISSABLE (api tsc clean; pavedRoadLoop +2 fences green): (1) **AUTO-SCOPE** in `createWorkflowFromDescription` — every built workflow is born with a derived spec (`deriveSpecDraft`, `verification:'probes_only'` to bound production cost; debug runs still get the full verdict for the build loop) UNLESS the caller already scoped one; the build result + message surface the acceptance ("VERIFIED-BY-DEFAULT: N acceptance check(s) — a run is only ACCOMPLISHED when they pass, never just COMPLETED"). (2) **VERDICT-AS-HEADLINE** in `run.status` — the result now leads with `accomplished`/`outcome` + a `headline` string ("NOT ACCOMPLISHED (hollow) — do not report success · <deficiencies>" | "ACCOMPLISHED — verified" | "COMPLETED but UNVERIFIED — scope it"); a weak agent that reads the top of the payload can no longer misread COMPLETED as done. ⭐The verdict machinery was fully built but left opt-in — enforcement = make Scope automatic and make the verdict the headline. ⚠️Bigger lever still open (proposed, not built): a server-side autonomous build-and-verify ORCHESTRATOR (`agentis.workflow.deliver(goal)`) that runs the whole loop — scope→build→dry-run→debug-run→verdict→bounded auto-fix→repeat until accomplished-or-honestly-blocked — so the agent makes ONE call and can't skip/mis-drive the multi-turn dance (which is what fails weak agents + hits the 80 tool-call cap). Fixed a pre-existing stale @agentis/core build (artifactPolicy/appId — operator's parallel WIP; `pnpm --filter @agentis/core build` cleared it).
- **2026-07-03 — ANTI-FABRICATION (operator: agents "return plausible JSON without executing anything" — a harvest reports 15 products while the directory is empty).** Grounded finding: the deterministic "script runner" the failing agent wanted to BUILD already exists — the `code`(python) node shells out via `child_process.spawn` (15-min cap, comment: "so code(python) nodes can shell out to long-running build/deploy scripts"). The real bug is authoring: the workflow used `agent_task` ("run the harvest script") where an `agent_task` has NO shell, so the model fabricates the output. Two structural guards shipped (api tsc clean; fences: workflowSpec +2, workflowVerdict +2, robustnessAudit +2): (1) **D9 audit `AGENT_ASKED_TO_RUN_SCRIPT`** — an agent_task prompt that instructs running a script/command (`run … python|node|npm|bash|subprocess|.py|.mjs|scripts/…`) is flagged → "it will FABRICATE the output; use a `code`(python) node + a file_probe check". (2) **`file_probe` acceptance check** — the verdict engine can now probe the FILESYSTEM (path exists / minFiles / minBytes, `{output.key}` templated), path-guarded to cwd + AGENTIS_DATA_DIR (never `/etc/passwd`), wired via `deps.statPath` / engine `#statVerdictPath`. A fabricated harvest now fails the world-check (`does not exist on disk` / `NEEDS ≥15 files`) → hollow/failed_checks → cannot accomplish/harden. Together: fabrication is caught at BUILD (steer to code node) and at RUN (disk probe). Also fixed a pre-existing `noUncheckedIndexedAccess` error in the operator's WIP `builtinExtensions.ts` (`tone: tuple[i%3] ?? 'pearl'`, behavior-identical) that was blocking the whole API typecheck. The "~74 tasks then stops" is the chat orchestrator's per-turn tool-call brake (`defaultMaxToolCalls()` = 80, env `AGENTIS_CHAT_MAX_TOOL_CALLS`) emitting the "tell me to continue" turn-limit message — a deliberate spend guard, NOT a crash; the durable answer is deterministic workflow nodes (a harvest is 1 code-node step, not 20 agent tool-calls), not raising the cap.
- **2026-07-02 — full regression suite: 2054 tests, 4 failures — all four were the arming gate working as designed** against old fences that armed cron/webhook/listener triggers with zero lifecycle evidence. Updated: deployment-mechanics tests seed `hardened` at the graph hash; the route test now fences BOTH the block (`BLOCKED_LIFECYCLE_NOT_HARDENED` on bare activate) and the audited `override:{ack}` path. The webhook double-activate fence exposed a REAL gate bug: activation itself links the trigger node (`linkTriggerNode` writes `triggerId` into the graph), which changed the content hash and staled the hardened stamp — the second activate was blocked. Fixed: `graphContentHash` excludes `triggerId` (runtime linkage is bookkeeping, not semantics — arming must not stale the evidence that allowed arming; same principle as excluding canvas position). Re-run: 68/68 across every hash-dependent fence; api tsc clean.
