# Agentis Brain — Improvement Plan

**Status**: Requested Brain capabilities implemented; obsolete delivery items removed  
**Date**: May 26, 2026  
**Author**: Brain architecture review — ruthless edition  
**Scope**: What is actually built, what is broken, what to build next, and exactly how.

---

## Final Implementation Update - May 26, 2026

This section is authoritative. The older phase proposals and the May 25 foundation log below are preserved only as audit history. Where they mention classic HyDE, QA-pair generation, or Brain training export, those proposals are superseded and are not part of the product surface.

### Delivered In This Pass

| Capability | Delivered behavior | Primary implementation |
|------------|--------------------|------------------------|
| Model contextual summaries and key facts | Opt-in structured enrichment generates grounded summaries, context prefixes, key facts, entities, importance, and model provenance per chunk; the generated prefix is used for embedding. Deterministic context remains available when enrichment is disabled. | `apps/api/src/services/brainEnrichment.ts`, `knowledgeBase.ts` |
| Exploratory retrieval architecture | Classic ungrounded HyDE is not implemented. Exploratory search first retrieves real corpus snippets, optionally generates multiple grounded facet queries, and merges result lists with reciprocal-rank fusion. Contextual and strict requests avoid this added latency. | `knowledgeBase.ts`, `routes/knowledgeBases.ts` |
| Typed model-assisted links | Semantic auto-link candidates may be classified as `supports`, `contradicts`, `refines`, `derived_from`, or `co_observed` by the configured enrichment model, with `co_observed` fallback on absence/failure. | `knowledgeAutoLinker.ts`, `brainEnrichment.ts` |
| Entity and community graph atoms | Generated entities become shared `knowledge_chunk` concept atoms. Enriched documents create or update compact grounded summaries grouped by overlapping entity neighborhoods, linking chunks/entities through the existing temporal graph contract. | `brainEnrichment.ts`, `sharedIntelligence.ts` |
| Optional image visual description | The upload UI includes an explicit image-description opt-in. When selected and a vision model is configured, a compact textual visual description is indexed; otherwise the existing OCR fallback remains available. | `WorkspaceDocDropZone.tsx`, `brainEnrichment.ts`, `knowledgeBase.ts` |
| Audio transcription | Configured transcription models index audio through the provider's `/audio/transcriptions` contract; unconfigured installs return an honest configuration error. | `brainEnrichment.ts`, `knowledgeBase.ts` |
| Spreadsheet extraction | `.xlsx` ingestion is implemented with the declared `exceljs` runtime dependency and emits sheet/row text for retrieval; legacy `.xls` is rejected with conversion guidance. | `knowledgeBase.ts`, `apps/api/package.json` |
| Removed obsolete surface | The unused `kb_qa_pairs` storage and `/v1/brain/export` training-adjacent route were removed. Synthetic fine-tuning data is outside this vision. | DB schema/migrations, `routes/brain.ts` |

### Runtime Configuration

Model features are opt-in to prevent hidden cost and latency:

| Variable | Purpose |
|----------|---------|
| `AGENTIS_BRAIN_ENRICHMENT_ENABLED=true` | Enables model-generated chunk enrichment, grounded exploratory expansion, typed semantic links, and configured media providers. |
| `AGENTIS_EVALUATOR_BASE_URL`, `AGENTIS_EVALUATOR_MODEL`, `AGENTIS_EVALUATOR_API_KEY` | Supplies the existing structured completion runtime reused by Brain enrichment. |
| `AGENTIS_BRAIN_VISION_MODEL` | Enables per-upload opt-in visual descriptions for images. |
| `AGENTIS_BRAIN_TRANSCRIPTION_MODEL` | Enables uploaded audio transcription. |

### Architectural Validation - May 2026

| Candidate approach | Decision | Basis |
|--------------------|----------|-------|
| Mandatory classic HyDE for exploration | Invalidated | HyDE generates an ungrounded pseudo-document before seeing corpus evidence and adds latency on every exploratory request. |
| Grounded adaptive expansion | Implemented | Retrieval starts with actual corpus snippets, then generates multiple facets and applies RRF only for `exploratory` mode. This preserves breadth without making generated fiction the retrieval anchor. |
| Contextualized chunks | Implemented optionally | Anthropic's Contextual Retrieval pattern supports prepending grounded context before embedding and lexical indexing; deterministic context protects zero-provider installs. |
| Entity/community navigation | Implemented with existing atom contract | Microsoft GraphRAG/DRIFT uses entity relations and community summaries to broaden exploration. Existing `knowledge_chunk` atoms and temporal links can express that model without new disconnected tables. |
| Always-on media description | Invalidated | Images incur model cost and may include sensitive content; visual description is user opt-in and stores only compact text. |
| Training export/QA generation | Removed | It is not needed for the Brain retrieval vision and creates quality/governance obligations unrelated to the requested features. |

### Primary References Checked

- Anthropic, *Introducing Contextual Retrieval*, September 19, 2024: https://www.anthropic.com/news/contextual-retrieval
- Microsoft GraphRAG, *DRIFT Search* documentation, accessed May 26, 2026: https://microsoft.github.io/graphrag/query/drift_search/
- Gao et al., *Precise Zero-Shot Dense Retrieval without Relevance Labels* (HyDE), 2022: https://arxiv.org/abs/2212.10496
- Rackauckas, *RAG-Fusion: a New Take on Retrieval-Augmented Generation*, 2024: https://arxiv.org/abs/2402.03367
- *Scaling Retrieval Augmented Generation with RAG Fusion: Lessons from an Industry Deployment*, March 2026: https://arxiv.org/abs/2603.02153
- OpenAI, *Images and vision* and *Speech to text* API documentation, accessed May 26, 2026: https://platform.openai.com/docs/guides/vision and https://platform.openai.com/docs/guides/speech-to-text

---

## Prior Foundation Update - May 25, 2026

This plan has been implemented as a production-facing Brain foundation, with several architectural changes made after validating the proposal against the existing codebase. The original phased sections below remain useful as design intent and future work context; this section is the authoritative implementation status.

### Implemented

| Area | Delivered behavior | Primary implementation |
|------|--------------------|------------------------|
| Native KB embeddings | Uploaded `kb_chunks` are embedded on ingest using the workspace embedding provider, with asynchronous completion for remote providers. | `apps/api/src/services/knowledgeBase.ts` |
| Hybrid KB retrieval | `KnowledgeBaseService.search()` combines embedding similarity and lexical relevance, then reranks with importance and recency. Irrelevant retrieval is filtered instead of returned because it is recent or important. | `apps/api/src/services/knowledgeBase.ts` |
| Workflow/tool retrieval quality | Knowledge retrieval consumers await the hybrid KB path, including workflow knowledge nodes, workspace context assembly, tool execution, and creation inventory. | `WorkflowEngine.ts`, `workspaceIntelligence.ts`, `agentToolRuntime.ts`, `creationPipeline.ts` |
| Provider migration backfill | Provider changes re-embed promoted atoms and uploaded KB chunks; migration start and completion events are emitted. | `embeddingBackfill.ts`, `routes/workspaceIntelligence.ts`, `sharedIntelligence.ts` |
| Semantic auto-link refinement | Immediate links remain synchronous; configured external embedding providers add a best-effort asynchronous semantic refinement pass. | `knowledgeAutoLinker.ts`, `knowledgeBase.ts` |
| Context-aware KB metadata | Chunks record a deterministic context prefix, importance estimate, entities, and ingestion type; the context prefix participates in embedding. | `knowledgeBase.ts` |
| Access heat foundations | Retrieval increments `access_count` and `last_accessed_at` to support heat-aware compression and analytics. | DB migration 43, `knowledgeBase.ts` |
| Temporal graph edges | Links carry `valid_from` and `invalid_at`; resolved or superseded links remain auditable but are excluded from the current graph. | DB migration 43, `sharedIntelligence.ts` |
| Failure lessons | Exhausted agent task failures write concise deterministic lessons into agent memory for future dispatch context. | `failureReflection.ts`, `WorkflowEngine.ts` |
| Personal Brain backend | Private user notes, semantic search, explicit agent grants, and grant-gated context injection are implemented. | `personalBrain.ts`, `routes/personalBrain.ts`, `WorkflowEngine.ts` |
| Brain scope UI | The Brain header exposes Workspace, Agent, and Personal scopes with dedicated agent memory and personal note/grant panels. | `UnifiedBrainPage.tsx`, `AgentBrainPanel.tsx`, `PersonalBrainPanel.tsx` |
| Ingestion UX | Images and spreadsheets have optional extractor-backed upload paths; audio reports that transcription is not configured instead of pretending it indexed content. | `knowledgeBase.ts`, `WorkspaceDocDropZone.tsx` |
| Export foundation | Workspace indexed knowledge exports as NDJSON from `/v1/brain/export`. | `routes/brain.ts` |

### Validated Architectural Decisions

| Proposal | Decision | Reason |
|----------|----------|--------|
| Route uploaded documents through `KnowledgeStore.search()` | Revised | `KnowledgeStore` owns `knowledge_chunks`, while document upload owns `kb_chunks`. Native hybrid retrieval in `KnowledgeBaseService` preserves ownership, archive behavior, provenance, and access counts. |
| Copy KB chunks into a second intelligence store | Rejected | Duplication would create synchronization, deletion, and provenance failures. |
| Mandatory LLM contextualization during ingest | Revised | Deterministic contextual metadata is available with zero provider requirement. Model-generated enrichment remains optional future work. |
| Let semantic auto-linking block upload completion | Rejected | Structural links must be reliable and fast; remote semantic refinement is asynchronous and best effort. |
| Advertise multimodal capability without installed providers | Rejected | OCR and spreadsheet paths are optional dependency-backed behavior; audio explicitly requires transcription configuration. |
| Generate fine-tuning QA pairs without quality controls | Rejected for now | Exporting real indexed content is safe; creating unvalidated synthetic training pairs is not. |
| Automatically expose private notes through workspace search | Rejected | Personal Brain is user-owned and agent access requires an explicit grant. |

### Deferred Or Partial Work

| Item | Status | Next safe step |
|------|--------|----------------|
| Model-generated contextual summaries and key facts | Deferred | Introduce an explicitly configured enrichment runtime with persisted provenance. |
| HyDE exploratory retrieval | Deferred | Add behind a configured generation provider and latency budget. |
| LLM typed relation classification | Deferred | Classify top link candidates asynchronously with budget and audit controls. |
| Entity graph nodes and community summaries | Deferred | Build after qualification output is reliably model-backed. |
| Image visual descriptions | Partial | Optional OCR path is present; visual-description generation needs a configured vision provider. |
| Audio transcription | Deferred by design | Add a transcription provider contract before enabling audio ingestion. |
| Spreadsheet extraction | Partial | Optional `xlsx` dynamic-import path is implemented; runtime package availability controls support. |
| QA generation and fine-tuning export UI | Deferred | NDJSON source-content export is implemented; generated datasets await quality controls. |

---

## 0. Ruthless Preamble

The BRAIN-MASTERPLAN.md describes a vision as if nothing exists. That is wrong. Agentis already has a sophisticated brain layer that most platforms will never build. The problem is not absence — it is **disconnection**: the right pieces exist in isolation and do not talk to each other. This document is a surgical plan to connect them, close the real gaps, and then build the three genuinely missing features that create irreplaceable value.

**The three real gaps that mattered at the pre-implementation baseline:**

1. **The KB dual-path problem.** `KnowledgeBaseService` (used for document uploads, the Knowledge tab, the `knowledge` workflow node) runs entirely lexical retrieval via `brainText.ts`. `KnowledgeStore` (used by agent intelligence, the brain graph, promotions) has full hybrid cosine + TF-IDF retrieval with the `EmbeddingProvider` interface. These are parallel systems. Users upload documents and wonder why retrieval is bad. The answer: they went through the wrong pipe.

2. **No multimodal ingestion.** The most valuable enterprise knowledge lives in images, PDFs with diagrams, audio recordings, and spreadsheets. Text extraction works. Everything else does not. This is a concrete capability gap that kills enterprise adoption.

3. **No personal brain scope.** The workspace brain is shared. The agent brain is per-run memory. There is no per-user persistent intelligence layer. This is the Obsidian opportunity — completely unbuilt.

Everything else in BRAIN-MASTERPLAN is either already built (embedding providers, compression, maintenance, graph viz, discourse injection) or is a quality improvement on a working path (auto-linker semantic upgrade, qualification pass, HyDE).

---

## 1. What Was Built At Audit Time — Baseline

This section records the pre-implementation audit. Do not read its gap statements as current delivery status; the implementation update and Appendix C supersede them.

### 1.1 Fully Operational

| Component | File | What it does |
|-----------|------|-------------|
| `KnowledgeStore` | `services/knowledgeStore.ts` | Hybrid TF-IDF + cosine retrieval. `search()` auto-selects path. `writeAsync()` for async embedding. Already supports `mode: 'auto' | 'lexical' | 'vector' | 'hybrid'`. |
| `EmbeddingProvider` interface | `services/embeddingProvider.ts` | Full interface. `HashingEmbeddingProvider` (512-dim, feature-hash fallback). `OpenAIEmbeddingProvider` (Nomic-embed-text default). `OpenAIEmbeddingProvider`. `selectEmbeddingProvider()` factory. `cosineSimilarity()`, `l2Normalize()` exported. |
| `SharedIntelligenceService` | `services/sharedIntelligence.ts` | Per-workspace embedding provider cache, `#resolveEmbeddingProvider()`, embedding-aware `promote()` with semantic deduplication, `embeddingStatus()`, `invalidateEmbeddingProvider()`. |
| `BrainCompressionService` | `services/brainCompressionService.ts` | 3-tier: T1 archive low-confidence stale, T2 cosine-cluster merge, T3 curator queue. |
| `BrainMaintenanceService` | `services/brainMaintenanceService.ts` | Weekly: stale/archive, link pruning, session atom expiry. |
| `BrainDiscourseService` | `services/brainDiscourseService.ts` | Context injection at turns 1 + N×cadence, peer profile facts, session-local atoms, discourse synthesis. |
| `AgentMemoryService` | `services/agentMemory.ts` | Per-agent persistent memory. `append()`, `search()` (lexical), `contextSection()` for dispatch injection. |
| `MemoryStore` | `services/memoryStore.ts` | Workspace memory (fact/preference/pattern/rule/lesson). Recall with trust × importance × recency scoring. Reinforcement. |
| `KnowledgeAutoLinker` | `services/knowledgeAutoLinker.ts` | Jaccard-based auto-linking on upload. `suggestLinks()` for UI. |
| Brain page UI | `web/src/pages/UnifiedBrainPage.tsx` | 3 tabs (Map / Knowledge / Insights). Real-time graph updates. Degraded-mode banner. Config drawer. |
| `BrainComposer` | `services/brainComposer.ts` | 4-layer composition (core/knowledge/memory/judgment) for the brain graph. |
| `EpisodicMemoryStore` | `services/episodicMemoryStore.ts` | Episode write/archive/recall. |
| `PeerProfileService` | `services/peerProfileService.ts` | Per-user peer card facts (INSTRUCTION, PREFERENCE, TRAIT, CONTEXT, BELIEF). |
| `SessionMomentService` | `services/sessionMomentService.ts` | Session-scoped atoms. Sweep-expired. |
| `CognitivePromotionQueueWorker` | `services/cognitivePromotionQueueWorker.js` | Async curator queue for brain tier-3 compression. |
| `IntelligencePromotion` | `services/intelligencePromotion.ts` | Pattern promotion from run outcomes. |
| `DatasetIngestion` | `services/datasetIngestion.ts` | Dataset feeding into knowledge clusters. |
| Dream Pass | `POST /v1/brain/dream-pass` | Triggered maintenance from Insights tab. |
| Degraded mode indicator | `BrainView`, `InsightsTab` | "Brain is running in keyword mode" banner with direct link to config. |

### 1.2 Original Broken / Disconnected Baseline

The table below captures the baseline that motivated this plan. Items addressed by the May 25 implementation are marked in the implementation update above and in Appendix C.

| Gap | Root cause | Impact |
|-----|-----------|--------|
| **KB documents use lexical-only retrieval** | `KnowledgeBaseService.search()` uses `brainText.scoreText()` (token overlap), not `KnowledgeStore`. Separate chunk table (`kbChunks`) with no embedding generation path. | HIGH — the primary user-facing upload flow has no semantic quality |
| **`kbChunks.embedding` column is never populated** | `persistDocument()` in `KnowledgeBaseService` inserts chunks without calling any embedding provider | HIGH — the column exists, the infrastructure exists, it is never called |
| **`knowledge` workflow node hits KB search, not KnowledgeStore** | `#executeKnowledge()` in `WorkflowEngine.ts` routes through `KnowledgeBaseService.search()` — lexical only | HIGH — agents using the `knowledge` node get lexical results even when semantic would work |
| **Auto-linker is Jaccard-only** | `knowledgeAutoLinker.ts` has `jaccard()` hardcoded — `cosineSimilarity` is never called | MEDIUM — graph edges have no semantic quality |
| **No multimodal ingestion** | Images, audio, video, spreadsheets not handled in `addDocumentFromBytes()` | HIGH — kills real-world content ingestion |
| **No personal brain scope** | No `user_notes` table, no `/v1/personal-brain` routes, no personal brain tab in UI | HIGH — Obsidian opportunity completely unbuilt |
| **No agent brain scope toggle** | Brain page is workspace-only. No per-agent graph view. | MEDIUM — agents have memory but no dedicated Brain page view |
| **No failure reflection pass** | `RUN_FAILED` fires but no service captures it and writes a `failure_lesson` memory | HIGH — Reflexion pattern unimplemented; agents don't improve from failures |
| **No LLM qualification at ingest** | Chunks arrive raw. No entity extraction, no importance score, no summarization. | MEDIUM — graph nodes are raw chunks, not structured knowledge |
| **No fine-tuning export** | No `/v1/brain/export` endpoint, no QA pair generation, no JSONL pipeline | LOW (future value) |

---

## 2. Research Foundation — 2025–2026 State of the Art

This section cites only what changes the architecture decisions. Skip old references already covered in BRAIN-MASTERPLAN.

### 2.1 Zep/Graphiti — Temporal Knowledge Graphs (Jan 2025, arXiv:2501.13956)

The key finding: **static chunk retrieval loses temporal context**. A fact that was true in January may be false in April. Flat cosine search cannot distinguish the two.

Graphiti's architecture:
- Entities, relationships, and episodes are all nodes with timestamps
- `invalidAt` / `validFrom` columns on facts — superseded facts are preserved but ranked lower
- Triple extraction at ingestion: (subject, predicate, object, timestamp)
- Result: 94.8% on DMR benchmark vs 93.4% MemGPT. 18.5% accuracy improvement on LongMemEval with 90% lower response latency.

**Agentis implication**: The `memoryEpisodes` table already has `updatedAt`. What is missing is **temporal edge metadata on `knowledgeLinks`** — a link should carry `validFrom` + `invalidAt` so the graph can represent that "tool X was the best option in Q1 2026 but was deprecated in Q2". The auto-linker should write this. The dream pass should update it.

**What to build**: Add `validFrom TEXT` + `invalidAt TEXT` to `knowledge_links`. Update `KnowledgeAutoLinker` to set `validFrom = createdAt`. Update dispute resolution to optionally set `invalidAt` on the losing atom's links. This is a schema migration + 3-file change.

### 2.2 Contextual Retrieval (Anthropic, 2024)

**The single highest-leverage retrieval improvement with minimal cost.** Before embedding a chunk, prepend a 1-2 sentence LLM-generated context:

```
CONTEXT: This chunk is from a document titled "{title}" about {document_summary}. 
The broader context is {surrounding_context}.

CHUNK TEXT: {raw_chunk}
```

Result: 49% reduction in retrieval failures. With reranking: 67% reduction. Cost: one cheap LLM call per chunk at ingest (not at query time).

**Agentis implication**: `KnowledgeBaseService.persistDocument()` should optionally call a fast LLM (gpt-4o-mini / claude-haiku) to generate a context prefix per chunk before embedding. This is the qualification pass made practical — no separate chunking run needed. The qualification IS the context generation.

**What to build**: `services/chunkContextualizer.ts` — optional async pass triggered after `persistDocument()`. Stores result in `kbChunks.metadata.contextPrefix`. Embedding is then `embed(contextPrefix + '\n\n' + chunkText)` instead of just `embed(chunkText)`.

### 2.3 A-MEM — Adaptive Memory Network (2025)

Rather than static memory storage, A-MEM treats memory as a **living network** where:
- New memories trigger review of existing related memories
- Highly connected memories get reinforced (confidence += delta)
- Isolated memories decay on schedule
- Contradictions are flagged automatically, not just co-observed

The interconnection formation is the key mechanism: "when X is created, retrieve the top-K similar existing memories and evaluate whether X extends, contradicts, or refines them — then write the appropriate link with a typed relation."

**Agentis implication**: The `KnowledgeAutoLinker` currently writes `co_observed` for anything above MIN_SIMILARITY. The typed relation mapping needs to be richer: `refines` (high similarity, different detail level), `contradicts` (high similarity but negation signals), `derived_from` (same document), `co_observed` (topically related but distinct). A fast LLM call can classify the relation for the top-1 match.

### 2.4 MemoryOS — Three-Tier Memory Scheduling (2025)

Inspired by OS process scheduling. The key insight: memory access follows a power-law distribution — a small number of memories get accessed constantly, most are rarely needed. Treating all memories equally wastes context budget.

Three tiers:
- **Hot buffer** (in-context): < 20 items, highest recency × frequency × importance score
- **Warm storage** (fast retrieval): < 500 items, moderate composite score
- **Cold archive** (compressed): everything else, retrievable on explicit query

Heat score:
```
heat = α × recency_decay + β × access_frequency + γ × importance
```

**Agentis implication**: The `BrainCompressionService` T1/T2/T3 tiers are structurally similar but use a different scoring function — only `confidence < threshold` gates T1, not a composite heat score. **Add `access_count INTEGER DEFAULT 0` and bump it on every retrieval.** Then T1 compression uses `heat < 0.2` rather than just `confidence < 0.15`. This makes the compression function match how memory actually works: frequently accessed low-confidence atoms stay live; rarely accessed high-confidence atoms eventually compress.

### 2.5 Self-RAG — Adaptive Retrieval (ICLR 2024, arXiv:2310.11511)

The key idea: retrieval should be **demand-driven**, not always-on. A query about what 2+2 equals does not need to search the KB. Over-retrieval dilutes precision.

For the `knowledge` workflow node in Agentis, the agent currently always retrieves. Self-RAG adds a retrieval gate: "Is retrieval needed for this query?" This can be implemented as a pre-retrieval classification (binary LLM call: yes/no) or by letting the node's `mode` field default to `'contextual'` which retrieves only if similarity exceeds a minimum threshold — which Agentis already partially implements via `mode: 'strict'`.

**Agentis implication**: The three retrieval modes (`contextual` / `strict` / `exploratory`) in `WorkflowEngine.ts` `#executeKnowledge()` already approximate this. The improvement is: when no result exceeds `minSimilarity`, return empty and let the agent decide rather than returning the top-K regardless.

### 2.6 GraphRAG — Community-Based Summarization (Microsoft, 2024–2025)

For large knowledge bases (> 1,000 documents), flat vector search loses multi-hop reasoning. GraphRAG's approach:
1. Extract entity-relationship triples from every chunk at index time
2. Cluster entities into communities (k-means or Leiden algorithm)
3. Generate a summary atom for each community
4. At query time, retrieve community summaries first, then drill into relevant communities

**Agentis implication**: The `BrainComposer` already builds a layered graph. The gap is **entity extraction at ingest** (not done for KB documents) and **community summary atoms** (not generated). This is the Phase 2 qualification work — entity extraction feeds community clustering feeds summary atoms. The graph then has semantic structure rather than just co-occurrence edges.

---

## 3. Architecture: The Unified Intelligence Plane

The core structural problem is two parallel data paths that never merge:

```
Current state:
                                                   
User uploads document
  → KnowledgeBaseService.persistDocument()
  → kbChunks table (lexical only, embedding=NULL)
  → KnowledgeBaseService.search() [brainText.scoreText]
  → knowledge workflow node output

Agent runs task
  → SharedIntelligenceService.promote()
  → memoryEpisodes table (embedding via #resolveEmbeddingProvider)
  → KnowledgeStore.search() [hybrid TF-IDF + cosine]
  → agent context injection

These two paths NEVER intersect.
```

```
Target state:

User uploads document
  → KnowledgeBaseService.persistDocument()
  → generateEmbedding(chunk, workspaceProvider)  ← THE BRIDGE
  → kbChunks table (embedding populated)
  → KnowledgeStore.search() or hybrid fallback  ← UNIFIED RETRIEVAL
  → knowledge workflow node output  ← SAME QUALITY

Agent runs task
  → SharedIntelligenceService.promote()
  → memoryEpisodes table (same provider)
  → KnowledgeStore.search()  ← SAME ENGINE
  → agent context injection
```

**The bridge is one function call added to `persistDocument()`.** Everything else follows from that.

---

## 4. Phased Implementation Plan

The phase definitions below preserve the original execution proposal. For delivered behavior and deliberate revisions, use **Implementation Update - May 25, 2026** above and the complete implementation log at the end of this document.

### Phase 0 — The Bridge (1–2 days) — Ship First, Highest ROI

These are the fixes that unlock every other improvement.

#### P0-1: Embed KB chunks at ingest time

**File**: `apps/api/src/services/knowledgeBase.ts`

In `persistDocument()`, after inserting each chunk row, resolve the workspace embedding provider and populate the `embedding` column:

```typescript
// In persistDocument(), after inserting the chunk:
const provider = this.getEmbeddingProvider(args.workspaceId);
if (provider) {
  const raw = provider.embed(chunk);
  const vec = raw instanceof Promise ? null : raw; // sync providers only in hot path
  if (vec) {
    this.db.update(schema.kbChunks)
      .set({ embedding: vec as unknown as object })
      .where(eq(schema.kbChunks.id, chunkId))
      .run();
  }
}
```

For async providers (OpenAI), queue an async embedding job after the synchronous insert.

**Add `setEmbeddingProvider()` method** to `KnowledgeBaseService` so `bootstrap.ts` can wire the workspace provider (same pattern as `setAutoLinker()`).

#### P0-2: Switch KB search to hybrid

**File**: `apps/api/src/services/knowledgeBase.ts`

Replace `KnowledgeBaseService.search()` body with a call to `KnowledgeStore.search()` when the workspace has an embedding provider configured. Fall back to the current `brainText.scoreText()` only when `kbChunks.embedding IS NULL` for the candidate set.

The transition is safe because `KnowledgeStore` supports `mode: 'auto'` — it detects whether embeddings exist and selects the best available path.

#### P0-3: Fix the `knowledge` workflow node path

**File**: `apps/api/src/engine/WorkflowEngine.ts`, `#executeKnowledge()`

Currently hits `KnowledgeBaseService.search()`. After P0-2, this is fixed for free — the service now uses hybrid retrieval.

#### P0-4: Semantic auto-linking

**File**: `apps/api/src/services/knowledgeAutoLinker.ts`

Add a cosine-similarity path alongside the Jaccard path. When the workspace embedding provider is available and the source chunk has an embedding, use cosine similarity for candidate scoring. Jaccard remains the fallback.

The `SharedIntelligenceService` already exports `cosineSimilarity`. Wire it.

#### P0-5: KB embedding backfill on provider configuration

**File**: new `apps/api/src/services/embeddingBackfill.ts`

When a workspace changes from `hashing` to a real provider (triggered by `ConfigDrawer`), enqueue a background job via `CognitivePromotionQueueWorker` that:
1. Queries all `kbChunks WHERE workspaceId = ? AND (embedding IS NULL OR ...)`
2. Generates embeddings in batches of 50
3. Updates each row

Emit `BRAIN_EMBEDDING_MIGRATION_STARTED` on start, `BRAIN_EMBEDDING_MIGRATION_COMPLETED` on finish (both events already exist in `REALTIME_EVENTS`).

---

### Phase 1 — Retrieval Quality (3–5 days)

#### P1-1: Contextual chunk generation at ingest

**File**: new `apps/api/src/services/chunkContextualizer.ts`

Optional async pass triggered after `persistDocument()` when an LLM is configured:

```typescript
interface ChunkContextResult {
  chunkId: string;
  contextPrefix: string;  // 1-2 sentence context
  entities: string[];     // named entities extracted
  importanceScore: number; // 0-1, LLM-rated
  keyFacts: string[];     // discrete extractable facts
}
```

Store results in `kbChunks.metadata` JSON column (already TEXT, already JSON-stored).

The contextual embedding is then: `embed(contextPrefix + '\n\n' + chunkContent)` — this alone delivers the Anthropic-documented 49% retrieval improvement.

Schema addition to `kbChunks`: none needed — store in existing `metadata` JSON column.

#### P1-2: Recency × Importance × Relevance scoring

**File**: `apps/api/src/services/knowledgeBase.ts` (KB search path)

After retrieval, re-score results with the composite function from Generative Agents (Park et al. 2023):

```
final_score = 0.65 × cosine_similarity
            + 0.20 × importance_score        // from metadata.importanceScore, default 0.5
            + 0.15 × recency_decay           // exp(-λ × days_since_created), λ = 0.007
```

This is a post-retrieval re-ranking. Cost: O(K) arithmetic on the top-K results after vector search. Zero additional LLM calls.

#### P1-3: HyDE query expansion for exploratory mode (superseded May 26, 2026)

**Superseded decision**: Do not implement the ungrounded HyDE flow described below. The delivered behavior is initial corpus retrieval followed by optional grounded multi-query expansion and RRF in `exploratory` mode only. The original text is retained for audit context.

**File**: `apps/api/src/services/knowledgeBase.ts`

When retrieval `mode = 'exploratory'` and an LLM is available, apply HyDE (Hypothetical Document Embedding, Gao et al. 2022):
1. Ask LLM: "Write a short paragraph that would answer: {query}" — one cheap LLM call
2. Embed the hypothetical answer
3. Use that embedding for retrieval instead of the raw query embedding

Gate this behind the `mode: 'exploratory'` flag so it does not add latency to `strict` or `contextual` modes.

#### P1-4: Access frequency tracking

**File**: `packages/db` schema migration

Add to `kbChunks`:
```sql
ALTER TABLE kb_chunks ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_chunks ADD COLUMN last_accessed_at TEXT;
```

Increment `access_count` on every retrieval hit. Feed into `BrainCompressionService` heat score (see §2.4).

---

### Phase 2 — Multimodal Ingestion (1 week)

This is the capability gap that most differentiates Agentis from competitors. Every component needed is open-source, installable as optional dynamic imports (same pattern as `isolated-vm`, `dockerode`).

#### P2-1: Image ingestion

**Pipeline**:
```
Image upload (PNG, JPG, WEBP, GIF)
  → OCR extraction (tesseract.js — pure JS, no native deps)
  → Visual description (GPT-4V if configured)
  → Combined text: "[IMAGE] {ocr_text} [DESCRIPTION] {llm_description}"
  → Standard chunk + embed pipeline (existing persistDocument)
```

**Schema additions to `kbChunks`** (via migration):
```sql
ALTER TABLE kb_chunks ADD COLUMN source_image_url TEXT;  -- reference to stored image
ALTER TABLE kb_chunks ADD COLUMN ocr_text TEXT;           -- raw OCR output
ALTER TABLE kb_chunks ADD COLUMN visual_description TEXT; -- LLM image description
```

**Implementation**: `apps/api/src/services/imageIngestion.ts`

Dynamic import pattern:
```typescript
async function loadTesseract() {
  try {
    return await import('tesseract.js');
  } catch {
    return null;
  }
}
```

Fall back gracefully: if tesseract.js is not installed, extract only the filename as content + flag `status: 'text_only'`.

**UI change**: `WorkspaceDocDropZone` — accept `image/*` MIME types.

#### P2-2: Audio ingestion

**Pipeline**:
```
Audio upload (MP3, M4A, WAV, OGG, MP4-audio)
  → Whisper transcription (whisper.cpp via Node.js binding, or OpenAI Whisper API)
  → Transcript segmented into 240-token chunks
  → Standard chunk + embed pipeline
  → Metadata: duration, speaker_count (if diarization available), source_audio_url
```

**Implementation**: `apps/api/src/services/audioIngestion.ts`

Two paths:
- **Local** (free, private): dynamic import `@xenova/transformers` Whisper model (runs in Node.js with no Python)
- **API** (fast, costs money): `OpenAI().audio.transcriptions.create()` when `openai` adapter is configured

Schema additions to `kbChunks`:
```sql
ALTER TABLE kb_chunks ADD COLUMN audio_transcript TEXT;   -- full transcript text
ALTER TABLE kb_chunks ADD COLUMN audio_duration_secs INTEGER;
```

#### P2-3: Spreadsheet/CSV ingestion

**Pipeline**:
```
CSV/XLSX upload
  → Column schema description: "Table with columns: {col1 (type)}, {col2 (type)}, ..."
  → Row serialization: each row → "{col1}: {val1} | {col2}: {val2} | ..."
  → Batch rows into 240-token chunks
  → Standard pipeline
```

**Implementation**: `apps/api/src/services/spreadsheetIngestion.ts`

Use `xlsx` package (already likely available or installable with dynamic import). No LLM calls needed — row serialization is deterministic.

#### P2-4: Upload UI multimodal support

**File**: `apps/web/src/components/knowledge/WorkspaceDocDropZone.tsx`

Update accepted MIME types and show type-specific badges (image icon, audio waveform icon, table icon) in the document list after upload.

---

### Phase 3 — Temporal Graph Quality (3–5 days)

#### P3-1: Temporal edges on knowledgeLinks

**Migration**: Add `valid_from TEXT` + `invalid_at TEXT` to `knowledge_links` table.

**KnowledgeAutoLinker**: Set `validFrom = new Date().toISOString()` on every new link.

**Dispute resolution**: When an atom is resolved as "superseded", set `invalidAt` on its outgoing links.

**Retrieval impact**: `SharedIntelligenceService.searchAtoms()` optionally filters `WHERE invalid_at IS NULL` to return only currently valid knowledge.

#### P3-2: Typed relation classification

**Current**: `KnowledgeAutoLinker` writes only `co_observed` or `derived_from`.

**Target**: For the top-1 similarity match, run a fast LLM classification:

```typescript
type AtomRelation = 
  | 'co_observed'    // topically related
  | 'refines'        // new atom adds detail/nuance to existing
  | 'contradicts'    // new atom asserts something incompatible
  | 'derived_from'   // same parent document
  | 'supersedes';    // new atom replaces existing
```

One LLM call per new atom (only for the top-1 match). Gate behind `BRAIN_TYPED_RELATIONS=true` env flag so it can be disabled on low-budget installs.

#### P3-3: Entity extraction → structured graph nodes

For documents passing through the contextualizer (P1-1), entities extracted become **graph atoms with `kind: 'entity'`**:
- If an entity matches an existing `memoryEpisodes.title` (cosine > 0.85), reinforce it
- If it is new and `importanceScore > 0.6`, create a new episode with `source: 'extracted'`

This upgrades the graph from "chunks linked to chunks" to "concepts linked to concepts with provenance tracing back to source chunks."

---

### Phase 4 — Failure Reflection (2–3 days)

This is the Reflexion pattern (Shinn et al. 2023) and it is the core of agent self-improvement.

#### P4-1: Failure reflection service

**File**: new `apps/api/src/services/failureReflectionService.ts`

```typescript
export class FailureReflectionService {
  async reflectOnFailure(args: {
    workspaceId: string;
    agentId: string;
    runId: string;
    errorMessage: string;
    ledgerEvents: LedgerEvent[];
  }): Promise<void>;
}
```

Logic:
1. Summarize the failed run from ledger events (tool calls, inputs, last output before failure)
2. Ask LLM: "This agent run failed with error: {error}. Here is what happened: {summary}. Write one concise lesson for the agent about what to avoid next time."
3. Write to `AgentMemoryService.append()` with `section: 'failure_lessons'` and `tags: ['failure', 'reflexion']`

#### P4-2: Wire to RUN_FAILED event

**File**: `apps/api/src/engine/WorkflowEngine.ts`

In `#transitionRunStatus()` when transitioning to `FAILED`, after emitting `RUN_FAILED`:
```typescript
if (this.deps.failureReflection) {
  const ledgerEvents = await this.deps.ledger.listForRun(runId);
  void this.deps.failureReflection.reflectOnFailure({
    workspaceId, agentId: primaryAgentId, runId, errorMessage, ledgerEvents,
  }).catch((err) => this.#log.warn('failure_reflection.skipped', { err }));
}
```

The reflection is async, fire-and-forget so it never blocks the run cleanup path.

#### P4-3: Inject failure lessons into agent dispatch context

`AgentMemoryService.contextSection()` already renders the top-8 memories. The failure lesson appears there on the next dispatch. No additional work needed.

---

### Phase 5 — Personal Brain (1–2 weeks)

This is the highest-value unbuilt feature. It is also the most self-contained: it introduces new tables, new routes, and a new tab, but touches nothing in the existing workspace brain path.

#### P5-1: Schema

New migration file in `packages/db/src/migrations/`:

```sql
-- Per-user persistent notes
CREATE TABLE IF NOT EXISTS user_notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  content TEXT NOT NULL,
  note_type TEXT NOT NULL DEFAULT 'note',  -- 'insight'|'reference'|'preference'|'goal'|'question'|'agent_memo'
  embedding TEXT,                           -- JSON float[] from workspace provider
  tags TEXT NOT NULL DEFAULT '[]',          -- JSON string[]
  source TEXT NOT NULL DEFAULT 'user',      -- 'user_typed'|'agent_promoted'|'imported'
  agent_id TEXT REFERENCES agents(id),      -- set if agent wrote this
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,   -- 'user_note'|'agent_memory'|'kb_chunk'
  target_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  relation TEXT NOT NULL,      -- 'inspired_by'|'contradicts'|'extends'|'related'
  confidence REAL NOT NULL DEFAULT 0.6,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_brain_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL DEFAULT 'read',  -- 'read'|'read_write'
  created_at TEXT NOT NULL,
  UNIQUE(user_id, agent_id)
);
```

#### P5-2: API routes

**File**: new `apps/api/src/routes/personalBrain.ts`

```
GET    /v1/personal-brain/notes           — list user's notes (auth required)
POST   /v1/personal-brain/notes           — create note
PATCH  /v1/personal-brain/notes/:id       — update note
DELETE /v1/personal-brain/notes/:id       — delete note
POST   /v1/personal-brain/search          — semantic search across user's notes
GET    /v1/personal-brain/grants          — list agent access grants
PUT    /v1/personal-brain/grants/:agentId — create or update grant
DELETE /v1/personal-brain/grants/:agentId — revoke grant
```

All endpoints are scoped to `req.user.id` from JWT. No workspace scoping. Personal brain is cross-workspace.

Security: personal notes are NEVER returned in workspace-level exports or knowledge base queries unless the user has explicitly granted an agent read access AND that agent is running in the user's workspace.

#### P5-3: Personal brain service

**File**: new `apps/api/src/services/personalBrainService.ts`

Responsibilities:
- `write(userId, note)` — embed + insert
- `search(userId, query, limit)` — cosine search against user's note embeddings
- `contextForAgent(userId, agentId, query)` — checks grant, returns relevant notes as context string
- `suggestLinks(userId, noteId)` — find related notes for the UI

#### P5-4: Agent context injection

**File**: `apps/api/src/engine/WorkflowEngine.ts`, `#dispatchAgentTask()`

After building the playbook context, check if any `personal_brain_grants` exist for the running agent and the workflow owner. If a `read` or `read_write` grant exists, inject:

```
<personal_context>
Notes from {user.name}'s personal brain relevant to this task:
- {note.content} ({note.note_type}, {note.created_at})
...
</personal_context>
```

#### P5-5: Personal brain UI

The Brain page scope toggle:

```
[Workspace ▼]
  ├─ Workspace Brain
  ├─ Personal Brain
  └─ Agent Brain ▶ [agent list]
```

The personal brain tab shows:
- Same force-directed graph layout (BrainStage is reusable)
- Note list with quick-capture composer
- "Which agents can see this?" settings drawer

The agent brain tab shows the `agent_memories` table for the selected agent rendered through the existing graph adapter.

---

### Phase 6 — Fine-Tuning Export (removed from delivery May 26, 2026)

**Removed decision**: The generated QA/export proposal below is retained as rejected history only. Its reserved storage and Brain export route were deleted from implementation.

This is the platform endgame. The brain accumulates structured, high-quality, semantically linked knowledge. That data has direct monetary value as fine-tuning training data.

#### P6-1: QA pair auto-generation

**File**: new `apps/api/src/services/qaPairGenerator.ts`

Nightly job for all chunks with `metadata.importanceScore > 0.6`:
1. Ask LLM: "Generate 3 question-answer pairs from this content: {chunk}"
2. Store in new `kb_qa_pairs` table:
   ```sql
   CREATE TABLE kb_qa_pairs (
     id TEXT PRIMARY KEY,
     chunk_id TEXT NOT NULL REFERENCES kb_chunks(id) ON DELETE CASCADE,
     workspace_id TEXT NOT NULL,
     question TEXT NOT NULL,
     answer TEXT NOT NULL,
     model TEXT,        -- which model generated this
     created_at TEXT NOT NULL
   );
   ```

#### P6-2: Export API

**File**: `apps/api/src/routes/brain.ts` — add `POST /v1/brain/export`

Request body:
```json
{
  "format": "openai" | "huggingface" | "axolotl",
  "include": ["qa_pairs", "success_trajectories", "failure_lessons", "knowledge_chunks"],
  "minImportance": 0.5
}
```

Response: streaming JSONL download (`Content-Type: application/x-ndjson`).

**OpenAI format** (instruction fine-tuning):
```json
{"messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "{question}"}, {"role": "assistant", "content": "{answer}"}]}
```

**HuggingFace format** (Parquet via Arrow):
- Requires `apache-arrow` — dynamic import, optional

**Success trajectory export**: ledger events from `COMPLETED` runs packaged as preference data pairs.

#### P6-3: Export UI

A simple export section in `InsightsTab`:
- "Export for fine-tuning" button
- Format selector (OpenAI / HuggingFace / Axolotl)
- Preview count: "Estimated {N} training pairs"
- Download triggers the streaming endpoint

---

## 5. Brain Page UI — Scope Toggle Design

The current `UnifiedBrainPage` has a 3-tab layout (Map / Knowledge / Insights). The scope selector lives in the header:

```
┌─────────────────────────────────────────────────────────────────┐
│ ⚡ The Brain  [⚙]                     [Workspace Brain ▼]        │
│                                        ├─ Workspace Brain        │
│ Map | Knowledge | Insights             ├─ Personal Brain         │
│                                        └─ Agent Brain ▶          │
│                                             Agent Alpha           │
│                                             Agent Beta            │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation notes**:
- The scope selector is a `<select>` or custom dropdown in the header right
- `scope: 'workspace' | 'personal' | { agentId: string }` state drives which data is fetched
- The graph fetch (`/v1/brain/graph`) accepts `?scope=workspace|personal|agent&agentId=xxx`
- The knowledge and insights tabs either hide (agent scope) or show filtered data
- `BrainStage` is already reusable — the graph data source changes, the renderer does not

---

## 6. Implementation Priority Matrix

This is the ruthless cut. Not everything in this document is equal priority.

| # | Task | Value | Effort | Build order |
|---|------|-------|--------|-------------|
| P0-1 | Embed KB chunks at ingest | Critical | 2h | Week 1 Day 1 |
| P0-2 | Hybrid KB search | Critical | 3h | Week 1 Day 1 |
| P0-3 | Fix knowledge node path | Critical | 1h | Week 1 Day 1 |
| P0-4 | Semantic auto-linking | High | 2h | Week 1 Day 2 |
| P0-5 | Embedding backfill job | High | 4h | Week 1 Day 2 |
| P1-1 | Contextual chunk generation | Very High | 6h | Week 1 Day 3–4 |
| P1-2 | Recency/Importance scoring | High | 3h | Week 1 Day 4 |
| P1-3 | HyDE query expansion | Medium | 4h | Week 2 |
| P1-4 | Access frequency tracking | Medium | 2h | Week 2 |
| P2-1 | Image ingestion | Very High | 8h | Week 2 |
| P2-2 | Audio ingestion | High | 8h | Week 2–3 |
| P2-3 | Spreadsheet ingestion | High | 4h | Week 3 |
| P2-4 | Upload UI multimodal | High | 4h | Week 3 |
| P3-1 | Temporal edges | Medium | 3h | Week 3 |
| P3-2 | Typed relation classification | Medium | 4h | Week 3 |
| P3-3 | Entity extraction → atoms | Medium | 6h | Week 4 |
| P4-1 | Failure reflection service | Very High | 6h | Week 4 |
| P4-2 | Wire to RUN_FAILED | Very High | 2h | Week 4 |
| P5-1 | Personal brain schema | High | 3h | Week 5 |
| P5-2 | Personal brain routes | High | 8h | Week 5 |
| P5-3 | Personal brain service | High | 6h | Week 5 |
| P5-4 | Agent context injection | High | 4h | Week 5–6 |
| P5-5 | Personal brain UI | High | 12h | Week 6 |
| P6-1 | QA pair generation | Medium | 6h | Week 7 |
| P6-2 | Export API | Medium | 6h | Week 7 |
| P6-3 | Export UI | Low | 3h | Week 7 |

---

## 7. What NOT to Build (Yet)

These were in BRAIN-MASTERPLAN and are being explicitly deferred:

| Item | Why deferred |
|------|-------------|
| Web connectors (Google Drive, Notion, GitHub sync) | Requires OAuth flows, webhook infra, incremental sync. Phase 2 of multimodal — not blocking. |
| ColBERT / late-interaction embeddings | Requires token-level embedding storage (N × dim per chunk vs 1 × dim). Storage bloat for SQLite. Revisit when pgvector path is opened. |
| Cross-encoder re-ranking | Requires local cross-encoder model or additional API call on every query. HyDE + contextual retrieval covers most of the quality gap at lower cost. |
| Pattern detection from ledger events | P4 (failure reflection) is higher priority for the same "agent self-improvement" goal. Pattern detection is an enhancement, not the core loop. |
| MemTree navigation | Only matters when KB > 1,000 documents. Not the current scale bottleneck. Revisit in Phase 3+. |
| Video ingestion | Requires frame sampling + CLIP, heavy compute. Audio ingestion is higher priority and simpler. |
| Fine-tuning export (P6) | Build the data first (P0–P5), then export it. Don't export bad data. |

---

## 8. Success Metrics

These are measurable. Check them weekly.

| Metric | Baseline (today) | Target after Phase 0 | How to measure |
|--------|-----------------|---------------------|----------------|
| KB chunks with embeddings | ~0% | > 95% | `SELECT count(*) FROM kb_chunks WHERE embedding IS NULL AND workspace_id = ?` |
| Average KB search cosine score | N/A (lexical) | > 0.65 on relevant queries | Log score in `kb_search_log` new table |
| Failure lessons written | 0 | > 0 per week per active workspace | `SELECT count(*) FROM agent_memories WHERE section = 'failure_lessons'` |
| Personal brain notes | 0 | > 10 per active user in first 30 days | `SELECT count(*) FROM user_notes WHERE user_id = ?` |
| Multimodal document share | 0% | > 15% of uploads are non-text | `SELECT count(*) FROM kb_documents WHERE mime_type NOT LIKE 'text/%'` |
| Brain health score | Degraded on fresh install | > 60 within 24h of embedding setup | `GET /v1/brain/health` → `healthScore` |
| Agent improvement signal | 0 | Failure lessons retrieved > 0 in subsequent runs | Count `contextSection` non-empty outputs with `failure_lessons` tag |

---

## 9. Technical Constraints That Don't Change

- **SQLite stays the default storage.** `sqlite-vec` extension for ANN search. Embeddings stored as JSON float arrays in TEXT column. Migration to pgvector is a retriever swap, not a schema rewrite.
- **Native dependencies stay optional / dynamic-imported.** `tesseract.js`, `@xenova/transformers`, `xlsx` all use the established dynamic-import pattern so a missing package degrades gracefully.
- **Async qualification is always fire-and-forget.** The synchronous write path (document upload) must never block on LLM calls. Qualification runs async after the insert.
- **Embedding backfill is a background job, never a startup blocker.** It runs via `CognitivePromotionQueueWorker`, not on the hot path.
- **HashingEmbeddingProvider remains the zero-config fallback.** It is explicitly labeled "keyword mode" in the UI. It is not removed, but it is never the default when a real provider is configured.

---

## Appendix A — File Map for Changes

| File to modify | Change |
|---------------|--------|
| `apps/api/src/services/knowledgeBase.ts` | P0-1, P0-2: embed on write, switch search to hybrid |
| `apps/api/src/services/knowledgeAutoLinker.ts` | P0-4: cosine path when embeddings available |
| `apps/api/src/engine/WorkflowEngine.ts` | P0-3: knowledge node uses hybrid search; P4-2: failure reflection wire |
| `packages/db` (new migration) | P1-4, P3-1, P5-1, P6-1: schema additions |

| File to create | Purpose |
|---------------|---------|
| `apps/api/src/services/embeddingBackfill.ts` | P0-5: background backfill job |
| `apps/api/src/services/chunkContextualizer.ts` | P1-1: contextual embedding generation |
| `apps/api/src/services/imageIngestion.ts` | P2-1: image → OCR + description → chunks |
| `apps/api/src/services/audioIngestion.ts` | P2-2: audio → transcript → chunks |
| `apps/api/src/services/spreadsheetIngestion.ts` | P2-3: CSV/XLSX → row chunks |
| `apps/api/src/services/failureReflectionService.ts` | P4-1: Reflexion pattern service |
| `apps/api/src/services/personalBrainService.ts` | P5-3: personal notes CRUD + semantic search |
| `apps/api/src/routes/personalBrain.ts` | P5-2: personal brain API endpoints |
| `apps/api/src/services/qaPairGenerator.ts` | P6-1: nightly QA pair generation |
| `apps/web/src/components/brain/ScopeSelector.tsx` | P5-5: workspace/personal/agent scope toggle |
| `apps/web/src/components/brain/PersonalBrainTab.tsx` | P5-5: personal brain graph + notes UI |

---

## Appendix B — Research Bibliography

Papers directly informing architectural decisions above:

1. **Zep/Graphiti** — Rasmussen et al. "Zep: A Temporal Knowledge Graph Architecture for Agent Memory." arXiv:2501.13956 (Jan 2025). → Section 3.1 temporal edges
2. **Contextual Retrieval** — Anthropic blog post (2024). → P1-1 chunk contextualization
3. **Generative Agents** — Park et al. arXiv:2304.03442 (2023). → P1-2 recency × importance scoring
4. **Reflexion** — Shinn et al. arXiv:2303.11366 (2023). → Phase 4 failure reflection
5. **Self-RAG** — Asai et al. arXiv:2310.11511 (ICLR 2024). → knowledge node demand-gating
6. **GraphRAG** — Edge et al. Microsoft Research (2024). → P3-3 entity extraction → community atoms
7. **A-MEM** — Xu et al. arXiv:2502.12110 (2025). → P1-4 access frequency in compression scoring
8. **MemoryOS** — Du et al. arXiv:2506.xxxxx (2025). → three-tier heat score model
9. **HyDE** — Gao et al. arXiv:2212.10496 (2022). → P1-3 hypothetical document expansion
10. **RAG Best Practices** — Wang et al. arXiv:2407.01219 (2024). → chunk sizing, overlap parameters

---

## Appendix C - Complete Implementation Log

**Implementation date**: May 25, 2026  
**Implementation posture**: The vision was implemented where the current architecture supported correct, testable behavior. Proposed mechanisms that would duplicate authority, leak private data, or claim unconfigured model capability were replaced with safer equivalents.

### C.1 Architecture Validation Log

| Decision | Original direction | Implemented decision | Outcome |
|----------|--------------------|----------------------|---------|
| Uploaded knowledge ownership | Make the KB path use `KnowledgeStore` as the shared retriever. | Keep `kb_chunks` authoritative and implement native hybrid retrieval in `KnowledgeBaseService`. | Uploaded documents retain their document lifecycle while receiving embedding-quality retrieval. |
| Provider sharing | New embedding logic for KB chunks. | Wire `KnowledgeBaseService` to `SharedIntelligenceService.embeddingProvider(workspaceId)`. | KB chunks and promoted atoms use the selected workspace provider without duplicating configuration. |
| Retrieval result gating | Return best top-K after search. | Require a meaningful retrieval signal before importance/recency reranking can include a chunk. | Recent unrelated chunks do not enter agent context. |
| Context enrichment | Require LLM-generated chunk contexts. | Persist deterministic prefixes, entity hints, ingestion type, and heuristic importance now. | Zero-config ingestion improves metadata and embeddings; richer enrichment remains safely optional. |
| Semantic link generation | Replace lexical auto-linking with provider semantic scoring. | Preserve synchronous structural/keyword linking and add asynchronous semantic refinement for remote providers. | Upload completion does not depend on remote calls; configured semantic quality improves later. |
| Multimodal behavior | Fall back to partial indexing when optional packages are absent. | Expose optional image/spreadsheet extractors and return an explicit configuration error when missing; refuse unconfigured audio transcription. | The UI does not claim that unprocessed binaries are indexed knowledge. |
| Personal intelligence | Add a user scope beside workspace data. | Implement a separate user-owned store with explicit grant checks before agent prompt injection. | Private notes are isolated from workspace retrieval and exports. |
| Fine-tuning data | Generate QA pairs automatically. | Add source-content NDJSON export, but defer generated QA pairs until a generation/evaluation contract exists. | Export is useful without contaminating future training data. |

### C.2 Database Changes

Implemented in `packages/db/src/sqlite/schema.ts` and migration version `43` in `packages/db/src/sqlite/migrations.ts`.

| Database object | Change | Purpose |
|-----------------|--------|---------|
| `kb_chunks.embedding` | Added persisted embedding JSON vector. | Native hybrid search for uploaded documents. |
| `kb_chunks.access_count` | Added integer counter with default `0`. | Record retrieval frequency for future heat scoring. |
| `kb_chunks.last_accessed_at` | Added timestamp. | Record retrieval recency. |
| `knowledge_links.valid_from` | Added timestamp. | Mark the start of relationship validity. |
| `knowledge_links.invalid_at` | Added timestamp. | Preserve historical relationships while excluding superseded links from the current graph. |
| `user_notes` | Added table. | Private user-owned Personal Brain notes and embeddings. |
| `user_links` | Added table. | Reserved relationship storage for Personal Brain expansion. |
| `personal_brain_grants` | Added table with unique user/agent grant constraint in migration SQL. | Explicit authorization for agent access to personal notes. |
| `kb_qa_pairs` | Added table. | Reserved storage for future validated QA generation. No unvalidated generation is currently performed. |

Migration correction made during implementation:

- New `kb_chunks` columns are introduced by migration `43`, not duplicated in the initial embedded schema, preventing duplicate-column failures on fresh databases that execute the migration chain.

### C.3 Knowledge Retrieval And Ingestion Log

Implemented primarily in `apps/api/src/services/knowledgeBase.ts`.

1. Added `setEmbeddingProviderResolver()` so the KB service uses the configured workspace provider.
2. Embedded every new KB chunk at ingest. Synchronous hashing embeddings are persisted immediately; asynchronous provider vectors are persisted after completion without blocking the insert.
3. Included deterministic context text in embedding input and stored metadata fields:
   - `contextPrefix`
   - `importanceScore`
   - `entities`
   - `ingestionType`
4. Converted `search()` to asynchronous hybrid retrieval using lexical overlap plus embedding cosine similarity.
5. Added post-retrieval ranking with relevance, importance, and recency.
6. Prevented unrelated chunks from being surfaced solely through recency or default importance.
7. Added retrieval modes for callers: `contextual`, `strict`, and `exploratory` contract support.
8. Incremented `access_count` and populated `last_accessed_at` on returned KB hits.
9. Added `backfillEmbeddings(workspaceId)` to re-embed existing KB content.
10. Added optional dependency-aware image OCR and spreadsheet extraction paths.
11. Added explicit failure behavior for audio ingestion when no transcription provider exists.

Async consumer updates:

| Consumer | Change |
|----------|--------|
| `apps/api/src/routes/knowledgeBases.ts` | Awaits hybrid KB search. |
| `apps/api/src/engine/WorkflowEngine.ts` | Knowledge workflow nodes await and merge hybrid results. |
| `apps/api/src/services/workspaceIntelligence.ts` | Agent context retrieval awaits hybrid KB hits. |
| `apps/api/src/services/agentToolRuntime.ts` | Agent knowledge tools await hybrid KB hits. |
| `apps/api/src/services/creationPipeline.ts` | Creation inventory search awaits hybrid KB hits. |

### C.4 Embedding Provider Migration And Linking Log

| File | Implemented behavior |
|------|----------------------|
| `apps/api/src/services/embeddingBackfill.ts` | Runs KB embedding backfill and records completion in logs. |
| `apps/api/src/routes/workspaceIntelligence.ts` | Counts active memory atoms plus KB chunks when requiring provider migration confirmation; queues both backfill paths. |
| `apps/api/src/services/sharedIntelligence.ts` | Exposes the workspace provider, invalidates provider cache on updates, emits `BRAIN_EMBEDDING_MIGRATION_STARTED` and existing completion signal. |
| `apps/api/src/services/knowledgeAutoLinker.ts` | Uses local hashing cosine when immediately available and schedules semantic refinement for asynchronous configured providers. |
| `apps/api/src/bootstrap.ts` | Wires provider sharing, backfill service, and semantic linker dependencies. |

### C.5 Temporal Graph Log

Implemented in `apps/api/src/services/sharedIntelligence.ts`:

1. New knowledge links receive `validFrom` at creation and begin with `invalidAt = null`.
2. Current graph reads exclude invalidated links.
3. Existing invalidated links are not reinforced as current relationships.
4. Resolved contradictions are marked resolved and invalidated.
5. When one disputed atom loses, its involved current links are invalidated.
6. When two disputed atoms merge, relationships attached to archived originals are invalidated.
7. Historical rows remain stored for provenance and future audit views.

### C.6 Failure Reflection Log

Implemented in `apps/api/src/services/failureReflection.ts` and `apps/api/src/engine/WorkflowEngine.ts`.

1. After an agent task failure exhausts self-healing, the responsible agent receives a stored lesson.
2. The lesson captures the failed task intent, compact error, and a cautious retry instruction.
3. Lessons are stored in `agent_memories` under `Failure lessons` with `failure`, `reflection`, and run tags.
4. Existing `AgentMemoryService.contextSection()` naturally makes those lessons available in later dispatches.
5. The implementation is deterministic and does not claim model-generated reflection when no evaluator model contract is configured.

### C.7 Personal And Agent Brain Log

Backend:

| File | Implemented behavior |
|------|----------------------|
| `apps/api/src/services/personalBrain.ts` | Note CRUD, embedding-based search, grants, revoke, and context retrieval for granted agents. |
| `apps/api/src/routes/personalBrain.ts` | Authenticated `/v1/personal-brain/notes`, `/search`, and `/grants` endpoints scoped to the authenticated user. |
| `apps/api/src/engine/WorkflowEngine.ts` | Injects relevant `<personal_brain>` excerpts only when a grant exists for the dispatched agent. |
| `apps/api/src/bootstrap.ts` | Creates and mounts the Personal Brain service/routes. |

Frontend:

| File | Implemented behavior |
|------|----------------------|
| `apps/web/src/pages/UnifiedBrainPage.tsx` | Header scope selector for `workspace`, `agent`, and `personal`. |
| `apps/web/src/components/brain/PersonalBrainPanel.tsx` | Quick note capture, private-note browsing/search, deletion, and explicit read-access grants/revocation. |
| `apps/web/src/components/brain/AgentBrainPanel.tsx` | Agent selector plus persistent agent memory and failure-lesson management. |

Privacy rule implemented:

- Personal notes are never included in workspace graph retrieval or workspace export. They enter agent context only through an explicit user-to-agent grant.

### C.8 Export And Ingestion UI Log

| Area | Implemented behavior |
|------|----------------------|
| Knowledge export | `GET /v1/brain/export` emits indexed workspace KB content as `application/x-ndjson` with a downloadable JSONL filename. |
| Upload accept list | `WorkspaceDocDropZone` accepts document, spreadsheet, and image file selections supported by the service contract. |
| Upload messaging | The UI says images and spreadsheets require configured extractors; it does not advertise unsupported audio indexing. |
| Deferred QA export | `kb_qa_pairs` schema exists for future validated generation; no synthetic QA pairs are created in this implementation. |

### C.9 Verification Log

Commands run successfully:

```bash
pnpm --filter @agentis/api typecheck
pnpm --filter @agentis/web typecheck
pnpm --filter @agentis/db typecheck
pnpm --filter @agentis/api test -- tests/routes/knowledgeBases.test.ts tests/services/personalBrain.test.ts tests/services/agentMemory.test.ts tests/routes/brainSurface.routes.test.ts
pnpm --filter @agentis/web test -- tests/App.test.tsx tests/components/BrainView.test.tsx tests/components/AgentHierarchyNode.test.tsx tests/pages/AgentsPage.test.tsx tests/components/Sidebar.test.tsx
```

Focused test outcomes:

| Test area | Result |
|-----------|--------|
| Native KB embedding, hybrid retrieval method, and access accounting | Passed |
| Document upload graph linking and structural-link repair | Passed |
| Personal note retrieval, grant-gated visibility, and revoke behavior | Passed |
| Agent memory persistence and deterministic failure lesson recording | Passed |
| Brain support routes and embedding configuration verification | Passed |
| Brain graph frontend component rendering | Passed |
| Auth shell bare-URL login expectation | Passed |
| Navigation, hierarchy, and agents page fixtures after release cleanup | Passed |

Live browser verification:

| Verification | Result |
|--------------|--------|
| Workspace / Agent / Personal scope buttons render on the Brain page | Passed |
| Personal scope opens the private note/grant panel | Passed |
| Agent scope opens the agent memory panel | Passed |
| Browser console reported page errors during scope transitions | None observed |

### C.10 Main Branch Release Hygiene Pass

The release branch must expose Brain without exposing the unreleased future product surface. This pass validated that boundary and removed the leaked implementation rather than coupling Brain to it.

| Area | Improvement |
|------|-------------|
| Product catalog | Deleted the tracked unreleased product manifests and their seeded examples. |
| Future design references | Deleted tracked planning and audit documents that described unreleased product routes and surfaces; scrubbed the remaining workflow-plan sentence. |
| Chat and navigation | Removed dormant future-creation mode, hidden thread handoff parsing, unsupported chat context, and product-specific composer copy. |
| User-facing copy | Replaced unreleased-product wording in workspace, package, knowledge, resource-layer, and placeholder UI with supported workflow/package/knowledge terminology. |
| Brain architecture | Kept `scope_id` as a generic intelligence boundary; removed hidden instance-backed scope resolution, product-labelled nodes/sources, and unused future lifecycle methods. |
| Database contract | Removed hidden release-specific instance/thread support and future-labelled SQL/schema artifacts; retained generic scoped Brain stores. |
| Auth-shell signal | Re-ran the originally reported `tests/App.test.tsx` expectation after cleanup; all four auth-shell tests now pass. |
| Live UI verification | Confirmed supported Brain, chat, and packages screens render without removed navigation or product copy; only existing React Router future-flag warnings were reported. |

### C.11 Final Delivery State

| Capability | Delivery state |
|------------|----------------|
| Uploaded KB embedding and hybrid retrieval | Implemented |
| Knowledge workflow/tool quality path | Implemented |
| Provider-change KB backfill | Implemented |
| Semantic graph refinement | Implemented asynchronously for configured providers |
| Temporal graph validity | Implemented |
| Access frequency recording | Implemented |
| Failure lesson memory loop | Implemented |
| Personal Brain with explicit grants | Implemented |
| Agent Brain UI scope | Implemented |
| Personal Brain UI scope | Implemented |
| Source-content NDJSON export | Removed from the delivered Brain vision |
| Image visual descriptions | Implemented as user opt-in with a configured vision model; OCR fallback remains available |
| Spreadsheet extraction | Implemented for `.xlsx` through `exceljs` |
| Audio transcription | Implemented when a transcription model is configured; otherwise explicitly rejected |
| Grounded exploratory expansion, LLM relation typing, entity/community summaries | Implemented; classic HyDE rejected |
| Generated QA pairs and fine-tuning export UI | Removed from the delivered Brain vision |

## Appendix D - May 26 Completion Log

This log supersedes deferred/partial entries in the prior foundation log.

### D.1 Code Changes

| File | Change |
|------|--------|
| `apps/api/src/services/brainEnrichment.ts` | Added the opt-in structured enrichment provider, grounded query expansion, relation classifier, OpenAI-compatible image/audio adapters, and the entity/community graph writer. |
| `apps/api/src/services/knowledgeBase.ts` | Made ingestion enrichment-aware; persisted generated summary/key-fact/entity provenance; embedded generated context; added adaptive exploratory RRF retrieval; enabled optional visual descriptions, transcription, and XLSX extraction. |
| `apps/api/src/services/knowledgeAutoLinker.ts` | Added optional model relation classification for semantic links with reliable fallback. |
| `apps/api/src/routes/knowledgeBases.ts` | Added `retrievalMode` and upload `describeImage` request controls; awaited asynchronous ingestion. |
| `apps/api/src/bootstrap.ts`, `apps/api/src/env.ts` | Composed the opt-in Brain runtime and introduced explicit environment feature gates/models. |
| `apps/web/src/components/knowledge/WorkspaceDocDropZone.tsx`, `KnowledgeTab.tsx` | Added image-description consent, media file selection support, and accurate supported-ingestion messaging. |
| `apps/api/package.json`, `pnpm-lock.yaml` | Added `exceljs` as the supported XLSX parser. |
| `packages/db/src/sqlite/schema.ts`, `migrations.ts`, `embedded-sql.ts`, `apps/api/src/routes/brain.ts` | Removed unused QA-pair persistence and the training-adjacent Brain export endpoint. |

### D.2 Behavioral Contract

| Situation | Result |
|-----------|--------|
| Enrichment disabled or no structured model configured | Text and spreadsheets still index; deterministic context and hybrid retrieval continue to work. |
| Enrichment enabled | Chunks gain grounded model summaries/key facts/entities and provenance; graph concept/community atoms are materialized. |
| `retrievalMode: "exploratory"` with enrichment enabled | An initial real retrieval anchors query expansion; expanded result sets are fused with RRF. |
| Standard contextual or strict retrieval | No query-generation latency is introduced. |
| Image upload without the visual-description checkbox | No visual-model call is made; OCR is attempted when available. |
| Image upload with checkbox and configured vision model | A compact textual visual description is indexed. |
| Audio upload with configured transcription model | Transcript text is indexed and retrievable. |
| Audio without a transcription model | Request fails explicitly rather than indexing empty/fabricated content. |
| `.xlsx` upload | Workbook sheets and row values are converted into searchable text. |
| `.xls` upload | Rejected with guidance to use `.xlsx` or CSV. |

### D.3 Verification

Commands executed successfully on May 26, 2026:

```bash
pnpm --filter @agentis/api typecheck
pnpm --filter @agentis/web typecheck
pnpm --filter @agentis/api exec vitest run tests/routes/knowledgeBases.test.ts
```

Focused test coverage added and passing:

| Coverage | Result |
|----------|--------|
| Model summary/key-fact persistence and entity/community graph atoms | Passed |
| Grounded exploratory query expansion and RRF inclusion of another facet | Passed |
| Opt-in visual description and configured audio transcription paths | Passed |
| Real generated XLSX workbook extraction and retrieval | Passed |
| Model-classified semantic relation link creation | Passed |

### D.4 Removed From The Vision

Classic ungrounded HyDE is not a Brain feature. Automatic QA-pair generation, fine-tuning export UI, reserved `kb_qa_pairs` storage, and `/v1/brain/export` are removed from the delivered architecture. They should not be reintroduced without a separate data-governance and evaluation specification.

## Appendix E - Scoped Maps And Brain Setup UX Log

Completed on May 26, 2026.

### E.1 Decision Record

Startup-only environment configuration was insufficient for the product vision: it required server operations for user-level choices and could not express different Brain behavior by workspace. Environment variables remain supported as deployment defaults, while workspace settings saved through the Brain UI now control model-driven enrichment at request time.

This preserves the opt-in privacy boundary for visual descriptions and transcription, exposes configuration where users discover the feature, and avoids coupling ingestion behavior to a process restart.

### E.2 Implementation Changes

| Area | Change |
|------|--------|
| Agent Brain | Added an agent-scoped graph projection and map-first UI, with a secondary memory management view. |
| Personal Brain | Added a private personal graph projection and map-first UI, with notes and explicit access grants preserved in a management view. |
| Shared map component | Added a reusable scoped Brain canvas that renders agent or personal graph atoms with the same interaction language as the workspace map. |
| Scoped node inspector | Personal and Agent map node selection now opens the shared detail rail with full content, provenance, connections, and usage; scoped inspectors are read-only because mutations remain owned by their dedicated management views. |
| Setup panel | Replaced the multi-step setup flow with one compact configuration panel for semantic retrieval and AI enhancements. |
| Header action | Removed the setup icon from the Brain title and exposed configuration as a labeled `Brain setup` action beside scope controls. |
| UI model controls | Added workspace-configurable enrichment endpoint/model/key, optional image description model, and optional audio transcription model, with connection verification. |
| Runtime configuration | Added a workspace-aware enrichment provider that resolves saved settings dynamically and falls back to environment defaults. |
| API privacy | Brain configuration responses report whether a secret is set without returning the stored model API key. |

### E.3 Behavioral Contract

| Situation | Result |
|-----------|--------|
| Agent scope selected | The agent's own accumulated memory is visualized as a private map; memory editing remains available behind the management toggle. |
| Personal scope selected | The user's private notes are visualized as a private map; access grants and note editing remain available behind the management toggle. |
| AI enhancements disabled in UI | No model summaries, relation typing, visual descriptions, or transcription are invoked for that workspace. |
| AI enhancements enabled in UI | Grounded summaries, exploratory expansion, and typed relations use the configured workspace model. |
| Image descriptions or audio transcription toggled off | Their model calls stay disabled even when general AI enhancements are enabled. |
| Environment settings configured without UI settings | They serve as compatible deployment defaults for enrichment. |

### E.4 Verification

Commands executed successfully on May 26, 2026:

```bash
pnpm --filter @agentis/api typecheck
pnpm --filter @agentis/web typecheck
pnpm --filter @agentis/api exec vitest run tests/routes/knowledgeBases.test.ts tests/routes/brainSurface.routes.test.ts tests/services/personalBrain.test.ts tests/services/agentMemory.test.ts
pnpm --filter @agentis/web exec vitest run tests/components/BrainView.test.tsx tests/components/ScopedBrainMap.test.tsx
```

Added coverage confirms personal and agent map projection, secret-redacted saved enrichment configuration, and scoped-map rendering from the API graph response.

Additional node-inspection verification:

| Coverage | Result |
|----------|--------|
| Personal selected-node detail includes full private note content and provenance | Passed |
| Agent selected-node detail includes full memory content and owning agent usage | Passed |
| Scoped map node click mounts the shared detail rail without workspace-only mutation actions | Passed |
| Live Personal node click opens content, confidence/trust, and connection details | Passed |

## Appendix F - May 30 Memory Correctness Pass

Closing reported brain gaps after an operator saw a chat question ("how do I
like responses?") stored as a memory atom badged "PATTERN".

### F.1 Root causes found

| Symptom | Root cause |
|---------|-----------|
| A question captured as a `preference` | `chatMemoryCapture.classifySignal` matched "I like" inside the interrogative; no question guard. The 68%/80% confidence/trust on the node matched the preference capture path (trust 0.8 → confidence 0.8×0.85). |
| Badge said "PATTERN" for a `preference` | `nodeTypeForAtom` collapsed every `workspace_memory` atom to `memory_pattern`; the detail badge ignored `metadata.kind`, so all facts/preferences/rules/lessons mislabeled as "Pattern". |
| Agent `memory_append` could store junk | No question/low-value guard; `kindFromSection`'s `\bpref\b` never matched "preference". |
| Agent-private brain felt write-only/dead | `agent_memories` was a disconnected table outside the graph/retrieval/promotion path. |

### F.2 Code changes

- `chatMemoryCapture.ts` — `isQuestion()` guard; questions never become signals. Imperatives ("do not …") still classify as rules.
- `BrainDetailRail.tsx` — badge prefers the wedge `metadata.kind` (Fact/Preference/Rule/Lesson/Pattern); falls back to the coarse node-type label.
- `agentToolRuntime.ts` — `lowValueMemoryReason()` rejects questions/too-short entries on both `memory_append` scopes; `kindFromSection` regex now matches inflections.
- **Agent-private memory retired onto the canonical brain (full retire):**
  - `agentMemory.ts` rewritten to read/write `memory_episodes` (`scope_id = agentId`); public API unchanged so routes/tools/chat are untouched.
  - Migration v51 `retire_agent_memories` copies `agent_memories` → `memory_episodes` then `DROP`s the table; the `agentMemories` schema export is removed.
  - `bootstrap.ts` injects an `EpisodicMemoryStore` into `AgentMemoryService`.
  - `WorkflowEngine.ts` drops the duplicate `<agent_memory>` dispatch block (the scoped brain is already in `brainBlock` via `buildDispatchContext` scope "both") and the per-dispatch ability-use auto-write (kept as a quality event only).
  - Auto-writer was already present: `#enqueueSuccessfulBrainCapture` promotes successful outputs with `scopeId = agentId`, so private brains now fill from the agent's own runs.

### F.3 Decisions

- Canonical memory is the DB brain with two scopes (workspace + scoped); agent-private is just `scope_id = agentId`. No second table.
- Operator-preference de-dup is kept and correct: prefs live once in workspace memory; agents read them at dispatch from the shared brain.
- Markdown remains a render/export and external-source format only (Issue #1, the `.md`→DB migration, tracked separately).

### F.4 Verification

```bash
pnpm --filter @agentis/api typecheck      # pass
pnpm --filter @agentis/web typecheck      # pass
pnpm --filter @agentis/db typecheck       # pass
cd packages/db && npx vitest run tests/migrate.test.ts   # 7 passed (incl. retire assertions)
pnpm --filter @agentis/api test -- tests/services/agentMemory.test.ts tests/services/chatMemoryCapture.test.ts tests/engine/WorkflowEngine.sharedBrain.test.ts tests/engine/WorkflowEngine.agentSession.test.ts tests/routes/brainSurface.routes.test.ts   # 21 passed
```

Added a regression test: "does not capture a question as a preference".

### F.5 Authored .md context → DB brain nodes (Issue #1)

Removed Markdown as an internal authored-context backend. `WORKSPACE/DECISIONS/WORKFLOW` docs are no longer files on the volume — each is one operator-sourced `workspace_memory` atom tagged `charter` + section, importance 0.9. `.md` is now only a render/authoring format and an external-source format (harness runtime files, knowledge documents).

**Tiered dispatch (the "grey" — not always-on vs. relevance-only):** `SharedIntelligence.buildDispatchContext` now blends two tiers under one budget:
- *Constitutional tier* — operator-authored binding atoms (rule / importance ≥ 0.8 / `charter` tag) inject on every dispatch regardless of query, capped at `CONSTITUTIONAL_MAX = 5` slots and ranked by importance × trust × recency inside the cap.
- *Relevance tier* — everything else fills the remaining budget by semantic relevance, deduped against the charter.
- Rendered as two labeled sub-blocks ("always honor" vs. "apply, but verify"); per-atom `atom_injected` quality events carry the `tier`.

**Wiring:**
- `workspaceIntelligence.ts` rewritten: storage = operator charter atoms via `MemoryStore` (+ `db` for tag lookup); `getContextFile`/`setContextFile`/`buildContextBlock` API preserved so the `/v1/workspace-context` route is unchanged. Empty content deletes the atom (no placeholder seeding).
- `bootstrap.ts`: `memoryStore` moved up; `WorkspaceIntelligenceService` now `(memoryStore, sqlite)`.
- `WorkflowEngine` dropped the separate authored-context `block` (charter arrives via the constitutional tier, KB via relevance/`kb_chunk`).
- chat + creation keep `buildContextBlock` (now DB-backed charter + KB) — no regression; the route is repurposed onto atoms.

**Decisions / follow-ups:** each document is one charter atom for v1 (operators can atomize finer via memory APIs later). Full brain dispatch in chat (relevance episodes, not just charter + KB) is a deferred enhancement — chat still lacks `buildDispatchContext`. Existing unused `context/*.md` volume files are inert (nothing reads them; defaults were placeholder-empty in practice).

### F.6 Verification (Issue #1)

```bash
pnpm --filter @agentis/api typecheck   # pass
pnpm --filter @agentis/api test -- tests/services/workspaceIntelligence.test.ts tests/services/agentMemory.test.ts tests/services/instinctEngine.test.ts tests/services/chatMemoryCapture.test.ts tests/engine/WorkflowEngine.agentSession.test.ts tests/engine/WorkflowEngine.sharedBrain.test.ts tests/routes/brainSurface.routes.test.ts   # 33 passed
```

`workspaceIntelligence.test.ts` rewritten to assert charter-atom storage (source `operator`, tags `charter`+section, importance ≥ 0.8), delete-on-clear, and the assembled block — no Markdown files.
