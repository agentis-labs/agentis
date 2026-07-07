# Self-Heal World-Autonomy + SWIFT run-what-you-build (10x)

> Operator: "self-heal should be a totally autonomous agent with total desktop
> control, able to fix/add/remove/modify whatever it needs to fix a run… and
> SWIFT should make the agent profoundly understand the desired result and fix
> the workflow's logic until it gets it." The agent is a real coding harness that
> ALREADY has desktop control — Agentis was restricting it.

## The real diagnosis (not a classifier — an architecture)

Both healing systems existed and were well-built, but shared one crippling
constraint: **they could only reshape the graph; they had zero control over the
world outside it.**

1. **The repair agent returned a *graph*, nothing else.** `#orchestratorReplan`'s
   contract was `<agentis_self_heal_repair>{nodes,edges,resumeNodeId}</…>`. It
   could create an agent/extension/ability, but it **could not set config, create
   a directory, run setup, install a dep, or fix a credential.** For
   `store_factory needs AGENTIS_STORES_DIR`, the fix lives *outside the graph* →
   structurally unreachable → "could not derive a grounded repair."
2. **It secretly ran in `ask` permission mode → aborted on the first
   confirmation.** `#chatReplanLoop` never set `permissionMode`; any mutating,
   non-`autoExecute` tool raised a confirmation and `sawConfirmation` returned
   `null` — the whole heal died. "Full power" on paper, self-terminating.
3. **"Bypass" was misnamed.** `cfg.mode: 'bypass'` only meant "apply certified
   *graph* edits without approval" (`decideRecoveryPolicy`). It did NOT grant the
   agent autonomy to act on the world.
4. **The agent already HAS total desktop control** — a Claude Code / Codex healer
   is dispatched with `--dangerously-skip-permissions` on BOTH the dispatch and
   chat paths (`ClaudeCodeAdapter`), so its native Bash/file/desktop tools run
   freely. Agentis was the ONLY thing stopping it, via the graph-only contract +
   `ask` mode + confirmation-abort.

Unifying insight: **the agent can rewrite *logic* but not act on the *world*. A
truly autonomous repair agent does whatever a human operator would at a terminal
— set the config, make the folder, run the script, fix the key — then re-runs.**

## What shipped

### Self-heal = let the agent be the agent (bypass mode)
- **Full-autonomy contract** (`#orchestratorReplan` brief) when `mode === 'bypass'`:
  "YOU HAVE FULL CONTROL of this machine and workspace — shell, filesystem, scripts,
  files, config, credentials — PLUS every Agentis tool. Fix this failed run BY ANY
  MEANS a human engineer would use at a terminal. If the fix lives outside the
  graph (missing dir/env/credential/build), DO IT YOURSELF, then resume."
- **Auto permission** (`#chatReplanLoop` runs the repair turn with
  `permissionMode: 'auto'` in bypass) — no confirmation, so it acts instead of
  aborting. The `sawConfirmation → null` abort now only applies to guarded.
- **Environment-fix resume**: the completion contract lets the agent fix the WORLD
  and return the current graph UNCHANGED with `resumeNodeId = the failed node`.
  `#finalizeProposal` already accepts this (it requires nodes + a valid resume
  target, not a graph *change*); the engine re-runs the node and it now passes.
- **Guarded mode is UNCHANGED** — the safe "propose a graph for approval" path.
  Bypass is the explicit opt-in (Settings → Workspace → Self-fixing → Full bypass).
- Fallback (`configGapReason`, guarded/no-harness): when autonomous repair isn't
  available, self-heal escalates with the EXACT remedy instead of mush.

### SWIFT = run-what-you-build reflex
`agentis.build_workflow`'s result now embodies the coding-agent reflex (via the
proven navigation-in-results lever): "you authored this, so you verify it — do NOT
hand an unverified workflow to the operator. Continue the loop (dry_run → debug →
verdict → fix → repeat) until ACCOMPLISHED, or call `agentis.workflow.deliver` to
run the whole build→verify→fix loop in one shot. Only stop to ask on a real
blocker." The autonomous `deliverWorkflow` loop already exists; this makes the
agent reach for it instead of shipping one-shot builds.

### SWIFT "warn previously" — proactive divergence, not reactive self-heal
> Operator: "if SWIFT is 10x the self-healing won't be necessary when an agent
> builds stuff… maybe only when operators change things — but even then it should
> warn previously!"

The final shape of the principle: **self-heal is the world-drift safety net, not
the routine repair path.** An agent build already runs the SWIFT loop
(run-what-you-build → `deliver` → ACCOMPLISHED → *blessed*), and the blueprint
guard forbids self-heal from restructuring a blessed graph. So the only way a
proven workflow breaks is when it **changes** — an operator (or agent) edit. The
system already *knew* this silently (`deriveLoopStage` demotes a hardened graph to
`authored` the instant its hash changes; `loop-status` flags stale evidence) — but
it **waited for a production failure** to surface it. That is exactly backwards.

`detectProvenDivergence(state, currentHash, workflowId)` (in `workflowCompass.ts`)
makes it proactive: when the current graph hash no longer matches the `blueprint`
(world-accomplished) or `hardened` (gates frozen) stamp, it returns a one-line
**UNVERIFIED** warning plus the two exact next calls — `agentis.workflow.deliver`
(re-prove) and `agentis.workflow.restore_blueprint` (roll back). Blueprint outranks
hardened (stronger proof + a runId to the proven bytes). It is wired at every
moment an edit could be trusted:
- **`compassForWorkflow`** folds it in — every compass-carrying surface (the
  agent's `build_workflow` / `dry_run` / `loop_status` results) now *leads* with
  the warning and puts `deliver` first, ahead of the stage's own steps.
- **`PATCH /:id` (save)** returns `divergence` — the editor is told the moment a
  proven graph is edited (non-blocking; the save still succeeds).
- **`POST /:id/run` (HTTP) and `agentis.workflow.run` (tool)** return `divergence`
  on a **production** run (suppressed for a debug run — that *is* the
  verification), so nobody trusts an unverified change silently.
- **`loop-status`** carries it, and the canvas **`WorkflowHealthIndicator`** (which
  re-polls on every graph edit) now shows a red **"⚠ Re-verify"** pill + an
  expanded banner with the warning and the deliver/restore steps — the operator's
  "warn previously," at edit time, before any run.

Result: a proven workflow that gets edited announces "UNVERIFIED — re-verify before
you trust it" at the edit and at the run. Self-heal only ever engages if the
operator ignores the warning and runs anyway — precisely the "operators changed
things" case it's meant for.

## Verification
- `workflowCompass.test.ts` — **23/23** (was 16), incl. 7 for `detectProvenDivergence`
  (never-proven → null; hash-match → null; blueprint/hardened divergence shapes;
  blueprint outranks hardened) and 2 for the compass fold (diverged → leads with
  UNVERIFIED + deliver + restore, keeps the stage step; proven graph → no warning).
- `WorkflowEngine.selfHeal.test.ts` — **11/11** incl. a new test proving bypass
  delivers the FULL-AUTONOMY contract to the repair agent (root power + env-fix
  resume + auto permission) and completes, while guarded is untouched.
- `workflowDeliveryOrchestrator` + `createWorkflowDelivery` — **24/24** green
  (build message change safe).
- Typecheck: 0 new errors (3 pre-existing `artifacts.ts`/`assetStore.ts` WIP).

## How to use it (the store_factory case)
1. Settings → Workspace → Self-fixing workflows → **Full bypass**.
2. Re-run. When `store_factory` fails on `AGENTIS_STORES_DIR`, the healer (a Claude
   Code / Codex agent) now uses its OWN shell/file tools to create the store-demo
   directory, run the setup, set the config on the node, then resumes the run — no
   human hand-off. Restart the API first to pick up the change.

⚠️ Bypass hands an unattended agent root-level power over the machine (by design —
it's the same coding harness you already run). Keep it the explicit opt-in.

## Implementation log
- **2026-07-05 — SHIPPED.** `WorkflowEngine.ts` (autonomy brief + `#chatReplanLoop`
  auto-permission + env-fix resume contract; `configGapReason` fallback classifier),
  `chatToolCatalog`/`build.ts` (run-what-you-build reflex), `PhaseLayer.tsx`
  (completed-phase checkmark). Tests: selfHeal 11, delivery 24. ⚠️ Needs API restart.
- **2026-07-05 (canvas realtime) — SHIPPED.** Root cause: node/phase status only
  paints when the canvas subscribes to the RUN room, which requires resolving
  `activeRunId`; that only came from a mount fetch (runs active at open) + `RUN_CREATED`
  events filtered by `workflowId === id` — which not every start path (App /
  orchestrator / deliver) emits to the workspace room. Fix (`WorkflowCanvasPage.tsx`):
  resolve `activeRunId` CONTINUOUSLY from the live workspace `activeRuns` list (kept
  fresh by the workspace room on every RUN_* event) — so a run of this workflow started
  by ANY path resolves the run room and paints live. Plus the completed-phase ✓
  (`PhaseLayer` rendered nothing for status 'completed'). Web typecheck 0; PhaseLayer
  tests 10/10 (✓ render + `derivePhaseStatus`); app renders clean in preview (no console
  errors). ⚠️ Late subscribers rely on the run-stream tail replay for events before
  `activeRunId` resolved — fine for long runs; a very fast early node may not paint.
- **2026-07-06 (SWIFT "warn previously") — SHIPPED.** `detectProvenDivergence` +
  `dedupeCompassSteps` in `workflowCompass.ts`; `compassForWorkflow` now folds the
  divergence warning ahead of the stage steps. Wired into `routes/workflows.ts`
  (`PATCH /:id` save response, `POST /:id/run` response, `loop-status.divergence`)
  and `agentisToolHandlers/run.ts` (`agentis.workflow.run`, production-only). Web:
  `WorkflowHealthIndicator.tsx` shows a red "⚠ Re-verify" pill + expanded banner
  (re-polls on every graph edit via `revision`). ⭐ Hash discipline: divergence must
  compare `graphContentHash` (the semantic hash the buildLoop stamps use) — NOT the
  DB row `hashWorkflowGraph`, or it always fires. Tests: compass 23/23 (+9), blueprint
  13, selfHeal 11. API + web typecheck: 0 new errors (3 pre-existing storage-WIP).
  ⚠️ Needs API restart.
