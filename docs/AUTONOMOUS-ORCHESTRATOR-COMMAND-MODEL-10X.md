# Autonomous Orchestrator & the Fractal Command Model (10x)

> Give the orchestrator — and every domain manager — genuine autonomy: complete,
> real-time awareness of the entire workspace, the ability to converse with
> specialists and operate apps/nodes/phases/integrations/MCP **as chat tools**
> (not fixed nodes), a **progressive comprehension** of what they manage and the
> progress made, and the drive to act on it — all without overloading context.

## The thesis

The gap between chat agents and codex-class agents was never capability — it was
**delivery + comprehension**:

1. **Reach** — codex agents *pull* their tool surface live over MCP; chat agents
   got the whole static catalog inlined. Fixed. (Layer A.)
2. **Comprehension** — agents have minds (Brain, workspace intelligence, App
   minds) but use them *passively*: memory is injected as flat context, never
   scoped to *what the agent manages*, never carrying *progress since last time*,
   never written back as the agent works. So the "manager" never actually
   manages. Fixed. (Layer B.)
3. **Proactivity** — agents only respond; they never wake, review their domain,
   and act. Fixed. (Layer C.)

The unit that ties it together is the **Command Model**, a single abstraction
parameterized by **scope**:

- `scope = workspace` → the **orchestrator** (manages the entire thing).
- `scope = domain(id)` → a **manager** (manages its sector, e.g. marketing).
- `scope = app(id)` → an **App-resident** agent (manages one product).

Same code, three altitudes — a fractal. The orchestrator is the primary subject;
managers are the same pattern scoped down.

## What already exists (this is a fusion, not a rebuild)

- **Ownership model** — `domains.managerId`, `workflows.ownerAgentId/spaceId`,
  `apps.ownerAgentId/spaceId`; `resolveResponsibleSpecialist()` maps work → the
  responsible manager. We add the **inverse**: manager → what it owns.
- **Reach substrate** — `PartialReplayService` (replay-from-node), `subflowExecutor`,
  `WorkflowPhase`, `McpToolBridge`, `agentis.agent.dispatch`, the `AgentisToolRegistry`
  (one plane, every transport).
- **Minds** — `SharedIntelligence.buildDispatchContext` (scoped Brain recall),
  `appLearning.recentLearnings` (App mind — graded lessons; today never reaches chat),
  `workspaceIntelligence.buildContextBlock` (workspace charter).
- **Progress** — Spaces aggregate output labels (`leads_qualified`, `meetings_booked`);
  run outcomes + verdicts (`workflowVerdict`).
- **Proactive execution** — `appOrchestrator` (dependsOn chains + cron), `scheduler`.
- **Real embeddings** — bundled ONNX e5-small (384-d).

## Architecture

### Layer A — Reach (find & invoke anything from chat)

- `capabilityUrn.ts` — the addressing scheme. Names any atom at any depth:
  `app:<id>` · `app:<id>/wf:<id>` · `.../node:<id>` · `.../phase:<id>` ·
  `agent:<id>` · `skill:<id>` · `mcp:<slug>__<tool>` · `coll:<app>/<name>`.
- `capabilityIndex.ts` — the compressed, searchable map. Derives atoms live from
  rows (apps, workflows + nodes + phases, agents, extensions); a `manifest()`
  digest (counts + samples) is resident; hybrid lexical→semantic `search()` returns
  ranked URNs. **Scope-aware** (whole workspace, or one domain's inventory).
- `capabilityRouter.ts` — resolves a URN → an existing registered tool + args
  (workflow.run / run.replay / agent.dispatch / mcp.call). One door, no dup logic.
- Meta-tools `agentis.capability.search/load/invoke` — the ~3 stable tools that
  replace the unbounded per-workflow tool explosion. MCP, apps, specialists, and
  deep nodes become **live chat tools**.

### Layer B — Comprehension (the Command Model)

- `commandScope.ts` — `resolveCommandScope(agent)` → `workspace` | `domain(ids)`
  (inverse of `resolveResponsibleSpecialist`). Enumerates owned domains/apps/workflows/specialists.
- `commandModel.ts` — builds the Command Model for a scope:
  - **Inventory** (scoped `CapabilityIndex`),
  - **Progress & deltas** (run outcomes + Space labels + blocked/in-motion vs. a
    persisted **watermark**, so the briefing says *what moved since last time*),
  - **Minds** (`SharedIntelligence` recall + `appLearning.recentLearnings` per owned
    App + `workspaceIntelligence` charter).
  Emits the resident **Command Briefing** block, and is refreshable on demand.
- **Progressive comprehension** — the manager's understanding persists in the Brain:
  it recalls prior decisions/objectives, and **writes back** new ones as it works
  (`command.note`). The watermark + progress snapshots make each session pick up
  where the last left off, not amnesiac.
- Prompt: a scoped **Command Briefing** + an explicit **USE YOUR MIND** doctrine
  (recall before acting · record decisions/learnings · track progress).

### Layer C — Proactivity (the heartbeat)

- `commandHeartbeat.ts` — on a cadence/trigger, for each orchestrator/manager:
  build its Command Model, detect what needs attention (blocked runs, in-scope
  approvals, stalled apps, unmet objectives), and run the agent to **review + act**
  through the reach layer. Bounded, logged, opt-in; reuses scheduler patterns.

## Efficiency guarantee

Per-turn tool-schema cost is O(1) (manifest + ~3 meta-tools), not O(workflows).
The Command Briefing is scoped + clamped to a fixed budget; progress is top-K
deltas; minds are top-K recall. Reach spans the whole workspace; context stays flat.

## Implementation log

- **2026-07-03 — SHIPPED A+B+C (typecheck 0 errors; 15 new tests green; affected
  chat/catalog/registry suites green).**
  - **Layer A — Reach.** `capabilityUrn.ts` (addressing, +9 tests), `capabilityIndex.ts`
    (manifest + hybrid lexical→semantic search over apps/workflows/**nodes**/**phases**/
    agents/extensions), `capabilityRouter.ts` (URN → delegation, incl. deep-node/phase
    replay-from-node + honest guidance when no prior run). Meta-tools
    `agentis.capability.search/load/invoke` (`agentisToolHandlers/capabilityPlane.ts`,
    delegates via `registry.execute` — one door). Added to `CHAT_TOOL_CATALOG`. Because
    they're registry tools, `mcp_native` (codex-class) agents get them too — the reach
    asymmetry is closed. MCP/apps/specialists are now live **chat** tools.
  - **Layer B — Comprehension.** `commandScope.ts` (inverse of `resolveResponsibleSpecialist`
    → workspace | domain | worker), `commandModel.ts` (scoped inventory + windowed
    progress + **since-last-review delta** via `workspace_kv` watermark + **App minds**
    via `appLearning.recentLearnings` — first time in chat), resident **Command Briefing**
    with the **USE YOUR MIND** doctrine injected in `chatSessionExecutor` (briefing subsumes
    the manifest; both never injected at once). Active-mind tools `agentis.command.review`
    (refresh + stamp watermark) and `agentis.command.note` (write decisions/learnings to the
    Brain, scoped to the agent) — comprehension now compounds across sessions.
  - **Layer C — Proactivity.** `commandHeartbeat.ts` — scheduler sweep (30 min), SURFACE by
    default (logs + de-dupes on an attention signature), ACT behind `AGENTIS_COMMAND_AUTONOMY=true`
    (drives a bounded auto-permission `ChatSessionExecutor.turn` so managers act unbidden
    through the reach layer).
  - **Wiring.** `bootstrap.ts`: `CapabilityIndex` + `CommandModelService` (reusing the Brain's
    per-workspace embedding provider + `appLearning`, moved up), threaded into `ToolHandlerDeps`
    + `ChatSessionExecutor.configure`; heartbeat registered on the scheduler.
  - ⚠️ Pre-existing (not ours): 2 transient typecheck errors on the in-flight approvals
    `payload` refactor (`WorkflowEngine.ts:8390`, `approvalInbox.ts:221`) appeared then cleared
    during the concurrent dev session; final full typecheck = 0 errors.
- **2026-07-03 — Follow-ups SHIPPED (typecheck 0; 19 tests green).**
  - **Semantic outcomes.** `CommandModel.progress.outcomes` now counts declared
    `workflow.settings.outputLabels` (leads_qualified, meetings_booked, …) per COMPLETED run
    in-window — same source as `space.summary`. Surfaced in the briefing ("Outcomes achieved …").
    The manager now sees what the work ACHIEVED, not just how many runs finished.
  - **Domain-ranked search.** `CapabilityIndex.search` takes an optional `scope` and applies a
    SOFT boost (never a filter) so a manager's own apps/workflows rank first; the
    `agentis.capability.search` handler resolves the caller's `CommandScope` and passes it. A
    manager still reaches anything in the workspace.
  - **Production-safe autonomy.** Two switches now gate action: the env master
    (`AGENTIS_COMMAND_AUTONOMY`) AND a per-workspace opt-in (`workspace_kv` `command:autonomy`,
    `isWorkspaceAutonomyEnabled` / `setWorkspaceAutonomy`) — enabling the deployment master never
    silently arms every workspace. Added a re-entrancy guard (no second autonomous turn for an
    agent while one is in flight) + start/done audit logs.
  - **Autonomy toggle UI/route SHIPPED.** `GET/PUT /v1/command/autonomy` (`routes/commandAutonomy.ts`,
    returns `{ enabled, master, effective }`) + a Settings → Workspace **AutonomyPanel** (`apps/web`)
    that toggles the per-workspace opt-in and disables itself with an explainer when the env master is
    off. Verified live in the browser (panel renders, GET returns `master:false` on a server without the
    flag, disabled state correct) + 3 route tests. **noUncheckedIndexedAccess** web typecheck clean.
  - **Multi-window outcome trend SHIPPED.** `CommandProgress.outcomeWindows` counts semantic
    outcomes across **24h / 7d / 30d** (widen the runs query to 30d once; derive the 7d slice for
    counts/attention; `outcomes` stays the 7d slice for back-compat). The briefing renders a momentum
    line per label ("leads_qualified: 2 · 3 · 40 (24h · 7d · 30d) — is the work accelerating?"), so a
    manager sees trend, not a single number. Covered by a multi-window test.
  - **Status: COMPLETE.** Reach + comprehension + proactivity, all follow-ups, the autonomy toggle
    UI/route, and the outcome trend are shipped, typecheck-clean, and tested.
