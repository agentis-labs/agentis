# Agent Autonomy 10x — agents over walls

**Thesis (operator, 2026-06-17):** *"Workflows are tools, not the Agentis
intelligence."* Today an agent's real autonomy is trapped inside an `agent_task`
workflow node — it can't freely spawn a team of subagents, can't reach for a
workflow as a tool mid-thought, and can't deviate when the work in front of it is
garbage. That is backwards for an agentic platform. **The Agent is the
intelligence; a Workflow is one tool it builds, runs, or abandons.**

> Workflows stay valuable — for *deterministic, auditable, scheduled* pipelines.
> What changes: agent intelligence is no longer **subordinate** to the graph.

> Status: **PLAN**. Grounded in the current code (file refs below). Honors
> [[feedback_no_duplication]] — unify the two runtimes, don't fork a third.

---

## 0. What exists today (verified)

| Capability | Where | Reality |
|---|---|---|
| Full agentic loop (`AgentSession`) | instantiated **only** in `engine/WorkflowEngine.ts` + `bootstrap.ts` | autonomy lives *inside* `agent_task` — a graph node |
| In-task tools | `agentSessionRuntime.ts` `#toolCatalog` + `CONTROL_TOOLS` | memory/scratchpad/broadcast + `delegate_task` (**blocking, one-at-a-time**, `create_if_missing`/`temporary`). No `spawn`, no workflow-as-tool, no deviation |
| Chat tools | `chatToolCatalog.ts` `CHAT_TOOL_CATALOG` | rich: `agent.spawn`, `specialist.create`, `dispatch`, `plan`, `reflect`, `build_workflow`, `workflow.run`, memory, knowledge — but a **separate, conversational** surface |
| Live graph edit | "planner splices live graph" (`WorkflowEngine`) | **engine-initiated**, not something the running agent can demand |
| Agent prompt | persona (`instructions`/per-agent AGENTS.md) + working-memory blocks + constitutional brain (`buildDispatchContext`) | **no capabilities manual** — agents aren't told their full power |

**Two problems fall out:** (1) the *same* agent is powerful in chat and crippled
in a task; (2) the workflow graph dominates — an `agent_task` must emit output for
the next node even when the upstream node handed it trash.

---

## 1. Four reframes

1. **Agent-primary, workflow-as-tool.** The durable agent runtime is a
   first-class thing invocable from anywhere (chat, channel, schedule, sub-task).
   `agent_task` becomes *one caller* of it, not its only home.
2. **One operating manual (the "system.md" for agents).** Every agent, in every
   context, is briefed on its full agentic surface — composed, editable,
   capability-aware. This is what makes agents actually *use* the platform.
3. **Teams on demand.** An agent spawns *multiple* subagents in parallel,
   coordinates them, and synthesizes — not a single blocking delegate.
4. **Deviation is a right.** An agent may reject unusable input, re-scope, replan,
   abort-with-reason, or reshape the remaining work — instead of dutifully
   processing garbage down a rigid graph.

---

## 2. Workstreams

### W1 — Unify the agent runtime (lift `AgentSession` out of the cage)
- Introduce `AgentRunService.run({ agentId, objective, context, surface })` wrapping
  the existing `AgentSession` so it can run **without a workflow**. `agent_task`,
  chat, channels, schedules, and sub-tasks all become callers of the *same*
  runtime — no third engine ([[feedback_no_duplication]]).
- **Converge the two tool surfaces.** Replace the chat-only `CHAT_TOOL_CATALOG`
  vs task-only `#toolCatalog` split with ONE capability set + a grant/role filter,
  so an agent has the same powers in chat and in a task (powers differ by *grant*,
  not by *which code path invoked it*).

### W2 — The Agent Operating Manual ("system.md", Agentis-native)
A composed system prompt assembled for every agent run, in layers:
1. **Capabilities manual** — *what you can do and when*: spawn a team, delegate,
   build & run a workflow, search/write memory, create an ability, reflect,
   **replan, reject bad input**. The piece that's missing today.
2. **Persona** — the agent's `instructions` / per-agent AGENTS.md (exists).
3. **Constitution + live brain** — `buildDispatchContext` (exists).
4. **Objective + environment** — the task, tools available now, budget left.

Surface it like the harness instruction file, layered (D1): **workspace default →
role-tier default (orchestrator / manager / worker) → per-agent override**, each
editable, viewable in the agent's Instructions tab. The role-tier layer lets an
orchestrator's manual emphasize team-spawning + delegation while a worker's
emphasizes focused execution. Imported agents inherit it (ties to
AGENT-TRANSITION — a transitioned agent gains full Agentis power, not just its old
persona).

### W3 — Teams on demand (parallel spawn + orchestration)
- Add `spawn_team` (and a non-blocking `delegate`) to the unified catalog: launch
  N subagents (ephemeral or durable), run **concurrently**, await all or stream,
  then synthesize. Reuse ephemeral specialists + the existing `scratchpad` /
  `broadcast` / `read_channel` for coordination.
- Depth/fan-out/budget guards from the start (W6). `run_inspect` already exposes
  delegation depth — extend with fan-out + spend.

### W4 — Workflow as a tool (in *both* directions)
- Expose `build_workflow` + `workflow.run` + `ephemeral.run` *inside* the agent
  runtime (chat has them; tasks don't). An agent mid-task can build+run a workflow
  as a subroutine, read its result, and continue. The workflow becomes a reusable
  tool the agent reaches for — exactly the operator's framing.

### W5 — Deviation & replanning (escape the rigid graph)

**W5.0 — Soft output contracts (the concrete bug the operator hit).** Today
`normalizeDeclaredNodeOutput` (`WorkflowEngine.ts:6405`) tries alias/envelope
coercion, then **hard-throws** `VALIDATION_FAILED` —
> `agent node 'qualify-and-harvest' did not produce declared output key(s): location`

— so an agent that received bad upstream data, *did better work*, and produced a
different (valid) shape gets its run **killed for a schema miss**. That is the wall.
Replace the hard throw with a negotiation, default **autonomous** (D2):
1. **Coercion pass** — a cheap model maps the agent's actual output onto the
   declared keys ("extract `location` from your result"); the value is usually in
   the prose.
2. **Accept-partial + deviation signal** — if it genuinely can't (the input *was*
   trash), accept the agent's real output plus a structured `deviation`
   ("couldn't produce `location` because upstream gave X; produced Y instead, here's
   why") and let the engine **route to repair/replan / escalate / pass-with-gap** —
   never a dead run on a key miss alone.
3. The agent's attempt to *get better results* is honored, not rejected. A hard
   fail is reserved for genuine inability after replan within budget.

**W5.1 — First-class agent verdicts.** From any node/run an agent may emit:
**reject-input**, **re-scope**, **abort-with-reason**, or **propose-graph-change**
(make the existing planner-splice *agent-initiated*). The engine adapts (splice /
re-route / escalate / honest fail) instead of forcing the next node on garbage.
A node's contract becomes *objective + success criteria*, not *"emit exactly this
shape no matter what."* Default per D2 = autonomous replan within budget; outward/
irreversible steps still hit approval (W6).

### W7 — Autonomous workflow self-healing (semi-deterministic workflows)

> Operator: *"our agents should be agents, not scripts — see the error, study why,
> fix the workflow maintaining the workflow intention. They cannot in any
> circumstance hallucinate."* Fixing workflows by hand is a nightmare for most
> users; a real agent should repair its own pipeline within budget.

**What exists is palliative.** `retryPolicy.selfHeal` (`WorkflowEngine.ts:1030`)
re-runs the *same node* with the error appended — it can only redo its own output,
**not diagnose the cause or fix the workflow**; when the real fault is upstream,
retrying is futile. On exhaustion it files a Feynman lesson but fixes nothing. And
it's a buried per-node flag, not a capability users can turn on. Replace it with a
real **diagnose → repair → validate → resume** loop. This *subsumes* W5.0 — the
output-key failure becomes one trigger of the heal loop, not a dead run.

1. **Diagnose (grounded root-cause).** On failure the healing agent receives the
   real error + run state + failing node config + upstream outputs + the workflow's
   **intent anchor** (title / description / inputContract / each node's objective).
   Root-cause via `run.diagnose` + replay + Feynman grounding. Grounded **only** in
   the actual error/data; if it can't ground a cause, it escalates honestly.
2. **Repair (intent-preserving, bounded).** Propose the *minimal* patch — failing
   node params/prompt/contract, an upstream node, a re-route, or an inserted repair
   step — via the existing `build_workflow` / `workflow.patch`. Two modes chosen by
   diagnosis: **output** (re-prompt/coerce — old behavior + W5.0) vs **structural**
   (edit the graph — the new power).
3. **Intent-preservation judge (the anti-hallucination gate).** Before applying, a
   judge (model + deterministic checks) certifies the patch (a) preserves the intent
   anchor and (b) is grounded in the error — a semantic diff against intent. If it
   can't certify, it does **not** apply → escalate with the diagnosis. Reuses the
   grounded, no-op-by-default discipline of FormationJudge / Feynman.
4. **Validate before applying.** The patched graph must pass preflight
   (`validateGraph` + the truthful-preflight gate) — never run an unvalidated graph.
5. **Reversible + audited + budget-gated.** Snapshot the pre-patch graph; record
   patch + rationale + grounding to the audit log; cap attempts (existing
   `maxSelfHealAttempts`) and consume run budget; honest escalation on exhaustion.
6. **Learn.** A successful grounded repair promotes a memory/ability so the same
   break isn't re-solved next run (extends the Feynman lesson path).

**Anti-hallucination rules (hard — the operator's non-negotiable):**
- **R1 Intent immutability** — never alter the workflow's declared goal /
  inputContract / output *meaning*. Change HOW, never WHAT.
- **R2 Evidence-grounded** — every edit cites the concrete error + run data. No edit
  without grounding.
- **R3 No fabrication** — never invent data or synthesize a fake output to satisfy a
  contract or make a node "pass."
- **R4 Validate-before-apply** — preflight must pass; no unvalidated graph runs.
- **R5 Reversible + audited** — snapshot + audit + operator can revert.
- **R6 Escalate-on-uncertainty** — if cause or fix can't be grounded, or intent
  can't be certified, stop and ask. Honest failure beats confident guessing.
- **R7 Bounded** — attempt cap + run budget; never an infinite repair loop.

**UX (the operator's ask):** a **profile-dropdown quick toggle** "Self-fixing
workflows (within budget)" + a **Settings → Automation** section: on/off, repair
budget cap, and "require approval before applying *structural* fixes." Per-workflow
override; the per-node `retryPolicy.selfHeal` still honored. Each heal streams into
Mission Control: diagnosis · patch diff · grounding · revert.

### W6 — Autonomy guardrails (power ≠ chaos)
- Budgets (spend/time/**depth/fan-out**), cycle detection, approval gates for
  outward/irreversible actions, full audit. Reuse the build spend circuit breaker
  + approval system + audit log.
- **Team spawn (D3): free up to a default cap, approval beyond.** An agent may
  spawn a team within a default fan-out + depth cap (and the workspace budget) with
  no friction; exceeding the cap requires operator approval. Keeps agents fluid
  while bounding blast radius + cost. Outward/irreversible actions always route
  through approval regardless of cap.

---

## 3. Sequencing
- **W2 first** (operating manual) — highest leverage, lowest blast radius; agents
  immediately start using powers they already have.
- **W1** (unify runtime + converge catalogs) — the structural keystone.
- **W5 + W7** next (deviation + self-healing) — the operator's live pain; W5.0 is
  the contained entry, W7 the real autonomous capability it folds into.
- **W3** (teams) → **W4** (workflow-as-tool in tasks) → **W6** woven throughout.

## 4. Non-negotiables
1. **No third runtime.** Unify chat + task onto one `AgentSession`-based runtime.
2. **Model/harness-agnostic** — capabilities negotiated, never branched on family.
3. **Guardrails are not optional** — every new power ships with its budget/approval/
   audit. Autonomy with a kill-switch and a ledger.
4. **Workflows remain first-class** for deterministic automation; this elevates
   agents *above* them, it doesn't delete them.
5. **No hallucinated autonomy.** Every self-repair / deviation is grounded in real
   evidence, preserves the workflow's intent, is validated before it runs, and is
   reversible + audited (W7 rules R1–R7). Uncertainty escalates; it never guesses.

## 4b. Implementation log

**2026-06-17 — W2 + W5.0 + W7-core shipped & tested (api + web typecheck clean; 13 targeted tests: 7 self-heal service + 6 manual/settings; engine agentSession regression green).**

- **W7 self-heal service** — `services/workflowSelfHeal.ts` `WorkflowSelfHealService`:
  diagnose → output-coercion / structural-repair proposal → **intent-preservation
  judge** → `validateWorkflowGraph` → `output_fixed | graph_patched |
  graph_patch_proposed | escalate`. Anti-hallucination rules R1–R7 enforced
  (deterministic node-set guard + grounded-only extraction + judge + validate +
  escalate-on-uncertainty). Pure/unit-tested.
- **W5.0 engine wiring** — `WorkflowEngine.notifyTaskCompleted` now calls
  `#attemptOutputSelfHeal` when `normalizeDeclaredNodeOutput` would throw: recovers
  the declared key(s) from the agent's OWN output and completes the node instead of
  a dead run (the live `location` failure). Structural proposals are diagnosed +
  logged for visibility. `EngineDeps.selfHeal` wired in bootstrap.
- **W2 operating manual** — `services/agentOperatingManual.ts` (capabilities +
  role-tier + workspace override), injected as `<operating_manual>` leading the
  agent context in `#withWorkspaceContext` (covers agent_task / agent_session /
  planner / dispatch). Per-agent persona stays separate.
- **W7 UX + settings** — `services/selfHealSettings.ts` (workspace_kv `selfheal.config`,
  default on / structural=approve / 2 attempts), `GET|PUT /v1/workspaces/:id/self-heal`,
  Settings → Workspace `SelfHealingPanel` (toggle + approve/autonomous bypass + attempts),
  and an AvatarMenu (profile dropdown) quick toggle.

**2026-06-17 (cont.) — W7 structural apply-and-resume shipped & tested (3 engine integration tests + 17 engine/unit regression green; core+api+web typecheck clean).**
- Self-heal now wired at the universal completion chokepoint `#completeNode` (covers
  both the adapter path and the in-process agentic loop) AND the failure path
  `notifyTaskFailed`. `#runSelfHeal` returns `output_fixed | structural_applied |
  awaiting_approval | none`.
- **Autonomous structural repair**: `#buildHealPatch` (changed-nodes-only
  `self_heal` patch) → `applyGraphPatch` (the proven validate+persist+revision+audit
  primitive) → `#applyHealAndRedispatch` resets the node + re-runs it through the
  ORIGINAL `#dispatchNode` path (handles useRoleTools/session/adapter uniformly) +
  ticks to settle. graphRevision bumps; run completes.
- **Approve mode**: `#proposeHealForApproval` creates an approval + parks the node
  WAITING; `resolveApproval` gains a `self_heal` branch — approve applies the stored
  patch + resumes, reject fails honestly. New core enum value
  `WorkflowGraphPatch.reason = 'self_heal'`.
- Tests: `tests/engine/WorkflowEngine.selfHeal.test.ts` (output recovery · autonomous
  apply-and-resume · approve→resume).

**2026-06-17 (cont.) — W3 parallel team spawn shipped & tested (1 engine integration test + 9 engine regression green; api typecheck clean).**
- New session control tool `spawn_team` (`agentSessionRuntime.ts`): a `delegate_team`
  yield carrying N `DelegateMember`s (shared `parseDelegateMember`), fan-out capped
  at `MAX_TEAM_FANOUT = 8` (W6/D3). Added to the session `#toolCatalog` so every
  agentic node gets it.
- Engine `#advanceSessionLoop` resolves `delegate_team` via `#runDelegateTeam` =
  `Promise.all` of the existing `#runDelegate` per member (depth guard, grant
  attenuation, on-demand specialist creation all apply), then injects the combined
  `{ ok, team: [...] }` payload to the parent. Reuses the proven delegation path.
- Test: `tests/engine/WorkflowEngine.spawnTeam.test.ts` (content-aware adapter:
  parent spawns 2 researchers in parallel → both run → parent synthesizes → run
  completes, 2 delegation records).

**2026-06-17 (cont.) — W5.1 deviation verdicts + W1 operating-manual-in-chat shipped & tested (1 new engine test; api+web typecheck clean; 28-test autonomy sweep green).**
- **W5.1** — `flag_deviation` session control tool (`agentSessionRuntime.ts`): a
  first-class, visible verdict (`reject_input | rescope | blocked` + grounded
  reason + proposed path) BEFORE failing. Records to the scratchpad, broadcasts to
  a `deviations` channel, emits a work-step, and returns guidance (partial /
  escalate / re-scope; never fabricate). Test in `WorkflowEngine.agentSession.test.ts`.
- **W1 (partial — the universality win)** — the operating manual now also injects
  into the CHAT path (`chatSessionExecutor.ts`), so an agent gets the same agentic
  briefing in chat and in tasks. Closes the W2 gap.

**2026-06-17 (cont.) — W4 workflow-as-tool (await-result) shipped & tested (1 engine integration test; api typecheck clean; 29-test autonomy sweep green).**
- New session yield `run_workflow` + control tool (`agentSessionRuntime.ts`): an
  in-task agent runs a SAVED workflow as a subroutine and WAITS for its result.
- Engine `#parkSession` case `run_workflow` reuses **`SubflowExecutor`** (child-run
  lifecycle + completion bridge): start the child workflow, park the session, and
  `#wakeSession` it with `{ ok, result }` when the child finishes. Colon-free
  synthetic parentNodeId (the subflow pending key splits on `:`).
- Test: `tests/engine/WorkflowEngine.runWorkflow.test.ts` (parent session runs a
  child workflow as a tool → resumes with its output → completes; child run spawned).
- **`build_workflow`** (also W4): a session yield + tool to AUTHOR + persist a new
  saved workflow (engine `#parkSession` validates via `validateWorkflowGraph` +
  inserts, wakes the session with the new id). An agent can now *build* a reusable
  workflow and then `run_workflow` it — same test file covers it.

### Capability status — the autonomy plan is functionally COMPLETE
All seven workstreams' **capabilities** now ship + are tested: W2 (manual, task+chat) ·
W3 (parallel teams) · W4 (workflow-as-tool w/ await) · W5.0 (output recovery) ·
W5.1 (deviation verdicts) · W6 (budget/fan-out caps + approvals woven in) · W7
(self-healing: output + autonomous structural + approve→resume).

**The only thing NOT done is non-behavioral cleanup:** W1's literal merge of
`CHAT_TOOL_CATALOG` and the session `#toolCatalog` into one shared module + one
execution path. The *capability* goals of W1 are met — the manual injects in both
surfaces, and task agents now have spawn_team / run_workflow / flag_deviation /
self-heal alongside their role tools. Collapsing the two catalog data structures
+ the two execution models (chat's `ChatToolExecutor`/handlers vs the session's
inline `#execTool`/yields) into one is a pure refactor that changes no behavior and
carries real blast radius across chat + the engine — deliberately left as cleanup,
not forced, per the "no shameful palliative" rule.
- **W5.1** (reject-input / re-scope / propose-graph-change verdicts) — partial: the
  output-miss path is handled; the broader verdict protocol is pending.
- **W6** — self-heal has attempt-cap + budget setting + escalation; team caps await W3.

## 5. Decisions (LOCKED — operator, 2026-06-17)
- **D1 = layered manual:** workspace default → **role-tier** → per-agent override.
- **D2 = autonomous replan within budget.** The trigger case was the hard
  output-key failure (W5.0): the engine rejected the agent's better work for a
  schema miss. Fix is soft contracts + autonomous re-route/replan; never kill a run
  on a declared-key miss alone. Outward/irreversible steps still hit approval.
- **D3 = free team spawn up to a default fan-out/depth cap**, approval beyond.

**Still open:**
- **D4 — self-fixing default + approval (W7).** Recommended: **on within budget**
  at the workspace level (manual workflow-fixing is a nightmare for users), with
  **structural** graph edits gated behind approval by default while **output**
  repairs apply autonomously; both toggleable in Settings + the profile dropdown.
  Confirm, or prefer off-by-default / approval-for-all-repairs?
