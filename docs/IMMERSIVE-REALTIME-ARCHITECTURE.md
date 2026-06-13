# Immersive Realtime Architecture — "See Everything, Everywhere, Live"

> Status: **design / to implement**. This is the authoritative plan that supersedes
> the aspirational parts of `REALTIME-WORKSPACE-10X.md`. It corrects that doc's
> false premise ("Agentis already has the robust backend infrastructure") with the
> real, traced state of the code, and lays out an unambiguous, layered build order.
> Phase 0 (Stop / pause-resume / honest state) is **already implemented** in the
> engine + run UI; everything else here is to build.

---

## 0. Why (the operator's experience, and the truth behind it)

Watching a workflow run today, the operator sees:

- **`agent_task` does nothing** — empty output, **zero model consumption**, the node
  sits "running" forever. "I really believe agent_task does not work at all."
- **No realtime anywhere** — the workflow canvas doesn't animate; the "Realtime
  monitor" says *Run stream connected · EVENTS 0 · No activity captured yet*; the
  workspace canvas is "completely broken and poor"; the right-side detail cards show
  no value; the run page only updates on reload.
- **The triage card is "the worst thing ever"** — a list of workflow titles instead of
  an immersive view of what agents are actually thinking and doing.
- **No way to watch agents collaborate** — orchestrator → manager → specialist
  instructions, A2A messages, handoffs. "We even started to create it, but it's not
  shown."

This is the single most important reason Agentis's UI exists: **a human must be able
to see everything happening in the workspace — reasoning, steps, collaboration —
without changing pages, regardless of the runtime provider.** Today that promise is
unmet end-to-end.

### The four root causes (traced in code)

1. **Agents have no brain.** Specialists created by the orchestrator
   (`materializeCast` → `build.ts:980`, and `ensureRole`) are persisted with
   `adapterType: 'http'`, `status: 'offline'`, and **no real runtime**. `agent_task`
   dispatch (`WorkflowEngine.#dispatchAgentTask:1437` → `AdapterManager.dispatchTask`)
   sends the task to a **dead HTTP adapter** that never calls back → the node hangs,
   nothing is consumed, output is empty. There is **no default-runtime fallback** for
   workflow agent tasks (unlike chat, which falls back to `orchestratorRuntime`).
   **Without a working brain there is nothing to observe — this is the bedrock bug.**

2. **The backend throws away the agent's thoughts during runs.** Adapters *do* emit
   rich intermediate events — `task.progress`, `agent.thinking`, tool calls
   (`HermesAdapter.ts:464-486`) — but the adapter-event router in
   `bootstrap.ts:785-799` only handles `task.completed` / `task.failed` and **drops
   everything else**. Runs emit only coarse node-level `AGENT_WORK_STEP`
   (start/complete/fail). So the canvas monitor truthfully shows **0 events**.

3. **The frontend spine is ready but starved.** `apps/web/src/lib/realtimeActivity.ts`
   already normalizes `AGENT_TERMINAL_TOOL_CALL`, `AGENT_TERMINAL_MESSAGE`,
   `AGENT_WORK_STEP`, `NODE_*`, `RUN_*`, etc. into a `RealtimeActivity`. It subscribes
   correctly — it just **never receives the agent-thought events** (cause #2), and the
   transport is fragile (websocket-only; the `canvas/stream` SSE fallback exists in
   `workspaces.ts:41` but was historically unused — the operator has started wiring a
   `'fallback'` status).

4. **The surfaces are hollow shells.** The triage HUD (`CanvasHudBar.tsx` /
   `WorkspaceEcosystemCanvas.tsx`) renders titles, not thoughts. The node detail panel
   (`CanvasNodeDetailPanel.tsx`) shows no live value and no canvas animation. The
   "watch agents talk" feed (`AgentInteractionFeed.tsx`) is not fed by internal
   A2A/handoff events (the `a2a.ts` route is the *external* protocol surface — workflow
   skills — not internal collaboration visibility).

**Fixing this is layered: you cannot stream thoughts that don't exist (cause #1), and
you cannot render events the backend never sends (cause #2). Build bottom-up.**

---

## 1. The architecture — five layers, built bottom-up

```
Layer 4  Surfaces        Workspace Canvas · Workflow Monitor HUD · Run Inspector ·
         (immersive)     Node Detail · Mission-Control Triage · Agent Conversation Theater
                              ▲  one hook: useActivityStream(scope)
Layer 3  Transport       socket(ws+polling) → SSE fallback → poll   (never silently off)
                              ▲  one normalized event type
Layer 2  Activity Spine  normalized + PERSISTED + replayable stream of every
                         thought / tool / step / handoff, per run & per agent
                              ▲  emitted by
Layer 1  Emission        engine forwards ALL adapter events + node/run + A2A/handoff
                              ▲  produced by
Layer 0  Real Agents     every agent has a working runtime (brain) + workspace context
```

The guiding invariant: **one event taxonomy, one transport hook, one stream — every
surface is just a projection of the same spine.** No surface invents its own data path.

---

## 2. Layer 0 — Real agents (the bedrock: make `agent_task` actually work)

**Goal:** every agent the orchestrator creates is a *powerful, working specialist* — it
runs on a real model, is grounded in the workspace (brain, memory, tools), and produces
real output and real thoughts. This is the prerequisite for everything else.

### 2.1 Default runtime inheritance (no agent is ever "offline with no brain")
- An agent with **no explicitly configured adapter** must resolve to the workspace's
  default model runtime — the SAME `OrchestratorModelRouter` that powers chat
  (`resolve('conversation', workspaceId)` / a new `'worker'` role). Implement a
  **fallback in `AdapterManager.dispatchTask`** (or in `#dispatchAgentTask`): if no
  adapter is registered for `agentId`, dispatch through the router's runtime, binding
  the agent's persona (role system prompt, memory) — exactly as chat's
  `#resolveChatAdapter` does. Mirror that pattern.
- `materializeCast` / `ensureRole` must stop minting dead `http`/`offline` specialists.
  Either register a real runtime at creation (reuse `agentCommission.ts` which already
  calls `adapters.register`), or rely on the dispatch fallback above. Prefer **both**:
  mark specialists `online` and back them with the inherited runtime.
- A specialist with a genuinely unconfigured/unreachable runtime must **fail fast with a
  plain-language reason** (reuse the recoverable-error → pause path from Phase 0), never
  hang.

### 2.2 Grounded in the workspace (the "cooperate with the brain" requirement)
- Agent tasks already compose workspace context via `#withWorkspaceContext`
  (role identity → workspace context → agent memory → task). Keep and strengthen this:
  every dispatched task and tool-loop turn must carry brain/memory/knowledge context so
  specialists act as part of the whole, not in isolation. This is existing wiring —
  verify it fires on the inherited-runtime path too.

### 2.3 Always-terminal execution (no hangs)
- A dispatched task that never reports back must hit `AGENT_TASK_RESPONSE_TIMEOUT_MS`
  and emit `task.failed` — verify this for **every** path (external adapter, inherited
  runtime, and the in-engine `AgentToolLoop`). The tool-loop must also honor the run
  abort signal (Phase 0 threaded `ctx.abortController.signal` into dispatch; extend it
  to `AgentToolLoop.run`).

**Done when:** running the "Daily AI News Insights Digest", the "Ranked AI Digest Draft"
agent node consumes real tokens, produces a real ranked digest, and streams its
reasoning (next layers) — or fails/pauses with a clear reason. Never empty + silent.

---

## 3. Layer 1 — Emission (stop dropping the agent's thoughts)

**Goal:** every meaningful thing an agent or the engine does becomes a bus event,
runtime-agnostic.

### 3.1 Forward intermediate adapter events (the core fix)
In `bootstrap.ts:785`, extend the adapter-event router beyond `task.completed/failed`:

| adapter `eventType`        | → bus event                          | carries                          |
|----------------------------|--------------------------------------|----------------------------------|
| `agent.thinking`           | `AGENT_TERMINAL_MESSAGE` (kind=think) | reasoning delta                  |
| `task.progress`            | `AGENT_TERMINAL_MESSAGE` (kind=text)  | output delta                     |
| tool call / result         | `AGENT_TERMINAL_TOOL_CALL`           | tool name, args, result, status  |
| `task.started`             | `AGENT_WORK_STEP` (phase=start)      | node, agent                      |

Publish to **both** `REALTIME_ROOMS.run(runId)` and `REALTIME_ROOMS.workspace(wsId)`
(and `REALTIME_ROOMS.agent(agentId)`), tagged with `runId` + `agentId` + the **active
node** (resolve via `ctx.state.activeExecutions`, robust to the taskId↔nodeId binding at
`bootstrap.ts:789`). These are the exact events `realtimeActivity.ts` already consumes —
so the frontend lights up the moment the backend emits them.

### 3.2 One taxonomy, mirror the chat ledger
Reuse the `ChatDelta` shape (thinking | text | tool_call | tool_result | done) so a
workflow run and a chat turn produce **identical** activity items and render with the
SAME components (`LiveActivityTrace`, `ExecutionFeed`). The prior change already streams
*build* narration this way — extend the pattern to *runs*.

### 3.3 Internal A2A / handoff as conversation events (the "watch agents talk" feed)
Emit a first-class event whenever agents collaborate:
- orchestrator → manager/specialist **instruction** (when chat creates a specialist or
  delegates),
- `delegate_task` / `complete_task` between agents (the session/delegation path already
  exists — `WorkflowEngine.delegationScope`),
- A2A `message:send` reception (`a2a.ts`).

Add `AGENT_HANDOFF` / reuse `AGENT_TERMINAL_MESSAGE` with `peer` metadata
(`fromAgentId` → `toAgentId`, instruction, reply). This is what feeds the **Agent
Conversation Theater** (§6.6) and the canvas edge animations.

### 3.4 Persist a replayable tail (kills "0 events" on join/reload)
The spine must be **replayable**, not fire-and-forget:
- Append every activity item to a capped per-run ledger (the `ledger` service already
  exists — `runs.ts:/:id/ledger`) and a small per-agent ring buffer.
- Expose `GET /v1/runs/:id/activity?after=…` and `GET /v1/agents/:id/activity` returning
  the recent tail, so any surface opened mid-run (or after a socket drop) **back-fills**
  history then streams live. This is the difference between "EVENTS 0" and "watch it
  replay the last 30 seconds, then continue."

---

## 4. Layer 2 — The Activity Spine (one normalized, shared model)

- Single source of truth: extend `apps/web/src/lib/realtimeActivity.ts`'s
  `RealtimeActivity` to carry `kind: 'thinking' | 'text' | 'tool_call' | 'tool_result' |
  'node' | 'run' | 'handoff' | 'approval'`, `agentId/agentName`, `peer`, `nodeId`,
  `runId`, `tokens/cost` (when known), and `sequence` (for ordering + back-fill).
- A `RealtimeActivityStore` (per scope: run, agent, workspace) keeps an ordered, capped
  buffer; back-fills from the `/activity` endpoint on mount; merges live events;
  deduplicates by `id`/`sequence`. Every surface reads from this store — never raw
  sockets.

---

## 5. Layer 3 — Transport that is never silently off

- **Primary:** socket.io with `transports: ['websocket','polling']` + reconnection +
  the visible status indicator (`RealtimeStatusIndicator`, already shipping, with a
  `'fallback'` state).
- **Fallback:** when the socket can't connect within a grace window, auto-open the SSE
  stream (`GET /v1/workspaces/:id/canvas/stream`, already built) and a per-run/agent SSE
  if needed, feeding the SAME store. Status flips to `'fallback'` (still green-ish, not
  "broken").
- **Last resort:** poll `/v1/runs/:id` + `/activity` on an interval while a run is
  non-terminal and realtime is down.
- **One hook:** `useActivityStream(scope)` encapsulates back-fill + socket + SSE + poll
  selection. Every surface uses only this hook.

---

## 6. Layer 4 — The immersive surfaces (all projections of the spine)

All of these consume `useActivityStream` + `RealtimeActivityStore`. None fetch their own
data path. This is where the REALTIME-WORKSPACE-10X vision finally has real fuel.

### 6.1 Workspace Ecosystem Canvas (`/home`)
- Active agent nodes show a **live thought ticker** (scrolling reasoning + current tool)
  adjacent to the node — fed by per-agent activity.
- **Energy/particle flows** on edges when an agent is processing or two agents are
  talking (A2A/handoff events); **pulse** on node complete, **glitch/red** on fail.
- Selecting a workflow/agent node opens the detail panel **and** plays the live (or
  replayed) mini-canvas animation of the run — no page change.

### 6.2 Workflow Monitor HUD (`WorkflowCanvasPage` / `WorkflowMonitorCard`)
- Replace "EVENTS 0 / Listening" with a **live terminal feed** of node steps + agent
  thoughts + tool calls; click an item → pan/zoom the React Flow canvas to that node and
  animate it. HITL approvals render inline (amber, Approve/Reject).

### 6.3 Run Inspector (`RunDetailPage`) + Node Detail cards
- The right-side node card shows **live status + streaming reasoning + tool I/O +
  input/output**, not an empty shell. While a node runs, it animates; reuse
  `LiveActivityTrace`/`ExecutionFeed`. Stop / Pause-Resume controls (Phase 0) live here
  and on the canvas HUD.

### 6.4 Mission-Control Triage (replace `CanvasHudBar` "Live action queue")
The triage card is reborn as **Mission Control** — the single immersive "what is my
workspace doing right now" surface:
- Not a list of titles. For each active run **and** each active orchestrator chat
  request: the agent's **current thought**, the **task progress** (step x/y + phase),
  and **what's being done** (current tool / node), streaming live.
- Asking the orchestrator something in chat shows that request's progress here too
  (chat turns and runs share the spine), so the operator watches the orchestrator work
  without staring at the chat bubble.
- Honest state: a paused/blocked run shows "Paused — needs credits" with Resume; a
  failed run shows the plain-language cause. No more "running 17/22" next to "Failed at".

### 6.5 (folded into 6.4) — consistency
Home, canvas, run-detail, and triage are all the **same projection** at different zoom
levels. The home proactive card is driven by real `RUN_*` + pause state, so it can never
again contradict itself.

### 6.6 Agent Conversation Theater (the "watch agents talk" peer to chat)
A dedicated surface (and an embeddable panel) that renders the **agent↔agent
conversation** as a readable thread, fed by §3.3 handoff/instruction events:
- orchestrator → manager → specialist instructions ("You are the Ranking specialist;
  here's your task + context"),
- specialist replies / `complete_task` outputs,
- A2A `message:send` exchanges,
- with the workspace brain as a visible participant when context is injected.
- Reuse/upgrade the existing `AgentInteractionFeed.tsx`; back it with the persisted
  conversation events so it replays history and streams live. This is the operator
  "control room" for multi-agent collaboration the user asked for.

---

## 7. Layer (cross-cutting) — Honest state & control  ✅ Phase 0 (done)

Already implemented (keep, surface everywhere via the spine):
- **Stop** a run end-to-end (cancel threads `ctx.abortController.signal` into dispatch +
  `adapters.cancelTask`; open nodes marked skipped; `RUN_CANCELLED`). Stop button on the
  run page (and to add on the canvas HUD).
- **Pause & resume on credit/model failure**: recoverable errors (402 / insufficient
  quota / out of credits) **pause** the node (`WAITING` + `blockedReason`) instead of
  hanging or failing opaquely; `POST /v1/runs/:id/resume` re-dispatches from the stalled
  node; the run shows **Paused — add credits / switch model**, never a lying "running".
- No silent green; plain-language failures (`analyzeRunFailure`).

---

## 8. Build order (unambiguous, dependency-ordered)

1. **Layer 0 — Real agents.** Default-runtime inheritance for agent_task +
   non-offline specialists + always-terminal. *Until this lands, there is nothing to
   stream.* (`AdapterManager`, `WorkflowEngine.#dispatchAgentTask`, `materializeCast`,
   `agentCommission`.)
2. **Layer 1 — Emission.** Forward intermediate adapter events + A2A/handoff events;
   persist the replayable tail + `/activity` endpoints. (`bootstrap.ts`,
   `WorkflowEngine`, `events.ts`, `ledger`.)
3. **Layer 2/3 — Spine + transport.** `RealtimeActivity` extension,
   `RealtimeActivityStore`, `useActivityStream` (socket→SSE→poll + back-fill).
4. **Layer 4 — Surfaces, in this order:** Run Inspector & Node Detail → Workflow Monitor
   HUD → Mission-Control Triage → Workspace Canvas thought streams/flows → Agent
   Conversation Theater.
5. Delete/upgrade the hollow shells they replace.

Each layer is independently shippable and observable: after Layer 1 you can already
watch real events arrive in the existing (un-pretty) feed; Layer 4 makes it beautiful.

---

## 9. Reuse (do not reinvent)

- **Runtime fallback:** `ChatSessionExecutor.#resolveChatAdapter` (chat already inherits
  the orchestrator runtime — mirror for agent_task) and `agentCommission.ts`
  (`adapters.register`).
- **Spine/render:** `realtimeActivity.ts` (`RealtimeActivity`, the event list),
  `LiveActivityTrace.tsx`, `ExecutionFeed.tsx`, `useRealtime`, the prior build-narration
  streaming pattern (`chatSessionExecutor.#streamBuildNarration`).
- **Transport fallback:** `workspaces.ts` `canvas/stream` + `mapCanvasBusMessage` +
  `buildCanvasSnapshot`; `RealtimeStatusIndicator`.
- **Persistence/replay:** the `ledger` service + `runs.ts /:id/ledger`.
- **A2A:** `a2a.ts`, `runPublishedWorkflow`, `AgentInteractionFeed.tsx`.
- **Honest state:** Phase 0 engine work (`#pauseNodeBlocked`, `resumeBlockedRun`,
  `isRecoverableModelError`, cancel signal threading).

## 10. Verification (end-to-end)

- **Layer 0:** run a workflow with an out-of-the-box specialist → it consumes tokens and
  produces real output (or pauses with a clear reason). No empty/hung node.
- **Layer 1:** assert `bootstrap` forwards `agent.thinking`/`task.progress`/tool events
  to the run + workspace rooms; `/v1/runs/:id/activity` returns the tail.
- **Layer 3:** with the socket forced off, surfaces still stream via SSE/poll and
  back-fill on open (the monitor never shows a permanent "EVENTS 0").
- **Layer 4:** watch a run from the workspace canvas, the monitor HUD, the run inspector,
  and the triage Mission Control **without changing pages** — each shows the live agent
  reasoning + progress; the Conversation Theater shows the orchestrator instructing a
  specialist and the specialist replying.
- **Cross-cutting:** Stop halts a run; an out-of-credits agent pauses and resumes.

---

## 11. Implementation status (reconciled with real code)

Shipped (typechecked; engine tests green):
- **Layer 0 — real agents.** `OrchestratorModelRouter.resolveForAgent(agentId, ws)`
  mints a model-backed runtime bound to the agent; `WorkflowEngine.#dispatchAgentTask`
  lazily registers it when an agent has no adapter. **Plus the critical binding fix:**
  dispatch `taskId = node.id` (was a random uuid) — completion previously never mapped
  back, so agent_task hung RUNNING forever even with a runtime. (The test adapter
  masked this by emitting `taskId: task.nodeId`.)
- **Layer 1 — emission + replay.** `WorkflowEngine.notifyAgentActivity` publishes
  `agent.thinking`/`task.progress`/tool-calls to the **run room** with correct node
  attribution (via `activeExecutions`); bootstrap's adapter-event router forwards them
  (it used to drop everything but completed/failed). A capped in-memory **activity
  tail** + `GET /v1/runs/:id/activity` back-fills a surface opened mid-run.
- **Layers 2/3 — transport.** `realtime.ts` runs socket(ws+polling) → **SSE fallback**
  (`canvas/stream`) → local fan-out, with a `'fallback'`/`'disconnected'` status
  indicator. `useRunActivity(runId)` = the one hook (back-fill + live) every run
  surface uses.
- **Layer 4 — surfaces.** `WorkflowMonitorCard` back-fills `/activity`;
  Mission-Control **`TriageRunRow`** shows live reasoning/step/progress per run;
  `RunDetailPage` subscribes to the run room + streams a live feed. **Agent
  Conversation Theater:** the engine records agent↔agent hand-offs
  (`agent.task_assigned` / `agent.task_completed`, actorType `agent`, with the
  instruction + result) to `activity_events` → surfaced by `/v1/interactions` →
  `AgentInteractionFeed`, now **mounted** on the agent detail "Interactions" tab
  (it existed but was rendered nowhere).
- **Cross-cutting — honest state & control (Phase 0).** Stop; pause-&-resume on
  out-of-credits; no silent "running".

Also shipped (the "100%" pass):
- **All collaboration events**: `agent.commissioned` (orchestrator creates+instructs a
  specialist — `create_specialist`), `agent.delegated` (A2A delegate_task hand-off),
  `a2a.message_received` (inbound A2A), plus the run-time `agent.task_assigned` /
  `agent.task_completed` — all `actorType:'agent'` → the interaction feed.
- **Workspace-wide Conversation Theater**: a first-class `/theater` route + sidebar
  entry rendering the whole-workspace interaction feed (peer to chat), in addition to
  the per-agent "Interactions" tab.
- **Canvas**: the energy/particle edge flows + node active-states already exist in
  `WorkspaceEcosystemCanvas` (`<animateMotion>` particles keyed on `activeRunCount`);
  they were dormant only because nothing actually ran — Layers 0–1 fuel them. The
  node **detail card now streams live activity** (`NodeLiveFeed`) for the selected
  agent/workflow, fixing "the detail cards show no value".

- **Run-scoped SSE transport (socket-independent realtime).** The websocket and the
  workspace-level SSE fallback both have gaps when watching a *run*: the fallback is
  workspace-scoped and dropped run-room `NODE_*`/`RUN_*` events (no `workspaceId`).
  Added `GET /v1/runs/:id/stream` — replays the activity tail then relays every
  run-room envelope (status + reasoning + tool calls) with original event names —
  and wired `rtSubscribe('run')` to open it (deduped against the socket). So every
  run surface (triage rows, monitor, run detail) streams live **even when the
  websocket can't connect**. Also added `workspaceId` to run-status payloads so the
  workspace SSE fallback forwards them. This is the fix for "the triage looks the
  same / nothing updates": with the socket down, run activity now still reaches the
  browser. (Surfaces still need a fresh run producing activity — see Gap A.)
- **Always-on canvas thought bubbles** (`CanvasNodeThought`): an actively-working
  agent node shows its current tool call / latest reasoning in a small bubble
  beneath it — fed by the node's existing live fields (no extra subscription), so
  you see what each agent is thinking right on the canvas.

Nothing left deferred — the architecture is fully implemented.

## 12. Reconciliation note (correcting prior docs)

`REALTIME-WORKSPACE-10X.md` describes the target UX well but asserts the backend
infrastructure already exists. **It does not, in practice:** intermediate agent events
are dropped (`bootstrap.ts:785`), agents have no runtime (`materializeCast`), and the
transport is fragile. This document keeps that UX vision but makes Layers 0–2 — the
parts that were missing — the explicit, prioritized foundation. `SPECIALISTS-10X` and
`UNIVERSAL-HARNESS` remain the references for *what an agent is*; this doc is how the
operator *sees them work*.
