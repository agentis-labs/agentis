# PACER + Feynman — Implementation Log

This log is written **as the implementation happens**, not after. It records what
was actually built, the gaps in the original proposition that were corrected, and
the decisions made along the way. The source plan is
[`BRAIN_PACER&FEYNMAN_PROPOSITION.md`](./BRAIN_PACER&FEYNMAN_PROPOSITION.md);
this log is the ground-truth record of how it landed.

## 0. Pre-flight: what the doc got wrong / what the code actually has

Before writing a line of code I verified every claim in the proposition against
the real tree. Corrections:

1. **There is no `pgvector` anywhere, but the doc still half-implies a vector
   store as a target.** Reality: embeddings are JSON arrays in
   `memory_episodes.embedding` (and `workspace_memory`, `session_moments`, etc.),
   ranked with `cosineSimilarity`. The hashing provider is the zero-dep fallback.
   PACER changes nothing here — confirmed and kept.

2. **The doc names `memory_episodes` as "the" run store but never names the write
   helper.** Reality: `EpisodicMemoryStore.write()` owns the table; `metadata` is
   a free-form JSON column. → **PACER metadata needs no migration.** We attach
   `pacerClass` / `originSurface` / `formationMode` straight into `metadata`.

3. **The doc lists `failureReflection.ts` "writes a canned lesson" — true, but it
   writes to `agent_memories` via `AgentMemoryService`, NOT to
   `memory_episodes`.** So Level-2 reflection and durable episodic memory are
   *different stores* today. The real Feynman job (Level 3) must write to
   `memory_episodes` (agent- or workspace-scoped) to be retrievable by dispatch.

4. **The doc's "self-heal exists in WorkflowEngine" is correct** — `notifyTaskFailed`
   re-dispatches with error context up to `maxSelfHealAttempts`. But there is **no
   repeated-failure detection across runs** and **no trigger from self-heal
   exhaustion into a reflective job.** That is the real Phase-4 gap.

5. **The doc proposes "PACER should refine write policies" but `resolveMemoryPolicy`
   has no notion of source surface** (it only sees node kind / title / role /
   output shape). The genuinely missing signal is *where the content came from*
   (tool output vs operator chat vs ingest vs session vs run completion). Phase 2
   adds that as a first-class `SourceSurface`.

6. **The doc's Phase-1 constraint — "classify before code fences are stripped" —
   is real and important.** `extractCandidateStatements()` runs `stripNonProse()`
   first, which deletes code blocks. Procedural/reference signals (paths, code
   refs, identifiers) live in exactly that stripped material. So PACER
   classification reads the *pre-strip* candidate text plus source signals.

7. **"agent_memories was retired in migration v51"** (per schema comment) — but
   `FailureReflectionService` still calls `AgentMemoryService.append`. Verified
   `agent_memories` table still exists (migration v39 created it; v51 retired the
   *episode-mirroring*, not the table). Kept the cheap inline path intact.

Net: **no destructive changes, one additive migration (v62) only for an index** to
make PACER/feynman queries cheap; everything else rides existing JSON columns.

---

## Phase 0 — Architecture contract (docs)

- Added the PACER → store map and allowed transitions to the proposition doc
  (§ "Store Map" + "Allowed Transitions"), reconciled with the real store names.
- This log created.

## Phase 1 — PACER metadata on writes ✅

New module `apps/api/src/services/brainPacer.ts`:
- `classifyPacer(signals)` — deterministic, model-free PACER classifier. Combines
  an episode-type prior (when the FormationJudge typed it), a source-surface
  prior, operator-chat tag refinement, text cues, and identifier/path density.
- `pacerRouting(cls)` — the policy each downstream pass consults: `stagedTtlDays`,
  `importanceFloor`, `decayResistant`, `mergeSimilarity`, `curatorPriority`.
- `SourceSurface` + `PacerClass` types; `coercePacerClass` for read paths.

Writes now carry `pacerClass` / `pacerConfidence` / `pacerReason` /
`originSurface` / `formationMode` in `memory_episodes.metadata` (no migration —
it's a JSON column) and a `pacer:<class>` tag for cheap filtering:
- `SharedIntelligenceService.#commitFormedMemories` (formed atoms)
- `#stageOrReinforce` (staged traces)
- `#writeEpisodicMarker` (outcome markers → always `evidence`)
- `chatMemoryCapture.#writeWorkspaceMemory` → `workspace_memory.provenance`

**Design choice that matters:** PACER classifies the *pre-strip* candidate text,
not `extractCandidateStatements`' post-`stripNonProse` survivor. The staging path
classifies `cand.text` (which is already a survivor) — acceptable because staging
only runs in the no-model fallback; the formed path classifies `mem.statement`.
The truly raw signal is preserved for the operator-chat and (later) Feynman paths.

## Phase 2 — Source-aware routing ✅

- `CollectiveCognitivePromotionInput.originSurface` + `AtomPromotionPayload.originSurface`
  threaded enqueue → queue → `promote()`. `WorkflowEngine.#enqueueSuccessfulBrainCapture`
  stamps `run_completion`.
- `resolveMemoryPolicy` is now source-aware (step 2, before role/shape):
  - `operator_chat` / `agent_reflection` → always `form` (a stated rule is durable
    no matter how list-like the text).
  - `knowledge_ingest` / `session_conversation` → `episodic_only` (evidence stays cold).
- Staging TTL is now PACER-driven (`routing.stagedTtlDays`) instead of a flat 14
  days: procedural/conceptual traces get ~60 days to prove reuse; bulk evidence
  still decays in ~14. This is the concrete mechanism behind "evidence stays cold,
  procedural is preserved."

Typecheck: clean.

## Phase 3 — Retrieval & reuse as promotion signals ✅

`BrainMaintenanceService` gained a graduation pass that runs *before* TTL expiry:
- `#graduateStagedTraces` — an unconsolidated trace of a **decay-resistant** PACER
  class (procedural/conceptual/reference) that was retrieved into dispatch
  ≥ `GRADUATE_MIN_RETRIEVALS` (2) times — counted from `atom_injected`
  `brain_quality_events` via `#retrievalCount` — or reinforced once, is promoted:
  drops `unconsolidated`, gains `consolidated`+`graduated`, upgrades its type
  (`observation` → `success_pattern` for procedural, `distilled_lesson` for
  conceptual), bumps confidence/importance, clears its TTL, and emits an
  `atom_graduated` quality event.
- Evidence/analogical traces are explicitly excluded — they stay cold and expire
  on the PACER TTL set in Phase 2.

This is the literal implementation of the proposition's rule: *"Do not summarize
because something was stored. Summarize/consolidate because it keeps proving
useful."* The retrieval-frequency signal already existed as `atom_injected`
events; Phase 3 turns that latent signal into a consolidation gradient.

`BrainMaintenanceResult.stagedGraduated` added + surfaced in the maintenance
quality-event metadata. Typecheck: clean.

## Phase 4 — Real Feynman reflection jobs ✅

New service `apps/api/src/services/feynmanReflection.ts` + queue type
`feynman_reflection`:

- **Trigger** (`WorkflowEngine.notifyTaskFailed`): on an agent_task hard failure,
  `recordFailure()` writes a durable `node_failure` quality event and returns a
  cross-run count. A reflection is enqueued ONLY when self-heal just exhausted
  (`self_heal_exhausted`) or the same `(workflow,node)` has failed
  ≥ `REPEAT_FAILURE_THRESHOLD` (3) times (`repeated_failure`). Never per routine
  failure — it is a queue job, not a per-run tax.
- **The loop** (`run()`): L0 grounds itself with `analyzeRunFailure` (real run
  state). With the evaluator model it asks for a structured explanation —
  *what failed / why / wrong assumption / what to verify / a reusable lesson* —
  then **gates on grounding**: `groundingOverlap()` requires the explanation's
  tokens to overlap the real error/prompt/observations (≥ 0.18) and model
  confidence ≥ 0.5. A weak/ungrounded explanation stores **nothing** — the
  proposition's "no-op when confidence is weak" is the default, not an edge case.
- **No-model fallback:** stores a grounded procedural lesson ONLY when the
  deterministic analyzer *recognized* the failure; otherwise no-op.
- **Storage:** committed via `SharedIntelligence.addAtom` as a consolidated,
  PACER-tagged (`feynman`/`failure_repair`) lesson — agent-scoped for
  specialist-specific repairs, workspace-scoped for general ones — so dispatch
  retrieval surfaces it on future runs. Emits a `feynman_reflection` quality event
  (stored or not, with reason + grounding) for observability.
- Wired in `bootstrap.ts` (reuses the evaluator runtime as grading model) and
  attached to both `brainQueue.Feynman` and `engineDeps.feynmanReflection`.

Corrects proposition §6.4 which left this as "future" and never specified the
grounding gate or the no-op-by-default discipline. Typecheck: clean.

## Phase 5 — PACER-aware compression & curation ✅

`brainCompressionService` now consults `pacerRouting` (via `pacerOf(row)`):
- **Tier 1 (stale archive):** decay-resistant classes (procedural/conceptual/
  reference) get a 120-day leash (vs 60) and a halved confidence floor. A rarely
  retrieved but correct repair rule is no longer archived just for sitting idle.
- **Tier 2 (merge near-duplicates):** the merge cosine threshold is now the
  *stricter* of the two atoms' class requirements (procedural 0.96 — near
  identical, evidence 0.88 — merges freely). Procedural rules with small wording
  deltas are preserved as distinct rules.
- **Tier 3 (curator distillation):** clusters are ranked by `curatorPriority`
  (conceptual/procedural first); **evidence-dominated clusters are skipped
  entirely** — evidence stays archival/retrievable, never distilled into fuzzy
  memory. The `pacer:` routing tag is excluded from topic-cluster grouping. The
  dominant PACER class is passed into the curator payload and stamped onto the
  distilled atom (tag + metadata).

Typecheck: clean.

## Phase 6 — UI, observability, tests, migration ✅

**Observability / migration:**
- Migration **v62** (`pacer_feynman_indexes`): two composite indexes on
  `brain_quality_events` — `(atom_id, event_type)` for the Phase-3 retrieval
  count, `(workspace_id, event_type, created_at)` for the Phase-4 failure count.
  Idempotent, no data change.
- New quality-event types for inspection: `node_failure`, `feynman_reflection`
  (with `stored`/`reason`/`grounding`), `atom_graduated`.
- `BrainMaintenanceResult.stagedGraduated` surfaced in the maintenance event.

**UI** (`apps/web/src/components/brain/BrainDetailRail.tsx`):
- New "Memory class (PACER)" inspector section on atom detail: class (human
  label), origin surface, consolidation state (staged / consolidated /
  graduated-by-reuse), and formation mode. Reads `node.metadata` + the `pacer:`
  tag, which already flow through `episodeRowToGraphNode` → `brainGraphAdapter`.
  No API change.

**Tests** (all green):
- `tests/brainPacer.test.ts` — 15 cases: class assignments + routing invariants
  (incl. the directive-beats-rationale nuance).
- `tests/feynmanReflection.test.ts` — 5 cases: no-op on unrecognized/no-model,
  grounded → stored PACER lesson, ungrounded → no-op, low-confidence → no-op,
  cross-run failure counter.
- `tests/brainPacerPromotion.test.ts` — 2 integration cases: procedural staged
  with long TTL, evidence staged cold with short TTL.
- Existing `brainFormation` / `brainFormationPipeline`: 34/34 still green.

Web + API + db typecheck: clean.

---

## Closing summary

PACER and Feynman are now real in Agentis, in the grounded form the proposition
argued for:

- **PACER** — a deterministic routing/metadata discipline (`brainPacer.ts`) over
  the existing stores. Every formed/staged/operator memory carries its class,
  which drives TTL, decay-resistance, merge strictness, and curator priority.
  Nothing was collapsed into a new table.
- **Feynman** — a grounded, no-op-by-default repair loop (`feynmanReflection.ts`)
  that fires only on stubborn failures, checks its explanation against real run
  state, and commits a retrievable lesson only when it earns it.

Corrections vs the doc: the "future" Feynman is now specified + built with an
explicit grounding gate; PACER gained the source-surface signal the doc only
gestured at; and the lifecycle (graduation + PACER-aware compression) turns
"summarize because it keeps proving useful" into real code paths.

Deferred (intentionally, per the non-goals): analogical (A) atoms remain
derived-only (no first-class ingestion path — matches §4.2); a curator pass that
*reasons* over PACER with an LLM (vs deterministic concatenation today) is a
future enhancement.

