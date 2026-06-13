# Agentis Brain Plan: PACER + Feynman Reframed For The Real Architecture

> **Implementation status (2026-06-09): SHIPPED.** All phases 0–6 are implemented
> against `main`. See the ground-truth record in
> [`BRAIN_PACER_FEYNMAN_IMPL_LOG.md`](./BRAIN_PACER_FEYNMAN_IMPL_LOG.md), which
> also lists the corrections made to this proposition during implementation.
> The PACER router lives in `apps/api/src/services/brainPacer.ts`; the Feynman
> repair loop in `apps/api/src/services/feynmanReflection.ts`. No store was
> replaced; PACER metadata rides existing JSON columns (no schema change), and
> migration **v62** adds two indexes only.

This document replaces the earlier proposition with a plan that fits the Agentis codebase as it exists now.

## 0.0 PACER → Store Map And Allowed Transitions (the architecture contract)

This is the contract the implementation honors. PACER is a *classification +
routing* discipline over the stores that already exist — not a new table.

| PACER class | Meaning | Primary store(s) | Decay | Merge | Curator |
|---|---|---|---|---|---|
| **P** Procedural | execution rules, repair steps, conventions | `workspace_memory` (operator), agent/workspace `memory_episodes` | resistant (120d leash) | only near-identical (0.96) | high |
| **A** Analogical | "looks like that" — derived later | computed over `memory_episodes` + peer conclusions | cold (30d) | normal (0.90) | medium |
| **C** Conceptual | generalized lessons, decisions+rationale | consolidated `memory_episodes`, `workspace_memory` | resistant (120d leash) | strict (0.93) | high |
| **E** Evidence | grounded observations, run-local facts | `kb_chunks`, `knowledge_chunks`, `session_moments`, staged `memory_episodes` | cold (14d TTL) | free (0.88) | skipped (archival) |
| **R** Reference | stable lookup material | `workspace_memory`, `kb_chunks`, `knowledge_chunks` | resistant (45d) | near-identical (0.97) | low |

**Allowed transitions** (enforced by the pipeline):

- `session moment → staged episodic trace` — via the promotion queue.
- `staged trace → consolidated memory` — ONLY by the FormationJudge, or by
  Phase-3 graduation when a **decay-resistant** trace is retrieved ≥2× / reinforced.
- `evidence → durable concept` — ONLY through explicit formation (FormationJudge
  or Feynman), never by mere existence.
- `repeated failure → procedural/conceptual lesson` — via the Feynman queue job,
  gated on grounding + confidence; otherwise no-op.


The goal is still the same: make Agentis learn durable, reusable intelligence without turning every run, chat, tool result, and document into an expensive LLM summarization problem.

But the implementation path must match the real platform:

- SQLite-first storage
- async brain promotion through `CognitivePromotionQueueWorker`
- deterministic memory gating through `brainFormation.ts`
- lifecycle control through `memoryPolicyResolver.ts`, `BrainMaintenanceService`, and `BrainCompressionService`
- multiple existing memory surfaces instead of one universal "brain bucket"

PACER and the Feynman technique can be useful in Agentis, but only if we treat them as routing and validation policies layered onto the current architecture, not as a new abstract memory system disconnected from the code.

## 1. Executive Position

The previous proposition was right about one thing: Agentis should stay aggressively cost-aware.

It was wrong in three important ways:

1. It treated Agentis as if it had one unified memory substrate. It does not.
2. It implied storage patterns like `pgvector` that do not match the current SQLite-first implementation.
3. It described failure reflection as if the current code already runs a real "explain your understanding" loop. It does not.

So the right move is:

- keep the cost philosophy
- keep deterministic filtering as the default
- keep model work asynchronous and bounded
- reinterpret PACER as a metadata and routing layer over existing stores
- reinterpret Feynman as a staged failure-understanding and repair loop over existing execution paths

## 2. What Agentis Actually Has Today

Agentis already has several distinct memory and knowledge layers. Any brain plan must respect them.

### 2.1 Durable run-learned memory

Primary store: `memory_episodes`

Main write path:

1. `WorkflowEngine` resolves a write policy with `memoryPolicyResolver.ts`
2. It enqueues `atom_promotion` work into `CognitivePromotionQueueWorker`
3. `SharedIntelligenceService.promote()` applies:
   - `none`
   - `episodic_only`
   - `form`
4. `brainFormation.ts` deterministically filters candidate statements
5. If a formation model exists, `FormationJudge` commits typed durable memory
6. If not, candidates are staged as low-confidence `unconsolidated` episodes with TTL

This is already the canonical run-memory architecture.

### 2.2 Operator-authored workspace context

Primary store: `workspace_memory`

This is the constitutional layer:

- workspace rules
- architectural decisions
- workflow conventions
- operator corrections and preferences captured from chat

This is not the same as learned run memory and should not be merged into it.

### 2.3 Session-local ephemeral context

Primary store: `session_moments`

This is short-lived, per-conversation memory:

- recent operator signals
- session-local continuity
- retrieval inside the current conversation
- optional promotion later through the queue

This is the closest thing Agentis has to "working memory traces."

### 2.4 Uploaded and imported knowledge

Primary stores:

- `kb_chunks`
- `knowledge_chunks`

These are evidence and retrieval substrates, not inherently durable "beliefs."

They already support:

- lexical retrieval
- vector or hybrid retrieval when embeddings exist
- optional enrichment for summaries, context prefixes, key facts, and entities

### 2.5 Personal and agent-private memory

Primary stores:

- `user_notes`
- agent-scoped `memory_episodes` where `scopeId = agentId`

These are private memory surfaces, not shared workspace truth.

## 3. Architectural Principles For The Real Brain

### 3.1 No eager universal summarization

Cold data should not be summarized just because it exists.

That means:

- no blanket LLM condensation of tool logs
- no blanket LLM condensation of uploaded documents
- no blanket LLM condensation of all run outputs

Instead:

- transient outputs stay transient
- evidence stays retrievable
- only high-value reusable knowledge graduates into durable memory

### 3.2 Deterministic first, model second

Agentis already has the right shape here:

- `memoryPolicyResolver.ts` blocks whole classes of transient output from forming memory
- `brainFormation.ts` removes structural garbage before any model step
- `runFailureAnalysis.ts` explains known failure patterns without using a model
- `AgentToolLoop` and chat execution already clip oversized tool observations

The platform should keep extending this pattern.

### 3.3 Async expensive work, never inline by default

Anything involving:

- durable memory formation
- cluster curation
- reflective repair
- re-embedding
- dream-pass style inference

should run through the queue or another durable background worker unless the UX explicitly requires an inline answer.

### 3.4 PACER is a routing model, not a storage rewrite

PACER should help Agentis decide:

- what kind of knowledge something is
- where it should live
- how aggressively it should be retrieved
- whether it should decay

It should not require a brand-new central memory engine.

### 3.5 Feynman is a validation policy, not a poetic slogan

In Agentis terms, "Feynman" should mean:

- when something fails or is repeatedly confusing, force a compact explanation
- compare the explanation to real state
- if the explanation is weak, retrieve the missing context before retry

That is a concrete execution behavior, not a generic prompt philosophy.

## 4. PACER Mapped To Current Agentis Stores

PACER should be implemented as metadata plus routing over the stores that already exist.

## 4.1 P = Procedural

What it is:

- execution rules
- repeatable repair steps
- tool usage constraints
- operational instructions
- workflow conventions

Where it belongs:

- `workspace_memory` when operator-authored or platform-constitutional
- agent-scoped `memory_episodes` when a specific agent learns a reusable execution lesson
- workspace-scoped `memory_episodes` when a run proves a reusable platform-wide procedure

How it should be retrieved:

- high priority in dispatch context
- favored for agent-task execution
- should reinforce on successful reuse

Examples:

- "Always fetch credentials through native integration wiring, not inside agent prose."
- "When the build step fails validation, patch the missing node config before retrying the run."

## 4.2 A = Analogical

What it is:

- similarities between previous and current situations
- "this failure looks like that earlier outage"
- "this agent profile resembles prior behavior from another thread"

Where it belongs:

- usually not as a first-class ingestion result
- derived later from retrieval, reflection, or dream-pass style synthesis

How it should be implemented:

- as a computed reasoning layer over `memory_episodes`, peer conclusions, and knowledge chunks
- possibly persisted as low-frequency derived conclusions only after repeated support

This is not a `brainFormation.ts` regex problem.

## 4.3 C = Conceptual

What it is:

- generalized rules
- decisions with rationale
- invariant-like lessons
- failure-to-fix abstractions

Where it belongs:

- consolidated `memory_episodes`
- operator-authored `workspace_memory` when it is explicit policy

How it should be retrieved:

- strongly favored in the durable brain context
- reinforced by evaluator verdicts and successful dispatch reuse

This is the main target of `FormationJudge`.

## 4.4 E = Evidence

What it is:

- grounded observations
- retrieved passages
- run-local facts
- document excerpts
- messages that support a later belief but are not themselves a reusable rule

Where it belongs:

- `kb_chunks`
- `knowledge_chunks`
- `session_moments`
- low-confidence `unconsolidated` episodes when promotion fallback is used

How it should be treated:

- searchable
- linkable
- decaying when session-local
- not automatically promoted into long-term "truth"

## 4.5 R = Reference

What it is:

- stable lookup material
- docs, API notes, file paths, identifiers, configuration surfaces
- workspace conventions and known system inventory

Where it belongs:

- `workspace_memory`
- `kb_chunks`
- `knowledge_chunks`
- selected operator-authored notes

Reference data should remain exact and cheap, not over-distilled into fuzzy memory.

## 5. The Correct Write Policy By PACER Class

The current system already has three write policies:

- `none`
- `episodic_only`
- `form`

PACER should refine how those policies are applied and how the resulting rows are tagged.

### 5.1 `none`

Use when output is empty or purely transient noise.

Examples:

- empty results
- status chatter
- formatting wrappers
- obvious boilerplate

### 5.2 `episodic_only`

Use when output is a transient artifact or session trace.

Examples:

- digests
- newsletters
- reports
- homogeneous result lists
- one-off session moments
- bulky retrieved evidence

This policy already exists and is correct for much of PACER-E and PACER-R cold material.

### 5.3 `form`

Use only when there is a realistic chance of durable reusable knowledge.

Examples:

- procedural rules
- conceptual lessons
- failure-to-fix patterns
- stable operator guidance

This is where PACER-P and PACER-C primarily live.

## 6. Feynman Reframed For Current Agentis

Agentis should not run "explain everything in simple terms" on every task. That would be expensive and noisy.

It should apply Feynman-style validation only when understanding quality matters.

## 6.1 Level 0: Deterministic failure explanation

Already exists in `runFailureAnalysis.ts`.

This should remain the first line of explanation for failed runs:

- grounded in real node state
- grounded in real errors
- no hallucination risk
- zero model cost

## 6.2 Level 1: Self-heal retry with explicit error context

Already exists in `WorkflowEngine` for agent tasks with self-heal enabled.

This is a primitive Feynman loop:

- previous attempt failed
- the agent sees the error
- the agent is asked to correct itself

This can be improved, but it is already a real architectural hook.

## 6.3 Level 2: Failure lesson persistence

Already exists in `FailureReflectionService`, but today it is shallow.

Today it writes a canned lesson like:

- verify assumptions
- verify inputs
- use a smaller validation step

That is useful, but not enough.

## 6.4 Level 3: Proposed real Feynman repair loop

Future enhancement:

After:

- deterministic diagnosis fails to resolve the issue, or
- self-heal retries are exhausted, or
- the same node fails repeatedly across runs

enqueue a new reflective job that:

1. gathers the failed node prompt, input, error, and recent tool observations
2. asks for a short structured explanation:
   - what failed
   - why it failed
   - what assumption was wrong
   - what to verify before retry
3. validates whether the explanation references real evidence
4. stores either:
   - a procedural lesson, or
   - a failure pattern, or
   - nothing if confidence is weak

This should be a queue job, not an inline workflow tax.

## 7. The Storage And Retrieval Reality

Any robust plan must accept these realities:

### 7.1 SQLite is the current truth

Agentis is SQLite-first today.

Embeddings are stored as JSON arrays in SQLite tables. That is fine for the current architecture.

Do not plan around `pgvector` as if it were already the platform default.

### 7.2 Hashing embeddings are a first-class fallback

Agentis already ships a zero-dependency hashing embedding provider.

That means:

- local installs remain cheap
- semantic quality can improve when external providers are configured
- the system degrades gracefully instead of failing closed

### 7.3 Retrieval is already multi-surface

Agentis retrieves from different places for different reasons:

- dispatch brain context
- session moments
- personal brain
- workspace charter
- knowledge bases

PACER should improve retrieval ranking and routing across those surfaces, not try to collapse them into one table.

## 8. Concrete Implementation Plan

This is the recommended roadmap if we want PACER + Feynman to become real inside current Agentis.

## Phase 0: Formalize The Architecture Contract

Goal: define PACER and Feynman in Agentis terms before adding more heuristics.

Deliverables:

- add PACER definitions to brain docs
- define which current stores map to which classes
- define allowed transitions:
  - session moment -> episodic trace
  - episodic trace -> consolidated memory
  - evidence -> durable concept only through explicit formation

No schema change required.

## Phase 1: Add PACER Metadata To Existing Writes

Goal: classify what is being written without changing the underlying storage model.

Changes:

- extend promoted `memory_episodes.metadata` with:
  - `pacerClass`
  - `originSurface`
  - `formationMode`
- extend `workspace_memory.provenance` similarly where useful
- add deterministic source-aware routing before `brainFormation.ts`

Important constraint:

This classification should happen before code fences and structure are stripped, otherwise procedural and reference signals are lost.

Likely files:

- `WorkflowEngine.ts`
- `sharedIntelligence.ts`
- `chatMemoryCapture.ts`
- `sessionMomentService.ts`

## Phase 2: Source-Aware Routing Instead Of Regex-Only Routing

Goal: stop asking `brainFormation.ts` to infer everything from final flattened prose.

New routing signals should include:

- node kind
- agent role
- source surface
- whether content came from:
  - tool output
  - operator chat
  - knowledge ingest
  - session-local conversation
  - run completion

Desired outcomes:

- procedural candidates become easier to preserve correctly
- evidence candidates stay cold by default
- reference candidates are routed to exact stores, not generalized prematurely

## Phase 3: Retrieval And Reinforcement As Promotion Signals

Goal: make "usefulness over time" matter more than one-time existence.

Today:

- maintenance and compression use staleness, confidence, and clustering
- retrieval updates `lastAccessedAt`
- evaluator verdicts can reinforce injected atoms

Next step:

- add retrieval frequency and successful reuse as promotion/reinforcement signals
- make repeated useful staged traces more likely to consolidate
- make never-retrieved traces cheaper to expire

This is the right place for a practical version of "lazy summarization."

Do not summarize because something was stored.
Summarize or consolidate because it keeps proving useful.

## Phase 4: Real Feynman Reflection Jobs

Goal: convert repeated failure into grounded repair knowledge.

Add a new queue item type for reflective repair.

Trigger conditions:

- self-heal exhaustion
- repeated same-node failure
- contradiction between expected and actual tool result

Output options:

- procedural lesson
- conceptual lesson
- no-op when confidence is weak

Storage target:

- agent-scoped `memory_episodes` when the lesson is specialist-specific
- workspace-scoped `memory_episodes` when it is platform-general

## Phase 5: Compression And Curation Become PACER-Aware

Goal: compression should respect memory class, not only confidence and similarity.

Current compression is already useful:

- tier 1 archive stale, low-confidence managed rows
- tier 2 merge embedding-near duplicates
- tier 3 enqueue curation when clusters get large

Enhancements:

- do not merge procedural rules as aggressively as generic observations
- keep evidence clusters archival and retrievable
- prioritize conceptual and procedural atoms for curator distillation
- use PACER metadata inside curator pass prompts and cluster decisions

## Phase 6: UI And Observability

Goal: operators should see what the brain is doing.

Add visibility for:

- PACER class on atom detail
- source surface
- staged vs consolidated state
- why something was archived
- why something was promoted
- reflective repair jobs and their outputs

This is important because the brain should be inspectable, not mystical.

## 9. Specific Non-Goals

To avoid architectural drift, this plan explicitly does not propose:

- replacing SQLite with PostgreSQL as a prerequisite
- introducing a mandatory `pgvector` dependency
- summarizing all tool outputs
- summarizing all uploaded documents
- replacing existing stores with one new "brain table"
- pushing reflective diagnostics into every normal run

## 10. Recommended File-Level Work Map

If this plan is executed, the likely touch points are:

### Core promotion and routing

- `apps/api/src/engine/WorkflowEngine.ts`
- `apps/api/src/services/memoryPolicyResolver.ts`
- `apps/api/src/services/sharedIntelligence.ts`
- `apps/api/src/services/brainFormation.ts`
- `apps/api/src/services/cognitivePromotionQueueWorker.ts`

### Failure understanding

- `apps/api/src/services/runFailureAnalysis.ts`
- `apps/api/src/services/failureReflection.ts`
- `apps/api/src/engine/WorkflowEngine.ts`

### Session and chat memory

- `apps/api/src/services/chatMemoryCapture.ts`
- `apps/api/src/services/sessionMomentService.ts`
- `apps/api/src/services/brainDiscourseService.ts`

### Knowledge and evidence routing

- `apps/api/src/services/knowledgeStore.ts`
- `apps/api/src/services/knowledgeBase.ts`
- `apps/api/src/services/brainEnrichment.ts`

### Lifecycle and curation

- `apps/api/src/services/brainMaintenanceService.ts`
- `apps/api/src/services/brainCompressionService.ts`

### Schema and rendering

- `packages/db/src/sqlite/schema.ts`
- relevant brain UI panels in `apps/web/src/components/brain/`

## 11. Final Recommendation

Agentis should adopt PACER and Feynman only in this grounded form:

- PACER as a routing and metadata discipline across existing memory surfaces
- Feynman as a failure-understanding and repair discipline attached to real run failures

That keeps the good part of the original idea:

- cheap
- structured
- durable
- scalable for small teams

while staying honest about the current system:

- multiple memory layers
- queue-based promotion
- SQLite-first storage
- deterministic gating
- optional model enrichment, not mandatory model dependency

This is the architecture Agentis can actually build now.
