# Brain & Blueprint 10x — minds that form, recall visibly, and protect proof

> Operator report (2026-07-05): agents don't write valuable learnings to their
> brains and don't recall them across runs; and — the grave case — a workflow
> that was fixed and working failed once on a BAD MODEL, self-heal "repaired"
> the graph, and destroyed the proven structure. "If the app mind had a perfect
> blueprint this wouldn't happen."

## Diagnosis (all confirmed in code)

1. **Self-heal was blueprint-blind.** `WorkflowEngine.#runSelfHeal` never read
   `buildLoop.hardened` (or any proof) before letting the deep planner
   restructure a graph. One failed run could legally vandalize a proven one.
2. **No failure-class steering.** Only `isRuntimeBindingFailure` (agent_task
   binding drops) short-circuited. A bad-model failure (model 404 / overloaded /
   429 / quota / auth / spawn ENOENT / timeout) fell through to **graph
   surgery**, though no graph edit can fix a runtime problem.
3. **Blessing was asymmetric.** The verdict engine DEMOTED `hardened` on
   regression but never durably recorded "this graph @hash ACCOMPLISHED"
   (`productionRun` is overwritten by every terminal run, failures included).
   No restore path existed; the blessed bytes lived only in old runs'
   `graphSnapshot`s.
4. **Agent learnings never formed memory.** `chatMemoryCapture` mined only the
   OPERATOR's message (rule/preference shapes); the agent's own discoveries —
   and everything learned inside `agent_task` work — evaporated. Teachings not
   phrased as "always/never/I prefer" were dropped by the classifier.
5. **The Brain was invisible.** Recall (`buildDispatchContext`) injected
   silently; storage was a log line. Nothing like the desktop-harness
   "recalled X / storing Y", so the mind read as dead and bugs were undetectable.

## What shipped (2026-07-05)

### The Blueprint law
- **`BuildLoopBlueprintStamp`** (`workflowCompass.ts`): `{ at, runId, graphHash }`
  — ratchets ONLY on an ACCOMPLISHED production verdict; the blessed bytes are
  that run's `graphSnapshot` (written at startRun + on every mid-run patch).
- **Bless-on-accomplished** (engine verdict site, next to the demote): stamps
  `buildLoop.blueprint` + audits `workflow.blessed`.
- **`workflowBlueprint.ts`**:
  - `classifyRuntimeFailure(error)` — deterministic runtime-class detection
    (model missing/overloaded, 429/quota/billing, auth, context-length,
    spawn ENOENT/network, timeout, runtime unavailable).
  - `selfHealGuardDecision(...)` — the pure law: **(1) runtime-class failures
    never get graph surgery** (the graph was left untouched; fix the
    model/credential); **(2) a graph whose current hash is blessed
    (blueprint/hardened) is never autonomously restructured** — escalation
    names `agentis.run.diagnose`, deliberate `patchDraft`, and restore.
  - `findBlessedGraph(...)` — blueprint stamp → that run's snapshot; fallback
    newest ACCOMPLISHED run.
- **Guard wired** into `#runSelfHeal` AFTER the deterministic runtime-rebind
  strategy and the capability-gap check — deterministic rebinding still works;
  only the structural path is blocked. Audits `self_heal.guard.<class>`.
- **`agentis.workflow.restore_blueprint { workflowId, runId? }`**
  (`agentisToolHandlers/blueprint.ts`, in the chat catalog): rolls the graph
  back to the blessed bytes; explicit `runId` restores the exact graph of a
  named run (covers proven-in-practice workflows that never earned a formal
  verdict). Honest `restored:false` when nothing proven exists; `alreadyBlessed`
  no-op tells you the failure is runtime-class.

### Minds that form and show themselves
- **Agent learnings form memory** (`chatMemoryCapture.ts`): a substantive
  learning-shaped agent answer (`extractAgentLearningSignal` — root cause / the
  fix was / turns out / for future runs…, ≥120 chars) now enqueues the SAME
  formation pipeline (FormationJudge reconciles/dedupes), scoped to the agent,
  `originSurface: 'agent_chat_learning'`. Operator capture unchanged.
- **Visible recall** (`chatSessionExecutor.ts`): the turn now emits
  `Recalled N memories` as an activity delta when Brain atoms were injected —
  the mind is finally legible, like the desktop harness.

## Verification
- `workflowBlueprint.test.ts` — 10/10: classifier (runtime vs graph-class),
  guard law (runtime block, blessed block incl. hardened, unblessed allow),
  blessed-graph resolution (stamp-first, accomplished fallback), restore e2e
  (replaces mangled bytes, honest no-op when already blessed / never proven),
  learning gate.
- Regressions green: chatSessionExecutor 35, chatMemoryCapture, engine
  selfHeal — 48/48. Typecheck: 0 new errors (3 pre-existing in the operator's
  intelligent-storage WIP).

## The live incident (Fashion Store Factory — Capability 10X Canonical)
Ledger forensics (`0759b370-2b60-4151-85ac-041248a4888c`): last clean run
`c97a7bf4` COMPLETED 16:17→16:26; run `b441b70e` failed → `self_heal.graph_patched`
**18:51** (the vandalism) → cascade of `self_heal.escalated/blocked`. Recovery:
`agentis.workflow.restore_blueprint` with `runId: c97a7bf4-…` (explicit-run path).

## Follow-ups — ALL SHIPPED (same day, second pass)
- **agent_task capture closed.** The harness tool-loop completion was the ONE
  agent_task path that never enqueued brain formation (dispatch/session/swarm
  all call `#enqueueSuccessfulBrainCapture` after `#completeNode`) — it now does,
  through the same policy-gated pipeline.
- **Channel turns form memory.** `ChannelTurnDispatcher` got an optional
  `memoryCapture` dep (wired in bootstrap): after a delivered reply, the turn
  flows through `captureTurn` fire-and-forget — operator statements AND agent
  learnings, same as web chat.
- **"Stored N memories" is visible.** Root cause found: the route's notify
  condition ignored `capture.signals` — the PRIMARY formation path (queue →
  judge) produces no immediate ids, so exactly the turns that learned showed
  nothing. Now a `Storing N memories` activity is written INTO the SSE stream
  (still open at that point) before `done`, plus the bus work-step.
- **Operator bless.** `agentis.workflow.bless { workflowId, runId? }` — "this
  works" stamps the blueprint from the latest COMPLETED run (or an explicit
  run), granting blueprint protection to proven-in-practice workflows that never
  earned a formal verdict. Reports `matchesCurrentGraph` honestly (protection
  applies to the CURRENT graph only when hashes align; otherwise restore first).

## Implementation log
- **2026-07-05 (pass 2) — follow-ups SHIPPED.** `WorkflowEngine.ts` (harness
  tool-loop completion → `#enqueueSuccessfulBrainCapture`), `channelTurnDispatcher.ts`
  (+`memoryCapture` dep + fire-and-forget capture after delivery; bootstrap wires
  `chatMemoryCapture`), `conversations.ts` (signals-aware condition + `Storing N
  memories` SSE activity + `signals` on the local capture type),
  `agentisToolHandlers/blueprint.ts` (+`agentis.workflow.bless`, createdAt-sorted
  default run) + catalog entry. Tests: `workflowBlueprint.test.ts` now 13
  (3 bless cases incl. unverified-COMPLETED default, explicit runId,
  honest-false) + regressions: dispatcher, engine agentToolLoop/agentSession,
  chatGoldenPath, broadcastChat — all green. Typecheck: 0 new errors.
- **2026-07-05 — SHIPPED** everything above in one pass. Files:
  `workflowCompass.ts` (+blueprint stamp), `workflowBlueprint.ts` (new),
  `WorkflowEngine.ts` (guard + bless + import), `agentisToolHandlers/blueprint.ts`
  (new, registered), `chatToolCatalog.ts` (+restore entry),
  `chatMemoryCapture.ts` (+agent learning), `chatSessionExecutor.ts`
  (+recall visibility), `tests/services/workflowBlueprint.test.ts` (new, 10).
  ⚠️ Needs API restart/reload to take effect.
