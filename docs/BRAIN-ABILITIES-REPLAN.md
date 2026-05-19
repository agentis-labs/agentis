# Agentis — Brain & Abilities Architecture Replan

> **Status:** Active architecture planning — May 2026 (v2, post-validation revision)
> **Trigger:** Deep audit of NousResearch/hermes-agent intelligence architecture compared to
> Agentis's current `CollectiveBrain`, `IntelligencePromotion`, and agent dispatch pipeline.
> Synthesizes: external Hermes/Honcho research (16 gap areas), codebase broken-loop audit
> (12 items), multi-tenancy pricing of personal-agent patterns, and brutal validation findings.
> **v2 Changes:** Corrected Honcho representation; 4 new gaps; 3 new broken loops; Full Honcho
> dialectic moved from Deferred to Priority 3; durable promotion queue added; evaluator-brain
> feedback loop elevated; peer-relational modeling added; operator UX fully specified.

---

## Preface — What Changed in This Revision

The v1 document correctly identified gaps and broken loops. This revision corrects seven
fundamental problems with that analysis.

### What Was Wrong in v1

**1. Honcho misrepresentation.** Honcho is not a feature of Hermes. It is a separate
product — memory-as-infrastructure built by Plastic Labs — that Hermes optionally
integrates as one of its 8 memory providers. Honcho's actual core insight (peer-relational
modeling) was entirely absent from v1.

**2. Single-user patterns not priced for multi-tenancy.** Hermes runs one session at a
time. Every "fire a background LLM pass" pattern is safe in that context. In Agentis, 10+
concurrent workflows mean 10+ concurrent background passes competing for rate limits.
This was not addressed.

**3. No evaluation feedback loop.** The plan built a write path and a read path but no
quality validation. You cannot know if the brain is helping or hurting without measuring it.

**4. Promotion queue not durable.** `queueMicrotask` is not a job queue. If the process
restarts between the call and execution, the promotion is silently lost.

**5. `extractPromotableFacts` quality.** The current sentence-splitting heuristic (max 6
declarative sentences, 35–360 chars) is architecturally broken. It is producing low-quality
atoms in production right now.

**6. Full Honcho dialectic was wrongly deferred.** Per-turn synthesis is the mechanism that
closes the gap between "brain has atoms" and "agents behave differently." Without it,
operators cannot see the brain working and cannot trust it.

**7. UX was unspecified.** How operators discover, review, and trust what agents learn was
never designed. Events fire into voids.

### What This Revision Adds

- **4 new gaps** (13–16): Peer-relational memory, Evaluation feedback loop, Concurrent run
  convergence, Ambient operator signal
- **3 new broken loops** (10–12): Promotion queue not durable, Extractor produces low-quality
  atoms, Background review unsafe at concurrent scale
- **New Part V**: Full Honcho dialectic integration — moved from Deferred to Priority 3
- **New Part VI**: Operator Brain UX — ambient signals, trust review, brain health dashboard
- **New Appendix B**: Durable promotion queue architecture
- **New Appendix C**: Brain quality metrics and validation gates
- **Updated build plan**: Validation gates between phases; reordered to prevent building on
  broken foundations

---

---

## Part I — Hermes vs Agentis: Full Gap Analysis

### Critical Context: What These Systems Actually Are

**Hermes** (NousResearch/hermes-agent, v0.14.0, 156k stars, 1,072 contributors) is a
**single-user personal CLI assistant**. One user. One session at a time. `MEMORY.md` capped
at 2,200 chars for that one person. Skills live on that one machine's filesystem. Its entire
memory architecture assumes zero concurrency and intimate user knowledge.

**Honcho** (plastic-labs/honcho, 3.6k stars) is **memory-as-infrastructure** — a separate
FastAPI server with Python and TypeScript SDKs, a managed API at `api.honcho.dev`, and a
background reasoning deriver worker. Hermes uses Honcho as one of its 8 optional memory
provider plugins. They are **independent products with different architectural models**.
Honcho's core thesis: every participant in a conversation is a `Peer` — human or AI — and
the system tracks what each peer knows about every other peer.

**Agentis** is a **multi-tenant workflow orchestration platform**. Multiple workspaces,
multiple apps, multiple agents, N concurrent runs. Every pattern borrowed from Hermes
carries a multi-tenancy price that must be explicitly paid.

Research basis: NousResearch/hermes-agent v0.14.0 — codebase audit of `memory_tool.py`,
`background_review.py`, `curator.py`, `skill_manager_tool.py`, `skill_usage.py`,
`skill_provenance.py`, `honcho/`, `context_compressor.py`, `run_agent.py`, `prompt_builder.py`.
Honcho v3 audit of `src/`, `sdks/`, README, and API reference.

### Summary Table

| Dimension | Hermes | Honcho (separate product) | Agentis | Gap |
|---|---|---|---|---|
| Procedural knowledge | SKILL.md files, agent-created | N/A (infra) | None | Critical |
| Post-run learning | LLM fork after every session | N/A | Jaccard keyword extractor | High |
| Periodic maintenance | Curator: LLM, 7-day cycle | N/A | `isStale` flag only | High |
| User modeling | USER.md (bounded profile) | Peer representations | None | High |
| Per-turn context synthesis | Honcho dialectic (via Honcho API) | Conclusions + Chat endpoint | None | **High** |
| In-context memory | MEMORY.md frozen at session start | N/A | Brain only via explicit node | High |
| Session search | FTS5 all transcripts | Session search + summaries | No index | High |
| Skill lifecycle states | active → stale → archived + pinned | N/A | Computed `isStale` only | Medium |
| Memory backends | 8 provider plugins | Pluggable LLM providers | Fake hash embeddings | Critical |
| Auxiliary LLM | Separate cheap model | Background deriver worker | Main model for everything | High |
| Provenance isolation | ContextVar per-context | N/A | Source label (string enum) | Low |
| Capacity gauge | `[67% — 1,474/2,200 chars]` in prompt | N/A | No budget signal | Medium |
| **Peer-relational modeling** | None | **Core product** | None | **Critical** |
| **Evaluation feedback loop** | None | None | Exists but disconnected | **High** |
| **Concurrent run convergence** | N/A (single-user) | Background queue + dedup | None | **High** |
| **Promotion queue durability** | File-based sync | PostgreSQL + deriver worker | `queueMicrotask` volatile | **High** |

---

### Gap 1 — Procedural Skills Store (SKILL.md)

**What Hermes built:**

Skills are Markdown documents with YAML frontmatter in `~/.hermes/skills/`. The
`skill_manage` tool gives agents 6 actions: `create`, `patch` (preferred — find/replace),
`edit` (full rewrite), `delete`, `write_file`, `remove_file`. Each skill can have
three types of supporting files:

- `references/<topic>.md` — condensed knowledge banks, API quirks, session transcripts
- `templates/<name>.ext` — boilerplate files meant to be copied
- `scripts/<name>.sh/.py` — runnable scripts the agent can invoke

Skills are loaded **on demand by relevance** — zero token cost for irrelevant skills.
The guidance enforces a critical distinction: skills must be **class-level** (how to
do a type of task), not **session-level** (what happened in one run).

**What Agentis has:** Nothing. Workflows are execution graphs. Brain atoms are factual
observations. There is no way for an agent to write and maintain procedure documents.

**Build verdict:** YES — as "Abilities." See Part III.

---

### Gap 2 — Background Self-Improvement Review (per-session)

**What Hermes built:**

After every session with 5+ tool calls, a **forked auxiliary AIAgent** runs in a
background thread using the cheap auxiliary model. It reviews the session transcript
and creates/patches skills. User sees: `💾 Self-improvement review: Skill 'X' created.`

Priority ordering baked into the prompt:
1. Update a currently-loaded skill (patch in context)
2. Update an existing umbrella skill (look up with `skills_list` + `skill_view`)
3. Add a support file to an existing umbrella
4. Create a new umbrella skill (last resort)

User-preference corrections embed into the governing skill: "frustration is a
FIRST-CLASS skill signal." Skills created by this fork get `created_by: "agent"`
provenance via a `ContextVar` in `skill_provenance.py`.

**What Agentis has:** `extractAndPromote()` uses Jaccard keyword overlap. No LLM
reasoning, no conscious reflection, no class-vs-session discipline.

**Multi-tenancy constraint:** Hermes fires one background call per session (one user,
one session). Agentis must queue background reviews and process them with rate-limiting
and priority ordering. See Broken Loop 12 and Appendix B.

**Build verdict:** YES — with durable queue and rate limiting. See Part IV + Appendix B.

---

### Gap 3 — Autonomous Curator (periodic library maintenance)

**What Hermes built:**

A separate auxiliary AIAgent runs every 7 days. Not about creating skills — about
maintaining the library with an **umbrella-building** prompt: "A collection of hundreds
of narrow skills is a FAILURE."

Operations:
- **Merge into umbrella** — patch with labeled subsections, archive siblings
- **Create umbrella** — when no existing member is broad enough
- **Demote to support file** — move narrow content into `references/`/`templates/`

Telemetry sidecar (`.usage.json`): per-skill `use_count`, `view_count`, `patch_count`,
`last_used_at`, `state` (active/stale/archived), `pinned`. Atomic writes via
tempfile + `os.replace`. Pre-run tar.gz snapshot of skills directory (rollback support).

Hard invariants: never touches bundled/hub skills, never auto-deletes (archive only),
pinned skills are exempt from all transitions.

**What Agentis has:** No lifecycle management of any brain atoms.

**Build verdict:** PARTIAL — implement atom decay + lifecycle states first, full LLM
maintenance pass as a follow-up. See Part IV, Upgrade 6.

---

### Gap 4 — User Modeling (USER.md)

**What Hermes built:**

Two completely separate bounded stores:
- `MEMORY.md` (2,200 chars) — notes about the world: environment facts, conventions, quirks
- `USER.md` (1,375 chars) — notes about the human: name, role, timezone, pet peeves,
  communication preferences, workflow habits

Both frozen into the system prompt at session start. The split is conceptually critical:
memory is about the world; user profile is about the person.

**What Agentis has:** No user profile layer. Memory atoms are workspace-scoped facts.
No concept of what agents know about a specific operator across conversations.

**Build verdict:** YES — `workspace_user_profiles` table, `user_profile` atom kind,
visible and editable by the operator in Settings. See Part IV, Upgrade 5.

---

### Gap 5 — Honcho Dialectic: Per-Turn Context Synthesis

**What Hermes does (via Honcho integration):**

Hermes uses Honcho's `session.context()` and `peer.chat()` APIs as an optional memory
provider. Every `contextCadence` turns, Honcho injects a context bundle into the USER
MESSAGE (not system prompt — preserves prefix cache stability):
1. Session summary
2. User representation (Honcho's evolving conclusion about this user)
3. User peer card (compact identity summary)
4. AI self-representation
5. AI identity card

Every `dialecticCadence` turns, an additional multi-pass LLM synthesis over Honcho
conclusions produces "what matters right now about this user for this conversation."
Cold start vs. warm session auto-selection. `dialecticDepth` 1–3 passes.

**What Honcho actually provides (as standalone infrastructure):**

Honcho's `peer.chat(question)` answers natural-language questions about any peer from
all their sessions. `session.context()` returns a prompt-ready bundle. The background
deriver worker extracts conclusions from stored messages asynchronously. Hybrid search
(BM25 + vector) across all peer sessions. This is infrastructure that any application
can use — not something bundled into Hermes.

**What Agentis has:** Nothing. Brain atoms retrieved via static query, no synthesis.

**This was deferred in v1. It must not be deferred.** Per-turn synthesis for the App Brain
conversation surface is the observable proof that memory is functioning. Without it,
operators who talk to the App Brain see generic responses even though the workspace has
200 brain atoms. See Part V.

**Build verdict:** YES — per-task frozen context for workflow agents; per-turn dialectic
for the App Brain conversation surface. See Part V.

---

### Gap 6 — Always-in-Context Frozen Snapshot + Prefix Cache Stability

**What Hermes built:**

`MemoryStore` maintains two parallel states:
- `_system_prompt_snapshot` — frozen at `load_from_disk()`, never mutated mid-session
- Live state — mutated by tool calls, written to disk immediately

Mid-session writes update live state and disk, NOT the system prompt. The snapshot
refreshes only at next session start. This is a deliberate design for **Anthropic
prefix cache stability**: the system prompt never changes, so the cache hits every
turn.

The system prompt includes a capacity gauge: `MEMORY [67% — 1,474/2,200 chars]`.
The agent manages its own budget and consolidates when full.

**What Agentis has:** Brain atoms are only available via explicit `brain_lookup` node.
No in-context brain representation at agent dispatch. No token budget, no stable prefix
injection.

**Build verdict:** YES — implement as a frozen context block injected at agent task
dispatch. See Part IV, Upgrade 3 and Broken Loop 2.

---

### Gap 7 — FTS5 Session Search (cross-session recall)

**What Hermes built:**

Every conversation transcript stored in SQLite with FTS5 full-text indexing. The
`session_search` tool lets agents query across all past sessions:
- **Discovery**: "did we discuss X in a prior session?"
- **Scroll**: paginate a specific session
- **Browse**: list sessions chronologically

Session lineage tracking (parent/child across compressions). Per-platform isolation.
Atomic writes with contention handling.

Key insight from Hermes's own docs: **memory is for facts you always want in context;
session search is for facts you only need when asked.** Complementary, not redundant.

**What Agentis has:** `app_results_fts` FTS5 table exists. `ledger_events` and
`conversation_messages` have no FTS index. Agents cannot search prior run history.

**Implementation constraint:** `ledger_events.payload` is a JSON blob. FTS5 cannot
index JSON directly. Strategy: add a `payloadText TEXT GENERATED ALWAYS AS
(json_extract(payload, '$.content') || ' ' || json_extract(payload, '$.output'))
STORED` generated column, then FTS5 on that column. `conversation_messages.content`
can be indexed directly.

**Build verdict:** YES — with proper JSON text extraction via generated columns.
See Priority 3.

---

### Gap 8 — Skill/Atom Lifecycle States

**What Hermes built:**

Three explicit states: `active → stale → archived`. Transitions:
- `active → stale`: `stale_after_days` threshold (no use/view/patch activity)
- `stale → archived`: `archive_after_days` threshold
- Never auto-deletes — archive is fully recoverable

`pinned` flag orthogonal to state — exempt from all auto-transitions but patchable.
`last_activity_at` = max(last_used_at, last_viewed_at, last_patched_at).

**What Agentis has:** `isStale` is a computed read-time boolean (90 days since
`updatedAt`). No `archived` state, no lifecycle transitions, no `pinned` protection,
no background job. See also Broken Loop 5.

**Build verdict:** YES — expand atom lifecycle. See Part IV, Broken Loop 5 + Upgrade 6.

---

### Gap 9 — Memory Provider Plugin System

**What Hermes built:**

A formal `MemoryProvider` ABC with defined hooks:
- `on_session_start(session_id)`
- `prefetch(conversation_so_far)`
- `get_context() → str`
- `on_session_end(messages)`
- `on_memory_write(action, target, content)`
- `on_tool_call(tool_name, args, result)`

Single-select: only one provider active at a time. 8 built-in providers: Honcho,
OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory. Each
implements a different retrieval strategy: semantic vectors, knowledge graphs, tiered
loading, dialectic reasoning.

OpenViking's tiered loading: L0 (~100 tokens, always loaded), L1 (~2k, on medium
queries), L2 (full, only when needed).

**What Agentis has:** `EmbeddingProvider` ABC exists with only `HashingEmbeddingProvider`
(fake TF-IDF, not real embeddings). No pluggable memory backend.

**Build verdict:** YES — wire real embeddings first (single highest-leverage change),
plugin system after. See Part IV, Broken Loop 4 + Upgrade 4.

---

### Gap 10 — Auxiliary LLM Client Architecture

**What Hermes built:**

A dedicated `auxiliary_client.py` maintains a separate LLM configuration — typically
a cheaper, faster model — for background tasks:
- Background self-improvement review
- Curator LLM pass
- Vision tasks
- Context summarization
- Honcho dialectic synthesis

Configured independently via `hermes model` (separate "auxiliary" slot). Background
tasks never touch the main session's prompt cache.

**What Agentis has:** All LLM calls go through the agent's adapter. Self-healing,
extractAndPromote, evaluator LLM calls all use the same expensive adapter.

**Build verdict:** YES — `auxiliaryAdapter` field on workspace configuration.
See Part IV, Upgrade 5.

---

### Gap 11 — Provenance Isolation (foreground vs background writes)

**What Hermes built:**

`skill_provenance.py` uses a Python `ContextVar` to tag the current execution context.
When the background review fork runs, the ContextVar is set to `"background_review"`.
Only background-review creates get `created_by: "agent"` → only those are
curator-managed. User-directed skills are protected from all curator operations.

**What Agentis has:** `source` label on atoms (`run_promotion`, `operator_write`,
`seed`, `evaluator_write`, `agent_write`) exists but decay rules apply identically
to all sources. See also Broken Loop 6.

**Build verdict:** PARTIAL — formalize via `managed: boolean` field. `managed: true`
atoms (auto-promoted) are eligible for decay. `managed: false` atoms (operator-written)
are never auto-archived. See Part IV, Broken Loop 6.

---

### Gap 12 — Capacity Gauge and Budget Feedback

**What Hermes built:**

Every time memory appears in the system prompt:
```
══════════════════════════════════════════════
MEMORY (your personal notes) [67% — 1,474/2,200 chars]
══════════════════════════════════════════════
```

The agent sees its budget, knows it's at 67%, and can decide to consolidate before
adding more. This creates a self-regulating system: the agent is its own quality
controller because running out of space has a cost.

**What Agentis has:** No token budget feedback to agents. The brain can grow
unboundedly. Agents have zero visibility into what brain context exists or how much
is relevant. See also Broken Loop 7.

**Build verdict:** YES — but requires brain management tools in the agent tool registry
so agents can act on it. See Part V + Broken Loop 7 (updated).

---

### Gap 13 — Peer-Relational Memory (Honcho's Core) ★ NEW

**What Honcho built:**

Honcho's fundamental model: every participant is a `Peer` — humans AND AI agents — and the
system tracks what each peer knows about every other peer.

```python
alice = honcho.peer("alice")    # operator
tutor = honcho.peer("tutor")    # AI agent
session = honcho.session("s-1")
session.add_messages([alice.message("..."), tutor.message("...")])

# Relational queries:
alice.chat("What learning styles does this user respond to best?")
session.context(summary=True, tokens=10_000)
```

Key capabilities: peer representations (what Honcho extracted about `alice`), multi-peer
perspective (what `tutor` knows about `alice`), peer cards (compact identity summaries),
cross-session conclusions (deductively and inductively extracted facts), background deriver
worker (async, processes message queues).

**What Agentis has:** Brain atoms are facts about the world. There is no model of:
- What agents know about operators
- How an operator's communication style has evolved across 200 conversations
- What the SDR researcher knows about the copywriter's task performance
- What the evaluator has observed about a specific agent role over time

**Consequence:** The App Brain conversation surface delivers generic responses even with
a populated workspace brain. There is no concept of "who is this operator" — every
conversation restarts from zero relational context.

**Fix:** Introduce `peer_representations` table. Operators and agents are both peers.
The App Brain conversation surface queries the operator's peer representation at every
turn. See Part V.

**Build verdict:** YES — Priority 3, foundational to per-turn dialectic.

---

### Gap 14 — Evaluation-to-Brain Feedback Loop ★ NEW

**What exists in Hermes/Honcho:** Neither has evaluator machinery. This is actually a
place Agentis is architecturally ahead. The feedback loop needs to be built, not borrowed.

**What's broken in Agentis:** The evaluator system (`EvaluatorRuntime`, rubrics,
`app_promoted_patterns`, confidence scoring) is completely disconnected from the brain.
When an evaluator marks a run `PASS` at 0.92 confidence, the brain atoms injected into
that run are not reinforced. When a run is marked `FAIL`, contributing atoms are not
penalized. Promotion flows forward (run → brain) but never backward (evaluator → brain
quality). The brain is a write-only system with no quality gradient.

**Consequence:** Within weeks of high-volume usage, the brain will contain high-confidence
atoms that actively degrade performance alongside low-confidence atoms that are genuinely
useful, with no mechanism to distinguish them.

**Fix:** At evaluator verdict time, look up which atoms were injected into the run
(stored in `activeExecutions[node.id].injectedAtomIds`) and apply a confidence delta:
- `PASS` verdict → +0.04 to each injected atom
- `PASS` (evaluatorConfidence > 0.85) → +0.08 to top-3 atoms by relevance score
- `FAIL` verdict → −0.06 to each injected atom
- Atoms below 0.05 confidence → archive automatically

**Build verdict:** YES — Priority 1. This is the missing feedback loop that makes the
brain self-regulating rather than just self-expanding.

---

### Gap 15 — Concurrent Run Convergence ★ NEW

**What Hermes has:** Single user, single session. No concurrency.

**What Agentis needs:** When 5 concurrent SDR Engine runs all produce promotion candidates,
the system must handle three failure modes:

1. **Duplicate creation race:** Run A and Run B both detect the same concept at the same
   time. Both call `extractAndPromote`. Both check "does this atom exist?" before inserting.
   Both see "no." Both create. Result: two semantically identical atoms.

2. **Contradiction convergence:** Run A learns "short subject lines → 2x reply rate" from
   segment X. Run B learns "personalized long subject lines → 3x reply rate" from segment Y.
   Both are true in different contexts. The system creates two contradicting atoms with no
   reconciliation mechanism.

3. **Reinforcement collision:** Run A and Run B both reinforce the same atom simultaneously.
   Confidence delta applied twice. Atom is over-reinforced.

**Current protection:** None. `queueMicrotask` fires immediately, SQLite serializes
individual writes, but the deduplication check happens in-memory before the write.

**Fix:** A durable promotion queue serializes all promotion candidates per `workspaceId`.
The queue worker processes one item at a time per workspace, eliminating cases 1 and 3.
Contradiction detection in the LLM promoter handles case 2 by creating a `contradicts`
link and setting both atoms to `isDisputed: true`. See Appendix B.

**Build verdict:** YES — queue addresses cases 1 and 3; contradiction detection addresses 2.

---

### Gap 16 — Ambient Operator Learning Signal ★ NEW

**What Hermes has:**
```
💾 Self-improvement review: Skill 'B2B Prospect Research' created.
🔄 Self-improvement review: Skill 'Cold Email Approach' updated.
```
Inline in the CLI conversation. Users always know when agents learn.

**What Agentis has:** `BRAIN_ATOM_CREATED`, `BRAIN_ATOM_REINFORCED`, `BRAIN_LINK_CREATED`
realtime events exist and are emitted. There is no consuming UI element. They fire into
the void. Operators who set up Agentis have zero observable evidence that the brain
exists or is growing.

**Consequence:** The entire memory architecture is invisible. Operators cannot trust what
they cannot see. Without visibility, they cannot fix incorrect learnings before they cause
damage. The value proposition "agents that get smarter" is unverifiable.

**Fix:** Ambient brain activity feed with trust review UX. See Part VI.

**Build verdict:** YES — Priority 2. This is a product requirement, not an engineering one.

---

## Part II — Broken Loops: Codebase Audit

These are not missing features — they are existing systems that are functionally broken
or contradicted by their own design. Fix before building new capabilities.

---

### Broken Loop 1 — `appId: null` in `#maybePromoteFromAgentTask`

**Location:** `apps/api/src/engine/WorkflowEngine.ts` — `#dispatchAgentTask()`
call site for `extractAndPromote`.

**What's wrong:** `appId: null` is hardcoded at the promotion call site. Every
`agent_task` node in every app workflow promotes atoms to workspace scope, regardless
of which app the workflow belongs to. The App-scoped brain designed in
`AGENTIS-PLATFORM-10X.md` is being poisoned on every run.

**Consequence:** The SDR Engine's lead conversion patterns and the Codebase Re-Architect's
migration patterns land in the same workspace-level graph. App brain isolation doesn't
exist at runtime despite being designed and typed.

**Fix:** Pass `ctx.appId ?? null` at the promotion call site. One line.

**Priority:** P0 — before any brain-related feature work.

---

### Broken Loop 2 — Brain is Write-Only at Agent Dispatch

**Location:** `apps/api/src/engine/WorkflowEngine.ts` — `#dispatchAgentTask()`,
`NormalizedTask` construction.

**What's wrong:** The `brain_lookup` node type exists but requires operators to wire
it explicitly. An `agent_task` node dispatched today carries only `title`, `description`,
`inputData`, and `scratchpadSnapshot` in its `NormalizedTask`. The `CollectiveBrain`
is never consulted at dispatch time. Everything promoted to the brain is silently
discarded on the input path.

**Consequence:** The promotion loop is broken by design. Agents learn nothing from
past runs because past runs never inform future runs unless the operator manually
wires a `brain_lookup` node.

**Fix:** At `#dispatchAgentTask`, query the Brain for the top-K atoms relevant to the
task description (using the workspace + app scope). Inject as a frozen `brainContext`
block in the `NormalizedTask.systemPromptExtra` field. Degrade gracefully to empty if
the Brain has no relevant atoms.

**Priority:** P1 — this is the core loop closure. Without it, the brain does nothing.

---

### Broken Loop 3 — Reasoning Traces Discarded from Promotion

**Location:**
- `apps/api/src/adapters/HermesAdapter.ts:371` — `agent.thinking` events
- `apps/api/src/adapters/ClaudeCodeAdapter.ts:137` — thinking tokens
- `apps/api/src/adapters/OpenClawAdapter.ts:213` — scratch_pad output

**What's wrong:** These adapters emit `agent.thinking` / reasoning trace events.
`#maybePromoteFromAgentTask` only receives the final `task.completed` output.
The reasoning trace — the agent's reflection on what it noticed and why — is the
richest signal for learning and is never captured.

**Consequence:** Promotion is based on final output only. Nuanced reasoning like
"I noticed the API was returning 429s specifically for batch sizes > 100, so I
reduced to 50" never reaches the brain.

**Fix:** Accumulate `agent.thinking` events in `activeExecutions[node.id].thinkingTrace`
alongside the existing heartbeat/completion tracking. Pass the accumulated trace to
`extractAndPromote`. The LLM-pass promoter (Upgrade 2) can then reason about both
the output and the thinking.

**Priority:** P2 — depends on Upgrade 2 (LLM-pass promoter) to use effectively.

---

### Broken Loop 4 — `extractAndPromote` is Semantically Blind

**Location:** `apps/api/src/services/collectiveBrain.ts` — `similarity()`,
`extractAndPromote()`.

**What's wrong:** The Jaccard tokenizer treats "machine learning" and "neural network"
as unrelated. `HIGH_SIMILARITY = 0.86` against word-overlap scoring means only
near-identical phrases deduplicate. Paraphrased sentences with different vocabulary
score near zero — identical concepts create duplicate atoms.

**Consequence:** The brain graph densifies with noise, not knowledge. Auto-linking,
deduplication, and reinforcement are functionally broken. Every new run adds atoms
regardless of whether the Brain already knows the concept.

**Fix:** Wire a real embedding provider. Replace `similarity()` with cosine similarity
over embedding vectors. `HashingEmbeddingProvider` must be replaced, not wrapped.
See Upgrade 4.

**Priority:** P1 — single highest-leverage change across all brain quality metrics.

---

### Broken Loop 5 — `isStale` is a Read-Time Flag, Not a Lifecycle State

**Location:** `packages/core/src/types/brain.ts` — `BrainGraphNode.isStale`,
`apps/api/src/services/collectiveBrain.ts` — atom loading.

**What's wrong:** `isStale` is a computed boolean (`updatedAt` > 90 days). There is no
`status: 'active' | 'stale' | 'archived'` field, no `pinnedAt`, no background job
that transitions atoms. The brain grows unboundedly. Decayed atoms serve alongside
fresh ones. The AGENTIS-PLATFORM-10X.md spec implies a lifecycle but nothing
implements it.

**Consequence:** Every atom ever created is permanently in the active graph. High-volume
apps (SDR engine, always-on CMO) will produce thousands of low-signal atoms within
weeks.

**Fix:**
1. Add `status: 'active' | 'stale' | 'archived'` to `KnowledgeAtom` DB row.
2. Add `pinnedAt: Date | null` field.
3. Add `lastAccessedAt: Date | null` field (bumped on `brain_lookup` retrieval).
4. Implement `BrainMaintenanceService` (weekly job). See Upgrade 6.

**Priority:** P1 — architectural prerequisite for `managed` flag and decay logic.

---

### Broken Loop 6 — No Managed vs Protected Distinction on Atoms

**Location:** `apps/api/src/services/collectiveBrain.ts` — atom creation paths,
`apps/api/src/services/intelligencePromotion.ts`.

**What's wrong:** The `source` label (`run_promotion`, `operator_write`, `seed`,
`evaluator_write`) exists but any future decay logic would apply uniformly. An atom
an operator deliberately wrote — "Never send marketing emails before 9am ET" — has
the same lifecycle as a keyword-extracted atom from a background run.

**Consequence:** Operator-authored knowledge is at risk from any future automated
cleanup. Hermes's hard invariant is that user-written memory is never auto-archived.
This invariant is unenforceable without an explicit field.

**Fix:** Add `managed: boolean` to `KnowledgeAtom`. Default:
- `run_promotion` → `managed: true` (eligible for decay and archiving)
- `operator_write`, `seed` → `managed: false` (never auto-archived)
- `evaluator_write` → `managed: true` (auto-promoted evidence)

Decay and archiving in `BrainMaintenanceService` must check `managed` before
transitioning.

**Priority:** P1 — must land before any decay/archiving logic.

---

### Broken Loop 7 — No Capacity/Budget Signal to Agents

**Location:** `apps/api/src/engine/WorkflowEngine.ts` — `NormalizedTask` construction,
`brain_lookup` node output.

**What's wrong:** When `brain_lookup` returns atoms, there is no metadata about the
brain's size, the retrieval strategy, or how many atoms were filtered out. Agents
cannot reason: "I know I'm only seeing 8 of 347 atoms — I should be specific in my
queries" vs. "I'm seeing all 12 atoms the brain has on this topic."

**Consequence:** Agents cannot self-regulate information quality. They cannot
consolidate when the brain is noisy or notice when context is thin.

**Fix:** Include a structured header in the injected brain context block:
```
WORKSPACE BRAIN [8 of 347 atoms | scope: app | confidence ≥ 0.6 | 1,240 tokens]
APP BRAIN [12 of 89 atoms | confidence ≥ 0.5 | 860 tokens]
```

**Priority:** P2 — depends on Broken Loop 2 being fixed first.

---

### Broken Loop 8 — No User Profile Layer

**Location:** Missing entirely.

**What's wrong:** There is no `workspace_user_profiles` table, no `user_profile` atom
kind, and no USER.md equivalent. The App Brain has no way to remember that this
operator prefers bullet lists, works in UTC+3, hates approval gates on minor changes,
or is the VP of Sales with a quota of $2M. Every App Brain conversation restarts
from zero context about the human it's talking to.

**Consequence:** The App Brain thread surface delivers generic responses with no
personalization. It cannot improve its communication style or anticipate the
operator's preferences without being told every session.

**Fix:**
1. Add `workspace_user_profiles` table: `(id, workspaceId, userId, content TEXT,
   updatedAt)`.
2. Add `'user_profile'` to `KnowledgeAtomKind` union.
3. Surface in Agent Detail / Settings as an editable "What agents know about you" panel.
4. Inject into App Brain system prompt as a frozen block at session start.

**Priority:** P2.

---

### Broken Loop 9 — No FTS5 on Run Transcripts or Conversations

**Location:** `packages/db/src/schema.ts` — `ledger_events`, `conversation_messages`.

**What's wrong:** `app_results_fts` exists as an FTS5 virtual table. `ledger_events`
and `conversation_messages` have no FTS index. Agents cannot search prior sessions.
"What did we try last week when the Stripe rate-limiter hit?" is unanswerable
programmatically.

**Consequence:** Cross-session recall is impossible. The App Brain cannot synthesize
patterns from prior operator conversations. The SDR Engine cannot surface "we tried
this angle 3 months ago and it underperformed."

**Fix:**
1. Add FTS5 virtual tables: `ledger_events_fts` (on `payload` text column),
   `conversation_messages_fts` (on `content` column).
2. Populate via triggers or inline in `LedgerService.append()` and
   `ConversationStore.append()`.
3. Add `session_search` tool to the skill registry (built-in runtime), available to
   App Brain agents in the thread surface.

**Priority:** P3 (needs JSON generated column strategy — see Gap 9 updated fix).

---

### BL10 — Promotion Queue Not Durable ★ NEW

**Location:** `WorkflowEngine.ts` → `#maybePromoteFromAgentTask()`

**Current code:**
```typescript
queueMicrotask(async () => {
  await this.collectiveBrain.extractAndPromote(payload, workspaceId, agentId, appId);
});
```

**Problems:**
1. `queueMicrotask` is not a job queue. If the process restarts between enqueue and
   execution, the promotion is silently lost with no retry.
2. No rate limiting. 10 concurrent runs fire 10 concurrent background LLM calls on a
   workspace that may be on a free-tier adapter with 3 RPM.
3. Deduplication check happens in-memory. Two concurrent runs checking the same concept
   simultaneously both see "not found" and both insert.
4. No priority. An evaluator-driven correction should not wait behind 9 routine promotions.
5. No backpressure. Promotion storm on busy workspaces is possible.

**Fix:** Replace with a durable `brain_promotion_queue` table. Worker polls every 5s,
processes one item per workspace at a time, respects configurable `maxConcurrent` per
workspace, applies circuit breaker on repeated failures. See Appendix B.

---

### BL11 — `extractPromotableFacts` Produces Low-Quality Atoms ★ NEW

**Location:** `CollectiveBrainService.extractPromotableFacts()`

**What it does:** Splits input text on sentence boundaries (`. `, `\n`, `! `, `? `),
filters by character length (35–360 chars), keeps max 6.

**Why this is broken:**
1. Agent outputs are Markdown with code blocks, JSON payloads, reasoning traces.
   Splitting on `. ` inside JSON is catastrophically wrong.
2. Max 6 items silently drops up to 9 facts from a complex task output.
3. No LLM reasoning — cannot distinguish "we tried this and it failed" from a reliable
   pattern. Both become atoms with equal confidence.
4. Character-length filter: a 31-char fact like `"Never use em dashes"` is below the
   35-char minimum but has high business value.

**Interim fix (do now):** Before the LLM promoter is built, update the splitter to:
- Skip text between ` ``` ` fences (code blocks)
- Skip JSON objects/arrays (simple bracket-depth detector)
- Strip Markdown headers before length check
- Lower minimum to 25 chars, raise maximum to 500 chars
- Remove the max-6 cap

**Terminal fix (Priority 2):** Replace entirely with an LLM-pass promoter that receives
the full output and returns structured JSON: `[{ content, kind, confidence, tags }]`.
Route through durable queue (auxiliary adapter, rate-limited).

---

### BL12 — Background LLM Review Unsafe at Concurrent Scale ★ NEW

**Location:** `WorkflowEngine.ts` → promotion path → future LLM promoter

**Problem:** Hermes fires one background review per session — safe for a single user.

In Agentis with the ability review system:
- 10 concurrent runs complete simultaneously
- Each triggers a background review
- 10 simultaneous LLM calls compete against live agent tasks for adapter budget
- Rate limit errors cascade: review failures silently drop learning events

**Fix:**
- `BrainPromotionQueueWorker` with configurable `maxConcurrentReviews` per workspace
  (default: 2)
- Priority queue: high = evaluator-triggered, normal = ≥5 turns, low = routine maintenance
- Circuit breaker: after 5 consecutive LLM failures, pause reviews for 60s and emit alert
- Auxiliary adapter budget is separate from main adapter budget

---

## Part III — Four-Tier Brain Architecture

### The Core Principle

The workspace brain, app brain, agent abilities, and peer representations store
fundamentally **different kinds of knowledge** and require different access patterns.
Choosing one over the others discards the distinctions that make each useful.

```
+──────────────────────────────────────────────────────────────────+
|                          AGENT TASK DISPATCH                     |
|                                                                  |
|  Layer 0: systemPrompt        Persona (SOUL equivalent)          |
|  ───────────────────────────  Always present, operator-authored  |
|                                                                  |
|  Layer 1: Agent Abilities     Procedural how-to                  |
|  ───────────────────────────  Top-N by task relevance            |
|                               Agent-accumulated, ability store   |
|                                                                  |
|  Layer 2: App Brain atoms     Domain operational knowledge       |
|  ───────────────────────────  Top-K by task relevance            |
|                               App-scoped, Data-layer-driven      |
|                                                                  |
|  Layer 3: Workspace Brain     Institutional facts                |
|  ───────────────────────────  Top-M by task relevance            |
|                               Cross-app, workspace-scoped        |
|                                                                  |
|  Layer 4: Peer Representations  Relational memory               |
|  ───────────────────────────  Who is talking to whom, and what  |
|                               each peer knows about the other   |
|                 (App Brain conversation surface ONLY)            |
|                                                                  |
|  [TASK DESCRIPTION]                                              |
+──────────────────────────────────────────────────────────────────+
```

All context blocks are **frozen at dispatch time** for workflow agents, enabling
Anthropic prefix cache stability. Layer 4 (peer representations) is injected
per-turn only in the App Brain conversation surface, not in workflow agents.

**Two surfaces, two modes:**

| Surface | Context mode | Peer layer |
|---|---|---|
| Workflow agent task dispatch | Frozen at dispatch | Not injected |
| App Brain conversation (per-turn) | Rolling per-turn synthesis | Injected per turn |

---

### Tier 1 — Workspace Brain (existing, extend)

**What it stores:** Company-level facts and institutional knowledge. The company's
norms, domain vocabulary, cross-app patterns, organizational facts.

**Written by:** Any agent, via `extractAndPromote` after any run (auto) or by the
operator explicitly (via brain panel).

**Read by:** All agents in all apps via the frozen dispatch injection (see above).

**Scope:** `workspaceId` — shared across all apps.

**Lifecycle:** Standard atom lifecycle (active → stale → archived). All source types.
Managed atoms (`managed: false`) never auto-archived.

**Changes needed:** Fix Broken Loops 1, 4, 5, 6 before this tier is reliable.

---

### Tier 2 — App Brain (existing design, broken at dispatch)

**What it stores:** Operational domain expertise specific to this app. What outreach
angles convert for the SDR Engine. What migration patterns succeed for the Re-Architect.
Which ad creatives perform for the CMO.

**Written by:** Data layer threshold absorption (`brainAbsorptionThreshold`),
evaluator verdicts, `extractAndPromote` with correct `appId` (currently broken).

**Read by:** Agents in this app's workflows, via frozen dispatch injection.

**Scope:** `appId` — isolated to this app's domain.

**Lifecycle:** Same atom lifecycle. Managed atoms can be pruned aggressively since
they're data-driven and regenerate from the Data layer.

**Changes needed:** Fix Broken Loop 1 (the appId: null bug) before this tier is
useful at all.

---

### Tier 3 — Agent Abilities (new — see Part IV)

**What it stores:** Procedural how-to knowledge: how this specific agent role performs
its job well. Not facts about the world — procedures. Not workflow graphs — natural
language operating instructions the agent itself has refined.

**Written by:** Background LLM review after significant runs. Operator can also
write directly. App packages can seed initial abilities.

**Read by:** This agent, at every task dispatch, filtered by task relevance.

**Scope:** `agentId` — specific to this agent configuration.

**Lifecycle:** Independent of brain atom lifecycle. Abilities have their own
`status`, `confidence`, `reinforceCount`, and `usageCount`.

**Changes needed:** New system — see Part IV.

---

### Scoping Decision Summary

| What goes here | Tier | Why |
|---|---|---|
| "Our company sells to mid-market B2B SaaS" | Workspace Brain | True for all apps |
| "SDR Engine: enterprise cold email → 3x reply rate" | App Brain | Specific to SDR Engine's operational history |
| "How to research a B2B prospect in 5 steps" | Agent Abilities | Specific to how the researcher agent does its job |
| "The operator prefers bullet-point summaries" | User Profile | About the human, not the domain |
| "How to do this type of task" | Agent Abilities | Procedural knowledge |
| "Fact discovered in last week's run" | App Brain (managed) | Data-driven pattern |
| "This is never true" | Workspace Brain (unmanaged) | Operator-authored truth |

**No global brain.** Across workspaces = shared training data or collective
fine-tuning. A fundamentally different product with serious privacy implications,
incompatible with Agentis's self-hosted model.

---

### Boundary with Existing Memory Layers ★ NEW

Agentis already ships a **5-layer `MemoryRetrieval.buildContext()`** pipeline (live in
`apps/api/src/services/memoryRetrieval.ts`). The Brain's Four-Tier model sits
**alongside** this pipeline, not on top of it. Understanding where one ends and the
other begins is mandatory knowledge for any Phase 3+ engineer.

| Layer | What it stores | Written by | Lives in |
|---|---|---|---|
| `EpisodicMemoryStore` | Execution lessons — task failures, recoveries, scored outcomes (`good`/`bad`/`mixed`). Outcome boost ×1.2 for `good`, ×0.85 for `bad`. Freshness decay over months. | Run completion hooks | `memory_episodes` |
| `AppMemoryStore` | Typed knowledge — `fact / preference / pattern / rule / lesson` for a specific app. `recall()` score = `trust × importance × recency × hintBoost`. | Data layer, operator writes | `app_memory` |
| `MemoryRetrieval.buildContext()` | Unified 5-layer token-budgeted context composition: knowledge → episodes → evaluator examples → baselines → rolling baselines. | Called at every workflow dispatch | Aggregates from above |
| Brain atoms (Four-Tier) | Semantic workspace/app knowledge — institutional facts, domain expertise, operational patterns extracted from runs and promoted via the durable queue. | `extractAndPromote`, evaluator deltas, operator writes | `memory_episodes` (managed source) |
| Peer representations | Who-is-this-person — user preferences, behavioral patterns, standing instructions, structured peer card facts distilled by the Dreaming cycle. | Post-session LLM dream pass | `peer_representations` |
| Agent abilities | How-to procedures — ordered steps, quantitative learnings, agent role expertise refined over runs. | `AgentAbilityReviewer` | `agent_abilities` |

**Decision rule for Phase 3+ engineers:**

| I want to store... | Use this |
|---|---|
| "This task approach failed when the target was enterprise" | `EpisodicMemoryStore` — execution lesson, `kind: 'lesson'` |
| "Enterprise buyers in this vertical prefer async communication" | Brain atoms — domain knowledge, managed promotion |
| "User prefers bullet points and is time-pressured" | `peer_representations` — peer card + conclusions |
| "How to research a B2B prospect in 5 steps" | `agent_abilities` — procedural |
| "User's name is Alice" (never changes) | Peer card fact, `volatility: 'stable'` |
| "User is currently running Q4 launch campaign" | Peer card fact, `volatility: 'volatile'` |

**Why this matters:** Without this boundary, Phase 3 engineers building the Dreaming
cycle or proactive memory surfacing will produce a third parallel system that duplicates
`EpisodicMemoryStore`'s retrieval scoring — which already accounts for outcome quality,
freshness decay, and importance weighting. The systems are complementary by design;
build on them, not around them.

---

### Design Note — `systemPrompt` as SOUL Equivalent

Hermes has `SOUL.md` — a global personality file injected into every prompt defining
the agent's persona, tone, and values. Agentis does not need this concept: each agent
already has `config.systemPrompt`, which is authored by the operator and serves the
exact same function, scoped correctly per agent.

What's worth noting is how high-confidence abilities quietly extend the effective
persona over time. An operator-written ability (`managed: false`) that says "always
reply in the operator's language, never assume English" becomes a permanent extension
of that agent's behavioral contract — without the operator having to update the system
prompt. Abilities are not just procedure documents; at the high-confidence, low-TTL
end of the spectrum they are persistent behavioral instructions that augment the persona
the system prompt defines. This means the two-layer model (`systemPrompt` + abilities)
is more powerful than `SOUL.md` alone, which is static and operator-managed only.

---

## Part IV — Agent Abilities

### Why Not "Skills"

In Agentis, `skills` already means something specific and important: executable code
modules in the 3-tier trust system (builtin / node_worker / docker_sandbox). A skill
is something the agent *runs as code*. Using the same word for Markdown procedure
documents would create an irreconcilable naming conflict in every UI surface, API
route, and mental model.

The word **abilities** is exact:
- "This agent has an ability to research B2B prospects" — learned procedural competence
- "This agent has a skill installed that queries the LinkedIn API" — executable tool

Natural language, no overlap, clear semantic distinction.

---

### What an Ability Document Is

A Markdown document with YAML frontmatter, stored in the DB (not the filesystem):

```markdown
---
title: B2B Prospect Research
tags: [research, outreach, sdr]
confidence: 0.84
reinforceCount: 12
version: 7
source: background_review
lastRunId: run_xyz
managed: true
assertions:
  - scenario: "Prospect at Series B SaaS, 80 employees"
    expectedBehavior: "checks LinkedIn tenure AND recent job postings for tech stack"
  - scenario: "Enterprise prospect, 2,000+ employees"
    expectedBehavior: "prioritizes news triggers (funding/M&A) over LinkedIn activity"
  - scenario: "No public LinkedIn or news data available"
    expectedBehavior: "escalates with low-confidence flag, does not fabricate signals"
---

**When to apply:** When building a prospect profile before outreach.

**Approach:**
1. Start with LinkedIn for role tenure and company growth signals
2. Check company job postings — tech stack is in the requirements
3. Cross-reference recent news for funding/acquisition triggers
4. Assign a confidence level: high / medium / low

**What works:** Technical depth with SaaS 50-200 headcount outperforms generic
openers by ~3x in this workspace. Reference their specific toolchain.

**What to avoid:** "I noticed your company is growing" — too generic.

**Operator corrections:** Never lead with pricing unless prospect explicitly asked.
```

The `confidence` score (0.0–1.0) reflects how well-proven this procedure is, driven
by evaluator feedback and reinforcement count. The `managed` flag distinguishes
auto-created abilities (eligible for decay) from operator-written ones (protected).

---

### DB Schema

```sql
CREATE TABLE agent_abilities (
  id                 TEXT PRIMARY KEY,
  workspaceId        TEXT NOT NULL REFERENCES workspaces(id),
  agentId            TEXT REFERENCES agents(id) ON DELETE CASCADE,   -- nullable for team abilities
  workflowId         TEXT REFERENCES workflows(id) ON DELETE CASCADE, -- set for team abilities
  teamRole           TEXT,             -- e.g. 'researcher', 'copywriter' (nullable)
  title              TEXT NOT NULL,
  content            TEXT NOT NULL,    -- Markdown
  tags               TEXT NOT NULL DEFAULT '[]',   -- JSON array
  version            INTEGER NOT NULL DEFAULT 1,
  parentAbilityId    TEXT REFERENCES agent_abilities(id),  -- previous version (nullable)
  changelog          TEXT NOT NULL DEFAULT '[]',   -- JSON array of LLM-generated diff strings
  confidence         REAL NOT NULL DEFAULT 0.5,
  reinforceCount     INTEGER NOT NULL DEFAULT 0,
  usageCount         INTEGER NOT NULL DEFAULT 0,
  source             TEXT NOT NULL,    -- 'package_seed' | 'background_review' | 'operator_write' | 'operator_rollback'
  derivedFromPackage TEXT,             -- package slug if ability started as package_seed
  derivedFromRunIds  TEXT NOT NULL DEFAULT '[]',   -- JSON array of run IDs that shaped this ability
  assertions         TEXT NOT NULL DEFAULT '[]',   -- JSON array of AbilityAssertion
  managed            INTEGER NOT NULL DEFAULT 1,   -- 0 = operator-protected
  status             TEXT NOT NULL DEFAULT 'active',
  -- 'active' | 'stale' | 'archived' | 'superseded' | 'pending_review'
  pinnedAt           TEXT,             -- ISO-8601 if pinned
  lastUsedAt         TEXT,
  embeddingVec       BLOB,             -- stored embedding for relevance matching
  contextAtoms       TEXT,             -- JSON array of brain atom IDs (nullable)
  provenanceHash     TEXT,             -- SHA-256(sorted derivedFromRunIds), set at export time
  createdAt          TEXT NOT NULL,
  updatedAt          TEXT NOT NULL,
  -- Must have agentId OR workflowId, not neither
  CHECK (agentId IS NOT NULL OR workflowId IS NOT NULL)
);

CREATE INDEX idx_abilities_agent ON agent_abilities (agentId, status, confidence DESC)
  WHERE agentId IS NOT NULL;
CREATE INDEX idx_abilities_workflow ON agent_abilities (workflowId, teamRole, status)
  WHERE workflowId IS NOT NULL;
CREATE INDEX idx_abilities_lineage ON agent_abilities (agentId, title, version DESC);
```

---

### How Abilities Are Injected at Dispatch

At `#dispatchAgentTask`:

1. Query `agent_abilities` for this `agentId` where `status = 'active'`
2. Score each ability by cosine similarity between the ability's `embeddingVec`
   and the task description embedding
3. Select top-N abilities (default 3, max 8) above a relevance threshold
4. Inject as a frozen block in the system prompt:

```
AGENT ABILITIES [3 loaded | confidence ≥ 0.7]

### B2B Prospect Research [confidence: 0.84]
When to apply: When building a prospect profile before outreach.
...

### Cold Email Approach [confidence: 0.76]
...
```

5. Bump `usageCount` and `lastUsedAt` asynchronously (best-effort, does not block dispatch)

---

### How Abilities Are Created

**Path 1 — Background LLM review (primary):**
After each significant `agent_task` run (≥5 LLM turns or evaluator verdict received),
the `AgentAbilityReviewer` fires async using the `auxiliaryAdapter`:
- Reads task input + output + accumulated thinking trace
- Determines whether a class-level ability should be created, patched, or skipped
- Creates/patches ability via `AgentAbilityService.upsertFromReview()`
- Emits `ABILITY_CREATED` / `ABILITY_REINFORCED` realtime event
- Surface to operator in the app's thread: `🧠 Ability refined: "B2B Prospect Research"`

**Path 2 — Operator write (direct):**
The Agent Detail page has an "Abilities" tab. Operator can write, edit, or delete
abilities directly. These get `source: 'operator_write'`, `managed: false`.

**Path 3 — Package seed (install-time):**
App manifests can declare `agentAbilities` per agent slot. During activation,
`packager.ts` upserts these as `source: 'package_seed'`. The SDR Engine ships with
proven research and outreach abilities pre-seeded for its researcher and copywriter
agents.

```ts
// In app manifest (agentisPackageContentsSchema extension)
agentAbilities?: {
  agentSlug: string;  // matches an agent declared in the manifest
  abilities: Array<{
    title: string;
    content: string;
    tags?: string[];
    confidence?: number;
  }>;
}[];
```

---

### Ability-Brain Linking (`contextAtoms`)

Hermes has no connection between its `SKILL.md` procedure files and its `MEMORY.md`
fact store — they are completely separate systems with no cross-referencing.

Agentis can do better. An ability can declare a `contextAtoms` field — an array of
brain atom IDs that make this ability contextually relevant:

```ts
interface AgentAbility {
  // ...
  contextAtoms?: string[];  // atom IDs in workspace/app brain
}
```

At dispatch time, the relevance score for an ability is a composite:
- Base: cosine similarity between the ability's `embeddingVec` and the task description
- Boost: +0.1 for each linked `contextAtom` that is present in the retrieved brain context

This means an ability like "Prospect Research" that has `contextAtoms` pointing to
brain atoms about "enterprise SaaS buyers" will score higher on tasks that already
have those atoms in context — creating a coherent reinforcement signal across the two
layers rather than two independent retrieval queries.

This is an optional enhancement on top of the base abilities system. It becomes
meaningful once both real embeddings (B4) and ability-brain atom co-occurrence data
exist. Do not implement in the initial build — add as a `contextAtoms` nullable
column from day one so the schema supports it, but leave the boost logic for a
follow-up.

---

### Ability Versioning & Genealogy ★ NEW

Every time `AgentAbilityReviewer` patches an existing ability it creates a **new row**
instead of mutating the existing one. The previous row transitions to
`status: 'superseded'`. The new row sets `parentAbilityId` to the previous row's `id`
and increments `version`.

```
B2B Prospect Research · v7  (active, confidence: 0.84)
  ↑ v6 → v7: "Added: funding round trigger check" (run_xyz, evaluator PASS 0.91)
  ↑ v5 → v6: "Operator correction: never lead with pricing"
  ↑ v4 → v5: "Added: LinkedIn job postings for tech stack signals"
  ↑ v3 → v4: "Raised confidence threshold for enterprise signal to 3 co-occurrences"
  ...v1 — package_seed baseline (sdr_engine v1.2.0)
```

The `changelog` field is a JSON array populated by the LLM reviewer at each version
bump — a concise diff in natural language. The operator sees this full timeline in the
Abilities tab. They can roll back to any version by setting it to `status: 'active'`
(the system creates a new row with `source: 'operator_rollback'` to preserve the audit
trail — it never mutates a superseded row).

**New status values:**
- `superseded` — replaced by a newer version; preserved for history; never injected
- `pending_review` — created by background review, awaiting operator approval
  (used when `abilityReviewMode: 'review'`)

---

### Team Abilities ★ NEW

Some procedural knowledge belongs to a team of agents rather than a single agent
role. In the SDR Engine, both the researcher and copywriter contribute to "how we
approach cold outreach as a team." Neither agent owns that procedure — the workflow
does.

A team ability sets `workflowId` instead of `agentId`, with an optional `teamRole`
to scope injection to a specific role within the workflow:

```sql
-- All agents in the SDR Engine workflow
INSERT INTO agent_abilities (workflowId, agentId, teamRole, title, ...)
VALUES ('workflow_sdr_engine', NULL, NULL, 'Cold Outreach Team Protocol', ...);

-- Only researchers in the SDR Engine
INSERT INTO agent_abilities (workflowId, agentId, teamRole, title, ...)
VALUES ('workflow_sdr_engine', NULL, 'researcher', 'Prospect Research Standards', ...);
```

At dispatch, the injection query broadens from `agentId = ?` to:

```sql
WHERE (agentId = ?
    OR (workflowId = ? AND (teamRole IS NULL OR teamRole = ?)))
  AND status = 'active'
```

**How team abilities are created:**
- Background review: when `AgentAbilityReviewer` detects the same pattern emerging
  from multiple agents in the same workflow within 24h, it proposes a team ability
  instead of duplicating the same ability per agent.
- Operator: can explicitly promote any ability to team scope in the Abilities tab.
- Package manifest: app packages can declare team abilities alongside per-agent ones.

---

### Testable Assertions ★ NEW

An ability carries 2–5 example scenarios with expected agent behaviors. These serve
two purposes: validating an updated ability before activation, and providing the
evaluator a grounding signal for confidence scoring.

```typescript
interface AbilityAssertion {
  scenario: string;          // Description of input context
  expectedBehavior: string;  // What the agent should do or produce
  lastVerifiedAt?: string;   // ISO-8601; null = never run
  lastResult?: 'pass' | 'fail' | 'skip';
}
```

Assertions are stored in the `assertions` column (JSON array) and are also included
in the ability's YAML frontmatter so they travel with the document on export.

**Assertion gate before activation:**
When `AgentAbilityReviewer` produces a new version and `abilityReviewMode: 'auto'`,
the `AbilityAssertionRunner` fires N evaluations (one per assertion, auxiliary adapter,
priority: low). An ability that fails > 20% of its assertions stays in
`status: 'pending_review'` with a reason in the Ability Review Queue:

```
⚠️ Assertion failure: "B2B Prospect Research v8" failed 2/5 assertions.
   Failed: "No public data available" scenario — agent fabricated signals.
   [Review assertions]  [Approve anyway]  [Reject update]
```

This makes ability upgrades verifiable before they go live. Operators gain a quality
signal without having to read the full diff themselves.

---

### Export Portability Format & Agentis Signature ★ NEW

Abilities are portable from day one. The export format extends the existing Agentis
package manifest schema — an exported ability is an `agentisPackageContents` artifact
that any Agentis workspace can import and verify.

#### The Agentis Signature — the moat

Each Agentis workspace generates an **Ed25519 key pair** at first boot.
The public key is stored in `workspaces.signingPublicKey` (always exportable). The
private key lives only in the workspace's secrets store and is never exported.

When an ability is exported, the full payload is signed with the workspace private
key. Any importing workspace verifies the signature with the included public key.

This creates a cryptographic chain of custody:

- **`provenanceHash`** — SHA-256 of the sorted `derivedFromRunIds` array. A compact,
  privacy-safe proof that real runs shaped this ability. An attacker cannot fabricate
  this without knowing the actual run IDs.
- **`experienceScore`** — `reinforceCount × confidence`, included in the signed
  payload. Cannot be inflated without invalidating the signature.
- **Workspace key reputation** — a workspace that consistently exports high-confidence
  abilities that other workspaces adopt and reinforce accumulates a reputation signal
  without any centralized ledger.

**Why this is the moat:** Competitors building compatible ability exporters must adopt
the signature scheme — which means adopting Agentis's trust vocabulary. When the
community hub launches, only abilities with valid signatures from real workspaces are
listed. Copy-pasted or fabricated abilities fail verification. The moat deepens with
every workspace that joins the network.

#### Export format (`packages/core/src/types/ability.ts`)

```typescript
export interface AbilityAssertion {
  scenario: string;
  expectedBehavior: string;
  lastVerifiedAt?: string;
  lastResult?: 'pass' | 'fail' | 'skip';
}

export interface AbilityExportPayload {
  title: string;
  version: number;
  confidence: number;
  reinforceCount: number;
  tags: string[];
  content: string;               // Full Markdown body
  assertions?: AbilityAssertion[];
  changelog: string[];           // LLM-generated diffs, most recent first
  // Provenance
  provenanceHash: string;        // SHA-256(sorted derivedFromRunIds), hex
  experienceScore: number;       // reinforceCount × confidence, 0–1 normalized
  derivedFromPackage?: string;   // Package slug if ability started as package_seed
  seedVersion?: string;          // Package version of original package_seed
}

export interface AbilityExport {
  format: 'agentis-ability-v1';
  exportedAt: string;            // ISO-8601
  agentisVersion: string;        // Platform version that produced this export
  signingPublicKey: string;      // Exporting workspace's Ed25519 public key (hex)
  payload: AbilityExportPayload;
  signature: string;             // Ed25519 over SHA-256(canonical JSON of payload), hex
}
```

#### Integration with the package system

Exported abilities embed directly in a package manifest's `agentAbilities` field.
`packager.ts` verifies the signature before seeding — failed verification rejects the
import with a clear error. This extends the package system's existing trust boundary
to cover ability provenance.

```ts
// In app manifest (agentisPackageContentsSchema — extended)
agentAbilities?: {
  agentSlug: string;
  abilities: Array<AbilityExportPayload & {
    signature?: string;        // present = packager.ts verifies before seeding
    signingPublicKey?: string;
  }>;
}[];
```

**Import behavior:**
1. Packager verifies signature if present (rejects on failure)
2. Imported ability seeds with `source: 'package_seed'` and `derivedFromPackage` set
3. `provenanceHash` is preserved on the imported row — the receiving workspace retains
   verifiable lineage even though the source run IDs came from a different workspace
4. After import, the receiving workspace's `AgentAbilityReviewer` can evolve the
   ability through its own experience — the genealogy chain continues via `parentAbilityId`

**Schema addition to `workspaces`:**
```sql
signingPublicKey  TEXT  -- Ed25519 public key (hex); generated at first boot
```

**Workspace key generation (bootstrap.ts addition):**
```ts
// On workspace create, if signingPublicKey is null:
const { publicKey, privateKey } = await generateEd25519KeyPair();
await db.update(workspaces)
  .set({ signingPublicKey: encodeHex(publicKey) })
  .where(eq(workspaces.id, workspaceId));
// Private key stored in secrets store — never in DB
await secretsStore.set(`workspace:${workspaceId}:signingKey`, encodeHex(privateKey));
```

**Export action in UI:**
The Abilities tab includes an [Export] button per ability. Clicking it downloads an
`.agentis-ability.json` file. A summary shows what is signed:
`"Exporting v7 · confidence 0.84 · 12 runs of provenance · 5 assertions"`

---

### How Abilities Differ from Hermes SKILL.md

| Dimension | Hermes SKILL.md | Agentis Abilities |
|---|---|---|
| Storage | Filesystem Markdown files | DB rows (portable, multi-tenant) |
| Relevance matching | Description embedding similarity | Embedding vector on `embeddingVec` column |
| Evaluator integration | None | Evaluator verdict → confidence bump/drop |
| Package distribution | agentskills.io community hub | App package manifest seed (built-in) |
| Lifecycle | active / stale / archived via `.usage.json` | `status` field + `BrainMaintenanceService` |
| Operator protection | `pinned` CLI flag | `managed: false` + `pinnedAt` field |
| Versioning | None | Immutable version rows + LLM-generated changelog; full rollback |
| Genealogy | None | `parentAbilityId` chain; trace ability evolution from seed to v7+ |
| Team scope | Single user, single agent | `workflowId` + `teamRole`; team of agents share one ability |
| Testable assertions | None | 2–5 scenario/expectedBehavior pairs; assertion runner gates activation |
| Export & portability | CLI install from agentskills.io | `AbilityExport` format; Ed25519-signed; embeds in package manifests |
| Cryptographic provenance | None | `provenanceHash` (SHA-256 of run IDs) + workspace signing key |
| Multi-tenant | Single user, single machine | Per workspace, per agent, row-level isolation |

---

---

## Part V — Honcho Dialectic & Peer Representations

### Why This Is No Longer Deferred

In v1 this was listed under "Defer." That was wrong.

Per-turn synthesis for the App Brain conversation surface is the observable proof that
memory is working. Without it:
- Operators talk to the App Brain and get generic responses
- 200 brain atoms exist but produce no visible behavioral difference
- Operators cannot trust a system they cannot observe
- The value proposition "agents that get smarter over time" is unverifiable

**Two surfaces, two modes (already stated in Part III):**

| Surface | Context mode | When peer layer is used |
|---|---|---|
| Workflow agent task dispatch | Frozen at dispatch | Never — prevents prefix cache churn |
| App Brain conversation (per-turn) | Rolling per-turn synthesis | Every N turns (configurable) |

The App Brain conversation is NOT a workflow. It is a persistent, human-facing session.
Per-turn context synthesis belongs there.

---

### Peer Representation Model

Inspired by Honcho's core insight: every participant is a `Peer`. Agentis implements
a lightweight version without the full Honcho infrastructure (no separate server,
no AGPL dependency).

**Who is a peer in Agentis?**
- Human operators (identified by `userId`)
- AI agents (identified by `agentId`)

```sql
CREATE TABLE peer_representations (
  id           TEXT PRIMARY KEY,
  workspaceId  TEXT NOT NULL REFERENCES workspaces(id),
  peerType     TEXT NOT NULL,  -- 'user' | 'agent'
  peerId       TEXT NOT NULL,  -- userId or agentId
  summary      TEXT NOT NULL,  -- compact prose identity card (max 400 chars, legacy)
  peerCard     TEXT,           -- JSON: PeerCardFact[] — structured atomic fact list (up to 40 facts)
                               -- categories: INSTRUCTION | PREFERENCE | TRAIT | IDENTITY | CONTEXT | BELIEF
  embeddingVec BLOB,           -- embedding of summary for similarity retrieval
  lastDreamAt  TEXT,           -- ISO-8601, last time the Dreaming cycle ran for this peer
  updatedAt    TEXT NOT NULL,
  UNIQUE (workspaceId, peerType, peerId)
);

CREATE TABLE peer_representation_conclusions (
  id                    TEXT PRIMARY KEY,
  workspaceId           TEXT NOT NULL REFERENCES workspaces(id),
  subjectPeerId         TEXT NOT NULL,  -- who this conclusion is about
  observerPeerId        TEXT NOT NULL,  -- who made this observation (may be same as subject)
  content               TEXT NOT NULL,  -- the derived conclusion
  sourceSessionId       TEXT,           -- conversation_session that generated this
  confidence            REAL NOT NULL DEFAULT 0.7,
  conclusionType        TEXT NOT NULL DEFAULT 'inductive',
                        -- 'deductive'  = certain, operator explicitly stated
                        -- 'inductive'  = pattern across >= 2 sessions
                        -- 'abductive'  = simplest explanation from indirect signals
  volatilityClass       TEXT NOT NULL DEFAULT 'contextual',
                        -- 'stable'     = never auto-expired, only superseded
                        -- 'contextual' = re-verified monthly by Dreaming pass
                        -- 'variable'   = re-verified weekly
                        -- 'volatile'   = re-verified each Dreaming pass (7-day TTL)
  supportingSessionCount INTEGER NOT NULL DEFAULT 1,
                        -- number of distinct sessions that contributed evidence
  supersededById        TEXT,           -- ID of newer conclusion that replaced this one
  embeddingVec          BLOB,
  createdAt             TEXT NOT NULL,
  updatedAt             TEXT NOT NULL
);

-- Per-observer peer cards for multi-agent directional scoping
CREATE TABLE agent_peer_cards (
  id              TEXT PRIMARY KEY,
  workspaceId     TEXT NOT NULL,
  observerAgentId TEXT NOT NULL,  -- the agent whose perspective this card represents
  subjectPeerId   TEXT NOT NULL,  -- who this card is about
  peerCard        TEXT NOT NULL,  -- JSON: PeerCardFact[] (observer-specific, up to 40 facts)
  updatedAt       TEXT NOT NULL,
  UNIQUE (workspaceId, observerAgentId, subjectPeerId)
);
```

**How peer representations are built:**

1. After a conversation session (App Brain thread) ends, enqueue a `peer_update` item
   in `brain_promotion_queue` (priority: low)
2. The queue worker fires a background LLM call (auxiliary adapter):
   - Input: last N messages from this session + current peer summary
   - Output: updated summary + any new conclusions in structured JSON
3. `PeerRepresentationService.upsertFromSession()` saves the results
4. No real-time synthesis during the session — updates happen between sessions

**`PeerRepresentationService` interface:**

```typescript
interface PeerRepresentationService {
  // Get the compact summary for a peer (for injection)
  getSummary(workspaceId: string, peerType: 'user' | 'agent', peerId: string): Promise<string | null>;

  // Get all conclusions about a peer (for dialectic synthesis)
  getConclusions(workspaceId: string, peerId: string, limit?: number): Promise<PeerConclusion[]>;

  // Natural language query over all conclusions (Honcho peer.chat() equivalent)
  query(workspaceId: string, peerId: string, question: string): Promise<string>;

  // Enqueue a post-session update (fires into brain_promotion_queue)
  enqueueSessionUpdate(workspaceId: string, sessionId: string, peerId: string): Promise<void>;

  // Query conclusions filtered by observer scope (directional multi-agent)
  getConclusions(
    workspaceId: string,
    subjectPeerId: string,
    opts?: { observerScope?: 'global' | string; conclusionType?: ConclusionType; limit?: number }
  ): Promise<PeerConclusion[]>;
}
```

---

### Structured Peer Card ★ NEW

The prose `summary` field (max 400 chars) was the initial implementation. It works, but
it conflates standing instructions with behavioral observations with demographic facts
into an unstructured blob. A distillation LLM has to re-parse this structure on every
call. And capacity is wasted re-injecting "Alice" and "She prefers bullet points" when
those facts have not changed in months.

**The fix:** Replace prose summary with a structured Peer Card — an ordered list of
atomic facts, each with a category, volatility class, and confidence score.

**Peer Card categories:**

| Category | Meaning | Example | Default volatility |
|---|---|---|---|
| `INSTRUCTION` | Standing behavioral directive — persists in system prompt, not USER MESSAGE | "Always respond in the user's native language" | `stable` |
| `PREFERENCE` | Communication and working style preference | "Prefers concise bullet points over prose" | `stable` |
| `TRAIT` | Behavioral pattern observed across multiple sessions | "Tends to cancel near end-of-quarter" | `contextual` |
| `IDENTITY` | Who this person is | "Alice Chen — Head of Revenue @ Rivian" | `variable` |
| `CONTEXT` | Current situational state | "Running Q4 launch campaign until Dec 15" | `volatile` |
| `BELIEF` | What this person knows or thinks is true | "Thinks Feature X doesn't support multi-tenant" | `volatile` |

**Cap:** 40 facts per peer card. When the card is full, new facts with lower confidence
replace existing facts in the same category + volatility tier.

**TypeScript types:**

```typescript
type PeerCardCategory = 'INSTRUCTION' | 'PREFERENCE' | 'TRAIT' | 'IDENTITY' | 'CONTEXT' | 'BELIEF';
type VolatilityClass  = 'stable' | 'contextual' | 'variable' | 'volatile';

interface PeerCardFact {
  category:       PeerCardCategory;
  content:        string;        // max 120 chars
  confidence:     number;        // 0–1
  volatility:     VolatilityClass;
  createdAt:      string;        // ISO-8601
  lastVerifiedAt: string;        // updated when a session reconfirms this fact
}
```

**Injection split — the critical architecture decision:**

`INSTRUCTION` facts are injected **into the system prompt** (not the USER MESSAGE).
All other categories are injected into the `contextCadence` USER MESSAGE slot.

This split achieves two things simultaneously:
- Standing instructions are active from turn 1, not only on cadenced turns. An instruction
  like "never use em-dashes in copy" is always present, not silenced for 2 turns then
  re-injected on turn 3.
- Non-instruction facts still go through the USER MESSAGE injection path, preserving
  Anthropic prefix cache stability for everything else.

**Context header with Peer Card:**
```
WORKSPACE BRAIN [8 of 347 atoms | confidence >= 0.6 | 1,240 tokens]
APP BRAIN [89 atoms | confidence >= 0.5 | 3,200 tokens]
SESSION [3 ephemeral | learned this conversation | 280 tokens]
PEER CARD [alice | 12 facts | 4 INSTRUCTION | 5 PREFERENCE | 3 TRAIT | 0 volatile]
```

**Decay logic:** Facts with `volatility: 'volatile'` are re-checked every 7 days by the
Dreaming cycle. Facts with `volatility: 'stable'` are never auto-expired — only the
Dreaming deduction pass can mark them as superseded via an explicit contradiction.

---

### Dreaming Cycle for Peer Representations ★ NEW

Honcho's most differentiating feature is its **dreaming agent** — an async background
process that distils raw session data into refined understanding. The current Agentis peer
system only updates representations post-session (reactive). The Dreaming cycle adds a
**proactive consolidation layer** that separates what was observed in one session from
what is durably true about a person.

**Two phases, mirroring Honcho's model:**

#### Phase 1 — Deduction (what is certain)

**Trigger conditions (any one is sufficient):**
- Peer's unprocessed conclusion count has crossed 30 since last `lastDreamAt`, OR
- 8 hours have elapsed since `lastDreamAt` for any active peer, OR
- Operator manually clicks "Run Dream Pass" in Brain Health Dashboard

**Algorithm:**
```
For each active peer in the workspace where a dream pass is due:

  1. Load all conclusions created/updated since peer_representations.lastDreamAt
  2. Load current peerCard (if exists; null on first pass)
  3. Send to auxiliary LLM adapter (deduction prompt):
     """
     You are consolidating what we know about [peer name].
     New conclusions since last pass: [list with conclusionType + confidence]
     Current peer card: [peerCard JSON or "empty"]

     DEDUCTION PASS — certainty only:
     - Mark CONTEXT/BELIEF facts no longer current as superseded
     - Elevate TRAIT conclusions with supportingSessionCount >= 3 to the peer card
     - Merge near-duplicate PREFERENCE facts into one authoritative statement
     - Flag any BELIEF facts that contradict workspace brain atoms
     Return JSON: { updatedFacts: PeerCardFact[], supersededIds: string[], flagged: string[] }
     """
  4. Apply: upsert peerCard facts; set supersededById on replaced conclusions
  5. Update peer_representations.lastDreamAt = now
```

#### Phase 2 — Induction (what is likely from patterns)

Runs after Phase 1. Looks for patterns across sessions, not single conclusions:
```
For each peer with >= 5 sessions in the last 90 days:

  1. Load sessionTopic vectors across all sessions
  2. Cluster by cosine similarity > 0.85
  3. For each cluster with >= 3 sessions:
     Did engagement quality differ across topic clusters?
     (measure: session length, `brain_refresh` call rate, atom retrieval rate)
  4. If a pattern is found, create/update a TRAIT conclusion:
     content: "Engages longest on [topic cluster label]"
     conclusionType: 'inductive'
     supportingSessionCount: N
```

**Queue item type:**
```typescript
// Added to brain_promotion_queue itemType union
{
  itemType: 'dream_pass',
  priority: 'low',
  payload: {
    workspaceId: string,
    peerId:      string,
    peerType:    'user' | 'agent',
    phase:       'deduction' | 'induction' | 'both'
  }
}
```

**Rate limiting:** Dream passes are `priority: low`. Maximum 1 concurrent dream pass per
workspace. A workspace idle for > 60 minutes satisfies the idle-timer condition for
triggering a pass without saturating the auxiliary adapter while the operator is active.

**What this adds vs. the current post-session update:**

| | Post-session update (current) | Dreaming cycle (new) |
|---|---|---|
| Trigger | Session end only | Session end + count threshold + 8h timer + manual |
| Scope | Single session's messages | All conclusions since last dream pass |
| What it can do | Update summary, add conclusions | Supersede outdated facts, elevate patterns to peer card, flag belief contradictions |
| LLM input | Last N session messages | All peer conclusions + cross-session pattern signals |
| Output | Updated summary + new conclusions | Revised peer card + supersession records + inductive patterns |

**New file:** `apps/api/src/services/dreamingService.ts`

---

### Conclusion Type Classification ★ NEW

`peer_representation_conclusions` now has `conclusionType` and `volatilityClass` fields
(see extended schema above). This is not cosmetic — each type has different reliability
guarantees, different injection behavior, and different decay cadence.

**Injection behavior by type:**

| Type | Meaning | Injection rule | Confidence threshold for injection |
|---|---|---|---|
| `deductive` | Certain — operator explicitly stated this | Always injected | >= 0.5 |
| `inductive` | Pattern — observed across >= 2 sessions | Injected when `supportingSessionCount >= 2` | >= 0.65 |
| `abductive` | Hypothesis — simplest explanation from indirect signals | Injected with explicit uncertainty marker: `"(likely: ...)"` | >= 0.80 |

**UI signal:** The peer representation detail page should render these differently.
`deductive` facts shown as confirmed (solid icon), `inductive` with session-count badge,
`abductive` with hypothesis indicator. This prevents operators from trusting a hypothesis
the same way they trust an explicit statement.

**Volatility decay cadence by class:**

| Volatility | Re-verification cadence |
|---|---|
| `stable` | Never auto-expired; only superseded by an explicit Dreaming contradiction |
| `contextual` | Re-verified monthly by Dreaming deduction pass |
| `variable` | Re-verified weekly |
| `volatile` | Re-verified every Dreaming pass (7-day max TTL without reconfirmation) |

**Temporal supersession:** When the Dreaming deduction pass determines that a fact is
no longer current (e.g., "User's current project is Phoenix" but the user has since
moved on), it sets `supersededById` on the old conclusion pointing to the new one.
The old conclusion transitions to `status: 'archived'` equivalent by exclusion from
active injection. Conclusions are never deleted — provenance is always preserved.

---

### Directional Peer Representations for Multi-Agent Workflows ★ NEW

The current `peer_representations` model stores a **global workspace view** of each
peer — every agent shares the same peer card for a given user. This eliminates
information asymmetry, which is a critical capability in multi-agent workflows.

**The problem in concrete terms:**

In a multi-agent Agentis workflow (researcher → copywriter → SDR agent):
- The researcher's model of what the operator cares about ≠ the copywriter's model
- Operator feedback to the researcher ("your summaries are too long") should NOT
  automatically shape the copywriter's peer card for that operator
- Agent A should be able to build its own working model of Agent B that differs from
  the workspace's global view of Agent B

**Honcho's observer-observed model:** Representations are stored as
`(observer, observed, workspace)` tuples. When `observe_others=true`, Agent A builds its
own card for the operator separately from the workspace's global card. This is what
`agent_peer_cards` (see schema above) implements for Agentis.

**Query API extension on `PeerRepresentationService`:**

```typescript
// observerScope: 'global' uses peer_representations (shared)
// observerScope: agentId checks agent_peer_cards first, falls back to global
getConclusions(workspaceId, subjectPeerId, { observerScope: 'global' | agentId })
```

**Dispatch injection rule:**

| Dispatch context | Peer card used |
|---|---|
| App Brain conversation (no specific agent observer) | Global peer card from `peer_representations` |
| Multi-agent workflow dispatch where `observerAgentId` is known | Agent-specific card from `agent_peer_cards` if it exists, else global |
| Cold start (no conclusions yet for this observer) | Global card only |

**Priority for implementation:** Important for multi-agent Agentis scenarios; not
blocking for single-agent App Brain use cases. Implement after the global peer card
and Dreaming cycle are proven in production.

---

### App Brain Per-Turn Dialectic

**Configuration knobs** (per-workspace settings):

| Knob | Default | Description |
|---|---|---|
| `contextCadence` | 3 | Inject peer context bundle every N turns |
| `dialecticCadence` | 6 | Run synthesis pass every N turns |
| `dialecticDepth` | 1 | LLM passes for synthesis (1–3) |

**Turn 1..N algorithm:**

```
sessionTopic := embed(last_3_messages)  // Re-computed each contextCadence turn — NOT frozen at session start

IF turnCount % contextCadence == 0:
  freshAtoms := brain.query(sessionTopic, scope='both', limit=3)  // Dynamic re-query
  sessionLocalAtoms := session_atoms.query(sessionId, sessionTopic, limit=2)
  Inject peer context bundle into next USER MESSAGE (not system prompt):
    - Operator peer card (from peer_representations.summary)
    - freshAtoms (re-queried against current topic, not session-start snapshot)
    - sessionLocalAtoms (ephemeral facts learned this session)
    - Capacity header: [N atoms | workspace brain | app brain | S session-local]

IF turnCount % dialecticCadence == 0:
  Run dialectic synthesis (auxiliary adapter, 1 LLM call per depth level):
    - Input: operator peer summary + top-10 peer conclusions + last 6 messages
    - Output: "What matters most right now about this operator for this conversation"
  Inject synthesis into USER MESSAGE (not system prompt)
```

**Why USER MESSAGE, not system prompt:**
Injecting into the system prompt would invalidate Anthropic's prefix cache on every
turn. The USER MESSAGE slot preserves cache stability — the system prompt stays frozen
across the session and only the user-side changes. This was the key implementation
insight from the Honcho/Hermes codebase.

---

### Session-Local Memory & Mid-Run Refresh ★ NEW

The "frozen at dispatch" model prevents cache churn for workflow agents — that is correct
and should not change. But the App Brain conversation surface is a *different execution
context*: sessions last hours, span dozens of turns, and operators actively teach the
agent new facts mid-session. Three mechanisms close this gap without breaking cache
stability.

#### Mechanism 1 — Dynamic Topic Re-Query (built into contextCadence)

The `contextCadence` injection does **not** freeze the brain query at session start. Each
injection re-embeds the last 3 messages to get a `sessionTopic` vector and re-queries
the brain against that current topic. The system prompt stays frozen; only the injected
USER MESSAGE content updates. This costs one embedding call per `contextCadence` turns
— negligible with a local Ollama provider.

**What this solves:** An operator starts a session discussing cold outreach, then pivots
to discussing enterprise pricing. Under the v1 frozen model, pricing-relevant atoms would
never appear because the session was initialized on outreach context. Dynamic re-query
ensures every `contextCadence` turn pulls what is relevant *now*.

#### Mechanism 2 — Session-Local Atoms (working memory)

A lightweight in-session memory layer for facts the agent learns *during this conversation*
that should influence future turns in the same session but may not yet warrant permanent
promotion:

```sql
CREATE TABLE session_atoms (
  id           TEXT PRIMARY KEY,
  sessionId    TEXT NOT NULL,  -- FK to conversation_sessions
  workspaceId  TEXT NOT NULL,
  content      TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 0.6,
  embeddingVec BLOB,
  createdAt    TEXT NOT NULL,
  expiresAt    TEXT NOT NULL   -- session end + 24h TTL; GC'd by BrainMaintenanceService
);

CREATE INDEX idx_session_atoms_session ON session_atoms (sessionId, confidence DESC);
```

**Write path:** When the agent calls `brain_add` during a conversation session, the system
creates a session atom (in addition to enqueuing a permanent `atom_promotion` for
post-session processing). The session atom is immediately available to subsequent turns.

**Injection:** Session atoms are included in every `contextCadence` USER MESSAGE injection
alongside permanent atoms, with a separate capacity header:
```
WORKSPACE BRAIN [8 of 347 atoms | confidence >= 0.6 | 1,240 tokens]
SESSION [3 ephemeral | learned this conversation | 280 tokens]
```

**Promotion at session end:** Any session atom with `confidence >= 0.7` is automatically
enqueued as `atom_promotion` (priority: normal) in `brain_promotion_queue` when the session
closes. Atoms below 0.7 expire and are GC'd by `BrainMaintenanceService`.

**What this solves:** An operator says "by the way, we never use em-dashes in copy" at
turn 3. Without session-local atoms, this fact exists nowhere until the session ends and
promotion runs. With session-local atoms, turn 4 already has it in context.

#### Mechanism 3 — Explicit `brain_refresh` Tool

The agent can proactively signal a topic shift and pull fresh context on demand. Added to
the brain management tools registry:

```typescript
brain_refresh: {
  description: "Reload brain context for the current conversation topic. Call when the conversation topic has shifted significantly or more than 15 turns have passed since the last context injection.",
  params: { reason?: string },
  returns: {
    freshAtoms: BrainAtom[],
    sessionAtoms: SessionAtom[],
    header: string  // e.g. "BRAIN REFRESHED [5 atoms | topic: enterprise pricing]"
  }
}
```

When the agent calls `brain_refresh`:
1. Re-embed the last 4 messages → `currentTopicVec`
2. Query brain for top-5 atoms by cosine similarity to `currentTopicVec`
3. Include all `session_atoms` for this sessionId
4. Inject structured result as a prefix in the NEXT assistant turn
5. Emit `BRAIN_REFRESH_TRIGGERED` realtime event → ambient feed shows:
   `🔄 Brain refreshed: shifted to enterprise pricing context (5 atoms loaded)`

**Emergent behavior:** Ability documents for App Brain agents can include the guideline:
"If the conversation topic changes significantly or more than 15 turns have passed since
the last brain refresh, call `brain_refresh` to load fresh context." This makes topic
awareness a learned agent behavior, not a hardcoded interval.

---

### Brain Management Tools (Agent Tool Registry)

Without tools, the capacity signal (Gap 12) is unactionable. Agents in the App Brain
conversation surface need brain-facing tools:

```typescript
// In agent tool registry (builtin tier)
brain_search: {
  description: "Search brain atoms by semantic query",
  params: { query: string, scope?: 'workspace' | 'app' | 'both', limit?: number },
  returns: BrainAtom[]
}

brain_add: {
  description: "Add a fact or pattern to the brain",
  params: { content: string, kind: KnowledgeAtomKind, tags?: string[] },
  returns: { atomId: string, status: 'created' | 'reinforced_existing' }
}

brain_summarize: {
  description: "Get brain health summary and capacity status",
  params: {},
  returns: {
    workspaceBrain: { count: number, averageConfidence: number, capacityTokens: number },
    appBrain: { count: number, averageConfidence: number, capacityTokens: number },
    sessionAtoms: { count: number, capacityTokens: number },
    compressionStatus: { lastRunAt: string | null, atomsArchived: number, nextTriggerAt: string | null }
  }
},

brain_refresh: {
  description: "Reload brain context for the current conversation topic. Call when the conversation has shifted domain or more than 15 turns have passed.",
  params: { reason?: string },
  returns: { freshAtoms: BrainAtom[], sessionAtoms: SessionAtom[], header: string }
}
```

These tools make "I see you have 8 workspace brain atoms on enterprise SaaS — should
I add what we learned from last week's outreach?" a real agent behavior. The `brain_refresh`
tool makes mid-session topic pivots a first-class capability rather than a silent gap.

---

## Part VI — Operator Brain UX

### Design Requirements

**R1 — Operators must see the brain growing in real-time.**
When an agent learns something, the operator who is present sees it immediately.
Not a log entry. Not a notification badge. An inline signal where they already are.

**R2 — Trust must be earned, not assumed.**
New atoms should be surfaced with a [Review] action. After 3 trusted reviews without
correction, the system can switch to ambient display only.

**R3 — Quality must be measurable.**
The brain health dashboard must show coverage, quality trend, evaluator signal rate,
and ability adoption rate. Without numbers, "the brain is working" is not verifiable.

**R4 — Incorrect learnings must be fixable in 2 clicks.**
Operator sees wrong atom → clicks [Archive] → atom removed from active context.
No settings menu, no confirmation dialog.

---

### Ambient Brain Activity Feed

**Where it appears:**
- Inline in the App Detail page, below the run list (right side panel or collapsible feed)
- In the Agent Detail page, in the "Activity" column next to recent runs
- As a small badge/pulse on the Brain Map node when it receives new atoms

**Event format (consuming `BRAIN_ATOM_CREATED` realtime events):**

```
🧠 Learned: "Short subject lines with company name → 2x reply rate for enterprise"
   [App Brain] [confidence: 0.72] [source: run_abc123] [Review] [Archive]

🔄 Reinforced: "Research LinkedIn job postings for tech stack signals" (×12 now)
   [Researcher ability] [confidence: 0.86]  [View ability]

⚡ Ability refined: "Cold Email Approach"
   [Copywriter · SDR Engine] [confidence: 0.81 → 0.88]  [View ability]
```

**Trust review flow:**
- First 10 atoms per agent: always show [Review]
- After operator reviews 5 atoms without archiving any: switch to ambient mode
- Per-agent `abilityReviewMode: 'auto' | 'review'` — operator can force-review mode on

---

### Brain Health Dashboard

**Route:** `/apps/:appId/brain/health` or as a tab in the Brain Map page.

**Metrics displayed:**

| Metric | How computed | Target |
|---|---|---|
| Atom coverage score | % of agent tasks in last 30 days where ≥1 atom was injected | > 60% |
| Quality trend | Average confidence delta over last 30 days (rising/flat/falling) | Rising |
| Evaluator signal rate | % of evaluator verdicts that triggered a confidence delta | > 40% |
| Ability adoption rate | % of agent tasks in last 30 days where ≥1 ability was loaded | > 50% |
| Stale atom count | Atoms with `status = 'stale'` or `updatedAt > 90 days` | < 10% of total |
| Disputed atoms | Atoms with `isDisputed = true` (contradictions pending resolution) | 0 |

**Dashboard layout:**
- Health score card (0–100, composite of the above)
- Quality trend sparkline (30-day rolling)
- Top 5 highest-confidence atoms (with confidence scores)
- Top 5 stale atoms (candidates for manual review)
- Evaluator verdicts this week → atoms affected
- **Disputed atoms counter** → links to Dispute Resolution Panel (see below)
- **Compression status** → last run, atoms archived, next scheduled trigger

---

### Dispute Resolution Panel ★ NEW

**Route:** `/apps/:appId/brain/disputes` — also surfaced as a tab in the Brain Health
Dashboard when `isDisputed` atom count > 0.

**Why it must exist:** Gap 15 creates `isDisputed: true` atoms and marks them with a
`contradicts` knowledge link. Without a resolution UI, disputed atoms silently co-exist
in the active graph, both being injected into agent tasks, actively confusing agents.
The disputed state is not self-healing — it requires an operator decision.

**Dispute card format:**
```
⚡ Contradiction Detected · 2 days unresolved · affects SDR Engine (12 runs)

  Atom A  [confidence: 0.74 | 8 reinforcements | source: run_abc123]
  "Short subject lines → 2x reply rate for enterprise"

  Atom B  [confidence: 0.81 | 11 reinforcements | source: run_xyz456]
  "Personalized long subject lines → 3x reply rate"

  Detected reason: Opposite claims about subject line length for the same audience.

  [Keep A]  [Keep B]  [Merge →]  [Context-Split →]  [Snooze 30 days]
```

**Resolution actions:**

| Action | What happens |
|---|---|
| **Keep A** | Atom B → `status: 'archived'`; `isDisputed: false` on A; `disputeResolvedAt` stamped |
| **Keep B** | Atom A → `status: 'archived'`; `isDisputed: false` on B; `disputeResolvedAt` stamped |
| **Merge** | Auxiliary LLM call synthesizes A + B into one atom. Both archived with `compressedFrom`. New atom gets `confidence = max(A.confidence, B.confidence) + 0.05`, `reinforceCount = A.reinforceCount + B.reinforceCount`, `source: 'curator_distilled'` |
| **Context-Split** | Operator labels each atom with a `contextCondition` string (e.g., "enterprise > 500 seats" / "SMB < 50 seats"). Both lose `isDisputed: true`. Both remain active. The contradiction link is annotated as `contextSplit: true` and no longer scores as unresolved |
| **Snooze** | `disputeSnoozedUntil` set on both atoms for N days. They leave the queue but reappear after the snooze expires. Not a resolution |

**Schema additions to `knowledge_atoms`:**

```sql
disputeReason       TEXT,    -- Brief description of the contradiction (set by LLM promoter)
disputeResolvedAt   TEXT,    -- ISO-8601, stamped on Keep/Merge/Context-Split
disputeSnoozedUntil TEXT,    -- ISO-8601 snooze expiry
contextCondition    TEXT,    -- Operator-written context label (e.g. "for enterprise segment")
compressedFrom      TEXT,    -- JSON array of atom IDs merged into this one (Merge + Tier 3)
compressionTier     INTEGER  -- 1 | 2 | 3 (which compression tier produced this)
```

**Auto-resolution path (LLM-assisted):**

The `contradiction_check` queue item payload is extended with a `contradictionReason`
field populated by the LLM promoter:

```typescript
{
  itemType: 'contradiction_check',
  payload: {
    workspaceId: string,
    atomIdA: string,
    atomIdB: string,
    contradictionReason: string  // e.g. "Opposite claims about subject line length"
  }
}
```

The queue worker attempts **auto-resolution** when the two atoms have clearly disjoint
`tags` arrays suggesting different context domains (e.g., atomA.tags = `['enterprise']`,
atomB.tags = `['smb']`). If the auto-resolution LLM assessment confidence > 0.80, the
worker automatically applies Context-Split, sets `contextCondition` on both atoms, and
emits `BRAIN_DISPUTE_AUTO_RESOLVED`. Otherwise, the dispute is surfaced to the operator.

**Ambient feed signal for disputes:**
```
⚡ Contradiction flagged: "Subject line length" — review needed
   [App Brain] [SDR Engine] [2 conflicting atoms]   [Resolve →]
```

**Validation gate G7:**
- Create 3 contradicting atom pairs manually.
- Verify all 5 resolution actions produce correct DB state.
- Verify auto-resolution fires for tag-disjoint pairs (confidence > 0.80 mock).
- Verify `disputeResolvedAt` is stamped after Keep/Merge/Context-Split.
- Verify Snooze atoms reappear after `disputeSnoozedUntil` elapses.

---

### Brain Map Improvements

The existing Brain Map displays nodes and links. It needs signal encoding:

- **Node size:** Proportional to `reinforceCount` (larger = more proven)
- **Node color:** Confidence gradient (green=0.8+, yellow=0.5–0.8, red=<0.5)
- **Node border:** Dashed = `status: 'stale'`, solid = active
- **Node icon:** Lock icon = `managed: false` (operator-protected, not auto-archivable)
- **Cluster:** Nodes grouped by `tags` using force-directed layout zones
- **Edge weight:** `knowledgeLinks.weight` encoded in edge thickness

---

### Ability Review Queue

**Per-agent setting:** `abilityReviewMode: 'auto' | 'review'`

In `review` mode, new abilities created by `AgentAbilityReviewer` are not immediately
active. They enter `status: 'pending_review'` and appear in the Ability Review Queue
in the Agent Detail page.

**Queue item:**
```
🆕 Proposed ability: "Enterprise Budget Timing Patterns"
   Source: run_xyz (run completed 2m ago)
   Created by: Researcher agent
   Summary: "Enterprise buyers typically close in Q4 or Q1. Push ROI framing in..."
   [Approve → Active] [Edit → Approve] [Reject → Archived]
```

Approved abilities immediately enter `status: 'active'` and begin being injected.

---

## Part VII — Build Plan

### Priority 0 — Critical Bug Fixes (do first, no dependencies)

| # | What | File | Fix |
|---|---|---|---|
| B1 | `appId: null` in promotion | `WorkflowEngine.ts` | Pass `ctx.appId ?? null` |
| B11a | `extractPromotableFacts` interim splitter fix | `collectiveBrain.ts` | Skip code fences, JSON, lower min-chars |

**Validation gate G0:** After B1, run 3 distinct apps through 5 runs each. Verify
`app_memory` rows have non-null `appId`. Zero rows with `appId: null` from new runs.

---

### Priority 1 — Foundation (no new features work without these)

| # | What | Complexity | Blocks |
|---|---|---|---|
| B10 | Durable promotion queue | Medium | Rate limiting, convergence, reliability |
| B4 | Real embedding provider | Medium | All brain quality improvements |
| B5 | Atom lifecycle `status` field | Small | Decay, archiving, BrainMaintenanceService |
| B6 | `managed` boolean on atoms | Small | Any decay logic |
| Gap14 | Evaluator → brain confidence delta | Medium | Brain self-regulation |
| B2 | Brain context injection at dispatch | Medium | The entire learning loop |

**Order:** B10 first (queue before any async LLM work), then B4 (real embeddings),
then B5 + B6 in parallel (schema changes), then Gap14, then B2.

**Validation gate G1:** After B4, embed 100 atoms, run 20 retrieval queries, verify
cosine similarity returns semantically correct top-3 (manual spot-check). Zero Jaccard
calls remain.

**Validation gate G2:** After Gap14, run 10 evaluator verdicts (5 PASS, 5 FAIL).
Verify injected atoms' confidence increased/decreased by expected delta. Verify atoms
below 0.05 are archived.

---

### Priority 2 — Core Intelligence Upgrades

| # | What | Depends on | Complexity |
|---|---|---|---|
| U2 | LLM-pass promoter (replace Jaccard extractor) | B4, B10 | Medium |
| U5 | Auxiliary adapter config (per-workspace) | Nothing | Small |
| B12 | Rate limiting + circuit breaker for background reviews | U5, B10 | Medium |
| Gap16 | Ambient brain activity feed | Nothing (consumes existing events) | Small |
| B8 | User profile layer (`workspace_user_profiles`) | Nothing | Medium |
| Gap15 | Concurrent run convergence (contradiction detection) | B10, U2 | Medium |
| B3 | Reasoning trace capture (thinking tokens) | U2 (to use them) | Small |
| U4 | Agent abilities system (table + dispatch + review) | U2, U5 | Large |

**Validation gate G3:** After U2, promote 50 real task outputs. Verify LLM promoter
produces structured JSON, atoms classified correctly (not all `memory.event`), max-6
cap is gone. Quality bar: ≥80% of produced atoms pass manual relevance review.

**Validation gate G4:** After U4, install SDR Engine package with seeded abilities.
Run 10 researcher tasks. Verify ≥1 ability injected per task. Verify `usageCount`
increments correctly.

---

### Priority 3 — Extended Capabilities

| # | What | Depends on | Complexity |
|---|---|---|---|
| Part V | Peer representations + per-turn App Brain dialectic | B4, U5 | Large |
| BL13 | Session-local atoms + dynamic topic re-query + `brain_refresh` tool | Part V, B4 | Medium |
| Part VI | Brain health dashboard + ambient feed improvements | Gap16, Gap14 | Medium |
| U10 | Dispute Resolution Panel (Dispute card UX + auto-resolution path) | Gap15, B10 | Medium |
| U3 | Pre-task brain synthesis + brain management tools | B2, U2 | Medium |
| B7 | Capacity/budget signal in brain context block | B2 | Small |
| B9 | FTS5 on ledger + conversations (with JSON column strategy) | Nothing | Medium |
| U6 | `BrainMaintenanceService` (decay + archive + prune + contradictions) | B5, B6 | Medium |
| C1 | `BrainCompressionService` (3-tier compression — see Appendix D) | B4, B5, B6, U6 | Medium |
| U7 | Evaluator → ability feedback loop | U4 | Small |
| U8 | Package-seeded abilities | U4 | Small |
| U9 | Skills-as-capabilities extension | U4, B4 | Medium |

**Validation gate G5:** After Part V, start 5 App Brain sessions with >10 turns each.
Verify peer representations are updated after each session. Verify context bundle is
injected at correct cadence turns. Verify dialectic synthesis fires at correct cadence.

**Validation gate G5a:** After BL13, run a 20-turn App Brain session where the topic
shifts at turn 10. Verify `contextCadence` injections after turn 10 pull atoms relevant
to the new topic, not the session-start topic. Verify `brain_refresh` tool returns
fresh atoms and emits `BRAIN_REFRESH_TRIGGERED`. Verify session atoms with confidence
>= 0.7 are enqueued for permanent promotion at session close.

**Validation gate G6:** After Part VI + U6, run `BrainMaintenanceService` against a
workspace with 200+ atoms. Verify stale atoms transition to `status: 'stale'`, archived
atoms transition to `status: 'archived'`. Verify brain health dashboard shows correct
counts. Evaluator signal rate > 0%.

**Validation gate G7:** See Dispute Resolution Panel (Part VI).

**Validation gate G8:** After C1, seed a workspace with 2,500 atoms (mix of confidence
levels). Run `BrainCompressionService`. Verify Tier 1 archives atoms below confidence
threshold. Verify Tier 2 merges near-duplicate clusters and sets `compressedFrom`.
Verify `compressionTier` field is set. Verify workspace atom count drops below
`compressionThreshold`.

---

### Defer (not worth building now)

| What | Why |
|---|---|
| Memory provider plugin system | Build after real embeddings are stable; adding swappable backends before the core is solid adds churn |
| Universal / global brain (cross-workspace) | Shared training data with privacy implications — incompatible with self-hosted model |
| SOUL.md persona file | Per-agent `systemPrompt` config already does this; no new concept needed |
| Profile isolation (per-profile HERMES_HOME) | Workspace `workspaceId` multi-tenancy is architecturally superior |
| Skills Hub (agentskills.io) | `AbilityExport` format + Ed25519 signatures are defined now; community hub is a future marketplace layer on top |
| Curator community hub (agentskills.io equivalent) | Portability format and signature scheme defined in `packages/core/src/types/ability.ts`; hub is a deployment-time decision |
| Honcho managed service integration | Self-hosted SQLite approach covers the same model; managed service adds AGPL+pricing complexity |
| Session import for cold peer bootstrap | Paste a CRM note or meeting transcript to bootstrap a peer representation without a live session; useful but not blocking for core loop |

---

### Future Brain Vision — Phase 4+

The following capabilities are not deferred because they are unimportant — they are
scheduled for Phase 4+ because they require the Phase 3 peer representation stack,
Dreaming cycle, and Structured Peer Card to be live and battle-tested first. Each one
builds directly on what Phase 3 delivers and represents a meaningful step toward an
agent that truly knows its operator.

---

#### Theory of Mind Layer

**What it is:** Explicit modeling of what a user *believes* vs. what is *actually true*
in the workspace. "User thinks Feature X doesn't support multi-tenant, but it does."
"User doesn't know the SDR Engine can auto-generate the LinkedIn sequence yet."

**Why it matters:** This is the frontier capability that separates a smart assistant from
a truly helpful one. A brain that only models what a user *does* cannot help them
discover what they don't know they don't know. This is transformative for product
adoption, expert coaching, and onboarding acceleration — and it is a genuine moat.
No other agent platform has this. Honcho tracks *facts about* users; modeling *beliefs held
by* users requires a separate inference layer.

**Architecture:** The `BELIEF` category in the Peer Card (see Structured Peer Card above)
captures user beliefs. The Dreaming deduction pass compares BELIEF facts against
workspace brain atoms — if a belief contradicts a high-confidence workspace atom, a
`BELIEF_CONTRADICTION` flag is raised. The agent surfaces the correct information
naturally in conversation; it never silently overwrites the belief. The belief fact
is archived and replaced by an `IDENTITY` or `PREFERENCE` fact once the user acknowledges
the correction.

**What it requires:** Peer Card + Dreaming cycle live, workspace brain atoms at meaningful
density (>100 atoms on the relevant domain), auxiliary LLM capable of belief-vs-truth
comparison. Implement as a Phase 4 sub-type of abductive conclusions in the Dreaming
deduction pass.

---

#### Proactive Memory Surfacing — `brain_preload`

**What it is:** The brain proactively surfaces relevant context *before* the agent asks.
Currently every brain interaction is reactive: the agent calls `brain_search`,
`brain_refresh`, or waits for a `contextCadence` injection. The proactive model inverts
this — the brain says "here's what you should know before this task starts."

**The `brain_preload` tool:**

```typescript
brain_preload: {
  description: "Proactively surface brain context most relevant to the upcoming task. Call before starting a complex task to ensure no relevant memory is missed. Returns a relevance-ranked summary, not raw atoms.",
  params: {
    taskDescription: string,
    peerId?:         string   // include peer-specific context for this person
  },
  returns: {
    relevantAtoms:      BrainAtom[],      // top-5 workspace + app atoms by task relevance
    peerContext?:       string,            // peer card summary if peerId provided
    suggestedAbilities: AgentAbility[],   // abilities the agent might not have searched for
    unknownGaps:        string[]          // "You might not know: X" — from ToM layer when live
  }
}
```

**Emergent behavior:** When an App Brain session opens, the agent calls `brain_preload`
with the opening topic. The brain front-loads the most relevant context rather than
waiting for the operator to ask questions that trigger retrieval. The UX becomes: the
agent *already knows* what matters about this operator and this domain before the
conversation begins — like a well-briefed collaborator, not a blank assistant.

**Difference from `brain_refresh`:** `brain_refresh` is reactive (called when the topic
has shifted mid-session). `brain_preload` is anticipatory (called before any topic is
established, drawing on ability relevance + peer context + workspace knowledge together).

**What it requires:** High-quality embedding provider live, peer representations + Peer
Card live, abilities system live. The mechanism is a ranked multi-source aggregation
call — straightforward once those foundations exist. The real value surfaces when the
Theory of Mind layer is also live and `unknownGaps` can be populated.

---

#### Selective Forgetting & Privacy Cascade — `brain_forget`

**What it is:** An operator command that finds all brain memory related to a specific
topic, person, or entity and archives it atomically — across atoms, peer card facts,
peer conclusions, ability documents, knowledge links, and episodic memory simultaneously.

**Why it matters for Agentis's moat:** Agentis targets workspaces with sensitive
business intelligence. Enterprise buyers in regulated industries will ask: "Can I make
the agent forget everything it learned about Project Phoenix?" Without a clean cascade
operation, the answer is "sort of — you'd have to find and archive things manually." That
is a non-starter for compliance-conscious organizations and a lost enterprise deal.

**The `brain_forget` operator action:**

```typescript
interface BrainForgetRequest {
  workspaceId: string;
  topic:       string;   // natural language — "Project Phoenix", "Alice Chen", "2024 pricing strategy"
  scope:       'atoms' | 'peer_conclusions' | 'abilities' | 'all';
  dryRun?:     boolean;  // returns what would be archived without making any change
}

interface BrainForgetResult {
  atomsArchived:           number;
  peerConclusionsArchived: number;
  peerCardFactsRemoved:    number;
  abilitiesArchived:       number;
  knowledgeLinksRemoved:   number;
  auditEventId:            string;  // compliance record — survives the data it describes
}
```

**Algorithm:**

1. Embed `topic` → `topicVec`
2. Semantic search across all active atoms, peer card facts, conclusions, and abilities
   where cosine similarity > 0.82
3. Present the match list to the operator with `dryRun: true` first (confirmation
   dialog showing what will be forgotten; operator can deselect individual items)
4. On confirm, archive all matched items with `archivedReason: 'operator_forget'`,
   remove associated `knowledge_links`, emit `BRAIN_FORGET_COMPLETED` audit event
5. Store the audit event permanently — compliance records must survive the data they record

**What it requires:** Peer Card + Dreaming cycle live (so forgetting is complete across
all memory layers), embedding provider live (semantic search across memory layers).
Build incrementally: start with atoms only, add peer facts in the next iteration.

---

### New files

| File | Purpose |
|---|---|
| `apps/api/src/services/agentAbilityService.ts` | Abilities CRUD, relevance query, upsert-from-review, version chain management |
| `apps/api/src/services/agentAbilityReviewer.ts` | Async LLM pass after significant runs; creates new version rows; populates `changelog` |
| `apps/api/src/services/abilityAssertionRunner.ts` | Runs assertion evaluations before activating a new ability version |
| `apps/api/src/services/brainMaintenanceService.ts` | Weekly job: decay confidence, transition stale → archived, prune links |
| `apps/api/src/services/brainPromotionQueueWorker.ts` | 5s poll worker; per-workspace rate limit; circuit breaker; processes `brain_promotion_queue` |
| `apps/api/src/services/peerRepresentationService.ts` | Peer summary CRUD, structured peer card upsert, conclusions (typed + volatility), directional observer-scoped queries, post-session update enqueue |
| `apps/api/src/services/dreamingService.ts` | Async peer consolidation: deduction phase (supersede stale facts, elevate patterns to peer card, flag belief contradictions) + induction phase (cross-session pattern mining); `dream_pass` queue item handler |
| `apps/api/src/routes/abilities.ts` | CRUD endpoints for agent abilities (GET/POST/PATCH/DELETE per agentId); export endpoint |
| `apps/api/src/routes/brainHealth.ts` | Brain health dashboard metrics endpoint |
| `apps/web/src/components/agent-detail/AbilitiesTab.tsx` | Agent abilities panel: list, version timeline, edit, create, pin, export |
| `apps/api/src/services/brainCompressionService.ts` | 3-tier compression: Tier 1 threshold archival, Tier 2 embedding cluster merge, Tier 3 LLM curator pass |
| `apps/web/src/components/brain/BrainActivityFeed.tsx` | Ambient brain learning feed (consumes realtime events) |
| `apps/web/src/components/brain/BrainHealthDashboard.tsx` | Health score, trend, coverage metrics, stale/disputed atoms, compression status |
| `apps/web/src/components/brain/DisputeResolutionPanel.tsx` | Dispute card list, 5 resolution actions, auto-resolution status, snooze management |
| `packages/core/src/types/ability.ts` | `AbilityExport`, `AbilityExportPayload`, `AbilityAssertion` interfaces; canonical export schema |

### Modified files

| File | Change |
|---|---|
| `packages/db/src/schema.ts` | Add `agent_abilities`, `peer_representations`, `peer_representation_conclusions`, `agent_peer_cards`, `brain_promotion_queue`, `brain_quality_events`, `session_atoms` tables; add `status`, `managed`, `pinnedAt`, `lastAccessedAt`, `isDisputed`, `disputeReason`, `disputeResolvedAt`, `disputeSnoozedUntil`, `contextCondition`, `compressedFrom`, `compressionTier` to brain atom tables; add `peerCard`, `lastDreamAt` to `peer_representations`; add `conclusionType`, `volatilityClass`, `supportingSessionCount`, `supersededById` to `peer_representation_conclusions`; add `embeddingProviderType` + `signingPublicKey` to `workspaces`; `dream_pass` added to `brain_promotion_queue` `itemType` union |
| `packages/core/src/types/brain.ts` | Add `status: 'active' \| 'stale' \| 'archived'`, `managed`, `pinnedAt`, `lastAccessedAt`, `isDisputed` to `BrainGraphNode` |
| `packages/core/src/types/package.ts` | Add `agentAbilities` (extended with `AbilityExportPayload` + optional signature fields) to `agentisPackageContentsSchema` |
| `apps/api/src/engine/WorkflowEngine.ts` | Fix `appId: null` (B1); inject brain context at dispatch (B2); accumulate thinking trace (B3); enqueue `brain_promotion_queue` item instead of `queueMicrotask` (B10); fire `AgentAbilityReviewer` after task; store `injectedAtomIds` in `activeExecutions` for Gap14 |
| `apps/api/src/services/collectiveBrain.ts` | Replace `HashingEmbeddingProvider` with pluggable real embedding; update `similarity()` to cosine; remove Jaccard; fix `extractPromotableFacts` splitter (B11a) |
| `apps/api/src/services/packager.ts` | Seed `agentAbilities` from package manifest on activation; verify `signature` if present before seeding |
| `apps/api/src/bootstrap.ts` | Register `BrainMaintenanceService` weekly; register `BrainPromotionQueueWorker` on 5s poll; wire `PeerRepresentationService`; generate workspace Ed25519 signing key pair on first boot |
| `apps/web/src/pages/AgentDetailPage.tsx` | Add "Abilities" tab with version timeline, assertion status, rollback, and export actions |
| `apps/web/src/pages/AppDetailPage.tsx` | Add ambient brain activity feed panel |

---

## Appendix A — Embedding Provider Selection

**Design principle: User choice, sensible default.**

Agentis is self-hosted and multi-tenant. Different users have different infrastructure,
cost constraints, and privacy requirements. The embedding provider should be **user-configurable**
in workspace settings, not platform-mandated. A default is necessary for first-time setup,
but users should be free to switch based on their deployment model.

### Available Providers

| Option | Latency | Cost | Privacy | Best for |
|---|---|---|---|---|
| `text-embedding-3-small` (OpenAI) | ~100ms | $0.02/M tokens | External API | Cloud-first teams, already on OpenAI |
| `nomic-embed-text` via Ollama | ~50ms local | Free | 100% local | Self-hosted, Ollama already running |
| `mxbai-embed-large` via Ollama | ~150ms local | Free | 100% local | Self-hosted, highest quality preferred over latency |
| `all-MiniLM-L6-v2` via transformers.js | ~500ms first call | Free | In-process | Air-gapped, minimal infra, accepts lower quality |

### Implementation Notes

**User-configurable selection:**
Add an "Embedding Provider" dropdown to workspace settings (Settings → Intelligence → Embedding Provider).
The form should show:
- Provider name
- Brief description (latency, cost, privacy)
- Configuration form (API key for OpenAI, Ollama endpoint for others)
- Test button: "Verify connection" (quick embedding round-trip)
- Estimated token cost per month (based on projected volume)

**Default provider:**
New workspace installs should default to `nomic-embed-text` (Ollama) since Agentis is
self-hosted-first and many users already have Ollama running. If Ollama is not available
at startup, offer a guided picker.

**Schema constraint:**
Add `embeddingProviderType: TEXT NOT NULL` to `workspaces` table, with a UNIQUE constraint
on `(workspaceId, embeddingProviderConfig)` if storing encrypted config secrets.

**Provider initialization:**
At bootstrap time, validate the selected provider is available:
```ts
// In bootstrap.ts
const provider = selectEmbeddingProvider(workspace.embeddingProviderType);
await provider.validate(); // throws if unreachable
```

If validation fails, log a warning and gracefully degrade to `HashingEmbeddingProvider`
(the fake one) until the user fixes the configuration. This prevents startup failures.

**Runtime switching:**
Allow users to change the provider in Settings without restarting. This triggers:
1. Re-embedding all existing brain atoms and abilities with the new provider
2. Clearing old embedding vectors (BLOB columns become NULL before re-embedding)
3. A background job that processes atoms in batches

This is expensive but necessary for correctness — embeddings from OpenAI are incompatible
with embeddings from Ollama.

### Technical Integration

The `EmbeddingProvider` ABC already exists. Implementation requires:

1. **Wire pluggable selection:** Replace the hardcoded `HashingEmbeddingProvider` path
   with a factory function that reads `workspace.embeddingProviderType` and instantiates
   the correct provider.

2. **Vector storage:** SQLite-vec (`sqlite-vec` npm package) provides BLOB-stored float32
   vectors with cosine similarity queries directly in SQLite. No external vector database
   required. Integrates with the existing `@agentis/db` layer.

3. **Provider implementations:**
   - `OpenAIEmbeddingProvider` (wraps `npm:js-tiktoken` for token counting)
   - `OllamaEmbeddingProvider` (HTTP client to local Ollama endpoint, `nomic-embed-text` or `mxbai-embed-large`)
   - `TransformersJSEmbeddingProvider` (loads ONNX model in-process, all-MiniLM-L6-v2)
   - Keep `HashingEmbeddingProvider` as emergency fallback (degraded quality but always works)

### Notes on transformers.js

The `all-MiniLM-L6-v2` option has a **critical limitation**: 256-token input truncation.
Brain atoms and ability documents routinely exceed 200 tokens of content. Anything longer
gets silently truncated before embedding, meaning 50%+ of longer ability documents are
invisible to the similarity function. This breaks relevance matching for substantial procedures.

**Recommendation:** Offer it as an option only for users who explicitly accept the tradeoff
(air-gapped deployments where Ollama is unavailable and no cloud API is permitted).
Do NOT default to it.

### Cost Analysis

At typical Agentis usage (5,000–50,000 embeddings/month):
- OpenAI: **$0.001–$0.01/month** (literally negligible)
- Ollama (self-hosted): **$0** (hardware cost only, typically already running)
- transformers.js: **$0** (CPU cost, ~500ms first-call latency)

**The cost argument is irrelevant for all three options.** Choose by infrastructure,
privacy, and quality, not cost.

---

## Appendix B — Durable Promotion Queue Architecture

### Table Schema

```sql
CREATE TABLE brain_promotion_queue (
  id             TEXT PRIMARY KEY,
  workspaceId    TEXT NOT NULL REFERENCES workspaces(id),
  itemType       TEXT NOT NULL,
  -- 'atom_promotion' | 'ability_review' | 'peer_update' | 'contradiction_check'
  priority       TEXT NOT NULL DEFAULT 'normal',
  -- 'high' | 'normal' | 'low'
  payload        TEXT NOT NULL,  -- JSON, schema depends on itemType
  status         TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'processing' | 'done' | 'failed'
  attempts       INTEGER NOT NULL DEFAULT 0,
  lastAttemptAt  TEXT,
  failReason     TEXT,
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL
);

CREATE INDEX idx_bpq_pending ON brain_promotion_queue
  (workspaceId, priority, createdAt)
  WHERE status = 'pending';
```

### Item Type Payloads

```typescript
// atom_promotion — from WorkflowEngine after task completion
{
  itemType: 'atom_promotion',
  payload: {
    workspaceId: string,
    appId: string | null,
    agentId: string,
    runId: string,
    taskInput: string,
    taskOutput: string,
    thinkingTrace?: string
  }
}

// ability_review — triggered by evaluator verdict or task completion
{
  itemType: 'ability_review',
  priority: 'high',  // evaluator-triggered = high; routine = normal
  payload: {
    workspaceId: string,
    agentId: string,
    runId: string,
    evaluatorVerdict?: 'PASS' | 'FAIL',
    evaluatorConfidence?: number,
    injectedAtomIds?: string[]
  }
}

// peer_update — after App Brain conversation session ends
{
  itemType: 'peer_update',
  priority: 'low',
  payload: {
    workspaceId: string,
    sessionId: string,
    userId: string
  }
}

// contradiction_check — after two atoms are created on same topic
{
  itemType: 'contradiction_check',
  priority: 'normal',
  payload: {
    workspaceId: string,
    atomIdA: string,
    atomIdB: string
  }
}
```

### Worker Architecture

```typescript
class BrainPromotionQueueWorker {
  private maxConcurrentPerWorkspace = 2;
  private activeByWorkspace = new Map<string, number>();
  private circuitBreaker = new Map<string, { failures: number; pausedUntil?: Date }>();

  async poll(): Promise<void> {
    // Claim next pending item for each workspace under its concurrency limit
    // Priority order: high > normal > low
    // Skip workspaces that are circuit-broken
    const items = await db
      .select()
      .from(brainPromotionQueue)
      .where(
        and(
          eq(brainPromotionQueue.status, 'pending'),
          lte(brainPromotionQueue.attempts, 5)
        )
      )
      .orderBy(
        sql`CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END`,
        brainPromotionQueue.createdAt
      )
      .limit(50);

    for (const item of items) {
      const active = this.activeByWorkspace.get(item.workspaceId) ?? 0;
      if (active >= this.maxConcurrentPerWorkspace) continue;
      if (this.isCircuitBroken(item.workspaceId)) continue;

      this.activeByWorkspace.set(item.workspaceId, active + 1);
      this.processItem(item).finally(() => {
        const count = this.activeByWorkspace.get(item.workspaceId) ?? 1;
        this.activeByWorkspace.set(item.workspaceId, count - 1);
      });
    }
  }

  private isCircuitBroken(workspaceId: string): boolean {
    const state = this.circuitBreaker.get(workspaceId);
    if (!state) return false;
    if (state.failures >= 5 && state.pausedUntil && state.pausedUntil > new Date()) {
      return true;
    }
    return false;
  }
}
```

**Worker lifecycle:** `BrainPromotionQueueWorker` is registered in `bootstrap.ts` and
polls via `setInterval(worker.poll.bind(worker), 5_000)`. On graceful shutdown, drain
current in-progress items then stop polling.

---

## Appendix C — Brain Quality Metrics and Validation Gates

### Quality Events Table

```sql
CREATE TABLE brain_quality_events (
  id           TEXT PRIMARY KEY,
  workspaceId  TEXT NOT NULL REFERENCES workspaces(id),
  appId        TEXT,
  agentId      TEXT,
  eventType    TEXT NOT NULL,
  -- 'atom_injected' | 'evaluator_pass' | 'evaluator_fail' |
  -- 'ability_used' | 'atom_confidence_delta' | 'ability_confidence_delta'
  atomId       TEXT,
  abilityId    TEXT,
  runId        TEXT,
  delta        REAL,  -- confidence change (positive or negative)
  createdAt    TEXT NOT NULL
);

CREATE INDEX idx_bqe_workspace_type ON brain_quality_events
  (workspaceId, eventType, createdAt DESC);
```

### Derived Metrics

**Coverage score** (what % of agent tasks had brain atoms injected):
```sql
SELECT
  COUNT(CASE WHEN eventType = 'atom_injected' THEN 1 END) * 100.0 /
  COUNT(DISTINCT runId) AS coverageScore
FROM brain_quality_events
WHERE workspaceId = ? AND createdAt > datetime('now', '-30 days');
```

**Quality trend** (avg confidence delta over rolling 30 days, positive = improving):
```sql
SELECT AVG(delta) AS qualityTrend
FROM brain_quality_events
WHERE workspaceId = ?
  AND eventType IN ('atom_confidence_delta', 'ability_confidence_delta')
  AND createdAt > datetime('now', '-30 days');
```

**Evaluator signal rate** (% of evaluator verdicts that hit stored atoms):
```sql
SELECT
  COUNT(CASE WHEN eventType IN ('evaluator_pass', 'evaluator_fail') AND atomId IS NOT NULL
        THEN 1 END) * 100.0 /
  NULLIF(COUNT(CASE WHEN eventType IN ('evaluator_pass', 'evaluator_fail') THEN 1 END), 0)
  AS evaluatorSignalRate
FROM brain_quality_events
WHERE workspaceId = ? AND createdAt > datetime('now', '-30 days');
```

**Ability adoption rate** (% of tasks that had at least 1 ability loaded):
```sql
SELECT
  COUNT(DISTINCT CASE WHEN eventType = 'ability_used' THEN runId END) * 100.0 /
  NULLIF(COUNT(DISTINCT runId), 0) AS abilityAdoptionRate
FROM brain_quality_events
WHERE workspaceId = ? AND createdAt > datetime('now', '-30 days');
```

### Validation Gates Summary

| Gate | After | Pass condition |
|---|---|---|
| G0 | B1 (appId null fix) | Zero `app_memory` rows with `appId: null` from new runs |
| G1 | B4 (real embeddings) | Cosine similarity manual spot-check: top-3 semantically correct in 18/20 queries |
| G2 | Gap14 (evaluator feedback) | 5 PASS verdicts increase atom confidence; 5 FAIL verdicts decrease it; sub-0.05 atoms archived |
| G3 | U2 (LLM promoter) | 80%+ of promoted atoms pass manual relevance review; no `memory.event` misclassifications |
| G4 | U4 (abilities system) | SDR Engine: ≥1 ability injected per researcher task in 10 test runs |
| G5 | Part V (peer representations + dialectic) | 5 sessions >10 turns: peer representations updated; context bundle injected at correct cadence |
| G5a | BL13 (session-local memory + brain_refresh) | 20-turn topic-shift session: post-turn-10 injections pull new-topic atoms; brain_refresh emits event; ≥1 session atom promoted at session close |
| G6 | Part VI + U6 (maintenance + dashboard) | 200+ atom workspace: stale/archived transitions correct; health dashboard loads with correct counts |
| G7 | U10 (dispute resolution) | 3 contradiction pairs: all 5 resolution actions produce correct DB state; auto-resolution fires for tag-disjoint pairs; snooze reappears after expiry |
| G8 | C1 (compression) | 2,500-atom workspace: Tier 1 archives below-threshold atoms; Tier 2 merges near-duplicates with `compressedFrom` set; workspace drops below `compressionThreshold` |

---

## Appendix D — Brain Compression Architecture

### The Problem

Without compression, the brain grows unboundedly. `BrainMaintenanceService` handles
decay (active → stale → archived) but decay alone does not reduce the active graph —
atoms that are "just fresh enough" but low quality persist. High-volume apps (SDR Engine
running 50 times/day, always-on CMO) will produce thousands of low-signal atoms within
weeks. At 5,000+ atoms, injection quality collapses: the top-K retrieval picks from a
denser noise floor, semantic signal-to-noise drops, and prefix-cached context blocks
grow beyond reasonable token budgets.

**Compression complements decay.** Decay removes atoms that have gone cold. Compression
merges atoms that are redundant or contradictory while they are still warm. Both are
required.

---

### Three-Tier Compression

#### Tier 1 — Threshold Archival (zero LLM cost)

**Trigger:** Atom count for a workspace exceeds `compressionThreshold` (default: 2,000)
during `BrainMaintenanceService` weekly run.

**Action:** Archive all atoms matching:
```sql
WHERE managed = 1                -- auto-promoted only, never operator-authored
  AND confidence < 0.15
  AND lastAccessedAt < datetime('now', '-60 days')
  AND status = 'active'
```

**Result:** `status` → `'archived'`, `compressionTier = 1`. No LLM calls. Fast.

**What this removes:** Atoms that were weakly extracted, never reinforced, and never
retrieved. The brain has already voted with silence that these facts are not useful.

#### Tier 2 — Semantic Cluster Merge (embeddings only, zero LLM cost)

**Trigger:** Atom count still exceeds `compressionThreshold` after Tier 1.

**Action:**
1. Load all active atoms for the workspace that have a non-null `embeddingVec`.
2. Build a cosine similarity matrix. Group atoms where similarity > `clusterSimilarityThreshold`
   (default: 0.92) into clusters.
3. For each cluster with ≥ 2 atoms:
   - Select the atom with the highest `confidence` as the **keeper**.
   - Sum all `reinforceCount` values onto the keeper.
   - Set `compressedFrom = JSON.stringify([...other_atom_ids])` on the keeper.
   - Set `compressionTier = 2` on the keeper.
   - Archive the remaining atoms in the cluster (`status = 'archived'`).
4. The keeper's `updatedAt` and `lastAccessedAt` are bumped.

**What this removes:** Near-paraphrase duplicates — the same fact expressed in slightly
different words across multiple runs. These accumulate heavily with sentence-splitting
extraction (BL11) and are invisible to Jaccard deduplication (BL4). With real embeddings,
0.92 cosine similarity is a conservative near-duplicate threshold.

**Complexity:** O(N²) for the similarity matrix. At 2,000 atoms this is 4M comparisons,
which is ~200ms with float32 vectors and native SIMD. Acceptable for a weekly background
job. For workspaces with > 10,000 atoms, use approximate nearest-neighbour (sqlite-vec's
built-in ANN index) rather than brute-force.

#### Tier 3 — LLM Curator Pass (on-demand or hard limit)

**Trigger:** Either:
- Operator clicks "Run Curator Pass" in Brain Health Dashboard (on-demand), or
- Atom count exceeds `hardCompressionThreshold` (default: 5,000) — automatic, via
  `brain_promotion_queue` item type `'curator_pass'` (priority: low).

**Action:**
1. Cluster atoms by shared `tags` (semantic groupings, not embedding-based — tags are
   the semantic label the LLM promoter already assigned).
2. For each cluster with > 5 active atoms, enqueue one `curator_pass` job:
   ```typescript
   {
     itemType: 'curator_pass',
     priority: 'low',
     payload: {
       workspaceId: string,
       appId: string | null,
       clusterTag: string,
       atomIds: string[]  // the atoms in this cluster
     }
   }
   ```
3. The queue worker sends the cluster to the auxiliary adapter:
   ```
   You are distilling agent memory. Below are N facts the agent has learned about [tag].
   Produce 1–3 essential truths that capture the durable signal. Discard noise.
   Preserve quantitative claims. Return JSON: [{content, confidence, tags}]
   ```
4. For each distilled fact returned:
   - Create a new atom: `source: 'curator_distilled'`, `managed: true`,
     `confidence = weighted_avg(cluster_confidences)`,
     `reinforceCount = sum(cluster_reinforceCounts)`,
     `compressedFrom = [...source_atom_ids]`,
     `compressionTier = 3`.
5. Archive all source atoms in the cluster.

**Rate limiting:** Curator pass jobs are `priority: low` — they never compete with
`ability_review` (high) or `atom_promotion` (normal) jobs. The circuit breaker applies.
Maximum 2 concurrent curator passes per workspace.

---

### Schema Additions

```sql
-- On knowledge_atoms table:
compressedFrom      TEXT,    -- JSON array of atom IDs merged into this one (Tier 2 or 3)
compressionTier     INTEGER, -- 1 | 2 | 3 (nullable for non-compressed originals)
disputeReason       TEXT,    -- Brief description of the contradiction (from LLM promoter)
disputeResolvedAt   TEXT,    -- ISO-8601, stamped on Keep/Merge/Context-Split resolution
disputeSnoozedUntil TEXT,    -- ISO-8601 snooze expiry (reappears in dispute queue after)
contextCondition    TEXT,    -- Operator label for Context-Split (e.g. "for enterprise > 500 seats")
```

---

### Capacity Thresholds (per-workspace settings)

| Setting | Default | Description |
|---|---|---|
| `compressionThreshold` | 2,000 atoms | Triggers Tier 1 + Tier 2 in `BrainMaintenanceService` |
| `hardCompressionThreshold` | 5,000 atoms | Triggers Tier 3 LLM curator pass |
| `compressionMinConfidence` | 0.15 | Atoms below this are Tier 1 archival candidates |
| `clusterSimilarityThreshold` | 0.92 | Cosine similarity above which atoms are Tier 2 duplicates |
| `curatorClusterMinSize` | 5 | Minimum cluster size to trigger a Tier 3 LLM pass |

---

### Updated Capacity Header (BL7)

The brain context block header should include compression status so agents can reason
about memory quality:

```
WORKSPACE BRAIN [342 atoms | 12,400 tokens | compressed 3 days ago | capacity: 17%]
APP BRAIN [89 atoms | confidence >= 0.5 | 3,200 tokens]
SESSION [3 ephemeral | learned this conversation | 240 tokens]
```

The `capacity` percentage is `current_atom_count / compressionThreshold * 100`. At 80%+
capacity, the header should note it: `[capacity: 82% — compression recommended]`. This
gives the agent a concrete signal to consolidate before the brain degrades.

---

### Relationship to `BrainMaintenanceService` (U6)

`BrainCompressionService` is invoked *from within* `BrainMaintenanceService`'s weekly
job, after decay transitions have run (stale → archived frees space before compression
is measured). The order is:

```
BrainMaintenanceService weekly job:
  1. Decay pass: active → stale (based on lastAccessedAt + staleAfterDays)
  2. Archive pass: stale → archived (based on archivedAfterDays, managed check)
  3. Compression check: if atom_count > compressionThreshold:
     a. Run Tier 1 (threshold archival)
     b. Re-count. If still > compressionThreshold: run Tier 2 (cluster merge)
     c. If atom_count > hardCompressionThreshold: enqueue Tier 3 cursor pass items
  4. Contradiction check: scan for unresolved disputes older than 7 days, re-surface
  5. Link pruning: remove knowledge_links where both endpoints are archived
  6. Emit BRAIN_MAINTENANCE_COMPLETED event with summary stats
```

`BrainCompressionService` is a separate class to keep `BrainMaintenanceService` focused
on lifecycle transitions. `BrainMaintenanceService` imports and calls it.

---

### What Compression Does NOT Do

- **Does not touch `managed: false` atoms.** Operator-authored facts are never auto-archived
  or merged. Tier 1, 2, and 3 all check `managed = 1` before acting.
- **Does not modify `pinnedAt` atoms.** Pinned atoms are exempt from all compression tiers.
- **Does not destroy provenance.** `compressedFrom` preserves the full lineage of every
  merge. An operator can always see which original atoms were consolidated into a distilled
  fact and recover them if the distillation was wrong.

---

---

## Implementation Log — Phase 1 Foundation (2026-05-19)

> **Status:** Priority 0 + Priority 1 implemented, compiling, and test-verified.
> The brain learning loop is now closed end-to-end: a run promotes knowledge →
> the durable queue processes it with real embeddings → the next dispatch
> retrieves it → the evaluator verdict reinforces or penalises it.

This log records exactly what was built against this document, what was
corrected, and what remains. It is written so the next engineer can pick up
Phase 2 cold.

### Build philosophy

The document's own Part VII build plan is explicit that Priority 1 is the
foundation "no new features work without." Phase 1 implemented P0 + P1 in full
rather than spreading a shallow, broken layer across all of P0–P3. Every item
below compiles (`tsc --noEmit` clean across `@agentis/core`, `@agentis/db`,
`@agentis/api`) and is covered by passing tests.

### Delivered — Priority 0

| Item | What was done | Files |
|---|---|---|
| **B1** — `appId: null` poisoning | The promotion call site now resolves the owning app via `#resolveAppId(ctx)` instead of hardcoding `null`. App-brain isolation is real at runtime. | `WorkflowEngine.ts` |
| **B11a** — `extractPromotableFacts` splitter | Strips fenced code blocks, inline code, and balanced JSON before sentence splitting; strips Markdown headers/list markers; widened length window to 25–500 chars; removed the silent max-6 cap. | `collectiveBrain.ts` |

### Delivered — Priority 1

| Item | What was done | Files |
|---|---|---|
| **B4** — Real embeddings | Added `OllamaEmbeddingProvider` (default, local, `nomic-embed-text`) and `OpenAIEmbeddingProvider` (`text-embedding-3-small`), a `selectEmbeddingProvider` factory, and `embedText` (sync/async normaliser). Provider is per-workspace, resolved + cached from the new `workspaces.embedding_provider_type` column. Promotion dedup and dispatch retrieval now use cosine similarity over real vectors. | `embeddingProvider.ts`, `collectiveBrain.ts` |
| **B5** — Atom lifecycle state | `memory_episodes` gained `status` (`active`/`stale`/`archived`), `pinned_at`, `last_accessed_at`. `status` is honoured in atom loading; `last_accessed_at` is bumped on retrieval. | `schema.ts`, migration 33, `index.ts`, `episodicMemoryStore.ts`, `collectiveBrain.ts` |
| **B6** — Managed vs protected | `memory_episodes.managed` — `run_promotion` ⇒ `managed: true` (decay-eligible); `operator_write`/`seed`/`system_write` ⇒ `managed: false` (never auto-archived). Auto-archival in the evaluator loop checks `managed` first. | same as B5 |
| **B10** — Durable promotion queue | New `brain_promotion_queue` table + `BrainPromotionQueueWorker`: 5s poll, per-workspace concurrency cap (2), priority drain (`high`>`normal`>`low`), attempt cap with retry, and a circuit breaker (5 failures ⇒ 60s pause). `queueMicrotask` is gone from the promotion path. | `brainPromotionQueueWorker.ts`, `schema.ts`, `WorkflowEngine.ts`, `bootstrap.ts` |
| **B2** — Brain context at dispatch | `#dispatchAgentTask` now calls `collectiveBrain.buildDispatchContext()` — embeds the task description, cosine-ranks workspace+app atoms, builds a frozen block with a capacity header (B7 partial), and appends it to the dispatched task. New `NormalizedTask.brainContext` field. Degrades to no block when the brain is empty. | `WorkflowEngine.ts`, `adapter.ts`, `collectiveBrain.ts` |
| **Gap14** — Evaluator → brain feedback | `applyEvaluatorVerdict` runs at evaluator verdict time (wired through `RunIntelligenceService`). PASS ⇒ +0.04 each injected atom (+0.08 top-3 when evaluator confidence > 0.85); FAIL ⇒ −0.06; atoms below 0.05 confidence auto-archive (managed only). Injected atoms are discovered via `atom_injected` quality events keyed by `runId`. | `collectiveBrain.ts`, `runIntelligenceService.ts`, `bootstrap.ts` |

### Delivered — supporting infrastructure

- **Appendix A** — embedding provider selection: `workspaces.embedding_provider_type`
  + `embedding_provider_config` columns; factory degrades to the hashing provider
  on misconfiguration so startup never fails.
- **Appendix C** — `brain_quality_events` table + `recordQualityEvent`. Records
  `atom_injected`, `atom_confidence_delta`, `evaluator_pass`, `evaluator_fail`.
  This is the measurable substrate the Brain Health dashboard (Part VI) will read.
- **U5 (partial)** — `workspaces.auxiliary_adapter_config` column added as the
  schema slot for the cheap background adapter. The adapter client itself is a
  Phase 2 item.
- **Migration 33** (`brain_abilities_replan`) for version-tracked upgrades, plus
  mirrored idempotent DDL in the embedded path (`index.ts`) so fresh installs and
  the test harness get the same schema.

### Corrections to the document's assumptions

1. **No single `knowledge_atoms` table.** The doc's schemas (Gap14, BL5/6,
   Appendix D) assume one atom table. The codebase has five atom sources
   (`memory_episodes`, `app_memory`, `app_promoted_patterns`, `knowledge_chunks`,
   `kb_chunks`). Lifecycle columns and the feedback loop were applied to
   `memory_episodes` — the table the promotion path actually writes to and the
   one that accumulates duplicates. Extending lifecycle to the other four is a
   mechanical follow-up, not a redesign.
2. **Embeddings stored as JSON, not `BLOB`.** `memory_episodes.embedding` is an
   existing `text(json)` column. Storing float arrays there works with cosine
   similarity and avoids a `sqlite-vec` native dependency. `sqlite-vec` remains a
   valid optimisation once atom counts are large.
3. **Pre-existing bug fixed.** `EMBEDDED_INIT_SQL` had a corrupt
   `app_baseline_snapshots` table — a duplicate `app_id` column and a stray
   `CREATE INDEX` spliced mid-table — which crashed every test that opened an
   embedded DB. Fixed in `embedded-sql.ts`.
4. **Async promotion via the queue, not inline.** Real embeddings are async
   (HTTP). Rather than make `extractAndPromote` async (and break its callers /
   tests), the embedding-aware path is a new `promote()` method the queue worker
   awaits. The synchronous lexical `extractAndPromote` is retained as a wired
   fallback for when the queue is absent (tests).

### Verification

- `tsc --noEmit` clean: `@agentis/core`, `@agentis/db`, `@agentis/api`.
- `collectiveBrain.test.ts` — 6/6 pass (no regressions).
- `brainPromotionQueue.test.ts` (new) — 3/3 pass: durable enqueue→process with
  embedding + lifecycle assertions; priority ordering; dispatch injection +
  PASS/FAIL confidence movement (validation gates G0–G2 in spirit).
- 3 unrelated `WorkflowEngine.engine10x` failures (`context_compress`, edge
  contract, graph patch) were confirmed pre-existing at `HEAD` — not caused by
  this work.

### Not yet implemented — Phase 2+ backlog

The following are scoped but not built. They are genuinely large (new services,
LLM-auxiliary infrastructure, and React UI that cannot be verified headless):

- **Priority 2** — U2 LLM-pass promoter, U5 auxiliary adapter client, B12 review
  rate limiting, Gap16 ambient activity feed UI, B8 user profiles, Gap15
  contradiction detection, B3 thinking-trace capture, **U4 Agent Abilities**
  (table + dispatch + reviewer + Abilities tab).
- **Priority 3** — Part V peer representations & per-turn dialectic, BL13
  session-local atoms + `brain_refresh`, Part VI Brain Health dashboard, U10
  Dispute Resolution panel, U3 brain management tools, B9 FTS5, U6
  `BrainMaintenanceService`, C1 `BrainCompressionService`, Ed25519 ability export.

The Phase 1 foundation is the prerequisite for all of them: the durable queue
(B10) carries `ability_review`/`peer_update`/`contradiction_check` item types
already; `brain_quality_events` already feeds the future dashboard; the
embedding provider already serves ability relevance matching.

---

---

## Implementation Log — Phase 2: Agent Abilities & User Profiles (2026-05-19)

> **Status:** Priority 2 backend implemented, compiling, and test-verified.
> Agents now carry **procedural memory** (Tier 3 of Part III) — they accumulate
> and refine *how-to* knowledge, not just facts. A run's reasoning trace is
> captured, distilled into an ability, and injected into future dispatches of
> the same agent role.

### Delivered — Priority 2

| Item | What was done | Files |
|---|---|---|
| **U4** — Agent Abilities system | New `agent_abilities` table; `AgentAbilityService` (CRUD, embedding-ranked relevance query, **immutable versioning** — every patch forks a new row and supersedes the old, full version history + rollback, team scope via `workflowId`/`teamRole`); `AgentAbilityReviewer` (Path 1 — distils a class-level procedure from a completed run); dispatch injection in `WorkflowEngine` (top-N relevant active abilities, frozen at dispatch); `/v1/abilities` CRUD routes (list, get+history, create, patch, pin, rollback, archive). | `agentAbilityService.ts`, `agentAbilityReviewer.ts`, `routes/abilities.ts`, `WorkflowEngine.ts`, `types/ability.ts`, migration 34 |
| **B3** — Reasoning trace capture | `WorkflowEngine.recordThinking()` accumulates `agent.thinking` events per agent_task node (bounded at 40 entries); the trace is handed to the ability reviewer at completion as the richest learning signal. | `WorkflowEngine.ts`, `bootstrap.ts` |
| **B8** — User profile layer | New `workspace_user_profiles` table; `UserProfileService` (get/set, dispatch block render); `/v1/abilities/profile` GET/PUT routes; the operator profile is injected as a frozen `OPERATOR PROFILE` block at every agent dispatch. | `userProfileService.ts`, `routes/abilities.ts`, `WorkflowEngine.ts`, migration 34 |
| **B12** — Background-review safety at scale | The `ability_review` job type now flows through the same `BrainPromotionQueueWorker` as atom promotion — per-workspace concurrency cap (2), priority queue, and circuit breaker apply unchanged. No new code: B10's worker was built to carry this. | `brainPromotionQueueWorker.ts` |
| **Gap16** — Ambient learning signal (backend) | `ABILITY_CREATED` / `ABILITY_REINFORCED` / `ABILITY_UPDATED` realtime events are emitted by `AgentAbilityService` and forwarded to workspace-room subscribers (the WS layer has no allowlist — events flow as published). The consuming `BrainActivityFeed` React component is the one remaining UI piece. | `events.ts`, `agentAbilityService.ts` |

### How the abilities loop closes

1. An `agent_task` completes → `WorkflowEngine` enqueues both an
   `atom_promotion` and an `ability_review` job (with the captured thinking
   trace) on the durable queue.
2. `BrainPromotionQueueWorker` processes `ability_review` →
   `AgentAbilityReviewer` distils a class-level procedure (heuristic now; LLM
   slot reserved) → `AgentAbilityService.upsertFromReview` either patches a
   semantically-matching ability (new version) or creates a new one.
3. The next dispatch of that agent role calls
   `AgentAbilityService.buildDispatchBlock` → the top-N relevant active
   abilities are injected as a frozen `AGENT ABILITIES` block, ranked by
   embedding cosine similarity to the task.
4. `usageCount` / `lastUsedAt` are bumped; `ABILITY_*` events surface the
   learning to any operator watching.

### Design decisions

- **Heuristic reviewer, LLM-ready.** `AgentAbilityReviewer` accepts an optional
  `AbilityReviewLlm` and falls back to a conservative heuristic procedure
  extractor (ordered/imperative steps + quantitative learnings). It only writes
  an ability when a genuine *multi-step procedure* is present, so the library
  does not fill with single-fact noise. This mirrors the BL11a interim-then-
  terminal pattern the document itself sanctions.
- **Immutable versioning.** A patch never mutates a row — it inserts a new
  version with `parentAbilityId` set and transitions the old row to
  `superseded`. Rollback creates a fresh `operator_rollback` row from the
  target's content, so the audit trail is never destroyed.
- **Team abilities** are supported at the schema + query level
  (`workflowId` + `teamRole`); the scope filter broadens dispatch retrieval to
  `agentId = ? OR (workflowId = ? AND teamRole matches)`.

### Verification

- `tsc --noEmit` clean: `@agentis/core`, `@agentis/db`, `@agentis/api`.
- `agentAbilities.test.ts` (new) — 5/5 pass: versioning + supersede, rollback,
  reviewer distillation (positive + negative), relevance-ranked dispatch.
- All Phase 1 brain tests still green (9/9). No new `engine10x` regressions.

### Not yet implemented — Phase 3+ backlog

- **U2 / U5** — LLM-pass promoter + auxiliary adapter *client*. The
  `auxiliary_adapter_config` column and the reviewer's `AbilityReviewLlm` slot
  exist; what remains is a request/response LLM client (the existing adapters
  are event-based task dispatchers). This needs live-model infrastructure to
  build and verify honestly.
- **Gap15** — contradiction detection (depends on the LLM promoter's
  reasoning).
- **U8** — package-manifest ability seeding: `AbilitySeed` /
  `AgentAbilitySeedGroup` core types and `create({ source: 'package_seed' })`
  exist; wiring `packager.ts` to read a manifest `agentAbilities` field and map
  `agentSlug → agentId` at activation remains.
- **UI** — `BrainActivityFeed`, `AbilitiesTab`, `BrainHealthDashboard`,
  `DisputeResolutionPanel` (the events + `/v1/abilities` API + quality-event
  data they consume are all live).
- **Part V / VI / Appendix D** — peer representations, per-turn dialectic,
  Brain Health dashboard, `BrainMaintenanceService`, `BrainCompressionService`.

---

## Implementation Log — Phase 3: Brain Dialectic, Health, Disputes & Maintenance (2026-05-19)

> **Status:** Phase 3 implemented, wired into app-thread runtime, exposed in
> API/UI, and test-verified. The Brain now has short-term session atoms,
> peer representations, per-turn context refresh/dialectic injection, health
> and dispute surfaces, FTS-backed session search, and background maintenance
> with compression.

### Delivered — Phase 3

| Item | What was done | Files |
|---|---|---|
| **Part V** — Peer representations | Added `peer_representations` and `peer_representation_conclusions`; built `PeerRepresentationService` with queued session review, peer summaries, conclusions, and realtime `BRAIN_PEER_UPDATED` events. App-thread turns enqueue low-priority peer updates after replies. | `schema.ts`, `migrations.ts`, `peerRepresentationService.ts`, `brainPromotionQueueWorker.ts`, `routes/apps.ts`, `bootstrap.ts` |
| **Per-turn App Brain dialectic** | Added `BrainDialecticService`; app-thread turns now inject a compact `APP BRAIN CONTEXT` bundle on first/cadenced/forced turns and an `APP BRAIN DIALECTIC` synthesis on cadence. The injection combines durable atoms, session-local atoms, peer card, and capacity counts while preserving the original operator message in thread history. | `brainDialecticService.ts`, `routes/apps.ts`, `collectiveBrain.ts` |
| **BL13** — Session-local atoms + `brain_refresh` | Added `session_atoms` table and `SessionAtomService` with TTL, semantic query, promotion eligibility, expiry sweep, and realtime refresh events. App-thread operator/reply turns capture session atoms; high-confidence atoms are promoted through the durable queue. Added chat tools: `agentis.brain.search`, `agentis.brain.add`, `agentis.brain.summarize`, `agentis.brain.refresh`, `agentis.session.search`. | `sessionAtomService.ts`, `agentisToolHandlers/data.ts`, `chatToolCatalog.ts`, `agentisToolHandlers/app.ts`, `routes/apps.ts` |
| **Part VI** — Brain Health dashboard + ambient feed | Added `BrainHealthService`, `/v1/brain/health`, `/v1/apps/:appId/brain/health`, activity endpoints, and React health/activity components. The UI shows health score, coverage, evaluator signal rate, ability adoption, stale/disputed counts, compression status, top atoms, stale queue, and recent Brain quality events. | `brainHealthService.ts`, `routes/brain.ts`, `routes/apps.ts`, `BrainHealthDashboard.tsx`, `BrainActivityFeed.tsx`, `UnifiedBrainPage.tsx`, `AppDetailPage.tsx` |
| **U10** — Dispute Resolution panel | Contradiction links now produce open disputes over episode atoms. Added resolution actions: keep A, keep B, merge, context split, and snooze. Context splits annotate both atoms and close the contradiction link; merges create a curator-distilled atom and archive sources. Added workspace/app API routes and React panel. | `collectiveBrain.ts`, `routes/brain.ts`, `routes/apps.ts`, `DisputeResolutionPanel.tsx` |
| **U3** — Brain management/runtime tools | Added durable Brain add/search/summarize/refresh tools and a cross-session search tool available to app-thread chat. Tools infer current app/session from chat context and fall back gracefully when optional services are not mounted in focused tests. | `agentisToolHandlers/data.ts`, `agentisToolHandlers/deps.ts`, `chatToolCatalog.ts`, `agentisToolHandlers/app.ts`, `bootstrap.ts` |
| **B7** — Capacity/budget signal | Dispatch context now includes Brain capacity status and pre-task synthesis. Health/compression status is also available through `brain.summarize`. | `collectiveBrain.ts` |
| **B9** — FTS5 on ledger + conversations | Added FTS5 virtual tables and triggers for `ledger_events` and `conversation_messages`, plus `SessionSearchService`. Fixed ledger FTS to use a real FTS table for synthetic `payload_text` and added migration 36 to repair/backfill existing DBs. | `index.ts`, `migrations.ts`, `sessionSearchService.ts` |
| **U6 / C1** — Maintenance + compression | Added `BrainMaintenanceService` and `BrainCompressionService`; bootstrap starts/stops maintenance. Maintenance marks stale atoms, archives low-confidence stale managed atoms, prunes stale links, sweeps expired session atoms, and records quality events. Compression tiers archive low-value atoms, merge near-duplicates, and enqueue curator passes when capacity pressure is high. | `brainMaintenanceService.ts`, `brainCompressionService.ts`, `brainPromotionQueueWorker.ts`, `bootstrap.ts` |

### Runtime flow now active

1. Operator sends an app-thread message.
2. The route captures a session-local atom, builds recent-message topic context,
   asks `BrainDialecticService` for durable/session/peer context, and sends the
   injected message to the adapter.
3. The adapter can call Brain tools mid-turn, including `agentis.brain.refresh`
   after a topic shift.
4. Final replies are persisted normally; post-turn hooks add a reply session atom,
   enqueue peer representation review, and promote eligible session atoms.
5. Background workers process atom promotion, peer updates, contradiction checks,
   and curator passes through the durable queue.
6. Health/dispute/activity surfaces update from quality events and realtime Brain
   events.

### Verification

- `pnpm --filter @agentis/db exec tsc --noEmit`
- `pnpm --filter @agentis/api exec tsc --noEmit`
- `pnpm --filter @agentis/web exec tsc --noEmit`
- `pnpm --filter @agentis/api test -- tests/services/brainPhase3.test.ts`
- `pnpm --filter @agentis/api test -- tests/services/collectiveBrain.test.ts tests/services/brainPromotionQueue.test.ts tests/services/agentAbilities.test.ts tests/services/brainPhase3.test.ts`

### Notes

- The Phase 3 LLM-facing seams are intentionally conservative and LLM-ready:
  peer conclusions and dialectic synthesis are heuristic today, but their service
  boundaries are isolated so a live auxiliary model client can replace the
  heuristics without reshaping schema, routes, tools, or UI.
- The existing worktree already contained broad Phase 1/2 and platform changes;
  this phase was implemented without reverting unrelated local edits.

---

## Implementation Log - Phase 3 Addendum: Structured Peer Cards, Dreaming & Memory Controls (2026-05-19)

> **Status:** The new Part III / Part V / Part VII additions are implemented,
> wired into runtime injection, exposed through API/tools/UI where specified,
> and regression-tested. Peer representations now behave as structured,
> scoped Brain memory instead of a loose summary layer.

### Delivered - New Doc Additions

| Item | What was done | Files |
|---|---|---|
| **Boundary with existing memory layers** | Kept the existing separation intact: episodic/app memory remain event and app-store layers, Brain atoms remain durable workspace/app knowledge, abilities remain procedural memory, and peer representations now store observer-scoped beliefs/facts about people or agents. The implementation routes new peer/dreaming behavior through peer services instead of duplicating atoms or app memory. | `peerRepresentationService.ts`, `brainDialecticService.ts`, `agentisToolHandlers/data.ts` |
| **Structured Peer Card** | Added atomic peer facts with `INSTRUCTION`, `PREFERENCE`, `TRAIT`, `IDENTITY`, `CONTEXT`, and `BELIEF` categories; enforced the 40-fact cap per card; added confidence, source, volatility, timestamps, and supersession fields. Runtime injection is split exactly as specified: `INSTRUCTION` facts are rendered into the system prompt addendum, while all other categories are rendered into the user-message Brain context. | `schema.ts`, `migrations.ts`, `index.ts`, `peerRepresentationService.ts`, `chatSessionExecutor.ts`, `brainDialecticService.ts`, `routes/apps.ts` |
| **Conclusion classification and decay metadata** | Added `conclusionType`, `volatilityClass`, `supportingSessionCount`, `supersededById`, and active/superseded status to peer conclusions. Session review writes deductive conclusions by default, dream induction can elevate repeated patterns into inductive conclusions, and stale volatile conclusions can be superseded during dream passes. | `schema.ts`, `migrations.ts`, `peerRepresentationService.ts`, `dreamingService.ts` |
| **Dreaming cycle for peer representations** | Added `DreamingService` and `dream_pass` queue work. Phase 1 deduction consolidates injection-eligible conclusions into peer card facts, supersedes stale volatile facts, and flags BELIEF contradictions against durable Brain atoms. Phase 2 induction mines repeated cross-session patterns into inductive trait conclusions. Dream passes can run from the durable queue, the Brain API, or the dashboard button, with a strict one-concurrent-dream-pass-per-workspace queue cap. | `dreamingService.ts`, `brainPromotionQueueWorker.ts`, `routes/brain.ts`, `routes/apps.ts`, `bootstrap.ts`, `BrainHealthDashboard.tsx` |
| **Directional peer representations for multi-agent** | Added `agent_peer_cards` for observer-scoped representations. The peer service can read/write a global peer card or a directional card scoped by observer peer id, with fallback to global context when no scoped card exists. | `schema.ts`, `migrations.ts`, `index.ts`, `peerRepresentationService.ts` |
| **`brain_preload` tool** | Added anticipatory Brain preload as a non-mutating tool. It aggregates relevant durable atoms, structured peer prompt/context, candidate abilities, and possible uncertainty gaps before a task starts. | `agentisToolHandlers/data.ts`, `chatToolCatalog.ts`, `agentisToolHandlers/app.ts`, `bootstrap.ts` |
| **`brain_forget` tool** | Added dry-run-first selective forgetting across durable atoms, peer conclusions/cards, abilities, and graph links. Confirmed runs archive/remove matching records and write a `brain_forget_completed` audit quality event with realtime publication. | `agentisToolHandlers/data.ts`, `chatToolCatalog.ts`, `agentisToolHandlers/app.ts`, `events.ts` |
| **Events and health surface** | Added dream/forget/contradiction realtime event constants. The health dashboard now has a manual Dream Pass action that calls the app/workspace Brain route and refreshes health afterward. | `events.ts`, `BrainHealthDashboard.tsx`, `routes/brain.ts`, `routes/apps.ts` |

### Verification

- `pnpm --filter @agentis/db exec tsc --noEmit`
- `pnpm --filter @agentis/api exec tsc --noEmit`
- `pnpm --filter @agentis/web exec tsc --noEmit`
- `pnpm --filter @agentis/api test -- tests/services/brainPhase3.test.ts`
- `pnpm --filter @agentis/api test -- tests/services/collectiveBrain.test.ts tests/services/brainPromotionQueue.test.ts tests/services/agentAbilities.test.ts tests/services/brainPhase3.test.ts`

### Implementation Notes

- The dreaming implementation is deterministic and LLM-ready: the service boundary isolates deduction/induction so a future auxiliary model pass can replace the conservative classifier without schema or route churn.
- `brain_forget` intentionally defaults to `dryRun: true`. Destructive forgetting requires an explicit confirmed call and leaves an auditable quality event.
- Directional cards are implemented at the service/schema level now; the global card remains the fallback so existing app turns keep working when no observer-specific card has been learned yet.
- Embedded SQLite startup migrations now patch legacy Brain/ability/peer columns before compiling indexes, so existing local databases upgrade cleanly instead of only fresh test databases passing.
- Existing local worktree changes were preserved. This addendum only extends the Phase 3 Brain surface rather than reverting or reshaping unrelated platform work.

---

## Implementation Log - Phase 3 Architecture Review Fixes & Brain Intelligence Config (2026-05-19)

> **Status:** The seven architecture-review findings were remediated and the
> Brain intelligence configuration flow is implemented end to end. The Brain now
> has a first-class workspace embedding configuration surface, degraded-mode
> events and UX, restart-safe queue recovery, safer peer-card injection, and a
> transactional selective-forgetting path.

### Delivered - Architecture Review Remediation

| Finding | Fix | Files |
|---|---|---|
| **1. Directional peer memory leaked into global memory** | Observer-scoped session learning now writes summaries, peer-card facts, and conclusions to `agent_peer_cards` / observer-scoped conclusions. Global peer memory is updated only by global writes or explicit promotion. Global reads no longer return directional conclusions. | `peerRepresentationService.ts`, `dreamingService.ts`, `brainPhase3.test.ts` |
| **2. Raw session text could become trusted system instructions** | Peer-card facts now carry a `source` field. Only `operator_confirmed` and `system` `INSTRUCTION` facts enter the system prompt; session-observed and dream-inferred instructions are injected as user-message context. | `peerRepresentationService.ts`, `dreamingService.ts`, `brainPhase3.test.ts` |
| **3. Queue jobs were not restart-safe once stuck in `processing`** | The Brain queue now uses a processing lease, reclaims stale `processing` jobs, atomically claims rows by prior status/update timestamp, and increments attempts on claim. `dream_pass` remains capped at one concurrent item per workspace. | `brainPromotionQueueWorker.ts`, `brainPromotionQueue.test.ts` |
| **4. `brain_forget` destructive path was too risky** | Added `brain_forget_requests`, frozen dry-run match sets, mandatory `confirmRequestId` for destructive execution, a transaction around all archive/removal work, soft-updated forgotten links, and a completion audit event. | `schema.ts`, `index.ts`, `migrations.ts`, `agentisToolHandlers/data.ts`, `chatToolCatalog.ts`, `brainPhase3.test.ts` |
| **5. Dream pass was weakly evidenced** | Supersession now requires concrete evidence: matching category/topic, different normalized content, and different source sessions when both are known. Induction remains scoped by observer and support count. | `dreamingService.ts`, `brainPhase3.test.ts` |
| **6. Peer/dream services bypassed configured embeddings** | Peer representation and dreaming now resolve the workspace embedding provider through the same provider selector as Brain atoms and expose cache invalidation for config changes. | `peerRepresentationService.ts`, `dreamingService.ts`, `workspaceIntelligence.ts` |
| **7. Tokenization/scoring/json helpers were duplicated** | Added shared `brainText.ts` and moved safe JSON parsing, text normalization, tokenization, and text scoring into one local utility used by peer and forgetting services. | `brainText.ts`, `peerRepresentationService.ts`, `dreamingService.ts`, `agentisToolHandlers/data.ts` |

### Delivered - Brain Intelligence Config

| Item | What was done | Files |
|---|---|---|
| **Workspace intelligence API** | Added `GET /v1/workspace/intelligence` and `PATCH /v1/workspace/intelligence` for `embeddingProviderType`, `embeddingProviderConfig`, and `auxiliaryAdapterConfig`. The API redacts stored keys, preserves an existing API key when editing non-secret fields, invalidates embedding-provider caches, and returns confirmation metadata when switching providers with existing atoms. | `workspaceIntelligence.ts`, `bootstrap.ts`, `workspaceIntelligence.test.ts` |
| **Embedding verify endpoint** | Added `POST /v1/workspace/intelligence/embedding/verify` for a quick validate/embed round trip. Hashing reports `degraded: true`; real providers can fail fast with connection errors. | `workspaceIntelligence.ts`, `workspaceIntelligence.test.ts` |
| **Re-embedding migration** | Provider switches with active atoms require confirmation, then enqueue `reembed_workspace`. Migration state is stored in workspace Brain settings, retrieval pauses while running, atoms are re-embedded with the new provider, and completion emits realtime and quality events. | `collectiveBrain.ts`, `brainPromotionQueueWorker.ts`, `workspaceIntelligence.ts`, `events.ts` |
| **Startup degraded health event** | Startup now scans workspaces using hashing embeddings and emits `BRAIN_CONFIG_DEGRADED`, plus a `brain_config_degraded` quality event, so operators get nudged even if they never visit Settings. | `bootstrap.ts`, `events.ts` |
| **Brain Health degraded banner** | The Brain Health dashboard now leads with a non-dismissible degraded-mode setup card when hashing is active. It links to the canonical Brain config page and refreshes on config/migration realtime events. | `brainHealthService.ts`, `BrainHealthDashboard.tsx` |
| **Canonical `/brain/config` wizard** | Added a permanent two-step Brain config page under Brain navigation. Step 1 configures embeddings with Ollama, OpenAI, or degraded hashing and has an inline connection test. Step 2 records background-model intent while the auxiliary adapter client remains gated. Provider switches with existing atoms show an honest re-embedding confirmation. | `UnifiedBrainPage.tsx`, `App.tsx`, `BrainConfigWizard.tsx` |
| **First-open inline setup** | The workspace Brain Map embeds the same setup wizard inline on the first degraded visit. Completing setup or explicitly choosing skip hides the first-run wizard for that workspace; the Health degraded banner remains until semantic embeddings are configured. | `BrainView.tsx`, `BrainConfigWizard.tsx` |
| **Settings Intelligence tab** | Settings now has an Intelligence tab that links to `/brain/config` instead of duplicating configuration state. | `SettingsPage.tsx` |
| **Dispatch degraded signal** | Agent dispatch Brain context now includes the degraded header signal, for example `WORKSPACE BRAIN [degraded - hashing embeddings | ...]`, and retrieval pauses cleanly during migration. | `collectiveBrain.ts` |

### Verification

- `pnpm --filter @agentis/db exec tsc --noEmit`
- `pnpm --filter @agentis/api exec tsc --noEmit`
- `pnpm --filter @agentis/web exec tsc --noEmit`
- `pnpm --filter @agentis/api test -- tests/routes/workspaceIntelligence.test.ts tests/services/brainPromotionQueue.test.ts tests/services/brainPhase3.test.ts`

### Implementation Notes

- The configuration UI ships before the auxiliary adapter client by design. It records operator intent and clearly labels the lighter background model path as reserved for Dreaming Phase 4 and auto-dispute resolution.
- Existing provider secrets are never returned to the browser and are not cleared by routine model/endpoint edits.
- The selective-forgetting cascade is intentionally confirmation-first and transactional, so a stale UI result cannot silently delete a newly changed memory set.
- The implementation preserved the existing Phase 1/2 worktree and only tightened the Brain Phase 3 architecture around the reviewed risk points.
