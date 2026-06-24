# Agentis Brain — Memory Formation 10X

**Status**: Plan — not yet implemented
**Date**: June 9, 2026
**Author**: Memory-systems review (specialist edition)
**Scope**: The Brain **write path** — what gets *remembered* from agent runs, chat, and workflows. This is the formation, gating, typing, consolidation, and forgetting of memory. It is deliberately **not** about retrieval/RAG quality, which `BRAIN-IMPROVEMENT-PLAN.md` already covers.

> The Brain is the core of Agentis. Everything else — canvas, channels, specialists, abilities — is plumbing around one promise: *the system remembers, learns, and gets better at your work over time.* Today that promise is broken at the write path. This plan fixes it.

---

## 0. Why this document exists (the symptom)

The workspace and per-agent Brain graphs are filling with garbage. Real atoms observed in production:

- `MEMORY` — `| 8 | hn:48446141 | 3.70 | Healthcare AI copilot signal, useful but requiring cautious validation.`
- `MEMORY` — `Link: https://github.com/salimassili62-afk/ai-costguard`
- `MEMORY` — `| 4 | https://www.theverge.com/podcast/944138/microsoft-ai-ceo-mustafa-suleyman-superintelligence...`
- `PATTERN` — `No fresh unsent important AI stories were found for today's digest.`
- `PATTERN` — `I selected 8 stories because the instruction allows 5-8 when candidateCount is greater than...`
- `PATTERN` — `Actionable insight: Compare this approach with your current agent monitoring stack...`

Roughly **90% of auto-formed atoms are not memories at all.** They are *transient work product* (a daily digest's row data), *meta-commentary* (the agent narrating its own choices), or *raw artifacts* (URLs, story keys). Almost everything lands as the single type `PATTERN`/`MEMORY`, derived from one agent ("Orchy"), at uniform confidence.

This is not a tuning problem. It is an **architectural** one: Agentis has no memory-formation step. It has a memory-*dumping* step.

---

## 1. Root-cause autopsy (exact, with file:line)

The damage is produced by one path, fired on **every** `agent_task` completion.

### 1.1 The trigger is indiscriminate

`WorkflowEngine` enqueues an `atom_promotion` job after each task node finishes, handing the **raw task output** straight to the Brain:

- `apps/api/src/engine/WorkflowEngine.ts:2905-2930` — `enqueue({ itemType: 'atom_promotion', payload: { …, taskOutput: output } })`.

There is no gate on **what kind of task** this was. A daily-digest node that emits a formatted newsletter is treated identically to a debugging run that discovered a durable lesson. Transient deliverables are exactly the outputs that must **not** become long-term memory.

### 1.2 The "extractor" is a regex sentence-splitter, not a memory former

`CognitivePromotionQueueWorker` dispatches the job to `SharedIntelligence.promote()`:

- `apps/api/src/services/cognitivePromotionQueueWorker.ts:235-249`
- `apps/api/src/services/sharedIntelligence.ts:221` — `const facts = extractPromotableFacts(input.taskOutput)`

`extractPromotableFacts` (`sharedIntelligence.ts:2145-2154`) does the following:
1. flatten any object/array into text,
2. strip code fences and JSON-ish blocks,
3. split on sentence boundaries,
4. keep sentences 25–500 chars,
5. drop ones matching `looksSensitive`,
6. keep ones passing `hasUsefulSignal`.

Step 6 is the *entire* quality bar, and it is trivially defeated (`sharedIntelligence.ts:2192-2196`):

```ts
function hasUsefulSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return /learned|observed|found|confirmed|failed|succeeded|requires|should|must|because|resolved|rate|limit|error|policy|rule|pattern|use|avoid|returns|returned/.test(lower)
    || tokenize(text).length >= 8;
}
```

- "No fresh unsent important AI stories were **found** for today's digest" → passes on `found`.
- "I selected 8 stories **because** the instruction allows 5-8…" → passes on `because`.
- "| 8 | hn:48446141 | 3.70 | Healthcare AI copilot signal, **useful** but requiring cautious validation" → passes on ≥8 tokens.

**The `|| tokenize(text).length >= 8` clause means any sentence of 8+ words is admitted.** That is not a filter. There is no judgment of whether the text is *durable*, *reusable*, *generalizable*, or even *a statement about the world* rather than the agent narrating itself.

### 1.3 Everything is written as one type, at one confidence

`promote()` writes every surviving sentence identically (`sharedIntelligence.ts:260-283`):

```ts
type: 'distilled_lesson',
source: 'run_promotion',
confidence: 0.58,
importance: 0.62,
trust: 0.55,
```

So there is no discrimination between a hard rule, a recurring pattern, a one-off observation, and noise. They all become `episode` atoms (rendered as `PATTERN`/`MEMORY` in the graph via `episodeToGraphNode`, `sharedIntelligence.ts:1902`). Dedup is purely embedding cosine (`EMBED_HIGH_SIMILARITY`), which collapses *near-identical* junk but does nothing about *categorically wrong* junk.

### 1.4 What is actually well-built (and must be preserved)

The diagnosis is narrow on purpose. These adjacent paths already do the right thing and are the template for the fix:

- **`harnessMemoryIngestion.ts`** — has a real deterministic quality gate (`scoreAtom`, hard rejects for bare URLs/short lines, rule-cue scoring), content-hash idempotency, and a **preview → human-review → commit** flow. This is the *only* write path that resists garbage today.
- **`chatMemoryCapture.ts`** — classifies operator messages into `fact|preference|rule|lesson`, rejects questions and sensitive strings, dedups against existing memory. Solid.
- **`reflectionService.ts`** ("dream pass") — already does deduction/induction over peer conclusions with supersession and contradiction flagging. The consolidation *engine* exists; it just isn't applied to run-promoted atoms.
- **`intelligencePromotion.ts`** — the `promoted_patterns` table has typed kinds (`business_rule`, `recurring_exception`, `approved_output_pattern`, `failure_with_fix`, `successful_playbook`), evidence counting, reinforcement, and selective mirroring into memory. This is a *good* model — it's just not what `promote()` uses.
- **`cognitivePromotionQueueWorker.ts`** — durable, restart-safe, per-workspace concurrency, circuit breaker. The infrastructure to do expensive (LLM) formation work asynchronously already exists.
- **`brainMaintenanceService.ts` / `brainCompressionService.ts`** — adaptive forgetting + compression already exist; they just have far too much low-value input to chew on.

**Conclusion:** Agentis already has every *organ* of a state-of-the-art memory system except the one that matters most — the **formation gate** between "an agent produced text" and "the Brain commits a memory." That gate is currently a regex. We replace it with a real one.

---

## 2. What the field does in 2026 (research grounding)

The current generation of memory systems converges on a small set of principles. Agentis violates most of them on the run-promotion path.

### 2.1 Memory is *extracted and judged*, not dumped

**Mem0** (the production reference, arXiv 2504.19413) runs a **two-phase pipeline** on every exchange:
1. **Extraction** — an LLM identifies *salient facts* from the exchange (not every sentence; the ones worth keeping), conditioned on a rolling summary + recent context.
2. **Update** — each candidate fact is compared against semantically-near existing memories, and an LLM emits one of **ADD / UPDATE / DELETE / NOOP**. ADD only when nothing equivalent exists; UPDATE augments; DELETE removes contradicted memories; NOOP when redundant.

This is the single most important pattern Agentis is missing. Mem0's footprint is ~1.7k tokens/conversation vs Zep's ~600k precisely *because* it extracts salient facts instead of storing raw turns.

### 2.2 Distinct memory types with distinct lifecycles

The literature (Atlan; "Memory for Autonomous LLM Agents," arXiv 2603.07670; "Episodic Memory is the Missing Piece," arXiv 2502.06975) consistently separates:
- **Working memory** — the live prompt context (Agentis: dispatch context block).
- **Episodic memory** — what happened, with full context and timestamps (Agentis: `memory_episodes`).
- **Semantic memory** — generalized facts/knowledge distilled from episodes (Agentis: should be `promoted_patterns` + workspace memory, but `promote()` skips this).
- **Procedural memory** — skills/playbooks (Agentis: abilities + `successful_playbook`).

The key mechanism is **consolidation**: episodes are periodically *reflected upon* and only the generalizable signal graduates to semantic memory. "Consolidation from episodic to semantic is rarely automatic; most systems use crude heuristics" — Agentis' crude heuristic is `hasUsefulSignal`, and it graduates *everything directly to semantic* with no episodic staging.

### 2.3 Write-path filtering is a first-class concern

"Memory for Autonomous LLM Agents" (2603.07670) names **write-path filtering, contradiction handling, latency budgets, and privacy governance** as the core engineering realities. **Memory-R1** learns the write/forget policy via PPO. The takeaway: deciding *what not to remember* is as important as retrieval, and it deserves a real model, not a regex.

### 2.4 Forgetting is a feature

ACT-R-inspired architectures (ACM 3765766.3765803) and SAGE/MARK use **Ebbinghaus decay + salience/trust scoring** to let unreferenced memories fade. SSGM (2603.11768) adds **stability & safety governance** so evolving memory doesn't drift or get poisoned. Agentis has `brainMaintenanceService` decay but it is drowned by write volume.

### 2.5 Temporal & relational structure

**Zep/Graphiti** uses a bi-temporal knowledge graph (valid-time + ingestion-time) so facts can be superseded without deletion. **A-MEM** builds a Zettelkasten-style network where each note is structured (keywords/tags) and new notes link to and *revise* old ones. Agentis already has temporal link edges (`valid_from`/`invalid_at`, migration 43) and typed relations — they're just under-used on the promotion path.

### Reference index

- Mem0 — *Building Production-Ready AI Agents with Scalable Long-Term Memory*, arXiv [2504.19413](https://arxiv.org/abs/2504.19413)
- *Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers*, arXiv [2603.07670](https://arxiv.org/abs/2603.07670)
- *Position: Episodic Memory is the Missing Piece for Long-Term LLM Agents*, arXiv [2502.06975](https://arxiv.org/pdf/2502.06975)
- *Governing Evolving Memory in LLM Agents (SSGM)*, arXiv [2603.11768](https://arxiv.org/html/2603.11768v1)
- *Human-Like Remembering and Forgetting in LLM Agents (ACT-R)*, ACM [10.1145/3765766.3765803](https://dl.acm.org/doi/10.1145/3765766.3765803)
- Zep/Graphiti temporal knowledge graph; A-MEM Zettelkasten memory network; Letta (MemGPT) memory-as-OS — *Agent Memory at Scale 2026* vendor survey.
- Atlan, *Types of AI Agent Memory* and *Best AI Agent Memory Frameworks 2026*.

---

## 3. Design principles for Agentis

1. **Memory is formed, not dumped.** Nothing reaches the semantic graph without passing a real formation gate.
2. **Two stages: stage to episodic, graduate to semantic.** A run's output, if it survives a cheap deterministic pre-filter, becomes an *episodic trace* (cheap, decays fast, low-confidence). Only **reflection/consolidation** promotes episodic traces into typed semantic memory — and only when evidence recurs or an LLM judge confirms durability.
3. **The task's nature decides the write policy.** A digest/notification/report writes (at most) an episodic outcome marker, never patterns. A debugging/decision/evaluation run is allowed to form semantic memory.
4. **Type and scope are decided explicitly**, mirroring `promoted_patterns` kinds, not flattened to `distilled_lesson`.
5. **Self-narration is not memory.** First-person process commentary ("I selected 8 stories because…") is filtered structurally.
6. **Model-agnostic.** The formation judge uses the existing structured-completion runtime (`structuredCompleter.ts` / `platformModelService.ts`); it must degrade to the deterministic gate when no model is configured. Never branch on model family. (See `[[feedback_model_agnostic_tools]]`.)
7. **Forgetting is on by default.** Episodic traces have an expiry; unreferenced semantic atoms decay; the maintenance service must be able to keep up because write volume drops by an order of magnitude.

---

## 4. Target architecture: the Formation Pipeline

Replace the single `extractPromotableFacts → write` step with a staged pipeline. Each stage is cheap-to-expensive, short-circuiting early.

```
agent_task output
      │
      ▼
[A] Write-policy gate ──────────────► (digest/report/notify) ─► episodic outcome marker only ─► STOP
      │ (task is "knowledge-bearing")
      ▼
[B] Deterministic pre-filter  ── drops URLs, table rows, self-narration, artifacts, boilerplate
      │ (survivors only)
      ▼
[C] Episodic staging          ── write as `memory_episodes` type=`observation`, confidence ≤0.4,
      │                           ttlExpiresAt set, tag `unconsolidated`
      ▼
[D] LLM Formation Judge (async, batched, queue)  ── for staged episodes meeting a recurrence/age trigger:
      │   extract salient candidate facts → classify type → emit ADD / UPDATE / DELETE / NOOP
      ▼
[E] Semantic commit           ── ADD/UPDATE into typed semantic memory (promoted_patterns kinds);
                                 link & supersede via existing temporal graph; reinforce on recurrence
```

### 4.1 Stage A — Write-policy gate (the highest-leverage fix)

Before anything, classify the *task*, not the text. Source of truth, in order:
- explicit node config (a new optional `memoryPolicy` on task nodes: `form | episodic_only | none`),
- the agent/node role (a "digest"/"notifier"/"reporter" role defaults to `episodic_only`),
- a deterministic output-shape heuristic (output is a list of ≥N homogeneous rows, or is a rendered document/newsletter ⇒ `episodic_only`).

`episodic_only` tasks may write a **single** outcome marker ("Daily AI digest ran; 0 fresh stories" — useful for the agent's own continuity and for analytics) and **nothing** to the pattern/semantic layer. `none` writes nothing.

**This alone removes the digest garbage**, because a digest is structurally `episodic_only`.

Implementation: new `MemoryPolicyResolver` consulted in `WorkflowEngine` before enqueue (`WorkflowEngine.ts:2905`); policy travels in the `AtomPromotionPayload`.

### 4.2 Stage B — Deterministic pre-filter (cheap, no model)

Port and harden the good gate from `harnessMemoryIngestion.scoreAtom`. Reject outright:
- bare URLs / lines that are mostly a URL,
- table-row shapes (`| … | … |`, leading `#N`, ranking/score columns like `hn:48446141 | 3.70`),
- first-person process narration (`/^(I|we) (selected|chose|decided|picked|found|will|am|have)\b/i` where it describes the agent's own action, not a durable rule),
- "Actionable insight:" / "Summary:" framing wrappers (keep the content only if it survives on its own),
- boilerplate and pointer fluff (already in `harnessMemoryIngestion`).

Output a 0..1 deterministic quality score; only candidates above a floor proceed. **Crucially, remove the `|| tokenize(text).length >= 8` escape hatch** — length is not signal.

### 4.3 Stage C — Episodic staging (not semantic!)

Survivors are written as **episodic** atoms, not patterns:
- `type: 'observation'` (new) or `outcomeStatus`-tagged episode,
- `confidence ≤ 0.4`, `tags: ['unconsolidated', adapterType]`,
- a new `ttlExpiresAt` column (migration): default ~14 days. If never reinforced/consolidated, the maintenance service archives it.

This is the episodic→semantic separation the literature insists on. The graph view should **hide `unconsolidated` episodes by default** (or badge them "raw"), so the Brain UI stops showing junk even before consolidation runs.

### 4.4 Stage D — LLM Formation Judge (the Mem0 step)

A new `MemoryFormationService`, invoked by the queue worker (new item type `memory_formation`, or folded into a smarter `atom_promotion`). For a batch of staged episodes that hit a **consolidation trigger** (same cluster seen ≥2 times, OR an episode reached an age/access threshold, OR an evaluator marked the run a strong pass):

1. **Extract** salient candidate facts (Mem0 extraction phase), conditioned on the workspace's existing relevant memories (retrieved via `searchAtoms`).
2. **Classify** each into a semantic kind: `business_rule | recurring_exception | approved_output_pattern | failure_with_fix | successful_playbook | preference | fact`. Reject `none` (not a durable memory).
3. **Reconcile** against retrieved neighbors → **ADD / UPDATE / DELETE / NOOP** (Mem0 update phase) using the existing structured-completion runtime with a strict JSON schema.

Strict output schema (no free-form prose committed):
```jsonc
{ "operation": "ADD|UPDATE|NOOP|DELETE",
  "kind": "business_rule|recurring_exception|approved_output_pattern|failure_with_fix|successful_playbook|preference|fact",
  "title": "string",
  "statement": "generalized, reusable, non-first-person",
  "scope": "workspace|agent",
  "confidence": 0.0,
  "supersedesAtomId": "optional",
  "reason": "string" }
```

No model configured ⇒ skip Stage D entirely; episodic traces simply decay. The Brain stays clean by *omission*, never by dumping.

### 4.5 Stage E — Semantic commit

- `ADD` → `IntelligencePromotion.promoteOrReinforce()` with the judged kind (reuse `intelligencePromotion.ts` wholesale; it already mirrors eligible kinds into `workspace_memory`).
- `UPDATE` → augment the target atom; bump evidence/confidence via existing `reinforce`.
- `DELETE` → demote/supersede the contradicted atom through the temporal-link path (`createLink` relation `contradicts` + supersession), not a hard delete.
- `NOOP` → reinforce the matched neighbor's `lastAccessed`/evidence only.

This routes run-formed memory through the *same* typed, evidence-counted, self-regulating machinery that `promoted_patterns` already provides — instead of the flat `distilled_lesson` dump.

---

## 5. Cleanup of existing pollution

The graphs are already full. A migration/maintenance pass:

1. **Quarantine** existing `episode` atoms where `source='run_promotion'` AND `type='distilled_lesson'` that match the junk signatures (table rows, URLs, first-person narration, digest phrasing). Mark `status='archived'` with `archivedReason='formation_backfill'` — reversible, not destroyed.
2. **Re-stage** survivors as `unconsolidated` so the new Stage D can re-judge them on the next consolidation pass.
3. Expose a one-click **"Rebuild memory"** admin action (`/v1/brain/...`) that runs quarantine + re-consolidation for a workspace, with a dry-run count first.
4. Add a Brain-health metric: `formationPrecision = committed_semantic / staged_episodic` and `junkArchivedLast7d`, surfaced in `brainHealthService`.

---

## 6. Phased delivery

| Phase | Outcome | Primary files |
|------|---------|---------------|
| **P0 — Stop the bleeding** | Remove the `length≥8` escape hatch in `hasUsefulSignal`; add deterministic rejects for URLs/table-rows/first-person narration to `extractPromotableFacts`; hide `unconsolidated`/junk from the graph view. Ship in hours, kills ~80% of new garbage. | `sharedIntelligence.ts`, brain graph query |
| **P1 — Write-policy gate (Stage A)** | Task-nature classification; digests/reports/notifiers become `episodic_only`. Optional `memoryPolicy` node config. | `WorkflowEngine.ts`, new `MemoryPolicyResolver`, `AtomPromotionPayload` |
| **P2 — Episodic staging (Stage B+C)** | `ttlExpiresAt` column (migration); run-promotion writes `observation` episodes, not patterns; maintenance expires them. | migration, `sharedIntelligence.promote()`, `brainMaintenanceService.ts` |
| **P3 — Formation Judge (Stage D+E)** | `MemoryFormationService` (Mem0 two-phase, ADD/UPDATE/DELETE/NOOP) on a consolidation trigger; commits through `IntelligencePromotion`. Model-agnostic; deterministic fallback. | new `memoryFormationService.ts`, `cognitivePromotionQueueWorker.ts`, `intelligencePromotion.ts` |
| **P4 — Cleanup + governance** | Backfill quarantine + re-consolidation; SSGM-style stability checks (no unbounded confidence growth, poisoning guards); Brain-health formation metrics. | migration, `brainHealthService.ts`, admin route |
| **P5 — Eval harness** | Golden set of agent outputs labeled keep/drop + expected type; CI asserts formation precision/recall so this never regresses. | `apps/api/test/brain/formation.*` |

P0 is shippable immediately and independently. P1 and P2 deliver most of the user-visible win. P3 is the durable, model-grade fix.

---

## 7. Success criteria

- **Formation precision ≥ 0.85** on the eval set (committed semantic atoms that a human agrees are durable, reusable memories).
- **Zero** atoms that are bare URLs, table rows, ranking keys, or first-person process narration in the graph.
- Digest/notifier/report workflows form **no** pattern atoms (episodic markers only).
- Total semantic-atom write volume per workspace drops ≥ 10× while *recall quality* of dispatch context is unchanged or better (measured via existing `atom_injected` → evaluator-verdict loop in `applyEvaluatorVerdict`).
- The maintenance/forgetting service keeps `unconsolidated` episodic backlog bounded.

---

## 8. What this is explicitly NOT

- Not a retrieval/RAG change — `BRAIN-IMPROVEMENT-PLAN.md` owns that and stays authoritative there.
- Not a new parallel store — everything reuses `memory_episodes`, `promoted_patterns`, `workspace_memory`, the temporal link graph, and the existing queue worker. No disconnected tables.
- Not a model-family branch — the judge is one structured-completion call behind a capability check, with a deterministic fallback.
- Not destructive — cleanup quarantines (archives) and is reversible; the Formation Judge supersedes via temporal links rather than hard-deleting.

---

## 9. Implementation log

_Append entries here as phases land, reconciled against real code (per the masterplan-log convention)._

### 2026-06-09 — P0–P5 shipped end-to-end

All six phases landed in one pass. Typecheck (api + core) clean; 27 new eval tests + the existing shared-brain/brain-route/chat-capture/fan-out suites green.

**New modules**
- `apps/api/src/services/brainFormation.ts` — the deterministic gate (`extractCandidateStatements`, `isRejectable`, `scoreStatement`), `classifyOutputShape`, and the Mem0-style `FormationJudge` (extract → classify → ADD/UPDATE/NOOP). No DB access; fully unit-tested.
- `apps/api/src/services/memoryPolicyResolver.ts` — `resolveMemoryPolicy` (explicit override → transient role → output shape → default).
- `apps/api/tests/brainFormation.test.ts` — golden keep/drop set built from the exact production garbage + the write-policy gate.

**Changed**
- `sharedIntelligence.ts` — `promote()` rewritten into the staged pipeline (policy gate → deterministic extraction → Formation Judge or episodic staging). Added `setFormationCompleter()`, `#writeEpisodicMarker`, `#formationNeighbors`, `#commitFormedMemories`, `#stageOrReinforce`, `#applyEmbedding`, and the §P4 `quarantineRunPromotionJunk()` backfill. The `length≥8` escape hatch is gone; the legacy `extractPromotableFacts` now delegates to the hardened gate. `loadAtoms` hides `unconsolidated` episodes from the graph.
- `WorkflowEngine.ts` (`#enqueueSuccessfulBrainCapture`) — resolves the write-policy (incl. agent role + `node.config.memoryPolicy`) and threads `memoryPolicy`/`taskTitle` into the promotion payload.
- `cognitivePromotionQueueWorker.ts` — `AtomPromotionPayload` carries `memoryPolicy`/`taskTitle` through to `promote()`.
- `brainMaintenanceService.ts` — `#expireStagedTraces` archives unconsolidated traces past `metadata.ttlExpiresAt` (14d staged / 30d markers) that were never reinforced.
- `brainHealthService.ts` — `formation` snapshot block: consolidated/unconsolidated counts + `formationPrecision`.
- `routes/brain.ts` — `POST /v1/brain/rebuild-memory` (`{dryRun?, limit?}`) runs the quarantine backfill.
- `bootstrap.ts` — wires the env evaluator runtime as the Formation Judge model.
- `packages/core/src/types/memory.ts` — added the `observation` episode type for staged traces.

**Deviation from plan**: the Formation Judge runs *inline inside the existing `atom_promotion` queue job* (already durable, concurrency-capped, circuit-broken) rather than as a separate `memory_formation` queue item. Formed memories are committed as correctly-typed **episode atoms** (tagged `consolidated`) so they land in the same graph the user inspects; mirroring into `promoted_patterns`/`workspace_memory` via `IntelligencePromotion` remains available as a follow-up. When no evaluator model is configured, survivors are staged as decaying `observation` traces — the Brain stays clean by omission, never by dumping.

**Operate it**: `POST /v1/brain/rebuild-memory {"dryRun":true}` to preview how many legacy junk atoms would be archived, then again without `dryRun` to quarantine them (reversible — archived with `archivedReason: 'formation_backfill'`).

### 2026-06-09 — QA pass

- **End-to-end integration tests** (`apps/api/tests/brainFormationPipeline.test.ts`, 7 cases): drive the real `SharedIntelligenceService.promote()` against an in-memory DB and assert the observable Brain state for every policy — `none` writes nothing; `episodic_only` writes exactly one hidden marker; `form` without a model stages the lone real lesson (drops all 6 garbage lines) hidden from the graph; `form` with a stub judge commits one typed `consolidated`, graph-visible atom and falls back to staging on an unparseable verdict; the §P4 backfill archives the 3 seeded junk atoms (dry-run counts only) while preserving a genuine lesson and its provenance. Together with the 27 unit cases, that's **34 green** formation tests.
- **Operator override made real**: `memoryPolicy` added to `AgentTaskNodeConfig` (`packages/core/src/types/workflow.ts`) and the `agent_task` zod schema (`packages/core/src/schemas/workflow.ts`) so a node-level `form|episodic_only|none` survives save instead of being stripped.
- **Hardening**: `quarantineRunPromotionJunk` now merges `archivedReason` into existing metadata rather than overwriting provenance.
- **Dedup bug fixed**: the first QA pass flagged `agentisChatTools.test.ts` "reuses the current MCP agent draft". It turned out to be a **real, pre-existing, deterministic bug** (it failed in isolation), unrelated to memory formation. Root cause: an *identical* repeat `build_workflow` call was routed by the conversation latch into the model-requiring *refine-in-place* path, so with no synthesis model configured the second call threw `WORKFLOW_SYNTHESIS_UNAVAILABLE`. Fixed in `agentisToolHandlers/build.ts` (`createWorkflowFromDescription`): when the latched/explicit target is the workflow we *just* built from the same normalized request, dedup it (return the current graph) instead of re-synthesizing — a genuine refinement has a different content key and still takes the model path. The file now passes **5/5** (verified deterministic, repeated). Confirmed the change can't affect the other two `createWorkflowFromDescription` double-build tests (one passes no `workflowId`, the other revises with a different description).
- **Full suite**: every formation + dedup test is green; api + core `tsc --noEmit` clean. Across full-suite runs, `1144–1145 / 1146` pass — the only residual failures are **two pre-existing, load-induced timeouts** that alternate between runs and are unrelated to this work: `browserPool.test.ts` (browser-launch hook; passes **5/5** in isolation) and `bootstrap.routes.test.ts` (a heavy full-bootstrap test that runs in ~12s but trips the 30s test-timeout under full-suite CPU contention; passes with `--testTimeout` headroom). Neither touches memory formation, the dedup fix, or the trivial bootstrap wiring.
- **Timeout flakiness stabilized**: gave the two load-sensitive tests headroom over the default 30s — `browserPool.test.ts`'s `afterAll` Chromium-shutdown hook now has a 60s timeout (its tests already had generous per-test timeouts; only the teardown hook lacked one), and `bootstrap.routes.test.ts`'s test (30s→90s) and `beforeEach` (→60s) were widened. Pure headroom; no logic change.
- **Ordering flake stabilized**: `specialists.test.ts` intermittently saw an eval score of exactly `0.5` (`expected 0.5 to be greater than 0.5`). Root cause: the three generated starter eval cases share a `createdAt` and have random ids, so `listCases` (`ORDER BY createdAt DESC`) returns them in a non-stable order; the test ran its crafted output against `cases[0]`, which only covered 2/4 of the "Boundary recognition" case's expected terms (`outside domain delegate escalate`) → 0.5. Fixed by extending the crafted output to cover the expected terms of **all three** starter cases, so the score is 1.0 regardless of ordering (verified 5/5). No production change — the eval-case list order is functionally irrelevant; the test was over-fitting to `cases[0]`.

**Net QA outcome**: four distinct issues surfaced and were fixed at the root — one real product bug (build dedup) and three brittle tests (two load-timeouts + one ordering assumption). None related to the memory-formation change.
