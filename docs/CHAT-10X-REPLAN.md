# Chat 10x Replan
## One orchestrator, full screen context, ephemeral workflows, and platform command from a single thread

> **Status**: Plan — ready for sprint assignment
> **Date**: May 14, 2026
> **Scope**: Chat surface, `ChatPanel`, `ChatPage`, `HomePage` composer, orchestrator routing, screen context protocol, ephemeral workflow execution
> **Architecture references**: `AGENTS-10X-REPLAN.md`, `CHAT-AGENT-LOOP.md`, `CHAT-TASKS.md`, `AGENT-FIRST-ARCHITECTURE.md`, `ORCHESTRATOR.md`, `MULTI-AGENT-UX.md`
> **Thesis**: Chat in Agentis has one job — be the operator's command interface to the entire platform. That means a single point of entry (the workspace orchestrator), full awareness of what the operator is currently looking at, and the power to act on anything from a single message.

---

## 0. The Fundamental Question This Doc Answers

> *"Should we be able to chat with all our agents, or just one orchestrator?"*

**The answer is: one orchestrator per workspace.** Not one per agent. Not a thread per agent that you have to remember to switch between. One.

Here is why:

A workspace with 12 apps, 40 workflows, and 60 agents does not need 60 chat threads. What it needs is **one operator-facing intelligence that has authority over all of them**. Every platform that has tried to let operators manage large fleets via per-agent DMs has failed for the same reason: the cognitive load of routing your own questions ("which agent do I ask this?") is exactly the problem the platform was supposed to solve.

The orchestrator *already exists* in the Agentis architecture as a first-class entity (`role = 'orchestrator'`, exactly one per workspace, enforced at DB layer — see `AGENTS-10X-REPLAN.md §7`). It has tools: `agentis.workflow.run`, `agentis.agent.dispatch`, `agentis.agent.spawn`, `agentis.team.design`. It already *is* the composition root of the workspace. The chat thread should be its front door.

**Worker agents are not chatted with directly.** They are dispatched. You tell the orchestrator what you need; the orchestrator decides which agent or workflow handles it. This mirrors how the platform actually executes — the operator delegates, the engine routes.

**The one exception: Space Managers.** A workspace with multiple spaces may have space-specific managers (`role = 'manager'`). Operators should be able to scope a conversation to a manager when they are working inside a specific space. But even then, the default is still the orchestrator. The manager thread is a *scoped view*, not a separate chat system.

---

## 1. Why the Current Chat Is Not Good Enough

Three specific failures:

### 1.1 The chat is not aware of where the operator is

The operator is looking at a workflow canvas mid-run. Nodes are lighting up. They open chat and ask: *"why is the email node slow?"* The chat has no idea what workflow they are looking at. It cannot inspect the run. It cannot read the node's execution history. It answers generically or fails.

**The platform already knows everything** — which workflow is open, which run is active, which node was last clicked. None of this context is injected into the chat. The result is a chat assistant that is blind to 90% of the state it was supposed to help with.

### 1.2 The chat cannot act on the platform

The operator types: *"pause the run and wait for my approval."* Nothing happens. The chat is a message relay — it hands text to the adapter and appends the response to a thread. It has no ability to call `engine.cancelRun()`, create an approval request, patch a workflow graph, or do anything that changes platform state.

The agentic loop specified in `CHAT-AGENT-LOOP.md` defines the right shape: the orchestrator gets a tool catalog and can call platform operations. But this has not been wired into the chat surface — the loop exists only on paper.

### 1.3 The composer is the wrong entry point

The home page has a composer. `/chat` has another composer. The workflow canvas has a chat panel toggle. These are three different entry points to an incoherent mix of "send message to which agent exactly?" The composer on the home page does not even have a clear recipient — it has a recipient pill that defaults to the first agent the user ever created, which is almost never the orchestrator.

The result: operators do not use chat for real work. They use it as a novelty or a test. The platform's most powerful surface has been reduced to a demo feature.

---

## 2. Architecture — The Orchestrator Chat Model

### 2.1 One thread per workspace

```
Workspace
  └─ OrchestratorChatThread  (1 per workspace, persistent)
       ├─ Messages[]
       ├─ ScreenContext  (injected from UI, updated on navigation)
       ├─ EphemeralWorkflows[]  (temporary runs spawned from chat)
       └─ ActiveTasks[]  (platform operations currently in progress)

  └─ SpaceManagerThread[]  (0..N, opt-in, scoped to a space)
       └─ Same structure, narrower tool scope
```

The orchestrator thread is **not** the conversations table row for an arbitrary agent. It is a special-cased, always-available session tied to the workspace's single orchestrator agent. If no orchestrator exists, the chat entry point shows the commission prompt instead of the composer (same pattern as the wizard Step 1 greyed card in `AGENTS-10X-REPLAN.md`).

### 2.2 Screen context injection

The UI maintains a `ScreenContext` object that is updated on every significant navigation event and passed as a system prompt prefix on every turn.

```typescript
// packages/core/src/types/chat.ts
export interface ScreenContext {
  // Where the operator is right now
  surface: 'home' | 'workflows' | 'workflow_canvas' | 'agents' | 'agent_detail'
         | 'run_detail' | 'history' | 'goals' | 'approvals' | 'settings' | 'chat';

  // What is currently open/selected
  activeWorkflowId?: string;
  activeWorkflowTitle?: string;
  activeRunId?: string;
  activeRunStatus?: string;
  activeNodeId?: string;
  activeAgentId?: string;
  activeAgentName?: string;
  activeGoalId?: string;

  // What the operator has selected/highlighted (e.g. a node on canvas)
  selection?: {
    kind: 'node' | 'edge' | 'run' | 'agent';
    id: string;
    label?: string;
  };

  // Live metrics visible on the current screen (prevents stale tool calls)
  visibleRunCount?: number;
  visibleFailureCount?: number;
}
```

**How it is built:** The Zustand store (`agentisStore.ts`) already tracks `ambientId`, `activeRuns`, and canvas tab state. Add a `screenContext: ScreenContext` slice that page components update on mount:

```typescript
// Each page calls this on mount and on relevant state changes:
useEffect(() => {
  setScreenContext({
    surface: 'workflow_canvas',
    activeWorkflowId: workflowId,
    activeWorkflowTitle: workflow?.title,
    activeRunId: activeRunId ?? undefined,
    activeRunStatus: run?.status,
    activeNodeId: selectedNodeId ?? undefined,
  });
}, [workflowId, activeRunId, selectedNodeId]);
```

**How it is sent:** Before every chat turn, the screen context is serialized into the system prompt prefix:

```
[Platform Context]
Operator is currently viewing: Workflow Canvas — "Lead Qualification Pipeline"
Active run: run_a1b2c3 (RUNNING, started 3m ago)
Selected node: email_node (EmailSender)

Use this context when answering. If the operator refers to "this workflow", "this run",
or "this node", they mean the above.
```

This is **not** a tool call. It is prepended to every turn as a system block. The orchestrator always knows where the operator is before saying a word.

### 2.3 The tool catalog

The orchestrator in chat gets a different, richer tool catalog than the orchestrator in a workflow run. Chat tools are designed for interactive, operator-facing use — they return human-readable summaries, not raw JSON. Workflow tools are designed for programmatic use.

**Platform Read Tools** (safe, no side effects):

| Tool | What it does |
|---|---|
| `agentis.run.inspect` | Returns status, node timeline, and last 3 errors for a run |
| `agentis.workflow.list` | Lists workflows with health summary and last run status |
| `agentis.workflow.health` | Returns health report for a specific workflow |
| `agentis.agent.list` | Lists agents with status, current task, and budget metrics |
| `agentis.agent.status` | Returns live status of a specific agent |
| `agentis.approvals.list` | Lists pending approvals with context |
| `agentis.ledger.search` | Searches the activity log for events matching a query |
| `agentis.goals.list` | Lists goals with progress and assigned agent |
| `agentis.budget.summary` | Returns workspace budget usage for current period |
| `agentis.screen.read` | Returns a snapshot of the current screen context (already injected, but available as explicit tool for re-inspection) |

**Platform Write Tools** (mutate state, shown to operator before execution):

| Tool | What it does |
|---|---|
| `agentis.run.cancel` | Cancels an active run |
| `agentis.run.retry` | Retries a failed node in a run |
| `agentis.workflow.run` | Triggers a workflow with optional inputs |
| `agentis.workflow.patch` | Applies a graph patch to a workflow (for live editing from chat) |
| `agentis.agent.dispatch` | Dispatches a task to a specific agent |
| `agentis.agent.wake` | Wakes a standby agent |
| `agentis.approval.resolve` | Approves or rejects a pending approval |
| `agentis.ephemeral.run` | Creates and runs a temporary workflow (see §4) |
| `agentis.workflow.draft` | Creates a draft workflow from a text description |

**Write tools require confirmation before execution.** Before firing a write tool, the orchestrator presents a structured confirmation card (not just text) showing exactly what will happen. The operator clicks Approve or Cancel inline. This is the chat equivalent of the approval request system — the orchestrator itself asks permission before touching platform state.

```
┌────────────────────────────────────────────────────────┐
│  ⚡ Action required                                    │
│                                                        │
│  Cancel run_a1b2c3 — "Lead Qualification Pipeline"     │
│  This will stop the run immediately. 2 nodes           │
│  currently executing will be interrupted.              │
│                                                        │
│  [ Cancel run ]          [ Nevermind ]                 │
└────────────────────────────────────────────────────────┘
```

### 2.4 The agentic loop

The loop specified in `CHAT-AGENT-LOOP.md` is the correct shape. Connect it fully:

```
POST /v1/conversations/orchestrator/send
  body: { message, screenContext, workspaceId }
  response: SSE stream

Server:
  1. Inject screenContext into system prompt prefix
  2. Append user message to session history
  3. Call adapter.chat(history, PLATFORM_TOOL_CATALOG)
  4. Stream deltas: { type: 'thinking' | 'text' | 'tool_call' | 'confirmation_required' | 'tool_result' }
  5. On tool_call: check if write tool → if yes, pause loop and emit 'confirmation_required'
  6. On operator confirmation: resume loop, execute tool, inject result
  7. On final text: append to thread, persist
```

The key addition over `CHAT-AGENT-LOOP.md` is the `confirmation_required` delta type — the loop pauses for write tools, the UI renders the confirmation card, and the operator's approval resumes the loop via a follow-up call (`POST /v1/conversations/orchestrator/confirm`).

---

## 3. Chat UI — The 10x Experience

### 3.1 The chat panel is always visible

Not a page. Not a tab you navigate to. The orchestrator chat is a **persistent right-side panel** (360px wide by default, resizable) that is always available regardless of what page the operator is on. It is toggled with a keyboard shortcut (`Cmd/Ctrl + K` defaults to command palette if exists, or `Cmd/Ctrl + \`), a floating icon in the bottom-right corner, and the existing `chatPanelOpen` flag in the Zustand store.

When the operator is on the workflow canvas, the chat panel is aware of the canvas state. When they navigate to the agents page, the context shifts automatically. The panel never resets — the conversation is persistent and context updates are injected silently.

### 3.2 Context pill — the operator always knows what context is active

At the top of the composer, a **context pill** shows the current screen context. The operator can see at a glance what the orchestrator is "seeing":

```
┌─────────────────────────────────────────────────────────────────────┐
│  Orchestrator                                               ◉ live  │
├─────────────────────────────────────────────────────────────────────┤
│  [conversation history...]                                           │
│                                                                      │
│  ...                                                                 │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│  Context: ◈ Lead Qualification Pipeline · run_a1b2c3 RUNNING  ×    │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Ask the orchestrator anything...                             │  │
│  └───────────────────────────────────────────────────────────────┘  │
│  ↵ Send   ⌘K Ephemeral   @agent                     📎 Attach      │
└─────────────────────────────────────────────────────────────────────┘
```

The context pill is **dismissible** (the `×` clears the injected context for that message only — useful when asking a general question unrelated to the current screen). The pill is also **clickable** — clicking it opens a context detail popover showing the full `ScreenContext` object so the operator knows exactly what is being shared.

### 3.3 Message types in the thread

The chat thread is not a string list. Each message can be one of several rich types:

**`text`** — Standard assistant prose. Streamed with typing cursor.

**`thinking`** — Streamed thought blocks from the orchestrator's reasoning process. Rendered as a collapsible `◦ Thinking...` block that expands to show the full reasoning chain. Collapsed by default after the turn completes.

**`tool_call`** — Inline tool execution status:
```
◈ Inspecting run_a1b2c3...    ✓ done  (0.4s)
```

**`confirmation_required`** — A blocking card that pauses the loop (see §2.3).

**`artifact`** — A structured output card. Used when the orchestrator returns structured data. Three artifact subtypes:

- **Run card**: Live-updating summary of a workflow run (status, progress bar, active node, cost)
- **Workflow card**: Compact workflow summary with health metrics and trigger info
- **Agent card**: Single agent status card with current task and budget
- **Diff card**: A before/after view of a workflow graph patch (used when `agentis.workflow.patch` is called)

**`ephemeral_run`** — A special card for runs spawned from chat (see §4):
```
┌────────────────────────────────────────────────────────┐
│  ⚡ Ephemeral run · "Summarize this week's leads"      │
│  ● RUNNING  →  scrape_node  →  ...                     │
│  [View full trace]              [Cancel]               │
└────────────────────────────────────────────────────────┘
```

### 3.4 @mentions for scoped routing

Operators can use `@manager-name` in the composer to route a question through a space manager instead of the workspace orchestrator. The orchestrator receives the message with a routing hint:

```
System: The operator addressed @Research Manager specifically.
Route this to Research Manager agent (id: agt_xxx) and relay the response.
```

The orchestrator calls `agentis.agent.dispatch` to delegate, then streams the result back. The operator sees the reply attributed to the manager:

```
◌  Research Manager  via Orchestrator
"I found 3 workflows in the Research space that match your query..."
```

This keeps one thread while allowing space-scoped context. Worker agents are **never** directly addressable via `@mention`. Only managers and the orchestrator are valid recipients.

### 3.5 Canvas Copilot mode

When the operator is on the workflow canvas and the chat panel is open, the panel enters **Canvas Copilot mode** — shown by a subtle blue border on the panel and the context pill turning blue.

In Canvas Copilot mode, additional tools become available:

| Tool | What it does |
|---|---|
| `agentis.canvas.explain` | Describes the selected node's role and configuration |
| `agentis.canvas.debug_node` | Shows the last 5 executions of the selected node with inputs/outputs |
| `agentis.canvas.suggest_fix` | Analyzes a failed node and suggests a configuration change |
| `agentis.canvas.add_node` | Proposes a new node to add to the workflow (shown as a diff card) |
| `agentis.canvas.rewire` | Proposes an edge change (also shown as a diff card) |

Canvas mutations (from `add_node` or `rewire`) never auto-apply. They always produce a **diff card** showing what would change. The operator clicks "Apply" to invoke `applyGraphPatch()` on the engine.

```
◈  Orchestrator  →  Canvas Copilot
"The email_node is failing because its recipient field references
{{lead.email}} but the upstream scrape_node outputs `lead.contact_email`.
Here's the fix:"

┌────────────────────────────────────────────────────────┐
│  Workflow patch — email_node                           │
│  ─ recipient: "{{lead.email}}"                         │
│  + recipient: "{{lead.contact_email}}"                 │
│                                                        │
│  [ Apply patch ]       [ Dismiss ]                     │
└────────────────────────────────────────────────────────┘
```

---

## 4. Ephemeral Workflows — Execute Without Saving

The most powerful new capability in the chat experience is **ephemeral workflow execution**: the operator describes what they want done, the orchestrator builds a temporary single-use workflow in memory, executes it immediately, and streams the result back — all without creating a persistent workflow definition in the database.

### 4.1 The use case

```
Operator: "Can you quickly scan all my Slack messages from this week
           and give me a summary of action items?"

Orchestrator:
  ◦ Thinking...
  I'll create a temporary workflow: Slack fetch → LLM summarize → output.

  ⚡ Ephemeral run — "Slack weekly summary"
  ● RUNNING  slack_fetch → summarize → done
  ...
  ✓ Completed in 12s

  Here's what I found: [streamed summary]
```

The workflow was never saved. No row was created in `workflows`. The run used the existing engine execution path. The operator got the answer. Done.

### 4.2 How ephemeral runs work

An ephemeral workflow is a `WorkflowRun` with no persistent `Workflow` parent. The engine already has the shape needed: `startRun()` takes a `graphSnapshot` — normally loaded from the DB but technically constructable in memory.

```typescript
// New API endpoint
POST /v1/ephemeral/run
body: {
  graph: WorkflowGraph;  // temporary graph, not persisted
  inputs: Record<string, unknown>;
  title: string;  // shown in the run card
  maxDurationMs?: number;  // default: 60_000 (1 min safety cap)
}
response: { runId, streamUrl }  // same SSE stream as a regular run
```

**Backend implementation:**
1. Validate the graph (same validator used by `POST /v1/workflows`)
2. Create a `workflow_runs` row with `workflowId = NULL` and `isEphemeral = true` (new boolean column)
3. Serialize the graph into `workflow_runs.graphSnapshot` (already exists for recovery)
4. Call `engine.startRun({ workflowId: null, graphSnapshot: graph, inputs })` — engine uses `graphSnapshot` directly instead of loading from DB
5. Return the `runId` — all existing realtime events, ledger, and observability work as normal

**Cleanup**: A background job purges `workflow_runs WHERE isEphemeral = true AND endedAt < now() - 24h`. No longer than 24 hours, never queryable from the standard `GET /v1/workflows` list.

### 4.3 How the orchestrator builds the graph

The orchestrator uses `agentis.ephemeral.run` with a description. The `agentis.ephemeral.run` tool implementation calls the existing `POST /v1/workflows/draft-from-prompt` (which already returns a `{title, graph}` skeleton) and immediately fires `POST /v1/ephemeral/run` with the result. The operator sees:

1. `◈ Building workflow...` (tool call)
2. `⚡ Ephemeral run — "..."` live card appears in thread
3. Run executes, node statuses update in real time inside the card
4. On completion: final text summary streamed into thread

The ephemeral run card stays in the thread as a permanent artifact — the operator can click "Save as workflow" to promote it to a real workflow.

### 4.4 Safety constraints

- **Duration cap**: 60 seconds by default. The operator can increase to 5 minutes. No indefinite ephemeral runs.
- **No subflows**: Ephemeral workflows cannot reference other workflows. All nodes must be inline.
- **No triggers**: Triggers are meaningless for a one-shot run. Any `trigger` node in the graph is silently dropped.
- **Budget gate**: Ephemeral runs go through the same `BudgetService.checkAndReserve()` path as regular runs.
- **One at a time per thread**: If the operator starts a second ephemeral run while one is active, the orchestrator asks to confirm or cancel the first.

---

## 5. Space-Scoped Chat (Multi-Space Workspaces)

Workspaces with defined spaces (sets of apps and workflows) can have space managers (`role = 'manager'`). The chat model for multi-space workspaces:

```
┌────────────────────────────────────────────────────────┐
│  Chat                                                  │
│  ──────────────────────────────────────────────────── │
│  ● Orchestrator          (default)                     │
│  ○ Research Manager      (scoped to Research space)    │
│  ○ Engineering Manager   (scoped to Engineering space) │
└────────────────────────────────────────────────────────┘
```

The scope selector is a **compact tab row** at the top of the chat panel — not a full-screen conversation switcher. Switching tabs changes the active `agentId` for new messages. The conversation history per scope is separate, but the screen context injection is shared (the manager also knows which workflow the operator is looking at).

**Orchestrator always visible**: Even when scoped to a manager, the orchestrator thread is reachable via the first tab. Managers cannot do everything the orchestrator can — they have a narrower tool catalog scoped to their space's resources.

---

## 6. The Home Page Composer — Redesigned

The home page composer (`HomePage.tsx`) currently has a vague recipient pill and no clear routing. Replace it with:

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   What do you need done?                               │
│                                                         │
│   ┌─────────────────────────────────────────────────┐  │
│   │                                                 │  │
│   │                                                 │  │
│   └─────────────────────────────────────────────────┘  │
│                                                         │
│   Send to Orchestrator ▾     ⌘K Ephemeral    ↵ Send   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**"Send to Orchestrator"** is the default and hardcoded when a workspace orchestrator exists. The dropdown only appears in multi-space workspaces (to surface the manager options). Single-orchestrator workspaces have no dropdown — it reads as a chip, not a selector. This removes the confusion of "which agent?" from the primary homepage action.

When no orchestrator is commissioned, the composer is replaced with a commission prompt:

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   Commission your Orchestrator to get started          │
│                                                         │
│   The Orchestrator is the intelligence that runs       │
│   your workspace. You'll talk to it from here.         │
│                                                         │
│   [ Commission Orchestrator → ]                        │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 7. What This Changes in the Store and API

### 7.1 Zustand store additions

```typescript
// agentisStore.ts additions
interface AgentisStore {
  // ... existing fields ...

  // Screen context (replaces ad-hoc per-page state)
  screenContext: ScreenContext | null;
  setScreenContext(ctx: ScreenContext): void;
  clearScreenContext(): void;

  // Orchestrator chat
  orchestratorThreadId: string | null;   // fetched on workspace load
  chatScope: 'orchestrator' | string;    // string = managerId
  setChatScope(scope: 'orchestrator' | string): void;
}
```

### 7.2 New and modified API endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/conversations/orchestrator` | Returns (or creates) the orchestrator thread for the current workspace. Returns `{ threadId, agentId, agentName, agentStatus }`. |
| `POST` | `/v1/conversations/orchestrator/send` | Send a message with screen context. Body: `{ message, screenContext }`. Streams SSE. |
| `POST` | `/v1/conversations/orchestrator/confirm` | Confirm or reject a pending write-tool action. Body: `{ turnId, confirmed: boolean }`. |
| `POST` | `/v1/ephemeral/run` | Run a temporary workflow with no saved definition. Body: `{ graph, inputs, title, maxDurationMs? }`. Returns `{ runId }`. |
| `GET` | `/v1/ephemeral/:runId/promote` | Promotes an ephemeral run's graph to a saved workflow. Returns `{ workflowId }`. |

### 7.3 Schema additions

| Column | Table | Type | Purpose |
|---|---|---|---|
| `isEphemeral` | `workflow_runs` | `INTEGER` (0/1) | Marks runs with no parent workflow |

Migration: `ALTER TABLE workflow_runs ADD COLUMN isEphemeral INTEGER NOT NULL DEFAULT 0;`

---

## 8. What the Orchestrator Needs (Agent Configuration)

The workspace orchestrator is only as good as its playbook and tool access. On commission, the orchestrator is auto-configured with:

**Default playbook** (injected as `instructions`):

```
You are the Orchestrator for this workspace. Your job is to help the
operator manage their agents, workflows, apps, and goals.

You can read anything on the platform and act on it with the operator's
confirmation. When the operator asks you to do something that changes
platform state, always show them exactly what you are about to do before
doing it.

You know what the operator is currently looking at. Use that context.
If they say "this workflow" or "this node", they mean the one shown in
[Platform Context] above.

You can build and run temporary workflows for one-off tasks. Prefer
ephemeral runs over asking the operator to set up a workflow manually
for simple one-time jobs.
```

**Tool catalog**: The full `PLATFORM_TOOL_CATALOG` defined in §2.3 — all read tools plus all write tools (gated by confirmation).

**Model**: Default to the workspace's highest-capability model (e.g. `claude-opus-4-7` or equivalent) — the orchestrator is the operator's primary interface and should not be running on a budget model.

---

## 9. Phased Delivery

### Phase 1 — Screen Context Injection (low risk, high leverage)
**Scope**: `agentisStore.ts` (add `screenContext`), each page component (call `setScreenContext` on mount), `POST /v1/conversations/:agentId/send` handler (inject `screenContext` into system prompt prefix).
**Outcome**: The orchestrator knows what the operator is looking at. Every existing chat interaction becomes meaningfully more relevant.
**Risk**: Low. No schema changes. Additive to existing send endpoint.
**Files touched**: ~8

### Phase 2 — Agentic Loop + Tool Catalog
**Scope**: `ChatSessionExecutor.ts` (implement the full loop from `CHAT-AGENT-LOOP.md`), `ChatToolExecutor.ts` (platform tool implementations), `POST /v1/conversations/orchestrator/*` endpoints, SSE delta types including `confirmation_required`, confirmation card UI component.
**Outcome**: The orchestrator can inspect runs, list agents, read the ledger, and perform write operations with operator confirmation. Chat becomes a real platform command surface.
**Risk**: Medium. Core loop is well-specified. Confirmation flow requires new UI component and new API endpoint.
**Files touched**: ~12

### Phase 3 — Chat Panel UX Redesign
**Scope**: `ChatPanel` component tree — context pill, rich message types (artifact cards, ephemeral run card, diff card, confirmation card), scope tabs, `@mention` routing. Home page composer redesign.
**Outcome**: The chat UI matches the power of the backend. Operators see thinking, tool calls, structured artifacts, and live run cards — not just text.
**Risk**: Medium. Component work, no API changes required beyond Phase 2.
**Files touched**: ~10

### Phase 4 — Ephemeral Workflows
**Scope**: `POST /v1/ephemeral/run`, `GET /v1/ephemeral/:runId/promote`, `isEphemeral` column migration, engine path for null `workflowId` runs, `agentis.ephemeral.run` tool implementation, ephemeral run card in chat thread, "Save as workflow" button.
**Outcome**: Operators can ask the orchestrator to run one-off tasks and get results without building a workflow. The platform becomes conversationally executable.
**Risk**: Medium-high. Engine path needs care (null workflowId). Safety caps must be enforced.
**Files touched**: ~8 + 1 migration

### Phase 5 — Canvas Copilot Mode
**Scope**: Canvas Copilot tool catalog additions (`explain`, `debug_node`, `suggest_fix`, `add_node`, `rewire`), canvas context surface detection (blue panel border), diff card component with Apply/Dismiss, `PATCH /v1/workflows/:id/graph` wiring.
**Outcome**: The operator can debug, explain, and modify workflows from the chat panel while looking at the canvas. The combination of canvas + chat becomes the primary engineering interface.
**Risk**: Medium. Builds entirely on Phase 1–3. Diff card is the most complex new UI component.
**Files touched**: ~6

---

## 10. What Does NOT Change

- **Worker agents are not chatted with.** No direct DM to a worker agent. They are dispatched via the orchestrator's tool calls. This is a hard constraint, not a UX preference — it keeps the conversation model coherent as the fleet scales.
- **The workflow canvas is not replaced.** Chat extends it; does not replace it. Complex workflow construction (multi-branch logic, conditions, loops, approvals) still happens on the canvas. Chat handles one-off tasks and guided edits.
- **The existing conversation threads remain.** Agent-specific threads under `/conversations` and the per-agent `ThreadView` are preserved for historical context. They are not the primary chat surface; the orchestrator thread is.
- **The realtime event system is unchanged.** All existing socket.io rooms, event types, and subscriptions remain as-is. The chat loop reuses `AGENT_WORK_STEP`, `AGENT_PRESENCE_THINKING`, `CONVERSATION_MESSAGE_RECEIVED` — no new events required.
