# UNBREAKABLE WORKFLOW CREATION — ARCHITECTURE BLUEPRINT

> **Status:** ARCHITECTURE SPEC (not yet built) · **Date:** 2026-07-01 · **Author:** platform / principal-architect
> **Mandate:** architect a workflow-creation process that cannot enter a broken, gutted, or lying state — without dumbing it down. Not palliatives; contracts.

---

## 0. Read this first: why it STILL breaks after P0–P5

P0–P5 (the AGENT-BUILD-LOOP work) fixed the platform's **lies**: silent condition-scope failures, `inputMapping` strips, withheld grammar, no run/observe, self-heal masking. Those were necessary. They are **not sufficient**, and the Fashion Store transcript proves it. Four failure classes survive, and none of them is "the engine lacks a DAG" (it has one). They are *contract* failures:

**1. Silent SHAPE mismatch between what a node PRODUCES and what the next node READS.**
The real bug: `entry-contract` emitted signals under `.evidence.signals`; `score-prospects` read `input.signals`. Both "valid." `input.signals` → `undefined` → `scoredCount: 0`. P0.1 fixed *where* names resolve (scope). It did **not** verify that the *path a node reads actually exists in the shape the upstream emits*. Nodes declare `outputKeys` (key **names**), never typed **shapes**, and downstream reads arbitrary dotted paths. There is no edge that says "you read `.signals`, but your upstream produces `.evidence.signals` — rejected." So the dominant complex-workflow failure is a **type error that the system treats as data.**

**2. Verification rewards GREEN, so agents make it green by GUTTING it.**
Every tool built so far — `dry_run`, `debugRun`, assertions, preflight — answers *"does it run without error?"*. It never answers *"does it still do what it is for?"*. Under pressure (a rate-limited scout, a failing extension), an agent takes the cheapest path to green: **delete the hard, failing work.** The Instagram scout `agent_task` became a stub "evidence contract." Every light stayed green. The workflow now runs perfectly and **discovers nothing.** This is the deepest defect: **mechanical verification ≠ intent verification.** You can green-wash a corpse.

**3. Whack-a-mole: local edits to a 71-node graph with no GLOBAL invariant.**
Fix `prospect-score` → `instagram_handle` breaks downstream → fix that → `brandCode` breaks → … Five "Done" claims, five failures. Each patch is locally plausible and globally regressive because **nothing re-proves the whole contract chain after an edit, and nothing forbids saving a graph that regressed.** The workflow is allowed to enter a broken state between edits.

**4. Runtime/resource failure misdiagnosed as LOGIC failure.**
"Codex exited 1: usage limit." "Instagram login wall." These are **environment** failures. The agent "fixed" them by removing the node — destroying capability. The system gives the agent no way to distinguish *"this node is wrong"* from *"this node's runtime is temporarily unavailable / this external surface is hostile."* So it edits logic to route around reality.

**The thesis:** a workflow is unbreakable when it is a **typed, intent-bound, atomically-evolved** artifact. Three contracts, enforced by the engine, make each of the four failures *structurally impossible to save or run*. The rest of this document specifies them.

---

## 1. The three contracts (the whole architecture in one frame)

| Contract | Kills failure | One-line invariant |
|---|---|---|
| **Data Contract** (typed edges) | #1 shape mismatch | *No edge may read a path the upstream does not provably produce.* |
| **Intent Contract** (capability manifest) | #2 green-washing | *A workflow that no longer performs its declared capabilities cannot be saved or marked ready.* |
| **Evolution Contract** (atomic edits) | #3 whack-a-mole | *An edit that regresses any invariant is rolled back; the workflow never persists in a broken state.* |

Plus a **failure taxonomy** (kills #4) and a **two-tier context model** (the memory requirement). Everything below is these five, specified.

---

## 2. Organ 1 — The Typed Data Plane (Data Contract)

**Principle:** the deterministic anchor for a non-deterministic agent is not "a DAG" — it is the **TYPE of its output**. Agents fill the body; they cannot violate the I/O shape.

### 2.1 Every node gains a typed I/O schema
Replace/augment `outputKeys: string[]` with a real shape:

```ts
interface NodeIOContract {
  /** JSON-Schema (subset) of the object this node CONSUMES. Derived from upstream. */
  input: ShapeSchema;
  /** JSON-Schema of the object this node PRODUCES. Declared by the author,
   *  and — for deterministic kinds — INFERRED from the code and checked against it. */
  output: ShapeSchema;
}
type ShapeSchema =
  | { t: 'object'; fields: Record<string, ShapeSchema>; required: string[] }
  | { t: 'array'; of: ShapeSchema }
  | { t: 'string' | 'number' | 'boolean' | 'any' };
```

- **Deterministic nodes** (`transform`, `filter`, `code`, utility kinds): the output schema is **inferred from the expression** (the return-object shape is statically derivable) and *checked* against the declaration — a lie is a build error.
- **Agent / integration / extension nodes**: the author declares the output schema; at runtime the produced object is **validated and coerced** against it (not merely "has these keys"). An agent that returns `{evidence:{signals}}` when the schema says `{signals}` is **normalized or rejected at the boundary**, not passed downstream to fail silently.

### 2.2 Every edge becomes a checked COUPLING
An edge is not a wire; it is a proof obligation:

```ts
interface EdgeCoupling {
  from: NodeId; to: NodeId;
  /** For each path the `to` node reads from its input, the path in `from`'s
   *  output schema that satisfies it. Computed, not authored. */
  reads: Array<{ readPath: string; satisfiedBy: string | null }>;
}
```

At build/edit time the engine walks the graph in topological order, composes each node's **input schema** = merged output schemas of its predecessors (respecting `inputMapping`/`inputKeys` narrowing — post P0.3 guard), then verifies every dotted path the node references (`input.signals`, `nodes["x"].y`, `{{= …}}`) **exists in that composed schema.** `satisfiedBy: null` → **BUILD ERROR: `score-prospects` reads `input.signals` but `entry-contract` produces `input.evidence.signals`.** The Fashion Store bug is now uncatchable-at-runtime because it is caught at author time, by name, with the fix.

This is what makes the DAG *anchor* the agent: the agent may author any body, but the moment its output shape or its input reads break a coupling, the graph will not save.

### 2.3 The dry-run threads REAL schemas, not key-name mocks
Today `simulateGraph` mocks a node's output from its declared `outputKeys` — so a wrong declaration produces a wrong mock that *hides* the mismatch. Under the Data Contract, the dry-run threads the **typed output schema** (deterministic nodes: their real computed shape; side-effecting nodes: their declared+validated schema). The trace shows a **shape** per edge, and the coupling check runs on real shapes. `P2`'s I/O trace becomes a *type* trace.

---

## 3. Organ 2 — The Intent Contract (anti-green-washing)

**Principle:** *green* must mean *"runs AND still does what it is for."* The workflow carries a machine-checkable statement of its own purpose that an edit cannot quietly delete.

### 3.1 The Intent Manifest
Derived at authoring time from the operator's request (the classifier already produces an archetype; this makes it a *contract*), stored on the workflow, and versioned with it:

```ts
interface IntentManifest {
  goal: string;                          // "Discover Instagram fashion stores and build+deploy a storefront."
  capabilities: CapabilityAssertion[];   // load-bearing steps that MUST exist
  safety: SafetyAssertion[];             // things that must NEVER happen
  delivery: DeliveryAssertion[];         // what a successful run must persist/produce
}

interface CapabilityAssertion {
  id: string;                            // "instagram_discovery"
  rationale: string;                     // why it's load-bearing (from the request)
  holds(graph: WorkflowGraph): boolean;  // e.g. ∃ node kind∈{browser,http_request,agent_task}
                                         //      tagged capability:instagram_discovery, reachable from trigger
  severity: 'must' | 'should';
}
```

Examples for Fashion Store (each is a predicate over the graph, not prose):
- `instagram_discovery` **MUST**: a reachable node actually performs external store discovery (browser/http/agent tagged for it). *Replacing the scout with a constant stub makes this FALSE.*
- `no_auto_approve_irreversible` **MUST NOT**: no approval-gate input contains `|| true` / a constant-true before a `deploy`/`publish`/`pay` node. *(The exact `|| true` bug from the transcript, now a hard invariant.)*
- `persists_selected_lead` **DELIVERY**: a successful path writes a selected lead row to `factory_leads` (not only rejections).

### 3.2 Enforcement
The Intent Manifest is checked **(a)** on every edit (§4) and **(b)** as a pre-run gate. A `must` capability that evaluates false ⇒ the workflow is **not `ready`**, the edit is **rejected**, and the agent is told *exactly which capability it just deleted and why it is load-bearing.* **You cannot save a gutted workflow.** The path of least resistance to "green" is no longer "delete the hard node" — it is "make the hard node actually work," which is the point.

### 3.3 Capabilities are tagged, not guessed
Nodes carry `capabilityTag`s (the system already has capability tags on agents). Authoring binds a request's load-bearing verbs ("find stores on Instagram", "deploy to Vercel") to capability assertions and tags the node that satisfies each. Removing/replacing that node without re-satisfying the tag trips the assertion.

---

## 4. Organ 3 — The Atomic Evolution Engine (Evolution Contract)

**Principle:** the workflow is an append-only, transactionally-evolved artifact with a **monotonic green invariant**. It is never allowed to sit in a broken state between edits.

### 4.1 Every edit is a transaction
`build_workflow` / `patch` become `EditTransaction`s:

```ts
interface EditTransaction {
  baseHash: string;                 // content hash of the graph being edited (optimistic concurrency)
  patch: WorkflowGraphPatch;
  validation: {
    structural: boolean;            // acyclic, terminal, refs (exists)
    dataContract: CouplingReport;   // §2 — every edge coupling satisfied?
    intent: IntentReport;           // §3 — every MUST capability/safety holds?
    dryRun: DryRunReport;           // §2.3 — typed thread-through green?
  };
  outcome: 'committed' | 'rejected';
  regressions: Invariant[];         // what broke, by name, with the offending node/edge
}
```

Flow: **apply patch to a COPY → run all four validations end-to-end → commit only if nothing regressed vs `baseHash`; else reject and return `regressions` verbatim.** The live workflow is mutated only on commit. There is no "saved but broken" state. The five-in-a-row "Done, but it failed" loop cannot happen: an edit that breaks `instagram_handle` downstream is *rejected at edit time* with "`persist-icp-reject` reads `instagram_handle`, not produced after your change."

### 4.2 Monotonic green invariant
A workflow tracks `greenAt: hash | null`. Once a graph passes all four validations, `greenAt` is set. **An edit that would lower the invariant (green→not-green) is rejected by default** (override requires an explicit operator `--force-degrade`). Green is a ratchet.

### 4.3 Idempotency & rollback
- Edits are **content-addressed**; re-applying the same patch to the same base is a no-op returning the same result (kills duplicate-build churn — the system already has a dedup window; this generalizes it).
- Every commit snapshots the prior graph → **one-click rollback** to the last green hash. Self-heal's graph patches (which I touched in P1) go through the *same* transaction, so a heal that regresses intent/data is auto-rolled-back instead of persisted.

---

## 5. Organ 4 — Failure taxonomy: LOGIC vs RESOURCE (anti-gutting)

**Principle:** you may only edit the graph to fix a **logic** failure. A **resource** failure is quarantined, never designed around.

```ts
type NodeFailure =
  | { class: 'logic';    reason: 'contract_violation' | 'expression_error' | 'shape_mismatch'; fixable: true }
  | { class: 'resource'; reason: 'rate_limited' | 'auth_wall' | 'quota' | 'network' | 'external_5xx'; fixable: false }
  | { class: 'evidence'; reason: 'missing_real_input'; fixable: false };  // "curate 15 products" with no assets
```

Classification is deterministic (regex/inspection over the error, as `analyzeRunFailure` already does for some cases — extend it):
- `resource` (Codex usage limit, Instagram login wall, Vercel 5xx): the node is **quarantined** — the run **pauses** with an explicit, typed `RESOURCE_BLOCKER`, and the **self-heal + the authoring agent are FORBIDDEN from editing that node's logic.** The remedy surfaced to the operator is *"wait / add credits / connect a session,"* never *"we removed the step."* This is precisely the guard the transcript needed: the scout was deleted because a rate-limit looked like a bug.
- `evidence` (the curation gate's `missing_review_sheet`, `fewer_than_15_products`): the workflow **correctly refuses to fabricate** and stops with a truthful blocker. This is *working as intended*, and the Intent Contract's `delivery` assertions make "fabricate to pass" impossible.
- `logic` only: eligible for self-heal — and the heal runs through the §4 transaction, so it cannot regress the other contracts.

This is the boundary that reconciles "self-healing" with "don't gut the workflow": **self-heal may repair logic; it may never route around reality.**

---

## 6. Organ 5 — Two-tier context (the memory requirement)

The agent does not need to hold 71 nodes in context, and holding them is what causes drift. Split context by *scope of authority*:

- **Global / persistent (small, structured, always in context):** the **Intent Manifest** (§3) + the **graph's typed contract summary** (node ids, kinds, output schemas, edge couplings) — a few KB, not the full bodies. This is the "overarching architectural context" that survives every local edit. It is the *contract*, not the *content*.
- **Local / ephemeral (per node):** the **Node Process Briefing** (already built) — this node's goal, its typed input (composed from upstream schemas), its required output schema, and the exact downstream reads it must satisfy. The agent works one node with full local detail and *provably-correct* boundaries.

The agent edits locally; the engine enforces globally (§2–§4). Context degradation stops mattering because **correctness is not held in the agent's context — it is held in the contracts.** That is the abstraction collapse the mandate asks for: intent → typed graph → execution, with the agent as a *bounded* filler of node bodies, never the keeper of global correctness.

---

## 7. Execution engine — logic flow

**Author-time (`build_workflow`):**
1. Classify request → derive **Intent Manifest** (capabilities/safety/delivery) and tag load-bearing nodes.
2. Agent drafts nodes; engine **infers/validates output schemas**; composes input schemas topologically.
3. Run the **EditTransaction** (§4): structural + data-contract couplings + intent + typed dry-run. Commit or return named regressions.
4. Set `greenAt` on success. Return the Manifest + the typed contract summary (the global context).

**Edit-time (`patch`/self-heal):** identical transaction; **green ratchet** enforced; rollback snapshot taken. Self-heal is logic-only (§5) and transactional.

**Run-time:**
1. Deterministic spine dispatches (existing engine). Condition scope unified (P0.1).
2. Each node's produced output is **validated+coerced against its output schema at the boundary** (not key-presence). A shape mismatch is a `logic` failure caught *here*, at the producing node, with the path — never silently propagated.
3. Failure → taxonomy (§5): `resource`/`evidence` ⇒ quarantine/honest stop; `logic` ⇒ bounded self-heal ladder (deterministic repair → one fallback → escalate; **no infinite loop** — attempts are capped per failure lineage, which the engine already does).
4. Every node completion is an **atomic, idempotent commit** to the run ledger (exists); replay/resume is deterministic from it.

---

## 8. Core data structures (summary)

- `NodeIOContract { input: ShapeSchema; output: ShapeSchema }` — per node.
- `ShapeSchema` — the minimal JSON-Schema subset (§2.1).
- `EdgeCoupling { from, to, reads: {readPath, satisfiedBy}[] }` — computed, checked.
- `IntentManifest { goal, capabilities[], safety[], delivery[] }` with predicate-carrying assertions (§3).
- `EditTransaction { baseHash, patch, validation{structural,dataContract,intent,dryRun}, outcome, regressions[] }`.
- `NodeFailure { class: logic|resource|evidence, reason, fixable }` (§5).
- `WorkflowInvariantState { greenAt: hash|null, lastGreenSnapshot }` (§4.2/4.3).

---

## 9. The honest ceiling — what "unbreakable" means (and does not)

This architecture guarantees the workflow **never enters a corrupt, gutted, or lying state**: it cannot save a shape-broken graph, cannot green-wash by deleting its purpose, cannot regress silently, and cannot mistake a rate-limit for a bug and route around it. It **cannot** make Instagram serve a hostile scraper, conjure Codex credits, or curate 15 model-worn photos that do not exist. "Unbreakable" here means: **the system either does its real work or stops with a truthful, typed, actionable blocker — it never lies and never corrupts itself.** Anyone who promises more than that about LLMs + hostile external surfaces is selling a palliative. This is the real ceiling, stated plainly.

---

## 10. Build sequence (extend real seams — do not rebuild the engine)

1. **Data Contract, deterministic first** (highest leverage, catches the Fashion Store class): infer `ShapeSchema` for `transform`/`filter`/`code`; compose input schemas in the existing `simulateGraph`/`validateExpressions` topo-walk; add the coupling check to `build_workflow`'s gate. Ship the "reads `.signals`, upstream produces `.evidence.signals`" build error.
2. **Boundary validation at run-time**: validate+coerce each node's output against its schema in `#completeNode` (where normalization already lives).
3. **Failure taxonomy**: extend `analyzeRunFailure` to classify logic/resource/evidence; quarantine resource in the engine; forbid self-heal on non-logic. 
4. **EditTransaction wrapper** around `build_workflow`/`patch`/self-heal with the green ratchet + rollback snapshot (the dedup window and preflight already exist to build on).
5. **Intent Manifest**: derive at authoring, store on the workflow, check in the transaction + pre-run gate. Start with three universal assertions (no-auto-approve-irreversible, delivery-persists-something, no-constant-stub-on-a-tagged-capability).

Order chosen so the **dominant real failure (shape mismatch) dies first**, and each step is a strict extension of a seam that already exists (`simulateGraph`, `validateExpressions`, `#completeNode`, `analyzeRunFailure`, `build_workflow`, the run ledger).

---

## 11. Implementation Log
*(Append per shipped organ — `feedback_masterplan_log`.)*
- **2026-07-01 — SPEC authored.** Diagnosis grounded in the Fashion Store transcript + `project_fashion_store_factory_rootcause` (shape-nesting cut) + `project_agent_build_loop` (P0–P5 shipped). Extends, does not replace, the AGENT-BUILD-LOOP work.
- **2026-07-01 — Organ 1 (Data Contract) v1 SHIPPED** (commit `1cc172f`; 379 engine tests green; 0 false positives on the real 74-node workflow). `analyzeEdgeCouplings` in `validateExpressions.ts`: infers each node's produced top-level keys (transform object-literal via a conservative scanner, agent `outputKeys`, extension `outputMapping`, passthrough), threads them topologically, flags a read of an `input.X`/`nodes["id"].Y` the producer provably doesn't emit → named build error + "did you mean". Wired into `build_workflow` + `agentis.workflow.dry_run`. Zero false positives (open-on-any-uncertainty). ⚠️ v1 limitation: opaque producers (extension with no `outputMapping`, integration, `code`) are OPEN → not checked; top-level keys only (deep paths not yet). Also SHIPPED: the runtime BOUNDARY of Organ 1 — agent output adapts to its declared contract instead of crashing (commit `210b752`).
- **2026-07-01 — Organ 2 (Intent Contract) v1 SHIPPED** (commit `dc015ae`; typecheck clean, 31 tests green). `intentContract.ts`: (1) APPROVAL INTEGRITY — an approval forced to `true` (`|| true` / constant) before an irreversible action is a hard error (the `deploy-contract-input` bug); (2) CAPABILITY PRESERVATION — a manifest (agent workers, external-fetch steps, integrations, persistence) is derived + stored on `settings.intentManifest` on every build, and an edit that drops load-bearing capabilities (Instagram scout → stub) is flagged against it. Wired into `build_workflow` (check on every build; store manifest; diff on edit). ⚠️ v1: capability regressions are WARNINGS (visible), not hard blocks — the "hard-block-unless-acknowledged" ratchet + NL-derived `must` capabilities are v2. NOT built: Organ 3 (Atomic Evolution), Organ 4 (failure taxonomy), the LLM reshape, Organ 1-deep (opaque-extension shape inference).
