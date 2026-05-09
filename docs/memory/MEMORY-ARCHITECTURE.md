# Agentis Memory Architecture
## Reliable Memory For Agentic Apps

> Status: ✅ implemented (Agentis Memory OS)
> Date: 2026-05-09
> Scope: runtime memory model, retrieval architecture, promotion policy, evaluator-linked memory, app-scoped knowledge, phased implementation
> Synthesizes: `docs/PLATFORM-VISION.md` §3.3 Persistent Memory OS + the current Agentis app/runtime direction

## Implementation status

| Layer | Doc § | Code |
|---|---|---|
| 1. Working memory (typed scratchpad + compaction) | §5 | `services/workingMemoryCompactor.ts`, `working_memory_entries` |
| 2. App knowledge (hybrid lexical + vector) | §6 | `services/knowledgeStore.ts`, `services/embeddingProvider.ts`, `knowledge_chunks` |
| 3. Episodic memory (durable lessons) | §7 | `services/episodicMemoryStore.ts`, `memory_episodes` |
| 4. Evaluator + baselines | §8 | `services/evaluatorExampleStore.ts`, `services/rollingBaselineStore.ts`, `app_evaluator_examples`, `rolling_baseline_snapshots` |
| 5. Retrieval (token-budgeted composition) | §9 | `services/memoryRetrieval.ts`, `services/memoryRuntime.ts` |
| Promotion pipeline + audit trail | §10 | `services/memoryPromotion.ts`, `services/memoryTrust.ts`, `services/runPromotionExtractor.ts`, `memory_promotion_events` |
| Trust policy (capped agent writes) | §11 | `services/memoryTrust.ts` (`computeTrust`, `isHighRiskMemory`) |
| Failure handling (degraded modes) | §12 | `services/memoryRetrieval.ts` (try/catch per layer) |
| Package format additions | §13.2 | `routes/packages.ts` (`runtimeEpisodeSeeds`, `memoryPolicy`, `retrievalPolicy`) |
| `evaluatorMemory.ts` bridge | §13.3 | `services/evaluatorMemory.ts` (evaluator→memory feedback loop) |
| Routes | §15 | `routes/memory.ts` (mounted at `/v1/memory`) |
| Tools (agent surface) | §15 | `services/agentisToolHandlers/memory.ts` (7 tools incl. `agentis.memory.baselines.detect_anomalies`) |
| `IMemoryRuntime` facade | §15 | `services/memoryRuntime.ts` (`deleteWorking`, `snapshotWorking` added) |

---

## 1. Why this document exists

Agentis needs a real memory system.

Not a vague "AI memory" feature.
Not a notes table with a better name.
Not a chatbot history buffer.

A real memory system for Agentis must do one thing above all:

**make agentic apps more reliable, more cost-efficient, and more capable over time.**

This document exists because the repo currently has useful memory-adjacent pieces:

- run scratchpad
- memory entries
- knowledge bases
- dataset ingestion
- package seeds
- workflow baselines
- traces and ledger

But those pieces do not yet form one coherent memory architecture.

The older `Persistent Memory OS` planning in [PLATFORM-VISION.md](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/docs/PLATFORM-VISION.md) had more rigor:

- STM
- episodic LTM
- semantic retrieval
- token-budgeted injection
- async embedding
- failure handling

That rigor was good.
But the center of gravity was older: agent sessions and missions.

Current Agentis is no longer primarily a "mission coordinator."
It is becoming a platform for **agentic apps**.

That changes the architecture.

The correct memory system for Agentis must combine:

- the rigor of the old Memory OS
- the app-centric runtime of the current product

---

## 2. The design conclusion

The correct memory architecture for Agentis is:

**app-centric, run-aware, evaluator-backed, and retrieval-budgeted.**

Memory must be organized around five realities:

1. **Working state** for an active run
2. **Institutional knowledge** imported from real business data
3. **Durable episodic lessons** distilled from execution
4. **Quality and performance baselines** that define what good looks like
5. **Semantic retrieval** that injects only what is useful for the current step

The old STM/LTM/Semantic split is still valuable, but it must be remapped:

- STM becomes **run working memory**, not chat-session memory
- LTM becomes **app and workspace episodic memory**
- Semantic memory becomes **retrieval over knowledge, episodes, evaluator examples, and baselines**

This is a better fit for Agentis than a session-first memory model.

---

## 3. What memory is for in Agentis

Memory in Agentis exists to improve execution quality.

That means memory must help with:

- reducing repeated model reasoning
- grounding agents in historical facts and patterns
- recovering from failures without rethinking everything
- improving evaluator judgment with examples
- preventing repeated mistakes
- giving apps a way to compound intelligence over time

Memory does **not** exist to preserve every token forever.
If memory is not helping execution, it is storage noise.

---

## 4. The five memory layers

The memory system should be explicitly split into five layers.

```text
+--------------------------------------------------------------------------------+
| LAYER 1: RUN WORKING MEMORY                                                    |
| Scratchpad + compact turn state for an active run                              |
+--------------------------------------------------------------------------------+
| LAYER 2: APP KNOWLEDGE                                                         |
| Seeds + imported datasets + indexed documents                                  |
+--------------------------------------------------------------------------------+
| LAYER 3: EPISODIC MEMORY                                                       |
| Durable records of what happened, why, and what mattered                       |
+--------------------------------------------------------------------------------+
| LAYER 4: EVALUATOR AND BASELINE MEMORY                                         |
| Rubrics, examples, expected cost/latency/success envelopes                     |
+--------------------------------------------------------------------------------+
| LAYER 5: RETRIEVAL MEMORY                                                      |
| Semantic + lexical selection over the layers above, bounded by token budget    |
+--------------------------------------------------------------------------------+
```

Each layer has a different job.
Conflating them is how memory systems become expensive and useless.

---

## 5. Layer 1: Run Working Memory

### 5.1 Purpose

Run working memory is the short-term operational state of an active app execution.

It is not "knowledge."
It is not durable memory.
It is not a long-term retrieval corpus.

It is the live, mutable memory an app needs while work is happening.

### 5.2 What belongs here

- current task outputs
- intermediate results
- merged branch data
- current hypotheses
- compact continuation history for multi-turn agent tasks
- open questions and blockers
- transient run-local decisions

### 5.3 Current implementation anchor

This layer should continue building on the existing run scratchpad service:

- [scratchpad.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/services/scratchpad.ts)
- [WorkflowEngine.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/engine/WorkflowEngine.ts)

### 5.4 Architecture rules

Run working memory must be:

- fast
- mutable
- compact
- bounded in size
- disposable after the run

### 5.5 Required enhancements

The scratchpad must evolve into a more disciplined working memory layer:

#### Add namespaces

Example:

```text
run/
agent/
subflow/
turn/
eval/
artifact/
```

This makes memory more intelligible and easier to compact.

#### Add compaction

Multi-turn tasks should not keep dumping raw turn history into working memory.
They should periodically compact:

- prior tool results
- prior reasoning summary
- unresolved issues
- current plan state

#### Add typed working entries

Instead of everything being an untyped blob, support structured shapes:

- `working_plan`
- `working_summary`
- `pending_questions`
- `tool_result_cache`
- `artifact_draft`
- `evaluation_state`

### 5.6 Retention policy

Working memory dies with the run unless promoted.
No exceptions.

If a piece of run state matters in the future, it must be promoted into a durable layer.

---

## 6. Layer 2: App Knowledge

### 6.1 Purpose

App knowledge is the institutional context an app can retrieve from while operating.

This includes:

- package seeds
- imported business data
- indexed documents
- reference material
- prior domain facts

This is the biggest source of "this app knows my business."

### 6.2 Current implementation anchor

This layer already has meaningful foundations:

- [knowledgeBase.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/services/knowledgeBase.ts)
- [dataIngestion.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/services/dataIngestion.ts)
- [package.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/packages/core/src/types/package.ts)
- [packager.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/services/packager.ts)

### 6.3 What belongs here

- `knowledgeSeeds`
- imported CRM/ticket/codebase/wiki records
- indexed source documents
- canonical business facts
- reference policies and docs

### 6.4 What does not belong here

- temporary run state
- raw turn transcripts
- unresolved evaluator failures
- historical execution lessons

Those belong elsewhere.

### 6.5 Main architectural weakness today

The current knowledge layer is useful, but retrieval is still too shallow:

- lexical token overlap
- no real semantic embeddings in the current implementation path
- limited ranking sophistication

This is not enough for a world-class memory subsystem.

### 6.6 Required architecture

App knowledge retrieval should become hybrid:

1. lexical retrieval
2. semantic retrieval
3. metadata filtering
4. optional reranking

The system should support:

```ts
interface KnowledgeHit {
  id: string;
  sourceType: 'seed' | 'dataset' | 'document' | 'generated';
  appId?: string | null;
  datasetKey?: string | null;
  score: number;
  semanticScore?: number;
  lexicalScore?: number;
  freshnessScore?: number;
  trustScore?: number;
  content: string;
  metadata: Record<string, unknown>;
}
```

### 6.7 Scope model

Knowledge should be queryable at these scopes:

- run
- app
- workspace
- optional cross-app

Default retrieval order:

1. app-local
2. app-adjacent in same workspace
3. workspace-global if explicitly allowed

This protects relevance and reduces noisy retrieval.

---

## 7. Layer 3: Episodic Memory

### 7.1 Purpose

Episodic memory records what happened and why it mattered.

It is the durable lesson layer.

This is the part of the old Memory OS that should survive almost intact, but be re-scoped from sessions/missions to apps/runs/workspaces.

### 7.2 What belongs here

- decisions that changed outcomes
- failures and their causes
- successful remediation strategies
- evaluator verdict summaries
- approval outcomes
- repeated patterns worth reusing
- incidents and anomaly explanations
- distilled lessons from runs

### 7.3 What does not belong here

- every token of a conversation
- every intermediate scratchpad mutation
- every raw tool output

Episodic memory must be curated, not exhaustively dumped.

### 7.4 Proposed model

```ts
interface MemoryEpisode {
  id: string;
  workspaceId: string;
  appId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  agentId?: string | null;

  type:
    | 'decision'
    | 'failure'
    | 'recovery'
    | 'success_pattern'
    | 'approval'
    | 'evaluator_outcome'
    | 'incident'
    | 'artifact_outcome'
    | 'distilled_lesson';

  title: string;
  summary: string;
  details?: string | null;

  source:
    | 'run_promotion'
    | 'agent_write'
    | 'operator_write'
    | 'evaluator_write'
    | 'system_write';

  confidence: number;   // 0..1
  importance: number;   // 0..1
  trust: number;        // 0..1

  tags: string[];
  entities: string[];
  outcomeStatus?: 'good' | 'bad' | 'mixed' | null;

  metadata: Record<string, unknown>;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### 7.5 How episodes get created

Episodes should not mostly come from free-form agent writes.

They should come from structured promotion events:

#### Automatic promotion

- run completed successfully with high evaluator confidence
- run failed and a clear root cause was identified
- approval resolved with durable rationale
- repeated remediation pattern confirmed
- artifact outcome validated as useful

#### Manual promotion

- operator marks a lesson as durable
- agent proposes a memory write and the policy engine allows it

### 7.6 Importance and trust

The old Memory OS was right to insist on deterministic importance scoring.
Keep that discipline.

But importance alone is not enough.

Agentis needs three dimensions:

- `importance`: how consequential is this memory
- `confidence`: how likely is it factually correct
- `trust`: how much the runtime should rely on it in future execution

Example:

- operator-confirmed approval rationale:
  - importance high
  - confidence high
  - trust high

- agent-authored speculative lesson:
  - importance medium
  - confidence medium
  - trust low until validated

### 7.7 Retention

Episodes are durable by default.
They may be archived, merged, or superseded, but not silently discarded.

---

## 8. Layer 4: Evaluator And Baseline Memory

### 8.1 Purpose

This layer stores what "good" looks like.

It is separate from generic knowledge because it is operational, not descriptive.

### 8.2 What belongs here

- evaluator rubrics
- positive/negative examples
- approval exemplars
- expected success rate
- expected latency
- expected cost per run
- normal output distributions
- historical performance envelopes

### 8.3 Current implementation anchor

The package types already include strong beginnings:

- `evaluatorRubrics`
- `workflowBaselines`

in [package.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/packages/core/src/types/package.ts)

### 8.4 Why this is memory

Because evaluators improve over time only if they can remember:

- what previously passed
- what previously failed
- what outcomes later turned out to be correct
- what thresholds are normal for this app

### 8.5 Proposed model

```ts
interface EvaluatorExample {
  id: string;
  workspaceId: string;
  appId?: string | null;
  evaluatorKey: string;
  input: unknown;
  output: unknown;
  verdict: 'pass' | 'fail' | 'borderline';
  reason: string;
  confidence: number;
  sourceRunId?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface WorkflowBaselineSnapshot {
  id: string;
  workspaceId: string;
  appId?: string | null;
  workflowId: string;
  window: 'rolling_7d' | 'rolling_30d' | 'rolling_90d';
  successRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgCostMicros: number;
  avgReplayCount: number;
  avgApprovalCount: number;
  evaluatorPassRate: number;
  sampleSize: number;
  createdAt: string;
}
```

### 8.6 Runtime use

This layer must be queryable by:

- evaluators
- policy engine
- cost compiler
- anomaly detection
- self-healing / replan logic

Without this layer, "memory" helps recall facts but not improve performance.

---

## 9. Layer 5: Retrieval Memory

### 9.1 Purpose

Retrieval memory is not a store.
It is the selection and injection layer across all memory planes.

This is where memory becomes execution leverage.

### 9.2 Retrieval inputs

A retrieval request can draw from:

- app knowledge
- episodic memory
- evaluator examples
- baselines
- run-local summaries

### 9.3 Retrieval output

The runtime should return:

```ts
interface InjectedMemoryContext {
  workingSummary?: string;
  knowledgeHits: KnowledgeHit[];
  episodicHits: MemoryEpisode[];
  evaluatorExamples: EvaluatorExample[];
  baselineHints: Array<{
    workflowId: string;
    expectedSuccessRate?: number;
    avgCostMicros?: number;
    p95LatencyMs?: number;
    note?: string;
  }>;
  tokenEstimate: number;
}
```

### 9.4 Retrieval budget

The old Memory OS was correct: memory injection must be budgeted.

Keep explicit memory token budgets, but adapt them to app execution.

Suggested policy:

```ts
const MEMORY_BUDGETS = {
  cheap: 1200,
  balanced: 2500,
  power: 5000,
} as const;
```

### 9.5 Retrieval priority order

Use this order:

1. working summary for current run
2. app-local evaluator examples
3. app-local episodic success/failure patterns
4. app-local knowledge hits
5. workspace-level adjacent knowledge if needed
6. baseline hints

Reason:

- current execution state first
- precedent second
- institutional context third
- global context last

### 9.6 Retrieval ranking

Score each candidate on a blend of:

- semantic relevance
- lexical overlap
- scope proximity
- freshness
- trust
- outcome usefulness

Example:

```text
finalScore =
  semanticScore * 0.35 +
  lexicalScore  * 0.15 +
  trustScore    * 0.20 +
  freshness     * 0.10 +
  scopeMatch    * 0.10 +
  outcomeValue  * 0.10
```

The exact weights can evolve, but the idea matters:

**not all relevant memories are equally safe to inject.**

### 9.7 Injection modes

Support three modes:

- `strict`: only high-trust app-local memory
- `normal`: app-local + limited workspace memory
- `exploratory`: wider retrieval when ambiguity is high

This prevents every run from dragging in too much context.

---

## 10. Memory promotion architecture

### 10.1 Principle

Most useful memory should be promoted from execution, not manually typed.

### 10.2 Promotion pipeline

```text
run state / scratchpad / ledger / evaluator outputs
  -> candidate extraction
  -> scoring
  -> dedupe / contradiction check
  -> episode or evaluator-example write
  -> embedding enqueue
```

### 10.3 Candidate extraction

Candidates should be extracted from:

- evaluator failure summaries
- approval rationales
- replay root causes
- repeated tool failure patterns
- winning output patterns
- final artifact validation

### 10.4 Promotion rules

Promote only if one or more is true:

- approved by a human
- validated by evaluator
- repeated in N runs
- caused a major failure or major success
- exceeds importance threshold

### 10.5 Dedupe and contradiction control

Before writing durable memory:

- search similar existing episodes
- merge if clearly redundant
- mark superseded if contradictory
- lower trust if source is weak

Memory systems rot when they only append and never reconcile.

---

## 11. Agent-written memory policy

### 11.1 Principle

Agents should be allowed to propose memory, not dominate memory.

### 11.2 Trust rules

Agent-written memory starts with capped trust.

Suggested defaults:

- operator/system/evaluator confirmed: trust `0.9-1.0`
- repeated successful pattern: trust `0.7-0.9`
- single agent-authored lesson: trust `0.3-0.6`

### 11.3 High-risk memory

If a memory would affect:

- compliance
- security
- irreversible business action
- budget policy
- approval routing

then either:

- require human confirmation
- or require repeated validated evidence before promotion

---

## 12. Failure behavior

Memory architecture that ignores failure modes is fantasy.

### 12.1 Run working memory unavailable

Response:

- current run pauses or degrades depending on policy
- deterministic nodes may continue if not dependent on state
- agent loops should not blindly continue without working state

### 12.2 Knowledge store unavailable

Response:

- retrieve from cached or app seed knowledge only
- mark run context as degraded
- allow execution only if contract tolerates degraded knowledge

### 12.3 Embedding pipeline unavailable

Response:

- write episodes and examples immediately
- queue embedding retries
- lexical retrieval remains available

### 12.4 Retrieval failure

Response:

- inject empty memory context, not fabricated context
- surface degraded execution status to policy engine

### 12.5 Memory contradiction

Response:

- do not silently overwrite
- mark one or more entries as disputed or superseded
- prefer higher-trust source at retrieval time

---

## 13. What this means for the current repo

### 13.1 Keep

- [scratchpad.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/services/scratchpad.ts)
- [memory.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/routes/memory.ts)
- [knowledgeBase.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/services/knowledgeBase.ts)
- [dataIngestion.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/services/dataIngestion.ts)
- [packager.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/services/packager.ts)
- `knowledgeSeeds`, `evaluatorRubrics`, `workflowBaselines` in [package.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/packages/core/src/types/package.ts)

### 13.2 Evolve

#### Scratchpad

Add:

- namespacing
- compaction
- working summaries
- turn-state structures

#### Memory entries

Evolve from generic note storage into typed episodic memory with trust and promotion semantics.

#### Knowledge base

Upgrade from lexical-first only to hybrid retrieval.

#### Package format

Add:

- `memorySeeds`
- evaluator example seeds
- memory policy config
- retrieval policy config

### 13.3 Add new services

- `apps/api/src/services/memoryPromotion.ts`
- `apps/api/src/services/memoryRetrieval.ts`
- `apps/api/src/services/memoryTrust.ts`
- `apps/api/src/services/evaluatorMemory.ts`
- `apps/api/src/services/workingMemoryCompactor.ts`

### 13.4 Add new core types

In `packages/core/src/types/` add:

- `memory.ts`
- `retrieval.ts`
- `baseline.ts`

These should become canonical contracts shared across runtime, routes, and app packaging.

---

## 14. Proposed minimal data model expansion

Do not explode the schema.

Add only what is necessary:

### Likely needed

- `memory_episodes`
- `memory_episode_embeddings`
- `evaluator_examples`
- `workflow_baseline_snapshots`
- `memory_promotion_events`

### Possibly avoidable for now

- separate huge agent-session transcript tables
- elaborate graph-native memory edge tables
- speculative meta-memory subsystems

This should remain understandable to the team.

---

## 15. Recommended interfaces

```ts
interface IMemoryRuntime {
  // Working memory
  readWorking(runId: string, key: string): Promise<unknown>;
  writeWorking(runId: string, key: string, value: unknown): Promise<void>;
  summarizeWorking(runId: string): Promise<string>;
  compactWorking(runId: string): Promise<void>;

  // Knowledge
  searchKnowledge(params: {
    workspaceId: string;
    appId?: string;
    query: string;
    topK?: number;
    mode?: 'lexical' | 'semantic' | 'hybrid';
  }): Promise<KnowledgeHit[]>;

  // Episodes
  writeEpisode(input: CreateMemoryEpisodeInput): Promise<MemoryEpisode>;
  searchEpisodes(params: {
    workspaceId: string;
    appId?: string;
    query: string;
    topK?: number;
  }): Promise<MemoryEpisode[]>;

  // Evaluator / baseline memory
  writeEvaluatorExample(input: CreateEvaluatorExampleInput): Promise<EvaluatorExample>;
  getBaselines(workspaceId: string, workflowId: string, appId?: string): Promise<WorkflowBaselineSnapshot[]>;

  // Retrieval
  buildContext(params: {
    workspaceId: string;
    appId?: string;
    workflowId?: string;
    runId?: string;
    agentId?: string;
    taskDescription: string;
    mode?: 'strict' | 'normal' | 'exploratory';
    budgetClass?: 'cheap' | 'balanced' | 'power';
  }): Promise<InjectedMemoryContext>;

  // Promotion
  promoteFromRun(runId: string): Promise<void>;
}
```

---

## 16. Phased implementation plan

### Phase 1: Make the current layers coherent

Goal:

- stop treating scratchpad, memory, and knowledge as unrelated features

Work:

- define canonical memory types
- add namespaces to working memory
- add app/workspace scopes to retrieval APIs
- add `memorySeeds` to package format

Exit condition:

- every memory-like structure in the platform has a clear layer and role

### Phase 2: Build durable episodic memory

Goal:

- create the actual lesson layer

Work:

- introduce typed episodes
- add promotion rules
- add trust/importance/confidence fields
- write promotion hooks from runs, approvals, evaluators

Exit condition:

- important outcomes become durable searchable memory without manual copy-paste

### Phase 3: Upgrade retrieval

Goal:

- make memory useful at execution time

Work:

- semantic embedding pipeline
- hybrid search
- token-budgeted context injection
- retrieval ranking with trust and scope

Exit condition:

- memory injected into runs is relevant, bounded, and safe

### Phase 4: Evaluator-backed compounding

Goal:

- make memory actually improve app reliability

Work:

- evaluator example store
- baseline snapshots
- promotion from validated results
- anomaly detection against baselines

Exit condition:

- apps get better because successful patterns and good thresholds are remembered

### Phase 5: Memory-aware cost optimization

Goal:

- make memory reduce spend, not just store context

Work:

- retrieval budget classes
- memory compaction
- model-tier-aware context building
- use memory to avoid redundant reasoning

Exit condition:

- the runtime can show that memory reduced token spend and improved completion quality

---

## 17. What not to do

### Do not confuse logs with memory

Ledger is provenance.
Memory is distilled reusable intelligence.

### Do not let raw transcripts dominate durable memory

That creates cost and confusion, not capability.

### Do not make memory universal by default

App-local memory should be the norm.
Cross-app retrieval should be explicit and policy-driven.

### Do not trust agent-written memory too much too early

Memory without trust policy becomes hallucination preservation.

### Do not retrieve everything

Good memory architecture is as much about exclusion as inclusion.

---

## 18. Final design statement

Agentis memory should not be designed as "chat memory."
It should not be designed as "session memory."
And it should not be designed as "just vector search."

It should be designed as:

**a layered runtime intelligence system for agentic apps**

where:

- working memory powers active execution
- knowledge gives institutional context
- episodic memory captures durable lessons
- evaluator memory defines what good looks like
- retrieval injects only the right intelligence, under budget

That is the architecture that can genuinely make agentic apps:

- more reliable
- more adaptable
- more cost-efficient
- more defensible over time

---

## 19. Recommended next moves

If this document is accepted, the highest-leverage order is:

1. Add `memorySeeds` and canonical memory types.
2. Introduce typed episodic memory plus promotion hooks.
3. Build hybrid retrieval with token-budgeted injection.
4. Add evaluator examples and baseline snapshots as true memory layers.
5. Add memory compaction and trust-aware retrieval.

That is the right synthesis of:

- the strong rigor from the old Persistent Memory OS
- the newer app-centric architecture Agentis is actually becoming

