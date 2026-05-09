# Agentis App Knowledge Wedge Architecture
## Seeds, Imports, Evaluator Examples, And Runtime Intelligence

> Status: ✅ implemented (Agentis 1.1)
> Date: 2026-05-09
> Scope: app seeding model, dataset contract model, ingestion architecture, promotion model, retrieval surface, UI implications, rollout plan
> Depends on: `docs/app-canvas/APP-CANVAS-ARCHITECTURE.md`, `docs/memory/MEMORY-ARCHITECTURE.md`, `docs/memory/THE-BRAIN-UX-ARCHITECTURE.md`, `docs/AGENTIS-APP-FORMAT.md`

---

## Execution status — Agentis 1.1

| Spec section | Status | File / Symbol |
| --- | :--: | --- |
| §4 Four intelligence classes (typed) | ✅ | `packages/core/src/types/appIntelligence.ts` |
| §5 Class 1 — seeds (Knowledge / Memory / Evaluator / Baseline) | ✅ | `KnowledgeSeed`, `MemorySeed`, `EvaluatorExampleSeed`, `EvaluatorRubric`, `WorkflowBaselineSeed` in `appIntelligence.ts` |
| §6 Class 2 — DatasetSpec (with `wedgeRole`, `expectedImpact`, `freshnessExpectation`) | ✅ | `DatasetSpec` in `appIntelligence.ts` |
| §6.6 Ingestion behavior (resumable, visible, per-dataset, app-scoped) | ✅ | `apps/api/src/services/datasetIngestion.ts` |
| §6.7 Impact preview | ✅ | `DatasetImpactPreview` + `DatasetIngestion.#buildImpactPreview()` |
| §7 Class 3 — evaluator examples | ✅ | `apps/api/src/services/evaluatorExampleStore.ts` |
| §8 Class 4 — promoted execution intelligence | ✅ | `apps/api/src/services/intelligencePromotion.ts` |
| §10 Runtime architecture (composed query model) | ✅ | `apps/api/src/services/appIntelligenceRuntime.ts` |
| §11.1 Seeds storage | ✅ | `app_activation` writes seeds into runtime stores |
| §11.2 Imported datasets storage | ✅ | `dataset_imports` table + chunked routing into target stores |
| §11.3 Knowledge storage + retrieval | ✅ | `knowledge_chunks` table + lexical TF-IDF in `KnowledgeStore` |
| §11.4 Memory storage | ✅ | `app_memory` table (typed kinds: fact, preference, pattern, rule, lesson) |
| §11.5 Evaluator examples storage | ✅ | `app_evaluator_examples` table |
| §11.6 Baselines storage | ✅ | `workflow_baselines` table (per-workflow versioned snapshots) |
| §15.1 `GET /v1/apps/:appId/intelligence` | ✅ | `apps/api/src/routes/apps.ts` |
| §15.2 `AppIntelligenceResponse` | ✅ | `AppIntelligenceResponse` in `appIntelligence.ts` + `apps.ts` builder |
| §16 Package model evolution | ✅ | `apps/api/src/routes/packages.ts` `manifestSchema` |
| §17.1 Phase 1 — make seeds canonical | ✅ | `memorySeeds`, `evaluatorExampleSeeds` shipped in manifest |
| §17.2 Phase 2 — strengthen dataset contracts | ✅ | `wedgeRole` + `expectedImpact` + `freshnessExpectation` |
| §17.3 Phase 3 — `appIntelligenceRuntime` | ✅ | Composed retrieval with token budget enforcement |
| §17.4 Phase 4 — upgrade retrieval quality | ✅ Hybrid lexical TF-IDF + vector retrieval via `HashingEmbeddingProvider` (512-dim feature hashing); auto/lexical/vector/hybrid modes |
| §17.5 Phase 5 — promotion and compounding | ✅ | `IntelligencePromotion` + memory mirroring above 0.7 confidence |
| §17.6 Phase 6 — make the wedge visible in UI | 🟦 Backend complete; UI surfaces (App Canvas, Memory layer) land with the App Canvas / Brain UX docs |

**New tools surfaced through `agentisToolRegistry`** (Plane 2; MCP-exposed):
- `agentis.knowledge.search` — Class 1+2 retrieval (now wired to real backend)
- `agentis.app.memory.recall` — memory recall by hint + kind filter
- `agentis.app.memory.write` — operator memory write (mutating)
- `agentis.app.evaluator.examples` — Class 3 listing
- `agentis.app.baselines` — workflow baselines per app
- `agentis.app.intelligence.compose` — full composed context in one call
- `agentis.app.promotion.promote` — Class 4 promotion / reinforcement (mutating)

**Routes added at `/v1/apps`** (33 endpoints across intelligence, datasets, ingestion, knowledge, memory, evaluator examples, baselines, promoted patterns).

**Previously deferred — now implemented:**
- Vector retrieval — `KnowledgeStore` + `EpisodicMemoryStore` now use `HashingEmbeddingProvider` (512-dim feature hashing, zero external deps). Auto-mode activates hybrid when ≥50% candidates have embeddings.
- Resumable per-item ingestion — `dataset_import_items` table added; `DatasetIngestion.resume()` deduplicates by SHA-256 content hash, skipping already-`completed` items.
- Binary file ingestion — PDF (FlateDecode stream extraction + BT/ET text operators) and markdown-zip (PKZIP local header scan + `zlib.inflateRawSync`) now supported alongside CSV/JSON/JSONL/TXT.

---

## 1. Why this document exists

The strongest possible wedge for Agentis is not "we have agents" and not "we have a canvas."

Those are table stakes.

The real wedge is:

**you can build an app that starts with meaningful business intelligence and keeps compounding from your own data.**

That is what turns an app from:

- general-purpose
- prompt-heavy
- replaceable

into something that is:

- domain-shaped
- historically informed
- harder to replace
- increasingly powerful over time

This document defines the architecture for that wedge.

It sits directly on top of:

- the app canvas architecture
- the memory architecture
- the Brain / Memory UX architecture

It is not a side feature.
It is one of the main reasons Agentis should exist.

---

## 2. Executive conclusion

Agentis apps must be able to start with, absorb, and exploit four classes of intelligence:

1. **Seeds**
2. **Imported datasets**
3. **Evaluator examples**
4. **Promoted execution intelligence**

These four classes must become one coherent runtime system, not separate product checkboxes.

The system must be able to answer:

- what an app already knows before first run
- what business data the operator can feed it
- how imported data changes app behavior
- what new patterns the app has learned from real execution
- what intelligence is actually influencing outputs right now

The wedge becomes real only when all five are true:

1. app packages declare the knowledge/data contract up front
2. ingestion is first-class and easy
3. runtime retrieval uses the imported intelligence effectively
4. evaluators and memory promotion refine the app over time
5. the user can see this system clearly in the app UI

---

## 3. The product truth

An app without imported and promoted intelligence is a capable generalist.

An app with:

- good seeds
- the right business imports
- evaluator examples
- promoted lessons

becomes a domain expert.

That is the wedge.

This is the strategic difference between:

- "workflow automation with AI"

and

- "agentic apps that become specialized on your world."

---

## 4. The four intelligence classes

The app knowledge wedge should be modeled around four explicit classes.

```text
+--------------------------------------------------------------------------------+
| CLASS 1: SEEDS                                                                 |
| Builder-authored, compact, portable intelligence packaged with the app         |
+--------------------------------------------------------------------------------+
| CLASS 2: IMPORTED DATASETS                                                     |
| Operator-provided business data absorbed after activation                      |
+--------------------------------------------------------------------------------+
| CLASS 3: EVALUATOR EXAMPLES                                                    |
| Scored examples that define what "good" and "bad" look like                   |
+--------------------------------------------------------------------------------+
| CLASS 4: PROMOTED EXECUTION INTELLIGENCE                                       |
| Durable patterns learned from real app operation                               |
+--------------------------------------------------------------------------------+
```

Each class has a distinct job.
If they blur together, the wedge becomes muddy and hard to operate.

---

## 5. Class 1: Seeds

### 5.1 Purpose

Seeds are the app's starting intelligence.

They make an app useful before any operator imports anything.

### 5.2 What seeds should include

#### Knowledge seeds

- domain taxonomies
- heuristics
- business rules
- reference concepts
- example patterns

#### Memory seeds

- compact facts the app should "already know"
- durable preferences
- recurring business rules
- named pattern snippets

#### Evaluator seeds

- rubric examples
- pass/fail references
- baseline scoring hints

#### Workflow baseline seeds

- initial cost expectations
- latency expectations
- success-rate expectations

### 5.3 Rule

Seeds must be:

- small
- portable
- high-signal
- safe to export/import

Seeds are not raw business history.
They are distilled starting intelligence.

### 5.4 Required package evolution

The canonical `agentis` package model should evolve to include:

```ts
interface AgentisPackageContents {
  knowledgeSeeds: KnowledgeSeed[];
  memorySeeds: MemorySeed[];
  evaluatorRubrics: EvaluatorRubric[];
  evaluatorExampleSeeds?: EvaluatorExampleSeed[];
  workflowBaselines: WorkflowBaselineSeed[];
}
```

### 5.5 Why `memorySeeds` matters

This is one of the most important missing pieces.

Right now the docs talk beyond the runtime.
The runtime must catch up.

Without `memorySeeds`, the system has:

- seeded knowledge
- but weak seeded app memory

That is an unnecessary gap.

---

## 6. Class 2: Imported datasets

### 6.1 Purpose

Imported datasets are where the app stops being generic.

This is the operator's institutional context:

- CRM
- docs
- ticket archives
- PR history
- contract library
- customer records
- metric exports
- internal knowledge bases

### 6.2 Product rule

This cannot be an optional hidden advanced feature.

This must be a primary part of what it means to activate and mature an app.

### 6.3 Required model

The current `datasetSpecs` direction is right.
Keep it and strengthen it.

Every dataset spec should explicitly declare:

- what data it expects
- what formats it accepts
- what the effect is
- where the data goes
- whether it is required for the wedge

### 6.4 Strengthen the schema

Current `datasetSpecs` should evolve toward:

```ts
interface DatasetSpec {
  key: string;
  label: string;
  description: string;
  acceptedFormats: string[];
  targetStore: 'knowledge' | 'memory' | 'evaluator_examples' | 'baseline_inputs';
  chunkingStrategy: 'per-row' | 'per-document' | 'per-function' | 'sliding-window' | 'semantic';
  requiredFields?: string[];
  optional: boolean;
  recommended: boolean;
  wedgeRole:
    | 'primary_specialization'
    | 'performance_booster'
    | 'compliance_guardrail'
    | 'historical_context'
    | 'quality_calibration';
  expectedImpact?: {
    affects: Array<'retrieval' | 'routing' | 'evaluation' | 'output_quality' | 'cost_efficiency'>;
    note?: string;
  };
  embeddingHint?: string;
  freshnessExpectation?: 'static' | 'monthly' | 'weekly' | 'daily' | 'live';
  example?: {
    sampleColumns?: string[];
    exportInstructions?: string;
  };
}
```

### 6.5 Why `wedgeRole` matters

Not all imports are equal.

Some datasets are the app's actual moat.
Some are just helpful.

The UI and setup experience should know the difference.

### 6.6 Required ingestion behavior

Dataset ingestion must be:

- first-class
- resumable
- visible
- per-dataset
- app-scoped

The ingest pipeline should always produce:

- job status
- parsed item counts
- routed target store
- quality warnings
- impact preview

### 6.7 "Impact preview" is mandatory

After import, the system should not only say:

- `3,247 records imported`

It should say:

- what new knowledge clusters were created
- how evaluator confidence changed
- what memory regions were strengthened
- what app modules now have better grounding

This is the bridge from backend wedge to product wedge.

---

## 7. Class 3: Evaluator examples

### 7.1 Purpose

Evaluator examples are not ordinary data.

They are the runtime's definition of:

- what good looks like
- what bad looks like
- what acceptable ambiguity looks like

### 7.2 Why they matter to the wedge

Many AI systems stop at retrieval.
That is weak.

A real wedge requires the app to also know:

- how to judge its own outputs
- how to compare outputs against real business standards

That is where evaluator examples become strategic.

### 7.3 Sources of evaluator examples

Evaluator examples can come from:

- package seeds
- imported labeled datasets
- operator review decisions
- approved vs rejected outputs
- post-run scoring

### 7.4 Runtime use

Evaluator examples should feed:

- quality gates
- routing gates
- approval thresholds
- anomaly detection
- baseline drift analysis

### 7.5 Architecture rule

Evaluator examples should not be buried inside "eval cases" as a side subsystem.
They are one of the main intelligence classes of the app and should be visible in Memory UI and Brain surfaces.

---

## 8. Class 4: Promoted execution intelligence

### 8.1 Purpose

This is the compounding layer.

It is how an app becomes more valuable after real use.

### 8.2 What belongs here

- successful playbooks inferred from repeated wins
- failure causes with confirmed fixes
- approved output patterns
- evaluator-calibrated lessons
- operator-confirmed business logic
- recurring exceptions and exceptions handling

### 8.3 Promotion sources

Promoted execution intelligence should come from:

- run outcomes
- approval decisions
- evaluator verdicts
- replay outcomes
- repeated tool usage success/failure
- operator annotations

### 8.4 Architecture rule

This layer must be promoted, not dumped.

Raw history is not the wedge.
Distilled reusable intelligence is the wedge.

---

## 9. The wedge flow

This is the real lifecycle:

```text
Package seeds
  -> app activated
  -> operator imports datasets
  -> ingestion routes data into knowledge / memory / evaluator examples
  -> app runs with retrieval and evaluators
  -> successful and failed outcomes are promoted into durable intelligence
  -> app gets more specialized
```

That is the compounding loop.

If any part is missing, the wedge weakens:

- no seeds -> cold start
- no imports -> no institutional intelligence
- no evaluator examples -> no reliable judgment
- no promotion -> no compounding

---

## 10. Runtime architecture

### 10.1 Required runtime layers

The app knowledge wedge depends on these memory/runtime layers:

1. seed store
2. dataset ingestion layer
3. knowledge store
4. episodic memory store
5. evaluator example store
6. baseline store
7. retrieval builder
8. promotion pipeline

### 10.2 Query model

At runtime, the app should be able to build context like this:

```ts
interface AppIntelligenceContext {
  seedKnowledge: KnowledgeHit[];
  importedKnowledge: KnowledgeHit[];
  memoryPatterns: MemoryEpisode[];
  evaluatorExamples: EvaluatorExample[];
  baselineHints: WorkflowBaselineSnapshot[];
  tokenEstimate: number;
}
```

This should be assembled by one runtime service, not by scattered route logic.

### 10.3 Required service

Add:

- `apps/api/src/services/appIntelligenceRuntime.ts`

Responsibilities:

- fetch app-local intelligence
- rank relevance
- enforce token budget
- respect trust and freshness
- build injected context for agent tasks, evaluators, and planning

---

## 11. Storage architecture

### 11.1 Seeds

Stored in package contents and copied into runtime stores on activation.

### 11.2 Imported datasets

Stored as source-of-truth import jobs plus routed records in target stores.

### 11.3 Knowledge

Stored as documents/chunks with hybrid retrieval support.

### 11.4 Memory

Stored as typed episodes and promoted patterns, not just generic notes.

### 11.5 Evaluator examples

Stored in a dedicated evaluator example model, queryable by app and evaluator key.

### 11.6 Baselines

Stored as versioned snapshots over rolling windows.

---

## 12. What is real today and what is not

This section is intentionally blunt.

### 12.1 Real today

- `knowledgeSeeds` exist in the package model
- `datasetSpecs` exist
- target stores already include `knowledge`, `memory`, and `evaluator_examples`
- activation creates a seed knowledge base
- ingestion routes records into multiple targets

These are not dreams.
They are real foundations.

### 12.2 Status as of Agentis 1.1 — implemented end-to-end

#### Retrieval quality

✅ V1 lexical TF-IDF retrieval over `knowledge_chunks` (per-app). Trust-weighted ranking. The `embedding` column is reserved on the schema so the upgrade to vector retrieval is a single retriever swap.

#### Memory-targeted ingestion

✅ `targetStore: memory` now writes typed `MemoryEpisode` rows (kind: fact, preference, pattern, rule, lesson) — not row storage. Recall is scored by `trust × importance × recency × hintMatch`.

#### Evaluator example centrality

✅ `app_evaluator_examples` is its own table. Per-evaluator-key confidence is computed via `1 - exp(-N/10)` and surfaces in `/v1/apps/:appId/intelligence` and `/v1/apps/:appId/evaluator-examples`.

#### `memorySeeds`

✅ Now in the canonical package model (`packages/core/src/types/appIntelligence.ts`) and the install schema (`apps/api/src/routes/packages.ts`). Activation writes them into `app_memory` with `source: 'seed'`.

### 12.3 Strategic verdict

The wedge is now architecturally real **and** product-complete on the backend.
The remaining work is the UI surfaces (App Canvas, Memory layer, Brain UX) — landed by the next three docs in the 1.1 batch.

That is the right place to be: the wedge is no longer a slogan, it is operating substrate.

---

## 13. How this should appear in the app canvas

The app canvas should make the wedge visible.

### 13.1 Required top-level node types

At the app canvas level, imported intelligence should appear through:

- `knowledge_source`
- `memory_surface`
- `brain_surface`
- `output_surface`

### 13.2 What the user should be able to see

For each data/intelligence module:

- imported status
- freshness
- wedge role
- impact on app quality
- linked workflows
- linked outputs

### 13.3 Why this matters

If the imported knowledge wedge is invisible in the app architecture, users will not understand why the app is getting better or what makes it defensible.

---

## 14. How this should appear in the Memory layer

The Memory layer should visualize the four intelligence classes clearly:

### 14.1 Seeds

Display as:

- `Starter intelligence`
- compact
- clearly distinguishable from learned intelligence

### 14.2 Imported datasets

Display as:

- app knowledge sources
- grouped by source and freshness
- visibly connected to knowledge clusters

### 14.3 Evaluator examples

Display as:

- judgment clusters
- confidence and volume visible
- directly linked to decision/output surfaces

### 14.4 Promoted intelligence

Display as:

- memory patterns
- promoted lessons
- approval-confirmed practices

### 14.5 The core UX promise

The user should be able to answer:

- what did we seed
- what did we import
- what did the app learn
- what is actually shaping its output today

That is the UX manifestation of the wedge.

---

## 15. API architecture

### 15.1 App intelligence endpoint

Add:

```text
GET /v1/apps/:slug/intelligence
```

This should return a composed view for the app Memory layer and Brain surfaces.

### 15.2 Suggested response

```ts
interface AppIntelligenceResponse {
  app: {
    id: string;
    slug: string;
    name: string;
    status: string;
  };
  summary: {
    seedCount: number;
    importedDatasetCount: number;
    knowledgeClusterCount: number;
    promotedMemoryCount: number;
    evaluatorExampleCount: number;
    baselineConfidence: number | null;
  };
  seeds: {
    knowledge: Array<{ title: string; source: string }>;
    memory: Array<{ title: string; trust: number }>;
    evaluatorExamples: Array<{ evaluatorKey: string; count: number }>;
  };
  imports: Array<{
    datasetKey: string;
    label: string;
    wedgeRole: string;
    status: string;
    freshness: string | null;
    targetStore: string;
    counts: {
      sourceItems: number;
      storedItems: number;
      promotedItems?: number;
    };
  }>;
  memory: {
    patterns: Array<{ id: string; title: string; trust: number; confidence: number }>;
    gaps: Array<{ key: string; label: string; reason: string }>;
  };
  evaluators: Array<{
    key: string;
    confidence: number;
    exampleCount: number;
  }>;
  baselines: Array<{
    workflowId: string;
    successRate: number;
    avgCostMicros: number;
    sampleSize: number;
  }>;
}
```

This endpoint is not a luxury.
It is the backend contract that makes the wedge visible and actionable.

---

## 16. Required package model evolution

The package schema should evolve to include the missing wedge pieces.

### 16.1 Additions

```ts
interface KnowledgeSeed {
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface MemorySeed {
  title: string;
  content: string;
  trust?: number;
  importance?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface EvaluatorExampleSeed {
  evaluatorKey: string;
  input: unknown;
  expected: unknown;
  verdict: 'pass' | 'fail';
  reason?: string;
}
```

### 16.2 Why this matters

Without explicit support for these structures, the wedge remains partially documented and partially real.

That is not acceptable for Agentis 1.1.

---

## 17. Rollout plan

### Phase 1: Make seeds canonical

Goal:

- add `memorySeeds`
- add evaluator example seeds
- align package model with docs

### Phase 2: Strengthen imported dataset contracts

Goal:

- add `wedgeRole`
- add impact metadata
- improve setup and import language

### Phase 3: Build `appIntelligenceRuntime`

Goal:

- unify retrieval across seeds, imports, memory, evaluators, baselines

### Phase 4: Upgrade retrieval quality

Goal:

- move to hybrid retrieval
- rank by relevance, freshness, trust, and scope

### Phase 5: Promotion and compounding

Goal:

- turn successful and failed execution into durable intelligence

### Phase 6: Make the wedge visible in UI

Goal:

- render it clearly in app canvas and Memory layer

This is when the feature stops being "powerful backend stuff" and becomes a visible product moat.

---

## 18. What not to do

### Do not make imports optional in the user story

They may be technically optional, but they are central to the wedge.

### Do not equate more data with more intelligence

Quality, structure, freshness, and evaluator alignment matter more than bulk.

### Do not hide imported intelligence behind admin forms

It must be visible in the app's architecture and memory surfaces.

### Do not dump raw data into memory and call it learning

Learning requires promotion, ranking, and reuse.

### Do not let seeds and learned intelligence blur together

The user must know what was preloaded versus what the app earned.

---

## 19. Final design statement

The app knowledge wedge in Agentis is not simply:

- "you can upload a CSV"

It is:

**you can build an app that starts with focused intelligence, absorbs your real business context, evaluates itself against domain examples, and compounds durable lessons through use.**

That is a meaningful wedge.

And the architecture for it must be:

- explicit in the package model
- first-class in ingestion
- strong in retrieval
- disciplined in memory promotion
- visible in app canvas
- visible in Memory / Brain UI

If this is implemented well, Agentis stops being "a platform with AI workflows."

It becomes:

**a platform where apps become specialists on your world.**

