# Brain at Scale — the 10x viability plan

> **Status:** Proposal · 2026-06-24
> **Question that triggered it:** *"Is the Brain viable to grow — months of 24/7 work stored — and where are the vulnerabilities, gaps, and 10x opportunities?"*
> **Companion to:** [`BRAIN-10X-MASTERPLAN.md`](./BRAIN-10X-MASTERPLAN.md) (semantic recall + formation). This doc adds the **scale, growth-control, isolation, and retrieval-cost** dimension that one did not cover.
> **One line:** *The Brain's consolidation/conflict-resolution machinery is rich and mostly already built — the work is to **activate, connect, and fix the bounds**, not to build a parallel system.*

---

## 0. Framing (read first)

This is **not** a "the Brain is broken, rewrite it" document. A deep read shows a sophisticated, well-layered memory system: staged formation with a deterministic gate + Formation Judge, write-time dedup/reinforcement, a dispute/contradiction subsystem with supersede/merge/split-by-context, multi-tier compression, PACER-classed TTLs, a dream/reflection engine, and an embedding-provider registry with a re-embed migration path. **Most of what a "scalable brain" needs already exists in code.**

The problem is narrower and more dangerous *because* it's subtle: **half of that machinery is dormant**, the **embedding default silently undercuts the half that is live**, and a **handful of real bugs** make the read path O(workspace) and leak isolation. Over months of 24/7 use these compound into degradation. Every item below is grounded in `file:line`. The **non-goals (§6)** list what NOT to build because it already exists.

---

## 1. The system as actually built (the part we must not duplicate)

### 1.1 Consolidation & conflict resolution — what runs **live** today

`brainQueue` (the `CognitivePromotionQueueWorker`) **is** started (`bootstrap.ts:1434`). On the live path:

| Capability | Where | Trigger | Status |
|---|---|---|---|
| Staged formation (deterministic gate → Formation Judge ADD/UPDATE/NOOP) | `sharedIntelligence.ts` `promote()` (~:358), `brainFormation.ts` | `atom_promotion` job, enqueued by the engine on run completion (`WorkflowEngine.ts:4921`) + session moments | **LIVE** (model-gated) |
| Write-time dedup / reinforcement (cosine ≥ `EMBED_HIGH_SIMILARITY` 0.88 → reinforce, not add) | `sharedIntelligence.ts` `#stageOrReinforce` (~:576) | same `atom_promotion` job | **LIVE** (semantic-gated — see §2.2) |
| Dispute / contradiction subsystem (flag → review → **supersede-one / merge-both / split-by-context**) | `sharedIntelligence.ts:1466–1655` (`flagDispute`/`listDisputes`/`resolveDispute`) | auto-flag (+optional auto-resolve) via queue job `cognitivePromotionQueueWorker.ts:306–316`; operator UI | **PARTLY LIVE** |
| Feynman repair loop | `feynmanReflection.ts` | `feynman_reflection` job (`WorkflowEngine.ts:2465`) | **LIVE** |
| App/agent/workspace scope binding + brain bridge | `appData.ts`, `WorkflowEngine.ts` `#appScopeId` | run-completion + `data_promote_memory` | **LIVE** (added this session) |

### 1.2 Consolidation & lifecycle — what is **built but dormant**

`BrainMaintenanceService` is constructed (`bootstrap.ts:817`) and then **never started** — `bootstrap.ts:882` does `void brainMaintenance`, and the `.start()` block (`bootstrap.ts:1429–1435`) starts seven services but not this one. It is also the **only** enqueuer of `memory_reflection` jobs (`bootstrap.ts:818`). Consequently the entire *scheduled* half is dead in production:

| Capability | Where | Why dormant |
|---|---|---|
| Stale-mark → archive → expire lifecycle | `brainMaintenanceService.ts:85–243` | `.start()` never called |
| 3-tier compression (archive idle → **merge near-dupes** → curator LLM) | `brainCompressionService.ts:63–181` | only run from maintenance; threshold-gated at 2000 active atoms |
| Reconciliation / generalization + supersession (`supersededBy`) | `memoryReflectionService.ts` (`#reconcile`, :373, :421) | runs as `memory_reflection` job, only enqueued by maintenance |
| Belief-contradiction detection ("dreaming") | `reflectionService.ts:232` | `dream_pass`/reflection, scheduler-driven |
| Scheduled re-embed of stale vectors | `SharedIntelligence.reembedPending` (wired into maintenance at `bootstrap.ts:817`) | maintenance off |
| Link pruning | `brainMaintenanceService.ts:246–257` | maintenance off |

**Net:** write-time dedup curbs *some* duplication as it happens; the *periodic* elimination/reconciliation/compaction and **all disk reclamation** never run.

### 1.3 Embedding / retrieval — designed to be configured

- Per-workspace provider config exists: `embeddingProviderType` column (`schema.ts:60`, default `'hashing'`), `EmbeddingProviderRegistry` (`embeddingProviderRegistry.ts`), `PATCH /v1/workspace-intelligence`, a `confirmMigration` guard, and a `POST /reembed` path.
- A real semantic provider exists and is wired: `OpenAIEmbeddingProvider` (`embeddingProvider.ts:214`, `text-embedding-3-small`, 1536-dim).
- Provider/dim-change handling exists: `vectorIsComparable` + `needsReembed` + `retrieval_degraded` quality events + a bulk `reembedWorkspaceAtoms` path that sets `retrievalPaused`.

**This is a deliberate zero-config OSS default, not a bug.** The issue is its *invisible blast radius* (§2.2).

---

## 2. The real problems (precise, grounded)

### 2.1 The scheduled consolidation/lifecycle is dormant → unbounded **disk** growth

- `BrainMaintenanceService.start()` is never called (`bootstrap.ts:817/882/1429–1435`). Stale/archive/expire, compression, reconciliation, link-prune, scheduled re-embed → all dead.
- **Nothing hard-deletes.** A repo-wide search finds no `DELETE` on `memory_episodes`; the lifecycle's terminal state is `status='archived'` + `archivedAt` (`brainMaintenanceService.ts:238`). Archived rows are filtered from reads but **stay on disk forever**.
- Satellite tables also grow monotonically with no prune: `cognitive_promotion_queue` (`done`/`failed` rows never deleted), `brain_quality_events`, `promoted_patterns` (no automated lifecycle — `intelligencePromotion.ts`).
- **Severity: P0.** At ~1 promotion/min for a 24/7 agent (~43k rows/month) the file grows without bound and every scan (§2.3) gets slower.
- **One real algorithmic bug to fix *before* turning it on:** tier-2 compression is O(n²) over active atoms (`brainCompressionService.ts:86–138`) and runs synchronously — at the 2000-atom threshold that's ~2M cosine comparisons blocking the SQLite thread.

### 2.2 The hashing default silently undercuts **both** recall **and** the consolidation stack

- Default provider is `hashing` (`schema.ts:60`); `HashingEmbeddingProvider` is a 512-bucket token-frequency hash — its own docstring: *"no semantic understanding."* So "vector search" is bag-of-words cosine. (Confirms `BRAIN-10X-MASTERPLAN`'s "semantic recall is inert" from the scale angle.)
- **Systemic consequence (the new insight):** write-time dedup (`#stageOrReinforce` cosine ≥0.88), reconciliation, compression tier-2 ("merge near-dupes"), and contradiction detection are **all cosine-based**. On the hashing default they degrade to lexical — so the *live* consolidation from §1.1 is itself weakened, which *accelerates* §2.1's growth (true near-duplicates aren't merged). The embedding choice is effectively a **prerequisite for the brain's self-maintenance**, and that dependency is invisible.
- **Gaps (not "broken"):** (a) no auto-upgrade/nudge to a real provider even when `OPENAI_API_KEY` is present; (b) the reserved `local` ONNX provider falls back to hashing silently (`embeddingProvider.ts:269`); (c) after a provider switch, the *incremental* path degrades to lexical silently (only the bulk re-embed pauses retrieval).
- **Severity: P0** for the systemic effect; the default itself is fine, its invisibility is not.

### 2.3 Read path is O(workspace) per dispatch + missing index (genuine bug)

- `searchAtoms` loads **every** episode embedding in the workspace on every dispatch — `sharedIntelligence.ts:1235–1240`: `select({id,embedding,…}).from(memoryEpisodes).where(eq(workspaceId)).all()` — no `LIMIT`, no scope filter, no `archived` filter — then parses each JSON vector, even though only ≤500 atoms (`loadAtoms`) are scored. At 100k rows with 1536-dim vectors that's >1 GB parsed per dispatch → GC death → OOM.
- **No `memory_episodes(workspace_id, scope_id, updated_at)` index** exists; the v78 migration comment claiming parity with `knowledge_chunks` is wrong. Every recency-ordered scope query is a full scan + sort.
- `EpisodicMemoryStore.searchEpisodes` (`:387`) and several dashboard/count paths (`#capacityStatus` ~:1667, `summarize` ~:1431) also do unbounded `.all()`.
- No ANN at any scale — pure brute-force JS cosine (`embeddingProvider.ts:130`).
- **Severity: P0** (the unbounded scan) compounding directly with §2.1.

### 2.4 Isolation & governance (trust gaps)

- **Destructive writes lack a `workspaceId` predicate** — `reinforce`/`update`/`archive`/`supersede`/`delete` in `episodicMemoryStore.ts` filter on `id` only (e.g. `:224`, `:263`, `:272`, `:300`); cross-workspace safety rests entirely on the prior `byId` guard read. **P1 defense-in-depth.**
- **Single-scope recall amnesia** — `buildDispatchContext` recalls `workspace + one scope` (`scope:'both'`, `:741`). The app-scope binding added this session (`WorkflowEngine.ts` `#appScopeId ?? agentId`) therefore makes an agent operating an App unable to recall its **own** private memory. **P1 (self-inflicted, this session).**
- **Brain bridge writes raw record JSON (PII)** — `data_promote_memory` (`appData.ts`) and the agent-tool path store `JSON.stringify(record.data)` verbatim into memory, no scrub/summary. **P1 data governance.**
- **Formation is injectable** — harness import / channel-triggered runs can land workspace-global atoms that reach every agent's recall, bypassing the Formation Judge when no promoter is wired. **P1/P2.**
- **No `scope_type` discriminator** — `scope_id` overloads agentId/appId/workflowId as opaque strings; correctness/auditing risk as scope kinds grow. **P2.**

---

## 3. The plan — activate · connect · fix (extend, don't fork)

> Sequencing matters: §2.1 + §2.3 stop the bleeding; §2.2 makes the existing consolidation actually work; §2.4 is trust. Each item names the **existing component to reuse** and, where relevant, **what NOT to build**.

### Phase 0 — Survival (P0)

- **0.1 Bound the read path.** In `searchAtoms`, build `episodeVecs` only for the ≤500 atoms `loadAtoms` already returned (they already carry `embedding`), eliminating the full-workspace scan at `:1235`. Add the `memory_episodes(workspace_id, scope_id, updated_at)` index (migration + drizzle mirror). Cap `EpisodicMemoryStore.searchEpisodes` and convert `#capacityStatus`/`summarize` to `COUNT(*)`/bounded reads. *Reuse:* existing `loadAtoms`. *Do NOT* add a second store.
- **0.2 Turn on the lifecycle — safely.** Fix tier-2 compression from O(n²) to a token-bucket candidate pass (`brainCompressionService.ts:86`; the `tokenize()` primitive already exists), **then** start `BrainMaintenanceService` (`bootstrap.ts`, one line beside `brainQueue.start()`). Add the **one missing primitive — disk reclamation**: a maintenance pass that `DELETE`s `managed` rows archived beyond `hardDeleteAfterDays`, plus rolling prunes of `cognitive_promotion_queue` (done/failed), `brain_quality_events`, and superseded atoms (`memoryReflectionService.ts:373` should also set `archivedAt`). *Reuse:* the entire `brainMaintenanceService`/`brainCompressionService`/`memoryReflectionService` stack — it exists; it just isn't scheduled. *Do NOT* write a new reconciliation/compaction engine.
- **0.3 A real semantic brain *by default* — bundle local embeddings; OpenAI/local-model = opt-in.** The default stops being "hashing until you configure OpenAI." Ship a **bundled local ONNX embedder — `multilingual-e5-small` (384-dim, real semantic, offline, free, ~100 languages)** — as the zero-config default by implementing the empty `local` seam (`embeddingProvider.ts:269`). Everything else is **operator-configured, never bundled**, through one pluggable provider surface:
  - **Any API embedding endpoint** — OpenAI *or any OpenAI-compatible endpoint*, incl. a **local embedding server** (HF text-embeddings-inference, Ollama `/embeddings`, LM Studio, vLLM) via base-URL + model + key. This is how "a local model the operator runs" is supported — a local *embedding* endpoint, not a chat LLM.
  - **Any local ONNX model** via the same local provider, parameterized by model id/path + dims (`e5-base`, `gte-multilingual-base`, `bge-small-en`, …). Operator chooses and sets it up.

  *Why this default:* an OSS single-tenant operator gets a genuinely semantic brain with **zero config, zero key, zero data egress** — config-free and real stop being in tension. 384-dim keeps the brute-force/JSON-storage cost low (8× smaller per row than OpenAI-1536-as-JSON) until ANN+BLOB land (§0.5/§2). Multilingual-by-default directly serves §3.5. *Reuse:* `EmbeddingProviderRegistry`, `OpenAIEmbeddingProvider`, `reembedPending`, the `vectorIsComparable`/`needsReembed` migration. *Build (seam is empty):* the local ONNX provider. *Runtime:* prefer transformers.js/WASM (portable, no native build) over `onnxruntime-node` (faster, per-platform binary) for OSS "just works."

- **0.3a Delete hashing + lexical scoring entirely — clean codebase, no fallback tier.** Lands **in the same change as 0.3, never before** (hashing is today's default + the only zero-config vectors; lexical `similarity()` is the recall fallback; removing either first breaks the brain + ~13 test suites). Removal checklist (grounded — 36 files reference it):
  - Delete `HashingEmbeddingProvider` and the `selectEmbeddingProvider` `'hashing'` + `'local'→hashing` paths (`embeddingProvider.ts`).
  - Delete the lexical **recall** fallback `similarity(args.query, atom.text)` (`sharedIntelligence.ts:1264`); convert MMR diversity (`:2852`) and the working-set relevance gate to cosine — **no lexical scoring remains in the dispatch/recall path** (vectors are now guaranteed, so it's dead code).
  - Remove hard-wired `new HashingEmbeddingProvider()` in bootstrap (`:474` personal-brain, `:599` abilities fallback, `:718` knowledge store) → all route through `embeddingResolver` (= §3.3).
  - Drop `'hashing'` from the provider enum + the `schema.ts:60` default, plus `BrainConfigWizard.tsx`, the `workspaceIntelligence` route, and the registry.
  - **Migrate tests (~13 files)** off `HashingEmbeddingProvider` to a tiny deterministic **test-only** stub embedder (fixed-dim, lives in test code — never shipped).
  - **Data migration:** existing workspaces on `'hashing'` re-embed once with the new default on upgrade (reuse `reembedWorkspaceAtoms`/`reembedPending`).
  - **No-provider behavior:** fail loud (degraded banner / explicit error), never silently lexical.
  - **Coupling — 3.2 must ship here:** hashing is the only **synchronous** provider, so removing it makes every provider async and the write path's inline-embed branch (`episodicMemoryStore.write:117-137`) stops firing → embed **inline-async on write** (or fire an immediate per-promotion `reembedPending`), else every fresh memory is unretrievable until a sweep.

### Phase 0.5 — Scale ceiling (gated, bigger lift)

- **ANN via `sqlite-vec`** once a workspace exceeds ~50k active atoms: an ANN candidate stage feeding the existing MMR + (now-wired) reranker. Gate behind 0.1–0.3 proving out. *Do NOT* switch databases.

### Phase 1 — Trust & isolation (P1)

- **1.1** Add `workspaceId` to every UPDATE/DELETE/archive/supersede/reinforce WHERE in `episodicMemoryStore.ts` (cheap, closes the defense-in-depth gap).
- **1.2** Multi-scope recall: `buildDispatchContext(scopeIds[])` → `loadAtoms` `scope_id IN (appId, agentId)` + workspace, deduped. Fixes the app/agent amnesia from §2.4. *Reuse:* the existing `scope:'both'` path, generalized.
- **1.3** Govern the bridge: `data_promote_memory` requires a summarized `title`+`content` (or PII-scrub) instead of raw record JSON; route harness/channel-origin **workspace-scope** writes through the Formation Judge or quarantine.

### Phase 2 — Hygiene (P2, alongside)

- `scope_type` discriminator column; vectors as BLOB (not JSON TEXT) using the existing `embeddingDims`/`embeddingModel` provenance to gate migration; vector-based MMR + **wire the already-built `#modelRerank`** (`SharedIntelligence.setRerankCompleter(defaultCognitiveCompleter)` in bootstrap); fold `promoted_patterns` into the unified `memory_episodes` lifecycle so it inherits dedup + decay for free; **recalibrate `DISPATCH_MIN_RELEVANCE` per provider** — measured: e5 cosine lives in ~0.78–0.92 (even unrelated text ≈ 0.78), so the current `0.32` clears everything; the e5 relevance floor is ≈ 0.85. Store the floor alongside the provider identity.

### Phase 3 — "A Brain that actually remembers" (recall correctness & multilingual)

> Source: external review, **independently verified against code (all six accurate)**. These sharpen §2.2 and add a genuinely new dimension — **multilingual recall**. Folded into the spine above where they overlap; new items called out. Theme: *formation is strong; recall is lexical theater by default — make memory real, multilingual, and trustworthy.*

- **3.1 `local` becomes the *real default*, not a hashing alias.** ✅ `embeddingProvider.ts:269` silently returns `HashingEmbeddingProvider` for `local`. **Resolved by §0.3/§0.3a:** the bundled `multilingual-e5-small` ONNX provider becomes the default, hashing is deleted, and a missing/unavailable local model fails loud — never hashes. **P0** (the default embedder).
- **3.2 Close the fresh-write recall gap.** ✅ `episodicMemoryStore.write:117-137`: sync providers embed inline, but **async (OpenAI) stores a null vector + `needsReembed=true`**, deferred to the re-embed sweep — which lives in the **dormant** maintenance service (§2.1). A just-formed lesson is therefore **not** semantically retrievable on the next run (it falls to lexical), defeating the core cross-run promise. Critically, this means **enabling OpenAI (Phase 0.3) without this fix makes fresh-memory recall worse**. Fix: embed inline with a fast local model, or trigger `reembedPending` immediately after a form promotion. **New — P0, gates Phase 0.3.**
- **3.3 Route every scope through the registry.** ✅ Hard-wired `new HashingEmbeddingProvider()` bypasses workspace config for personal-brain (`bootstrap.ts:474`), abilities (`:599` fallback), and the knowledge store (`:718`) — only the episodic/agent stores use `embeddingResolver`. Route all of them through the registry. **P1.** *(Extends Phase 0.3.)*
- **3.4 Vector-score every atom kind, not just episodes.** ✅ `sharedIntelligence.ts:1261`: `atom.kind === 'episode' ? episodeVecs.get(...) : null` — promoted patterns, `knowledge_chunks`, and `kb_chunks` always fall to lexical `similarity()`, even with a real provider configured. Load comparable vectors for every kind in the dispatch retriever. **New — P1.**
- **3.5 De-anglicize formation (multilingual).** ✅ `brainFormation.ts:171-192` `scoreStatement` is pure English regex cues (`always|never|must|because|learned…`); base 0.35 < the 0.5 threshold, so a non-English statement with no English cue scores ~0.43 → **rejected**. Worse, the `length < 25` ASCII-char gate + whitespace `tokenize` (`words.length < 4 ⇒ score 0`) effectively **block CJK** (no spaces). Net: non-English personas form almost no memory. Back the gate with the existing **semantic PACER prototype path** (`classifyPacerByPrototype`, currently never called) + a language-agnostic scorer; measure length in graphemes, not ASCII chars. **New — P1, the multilingual dimension.**
- **3.6 PII scope default.** ✅ `episodicMemoryStore.write:166` defaults `shared: … ?? true` (team-visible), and formation callers passing `scopeId=null` form workspace-global atoms. Bias personal-smelling formed memory to **agent-scope**, require opt-in to share. **P1.** *(Folds into Phase 1.3 governance.)*

---

## 4. Why this is "activate/connect/fix", not "build"

Almost every capability a scalable brain needs is **already implemented**: staged formation, write-time dedup, the dispute/contradiction subsystem (with supersede/merge/split), 3-tier compression, reconciliation+supersession, dreaming/belief-contradiction, PACER TTLs, the embedding registry + re-embed migration, the model reranker, and the OpenAI provider. The 10x is recovered by **switching them on, connecting the embedding on-ramp that makes them effective, adding the single missing primitive (disk reclamation), and fixing five concrete bugs** — at a fraction of the cost and risk of any new subsystem, and with zero duplication.

---

## 5. Verification strategy (when implemented)

- **0.1:** a recall-cost test asserting `searchAtoms` issues no unbounded workspace scan (query count / row-read bound) at N=10k seeded atoms; confirm the new index via `EXPLAIN QUERY PLAN`.
- **0.2:** a maintenance test on a seeded workspace asserting archived-beyond-cutoff rows are deleted, queue/quality tables pruned, and tier-2 completes within a wall-clock budget at 5k atoms (proves the O(n²)→bucketed fix).
- **0.3:** registry test — with `OPENAI_API_KEY` set and no explicit opt-out, a new workspace resolves to OpenAI; degraded banner surfaces on hashing.
- **1.1/1.2:** cross-workspace write-isolation test (a destructive op cannot touch another workspace's atom); multi-scope recall test (an App-owned run recalls **both** App-scoped and the operating agent's private atom).
- **1.3:** promote-bridge test rejecting raw record JSON / asserting scrub.

## 6. Non-goals (do NOT build — it exists)

- A reconciliation / dedup / compaction engine → `brainMaintenanceService` + `brainCompressionService` + `memoryReflectionService`.
- A contradiction/conflict resolver → `flagDispute`/`resolveDispute` (supersede/merge/split) in `sharedIntelligence.ts`.
- A reranker → `#modelRerank` (just wire `setRerankCompleter`).
- The embedding *interface / registry / OpenAI provider / re-embed migration* → already exist (`EmbeddingProviderRegistry`, `OpenAIEmbeddingProvider`, `reembedPending`); don't rebuild them. The **one embedder we DO build** is the local ONNX provider (the `local` seam is empty today).
- A second memory store / parallel scope system → one `memory_episodes` substrate, generalized.
- **Keep hashing / lexical similarity as a fallback tier → it is DELETED (§0.3a), not demoted.** No silent lexical scoring anywhere in recall/ranking; no-provider = fail loud.

## 7. Open decisions

1. `hardDeleteAfterDays` default (disk reclamation vs. audit retention) — proposed 365d for `managed` archived rows; pinned/operator atoms never auto-deleted.
2. Default embedding model + dimension for the auto-upgrade, and OSS local model choice.
3. Multi-scope recall budget split (how the ≤K slots divide across workspace/app/agent).
4. PACER prototype path activation (currently exported but never called) — needed by §3.5 (multilingual formation), so likely **in** scope.
5. Fresh-write strategy (§3.2): inline-embed with a fast local model on every write, vs. fire an immediate per-promotion `reembedPending`. Inline is simplest but adds CPU to the write path; immediate-sweep keeps writes cheap but needs the worker live.
6. Multilingual scorer (§3.5): semantic-prototype-only vs. a hybrid (structural `isRejectable` is already language-agnostic; only `scoreStatement` cue-weighting is English). Grapheme-based length + CJK tokenization required either way.
7. Bundled default model = `multilingual-e5-small` (384-dim, MIT, ~100 langs) — confirmed. Runtime: transformers.js/WASM (portable, no native build) vs `onnxruntime-node` (faster, per-platform binary) — lean WASM for OSS portability. Model artifact (~120 MB INT8) downloaded+cached on first use.
8. Test embedder: a deterministic fixed-dim stub in test code (fast, offline) replaces `HashingEmbeddingProvider` across ~13 suites — hashing must not survive even in tests.

## Impl log

_(append per shipped phase, reconciled with real code — per `feedback_masterplan_log`.)_

### 2026-06-24 — Slice 1: real local semantic embedder shipped + proven (additive, green)

- Added `@huggingface/transformers` to `apps/api` (pulls `onnxruntime-node`; postinstall ran).
- `embeddingProvider.ts`: implemented **`LocalEmbeddingProvider`** — `multilingual-e5-small` (384-dim), lazy **dynamic import** of the runtime (zero startup cost unless used), mean-pool + normalize, `query:` prefix, configurable model. `selectEmbeddingProvider('local')` now returns it; the silent `'local'→hashing` fallback is **gone** (3.1). Factory kept **additive**: `'hashing'` still resolves to the legacy provider as a transitional **decoder** for un-re-embedded data — default/flip is migration-gated (below), so existing brains are not orphaned.
- **Proven with the real model** (throwaway smoke test, then deleted): `ML↔neural-network 0.892 > ML↔banana 0.783`; cross-lingual `EN↔PT 0.912`. Genuine semantics + multilingual confirmed; first run (download+infer) ~18 s.
- **Available now:** set `embeddingProviderType: 'local'` → a real, offline, free, multilingual brain. `api` typecheck clean.
- **New finding (folded into Phase 2):** e5 cosine sits in a high, compressed band (~0.78–0.92 even for unrelated text), so `DISPATCH_MIN_RELEVANCE = 0.32` is meaningless under e5 — it must be recalibrated per provider (e5 floor ≈ 0.85), else everything clears the gate.

**Remaining (migration-gated, NOT yet done):** flip the new-workspace default `hashing→local` + activate a boot **re-embed backfill** (`EmbeddingBackfillService` exists) so existing `hashing` workspaces migrate to 384-dim semantic vectors; close 3.2 (inline-async embed on the formation write path); then the cleanup — delete `HashingEmbeddingProvider`, the lexical recall fallback (`sharedIntelligence.ts:1264`), the bootstrap hardwires (`:474/:599/:718` → registry, which requires making `KnowledgeStore`/`PersonalBrain` workspace-aware), the `'hashing'` enum/UI, and migrate ~13 test suites to a deterministic stub. The class deletion **follows** the backfill (deleting the decoder before existing vectors are re-embedded would orphan them).
