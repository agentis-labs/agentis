# App Output Surface — Orchestrator Conversation Replan
## Full Replacement Plan: Issues Queue → App-Scoped Orchestrator Thread

> **Status:** Active planning — May 2026
> **Scope:** App Output surface, operator interaction model, issue system replacement
> **Trigger:** Strategic decision — Agentis builds agentic apps, operators interact with an orchestrator, not a kanban board
> **Supersedes:** D-12 (Issue/Task kanban) from APP-EXPERIENCE-REPLAN.md
> **Depends on:** APP-EXPERIENCE-REPLAN.md (D-10, D-11, D-13 remain valid), APP-CANVAS-ARCHITECTURE.md, ORCHESTRATOR.md

---

## The One-Line Decision

> The Output surface of an Agentis app is an orchestrator conversation thread scoped to the app — not a Kanban board.

D-12 from APP-EXPERIENCE-REPLAN.md introduced a Paperclip-style issue queue. That decision is reversed here.

Paperclip is a control plane for an AI company's operations. Agentis is a platform for building and running agentic apps. The metaphor is wrong at the root: you do not "file an issue" to an agentic app. You talk to it. The app is orchestrated — it has agents, workflows, and a brain. The operator's job is to direct it and receive its output, not to manage tickets against it.

This document replaces D-12 entirely and redefines the operator interaction model for the Output surface.

---

## Part I — Why Kanban Is the Wrong Model

### 1.1 What the Issues Queue Assumed

The current issues system (IssueService, `/v1/apps/:appId/issues`, `IssueLane` in AppDetailPage) is built on the premise that:

- Operators create discrete, trackable work items
- Items progress through a pipeline: Backlog → Running → Review → Done
- Each item has a status, priority, labels, and an identifier (AGT-N)
- The operator manages this pipeline visually

This is project management language grafted onto an agentic runtime. It is the vocabulary of Linear or Jira — not the vocabulary of talking to an intelligent system.

### 1.2 What the Current Code Actually Does (Stripped of Metaphor)

Under the Kanban UI, `IssueService.accept()` does exactly one thing: it calls `WorkflowEngine.startRun()` with the issue's description as input. The entire Kanban is a UI veneer over a single API: "run the entry workflow with this input."

That's the correct primitive. The metaphor wrapping it is wrong.

`IssueService.accept()` is a run-trigger. The operator isn't filing an issue — they're telling the app to do something. The "Backlog" lane is not a queue of unresolved items — it's a list of pending inputs. The "Done" lane is not a resolved issue — it's a completed run.

### 1.3 The Right Mental Model

An agentic app is not a ticketing system. It is a team of agents, orchestrated by the app's entry workflow, capable of receiving natural-language direction and producing structured output.

The interaction model should feel like:

> You open the Social Listening app.
> You see the last digest it produced.
> You type: "Focus on mentions of the v3 launch from the past 72 hours."
> The app picks it up. Its orchestrator acknowledges: "Running a scan now — I'll surface the results here when done."
> Three minutes later, a new result card appears in the thread.
> You reply: "Flag anything with negative sentiment above 0.7 and send a Slack summary."
> The app does it.

That is the product. Not a kanban. A conversation with a capable system.

---

## Part II — The New Interaction Model

### 2.1 The App Thread

Every app has an **App Thread** — a persistent conversation surface scoped to that app. It lives in the Output layer alongside the results hero.

The App Thread is not the workspace orchestrator chat (`/chat`). It is an app-scoped thread where:

- The operator directs the app in natural language
- The app (via its entry workflow or orchestrator binding) executes and streams progress
- Completed runs surface their output directly in the thread as result cards
- The orchestrator can provide commentary, ask for clarification, or surface decisions

This is structurally the same as the existing `ChatSessionExecutor` + `AgentisToolRegistry` pipeline. What changes is the **scoping**: the system prompt for an App Thread is app-scoped, not workspace-scoped. The orchestrator in this context knows:

- What app it is operating in
- The app's entry workflow, agent roster, output schema, and brain
- The most recent run results for this app
- Any pending approvals or checkpoints in active runs

### 2.2 Thread Anatomy

Three structural zones, one data model:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Social Listening App                            Output | Canvas | Brain    │
│  $0.04 this month · 14 runs · healthy                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  [Hero — promoted result, full fidelity]                                    │
│  Digest: May 14, 2026 · 247 mentions · 3 flagged       ◀ May 13  May 14 ▶  │
├──────────────────────────────┬──────────────────────────────────────────────┤
│  Conversation                │  Activity feed                               │
│  (operator-directed only)    │  (every run — scheduled + directed)          │
│                              │                                              │
│  ┌──────────────────────┐   │  ● 10:42  Daily digest        [view]          │
│  │ App                  │   │  ● 09:01  On-demand: v3 scan  [view]          │
│  │ Focused scan done:   │   │  ○ 08:14  Competitor watch    [failed] [↺]    │
│  │ 12 v3 mentions found │   │  ── May 13 ────────────────────────────────  │
│  │ [View result →]      │   │  ● 10:44  Daily digest        [view]          │
│  └──────────────────────┘   │  ● 09:01  On-demand scan      [view]          │
│                              │                                              │
│  ┌──────────────────────┐   │                                              │
│  │ You                  │   │                                              │
│  │ Focus on v3 launch   │   │                                              │
│  │ mentions last 72h    │   │                                              │
│  └──────────────────────┘   │                                              │
│                              │                                              │
│  ┌──────────────────────┐   │                                              │
│  │ App [running]        │   │                                              │
│  │ On it. Scanning...   │   │                                              │
│  │ ████░░ 60%           │   │                                              │
│  └──────────────────────┘   │                                              │
│                              │                                              │
│  [Compose message...]        │                                              │
└──────────────────────────────┴──────────────────────────────────────────────┘
```

**Hero** (top): full-fidelity rendering of the currently selected result. The ◀ / ▶ arrows navigate the result history. Auto-advances to the latest result when a new run completes. One data source — it is the same result object as the activity feed entry, rendered at full fidelity.

**Conversation** (left): only operator-directed interactions and the app's responses to them. Scheduled runs that complete without operator involvement do not appear here — they appear in the activity feed only. When an operator-triggered run completes, a compact result notification appears in the conversation with a [View result →] link that promotes that result to the hero.

**Activity feed** (right): every run in reverse-chronological order, grouped by day — scheduled, triggered, and operator-directed alike. Each entry has a [view] link that promotes its output to the hero. Failed runs show a [↺] retry button inline.

### 2.3 Thread Message Types

The **Conversation** contains four message types. Automated scheduled runs do not appear here — they go to the Activity Feed.

| Type | Who sends it | What it looks like |
|------|-------------|-------------------|
| **Operator message** | Operator | Plain text bubble, right-aligned |
| **App acknowledgment** | App/orchestrator | Text bubble with app icon, left-aligned — "Running a focused scan on v3 mentions now" |
| **Progress update** | App/orchestrator | Compact inline card — spinner + node name + progress bar — dismissed when run completes |
| **Result notification** | App (on operator-triggered run completion only) | Compact card: "Scan complete · 12 mentions found · [View result →]" — clicking promotes to hero |
| **Checkpoint** | App (human-in-loop node) | Approval card — "App needs your input: [decision]" with action buttons |

The core rule: **the Conversation is not a log**. It contains only what the operator initiated and what the app said back. Scheduled runs completing in the background never appear in the Conversation. They appear in the Activity Feed. If the operator wants to see what the app did while they were away, they look right. If they want to direct the app, they look left.

### 2.4 Directing the App

The operator's composer (bottom of the thread) accepts natural-language instructions:

- "Run a competitor analysis on the last 7 days"
- "Show me the top 3 flagged mentions from yesterday's digest"
- "Pause the daily digest for this week"
- "What's the current status of the scan you're running?"

These are sent as messages. The app's orchestrator processes them through the same `ChatSessionExecutor` pipeline, scoped to this app. The orchestrator can:

- Call `agentis.workflow.run` with the entry workflow + operator message as input
- Call `agentis.workflow.status` to report on an active run
- Call `agentis.knowledge.search` to answer questions from the app's brain
- Surface approval requests that the operator needs to resolve
- Explain what the app is doing and why

### 2.5 Progress Streaming

When a run is triggered through the thread, progress streams inline in the thread — not in a separate "Running" lane.

The progress card shows:
- App icon + "Running..." label
- Current node name (e.g., "Collecting mentions from Twitter API")
- Progress bar (nodes completed / total nodes)
- Elapsed time

When the run completes, the progress card is replaced by the result notification. If the run fails, the progress card becomes a failure card with a "Retry" button and the error in plain language (not a node ID or stack trace).

### 2.6 Conversation vs Activity Feed — The Structural Split

This split resolves the core tension between "thread as conversation" and "thread as execution log."

The problem: an app that runs daily accumulates 30 automated entries per month for every 1 operator message. If both go into the same scroll, the conversation becomes a server log with occasional questions buried in it. The chat metaphor collapses under the weight of the log.

The solution: they are different data with different purposes and they render differently.

| Surface | What goes here | Design principle |
|---------|---------------|------------------|
| **Conversation** | Operator messages, app responses, progress on operator-triggered runs, checkpoints | Sparse. Only directed interaction. Empty for apps the operator never talks to — and that is correct. |
| **Activity Feed** | Every run — scheduled, triggered, operator-directed — in chronological order | Dense. Complete execution history. The operator reads this to understand what the app did autonomously. |

An operator who schedules an app and never directs it manually sees: an empty Conversation with a composer ready, and a full Activity Feed. The absence of conversation messages is not a problem — it means the app is running autonomously as designed.

An operator who actively directs the app sees a conversation that reads cleanly because it contains only their directed exchanges.

Both operators see the same Hero — promoted from whichever result they last viewed, or the latest completed run by default.

---

## Part III — Output Surface Layout

### 3.1 The Three States (Unchanged from D-10)

D-10 from APP-EXPERIENCE-REPLAN.md is still correct. The three states remain:

**State A: App has runs and output configuration**
- Hero: latest result at full fidelity (Social Listening: digest with themes, alerts, key mentions)
- Below hero: thread (left) + results timeline (right)
- Ambient strip: `$0.04 this month · 14 runs · ↑ healthy`

**State B: App has runs but no output configuration**
- Hero: "Configure what to show here" with CTA to Canvas → Output node inspector
- Below: thread (left) + runs timeline right (status, duration, no rendered output)

**State C: App has no runs**
- Hero: "Your app is ready" with a primary CTA ("Ask the app to run" — opens thread with a pre-filled prompt)
- Thread is empty: show a starter suggestion ("Try: 'Run the first analysis'")

### 3.2 Tab Structure (Revised)

The Output layer's internal tab structure from D-13 is revised:

```
[Output]  [Canvas]  [Brain]          ← top-level segmented control
            ↓ when on Output:
[Results]  [Performance]  [Activity]
```

- **Results** (default): hero + thread + results timeline (this document)
- **Performance**: costs, run counts, cost trend, cost by agent (already exists — just not hero)
- **Activity**: raw audit trail of run events, approvals, errors

**Issues** tab is deleted. It does not exist. The thread replaces it.

### 3.3 Activity Feed

The right panel is a complete execution log — every run this app has started, in reverse-chronological order, grouped by day. It is not filtered to operator-directed runs only.

Each entry shows:

- Timestamp + trigger label (Daily digest / On-demand / Operator-directed)
- Output summary (first line of the result or artifact label)
- Status: ● success / ○ failed / ◐ in-progress
- **[view]** — promotes this run's output to the hero
- **[↺]** — retry button, visible on failed runs only

The Activity Feed is the authoritative index of what this app has ever produced. The hero is the viewport into it.

### 3.4 Hero as Promoted Result Viewport

The hero is not a separate data surface. It is the full-fidelity rendering of whichever result is currently selected. This resolves the duplication problem directly: the hero, the activity feed entry, and the conversation result notification all reference the same run record. There is no separate hero data fetch — the hero reads from the same `workflow_runs` record that the feed entry links to.

**Promotion sources:**
- On page load: auto-selects the latest completed run
- [view] in Activity Feed: promotes that run's output
- [View result →] in a Conversation result notification: promotes that run's output
- On new run completion (while page is open): auto-promotes unless the operator has manually navigated to a historical result

**Navigation:** The ◀ / ▶ arrows in the hero step through results in chronological order — the same ordering as the Activity Feed. Navigating via arrows highlights the corresponding feed entry on the right.

**One result, three fidelities:**

| Zone | Rendering |
|------|-----------|
| Activity feed entry | Single line: timestamp + summary + status badge + [view] |
| Conversation result notification | Compact card: "Scan complete · N items found · [View result →]" — only for operator-triggered runs |
| Hero | Full-fidelity output component: digest, document, metric, list — whatever the output type declares |

The hero has an **expand icon** (↗) in the top-right corner. Clicking it navigates to the Result Detail page for the currently promoted result.

### 3.5 Result Detail Page

#### Why a page, not a modal

A modal does not have a stable URL. Faking shareability with query params (`?result=id`) puts the recipient on the Output surface with a modal open — fragile, and it breaks if they navigate away. For long-form output (a 3,000-word research report, a full weekly digest, a generated data table), the hero card cannot render at true full fidelity without competing with the Conversation and Activity Feed for width. A dedicated route gives the full browser viewport.

#### URL structure

```
/apps/:slug                          →  Output surface (hero + conversation + activity feed)
/apps/:slug/results/:resultId        →  Result detail (full viewport, own URL, shareable)
```

#### Navigation behaviour

The result detail page slides in from the right over the Output surface — it does not perform a full page reload. The Output surface is preserved underneath. A back chevron (←) in the top-left restores the Output surface exactly as left, with the same result still promoted in the hero.

This is the same pattern Linear uses for issue detail: real route, real URL, slide-in animation over the parent surface.

#### Entry points

| Trigger | Action |
|---------|--------|
| ↗ expand icon on hero | Slide in result detail for the currently promoted result |
| [view] in Activity Feed | Navigate to result detail, slide in |
| [View result →] in Conversation notification | Navigate to result detail, slide in |
| ◀/▶ arrows in hero | Update URL in place, no slide — hero is the fast path for sequential browsing |
| Direct link / bookmark | Full load of result detail page with back chevron pointing to Output surface |

#### Result detail page layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ←  Social Listening  ·  Daily Digest  ·  May 14 10:00 AM           [Copy link] │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [Full-fidelity output — entire viewport width]                              │
│                                                                             │
│  247 mentions tracked across 5 sources                                      │
│  3 flagged items · Sentiment: 72% positive · Top theme: Product launch       │
│                                                                             │
│  [Full rendered digest content...]                                           │
│  ...                                                                         │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  ◄ Prev result                                              Next result ►  │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Header**: back chevron + app name + result label + timestamp + [Copy link] button
- **Body**: full viewport width, full-fidelity output component with no panel competition
- **Footer**: Prev / Next navigation across `app_results` (keyset, same ordering as Activity Feed)
- No Conversation, no Activity Feed, no composer — this is a read surface

#### Data source

Reads directly from `app_results WHERE id = :resultId`. One row fetch. No `workflow_runs` scan. The `content` column is the authoritative rendered value.

---

## Part IV — What Happens to the Issues System

### 4.1 What to Keep

The underlying run-trigger primitive is correct and stays. Specifically:

- `IssueService.accept()` — the logic of "take this input, start the entry workflow run" is the right behavior; it gets **repurposed** not deleted
- `POST /v1/apps/:appId/issues` (accept-on-create path) — becomes `POST /v1/apps/:appId/run` with a `{ prompt, priority? }` body, no issue metaphor
- The `linkedWorkflowId` concept — correct; entry workflow is the routing target

### 4.2 What to Delete

| What | Why |
|------|-----|
| `IssueLane` component in `AppDetailPage.tsx` | Replaced by thread + results timeline |
| `issueLane()` render function | Same |
| `acceptIssue()` in AppDetailPage | Replaced by thread send action |
| `ISSUE_CREATED` / `ISSUE_UPDATED` realtime events (management layer usage) | Replaced by `RUN_CREATED` + thread messages |
| AGT-N identifier system | No operator-facing issue identifier needed |
| Issue status / priority / labels fields | Not surfaced; run has its own status |
| "Backlog / Running / Review / Done" lanes | Replaced by thread progress + result cards |
| `GET /v1/apps/:appId/issues` endpoint | Replaced by `GET /v1/apps/:appId/thread` |
| `POST /:id/accept` on issues route | Replaced by direct workflow run trigger |

### 4.3 What to Repurpose

The **approval** pattern is kept and surfaced in the thread, not as a lane:

- When a workflow hits a `checkpoint` or `human_in_the_loop` node, the App Thread surfaces an **approval card** inline
- The operator resolves it in the thread with Accept / Reject buttons
- This maps to the existing `APPROVAL_REQUESTED` / `APPROVAL_RESOLVED` events — no new infrastructure needed

### 4.4 DB Migration Notes

If the `issues` table already has production data:

1. For `status = 'backlog'` (unaccepted) items: these are unstarted requests — the thread can surface them as "pending messages" on first load until the migration is complete
2. For `status = 'running'` items: these have `activeRunId` — wire them to the existing run via the results timeline
3. For `status = 'done'` items: archive to run history — no migration needed, runs already exist
4. The `issues` table can be dropped after the thread history table is stable

---

## Part V — App Thread Technical Design

### 5.1 New Route: App Thread

```
POST   /v1/apps/:appId/thread/send          — send a message, triggers execution if appropriate
GET    /v1/apps/:appId/thread               — get thread message history
GET    /v1/apps/:appId/thread (SSE)         — stream live thread events
GET    /v1/apps/:appId/results              — paginated app_results index (Activity Feed source)
GET    /v1/apps/:appId/results/:resultId    — single result (Result Detail page source)
```

The `send` endpoint is an SSE endpoint structurally identical to `POST /v1/conversations/:agentId/send`. The key differences:

| Dimension | Workspace Chat | App Thread |
|-----------|---------------|------------|
| System prompt scope | Workspace-wide, all workflows/agents | App-scoped: entry workflow, agent roster, output schema, last result |
| Tool access | Full `CHAT_TOOL_CATALOG` | Subset scoped to this app + `agentis.workflow.run` (entry workflow hardwired) |
| Thread persistence | `conversations` table (agent-scoped) | New `app_thread_messages` table (app-scoped) |
| Progress surfacing | Inline in chat as tool call summary | Inline as structured progress card (run subscription) |

### 5.2 App-Scoped System Prompt

> **Open question — agent hierarchy (blocks Phase 3 implementation)**
>
> This section assumes a flat 1-app-1-orchestrator model. That assumption is under review.
>
> The emerging architecture is a hierarchy:
> ```
> Workspace Orchestrator
>   └── Space Manager  (manages multiple apps within a space)
>         └── App: Social Listening
>         └── App: Campaign Tracker
>   └── Space Manager  (another space)
>         └── App: Release Monitor
> ```
>
> In this model the **voice in the App Thread** is not a bespoke per-app agent — it is the Space Manager
> (or the Workspace Orchestrator when no space layer exists) operating in the context of that specific app.
> The App Thread surface defined in this document remains correct. Only the identity of who is
> speaking (§5.2) changes once the hierarchy is decided.
>
> The hierarchy — which agents exist, how they are structured, how they are editable via canvas,
> and how they relate to spaces/apps/workflows — must be resolved in a separate architecture document
> before §5.2 is implemented. Phases 0–2 and Phase 4 of this plan are unblocked. Phase 3 depends on it.

When the App Thread bootstraps a `ChatSessionExecutor` turn, the system prompt will include app context
along the following lines. The exact `role` and `identity` fields resolve from the agent hierarchy
(workspace orchestrator → space manager → app) rather than being hardcoded per-app:

```
You are operating as {resolvedAgentName} ({resolvedAgentRole}) on behalf of the {appName} app.
Your job: execute the operator's requests using this app's entry workflow and agents.

App configuration:
- Entry workflow: {workflowId} ({workflowTitle})
- Agents: {agentRoster}
- Output schema: {outputComponents}
- Last run: {lastRunSummary}
- Active runs: {activeRunIds}

When the operator asks you to run something, call agentis.workflow.run with workflowId={entryWorkflowId}
and pass the operator's message as the run input.
When a run completes, summarize the result in plain language and it will be rendered as a result card.
When a run needs operator input (checkpoint), surface the decision clearly with options.
```

`resolvedAgentName` and `resolvedAgentRole` are resolved at request time by walking up the hierarchy:
app → space manager (if exists) → workspace orchestrator. The first agent in the chain that is
configured to handle this app's thread is the speaker. This lookup is a 1–3 DB row resolution, not
a new agent spawn.

### 5.3 Thread Message Persistence

New table: `app_thread_messages`

```sql
CREATE TABLE app_thread_messages (
  id          TEXT PRIMARY KEY,
  appId       TEXT NOT NULL REFERENCES app_instances(id),
  workspaceId TEXT NOT NULL,
  role        TEXT NOT NULL,  -- 'operator' | 'app' | 'system'
  kind        TEXT NOT NULL,  -- 'message' | 'progress' | 'result' | 'checkpoint' | 'error'
  content     TEXT NOT NULL,  -- JSON payload varies by kind
  runId       TEXT REFERENCES workflow_runs(id),
  createdAt   TEXT NOT NULL
);
```

The `content` JSON shape per `kind`:

- `message`: `{ text: string }`
- `progress`: `{ runId, nodeLabel, completedNodes, totalNodes, elapsedMs }`
- `result`: `{ runId, artifactType, outputKey, renderedValue }` — mirrors output component schema
- `checkpoint`: `{ approvalId, title, description, options: string[] }`
- `error`: `{ runId, message, retryable: boolean }`

### 5.4 Realtime Integration

`REALTIME_ROOMS` has no `app` room — rooms are scoped to `workspace`, `workflow`, `run`, `gateway`, `agent`, and `conversation`. The App Thread component uses a **two-step subscription**:

1. **On mount:** subscribe to `workflow(entryWorkflowId)` room to receive `RUN_CREATED` for any run that targets this app's entry workflow
2. **On `RUN_CREATED`:** subscribe to `run(runId)` for that specific run's progress events

A new `APP_THREAD_MESSAGE_APPENDED` event must be added to `REALTIME_EVENTS` (in `packages/core/src/events.ts`) and emitted on the `workflow(entryWorkflowId)` room whenever a row is written to `app_thread_messages`. This is the push signal that updates the Conversation panel in real time.

Full event mapping:

```
[workflow room — always subscribed]
APP_THREAD_MESSAGE_APPENDED → append message to Conversation
RUN_CREATED                 → open run(runId) subscription + emit progress card

[run room — opened per active run]
RUN_RUNNING     → update progress card
NODE_STARTED    → update progress card nodeLabel
NODE_COMPLETED  → increment completedNodes
RUN_COMPLETED   → replace progress card with result card; close run room subscription
RUN_FAILED      → replace progress card with error card; close run room subscription
APPROVAL_REQUESTED → insert checkpoint card
APPROVAL_RESOLVED  → update checkpoint card to resolved state
```

Note: `APP_THREAD_MESSAGE_APPENDED` is a new addition to `REALTIME_EVENTS`. All other events are existing. Add the new event to the `REALTIME_EVENTS` object in `packages/core/src/events.ts` and update the test that pins the allow-list.

### 5.5 Tool Restrictions for App Thread

The App Thread orchestrator does NOT have access to the full `CHAT_TOOL_CATALOG`. It has access to:

| Tool | Why |
|------|-----|
| `agentis.workflow.run` | Core action — trigger entry workflow |
| `agentis.workflow.status` | Report on active runs |
| `agentis.workflow.cancel` | Cancel a running job |
| `agentis.approval.list` | Surface pending approvals |
| `agentis.approval.resolve` | Resolve approvals from thread |
| `agentis.knowledge.search` | Answer questions from app's brain |
| `agentis.memory.read` | Access app-scoped memory |
| `agentis.run.diagnose` | Explain failures in plain language |

The app thread orchestrator cannot create new agents, patch workflows, or access other apps. It is scoped to operating this app, not building the workspace.

### 5.6 App Results Store

#### Why `workflow_runs` is the wrong query target

`workflow_runs` is an execution record. It stores run state, ledger events, node observability, and full `blockData` as JSON blobs. It is designed for replay, recovery, and audit — not for the query pattern the Output surface needs:

- Load the Activity Feed fast on page open (no JSON scanning)
- Load the hero for the latest result (single row fetch)
- "Give me all digests from the last 30 days"
- "Find results that mentioned competitor X" (full-text search)
- "Show sentiment trend week over week" (aggregate over structured fields)

Scanning `workflow_runs.runState` blobs for these is slow, fragile, and couples the display layer to execution internals. The right architecture separates the two concerns.

#### The `app_results` table

`app_results` is a **materialized projection** of run outputs. `workflow_runs` remains the source of truth for execution. When a run completes, the output surface node handler extracts declared outputs and writes one row per output key.

```sql
CREATE TABLE app_results (
  id           TEXT PRIMARY KEY,
  appId        TEXT NOT NULL REFERENCES app_instances(id),
  workspaceId  TEXT NOT NULL,
  runId        TEXT NOT NULL REFERENCES workflow_runs(id),
  outputKey    TEXT NOT NULL,        -- matches outputKey declared in app_instances.packageContents output config
  artifactType TEXT NOT NULL,        -- digest | document | metric | list | decision | table | file | link
  content      TEXT NOT NULL,        -- full rendered JSON value (source of truth for hero)
  summary      TEXT,                 -- headline / first line, pre-extracted for feed display
  triggeredBy  TEXT NOT NULL,        -- 'scheduled' | 'operator' | 'event'
  createdAt    TEXT NOT NULL
);

CREATE INDEX app_results_app_created  ON app_results (appId, createdAt DESC);
CREATE INDEX app_results_run          ON app_results (runId);
```

Full-text search on `content` and `summary` uses SQLite FTS5 via a shadow table (`app_results_fts`) kept in sync by an insert trigger. This is the same pattern used for workspace knowledge.

#### Write path

`AppResultsService.materialize(runId)` is called from a `bus.subscribe(REALTIME_EVENTS.RUN_COMPLETED, ...)` listener registered in API bootstrap — **not** from inside `WorkflowEngine`, which has no knowledge of app-layer concepts. `WorkflowEngine` emits `RUN_COMPLETED` on the bus; bootstrap glues the engine to the app layer.

`materialize(runId)` steps:

1. Load the run's `blockData` from `workflow_runs` (source of truth for node outputs)
2. Resolve the `app_instances` row via `workflow_runs.workflowId` → `app_instances.entryWorkflowId` lookup
3. Read declared output configuration from `app_instances.packageContents` — **not** from the graph snapshot. `output_surface` is an App Canvas (system-composition) node type, not a workflow execution node; it is never present in `workflow_runs.graphSnapshot`
4. For each declared output key: extract `outputKey`, `artifactType`, and the resolved value from `blockData`
5. Write one `app_results` row per output key
6. Emit no new event — the existing `RUN_COMPLETED` event is sufficient; the UI re-queries `app_results` on receipt

If `materialize()` fails (e.g. no output config in `packageContents`), it logs a warning and no row is written. State B (app has runs but no output config) is the correct fallback.

#### Read path

| Query | Source |
|-------|--------|
| Activity Feed entries | `SELECT id, summary, artifactType, triggeredBy, createdAt FROM app_results WHERE appId=? ORDER BY createdAt DESC` |
| Hero on page load | `SELECT * FROM app_results WHERE appId=? ORDER BY createdAt DESC LIMIT 1` |
| Hero for selected result | `SELECT * FROM app_results WHERE runId=?` |
| Historical navigation (◀/▶) | `SELECT id, createdAt FROM app_results WHERE appId=? ORDER BY createdAt` (keyset) |
| Operator question: "what did it find last week?" | FTS5 query on `app_results_fts` scoped to `appId` + date range |

The `workflow_runs` table is never queried by the Output surface. The Activity tab (raw audit trail) queries `ledger_events` directly — that is a separate concern from the results store.

#### No duplication with `app_thread_messages`

`app_thread_messages` of `kind: 'result'` stores a compact notification (`runId` + summary), not the full content. The hero reads `app_results.content`. There is one copy of the rendered output — in `app_results`. The thread notification is a pointer to it, not a copy.

---

## Part VI — UX States and Edge Cases

### 6.1 App Is Actively Running When Operator Opens Output

If a run is active when the operator opens the Output surface:

- The latest result hero shows the previous completed result (greyed slightly)
- A banner above the hero: "Running now · Social Digest · 60% · [View progress]"
- Clicking "View progress" scrolls the thread to the live progress card

### 6.2 Multiple Concurrent Runs

Some apps (high-frequency scheduled apps) may have multiple active runs simultaneously. Each shows as a separate progress card in the thread, ordered by start time. The results timeline shows all completed runs in reverse chronological order.

### 6.3 Scheduled App — No Operator Interaction Needed

Many apps run on a schedule and the operator never sends messages. This is fine:

- The thread shows only system messages: "Ran at 10:00 AM · [view result]"
- The composer is still available if the operator wants to direct the app
- The results timeline is the primary navigation surface for these apps

The thread never forces operators to interact — it surfaces interaction as an available channel, not a required workflow.

### 6.4 App Needs Credentials / Is Misconfigured

If the app's entry workflow fails because of missing credentials or configuration:

- The error card in the thread shows: "Your app can't run — a connection is missing: [Slack]. [Configure connections →]"
- The link goes to Config → Connections (D-2 from APP-EXPERIENCE-REPLAN.md)
- No technical error messages in the thread

### 6.5 First-Time App with No Runs

State C: the hero area shows a large, calm empty state with a single suggested message pre-filled in the composer:

```
[App icon]
"This app is ready to run."

Pre-filled in composer:
"Run the first analysis →"
```

Pressing send triggers the entry workflow with no input (or a default trigger input from the workflow's schema). The app is now running. The operator sees progress inline.

---

## Part VII — What This Is Not

This plan does not build a general-purpose chat agent. It does not build a chatbot. The App Thread is a **directed execution surface**, not a conversational assistant.

The orchestrator in the App Thread is an executor, not a conversationalist. Its job is:

1. Understand what the operator wants done
2. Map that to workflow execution
3. Report progress and results

It does not have opinions, does not offer unsolicited suggestions, and does not fill the thread with commentary. When a run completes successfully, the result card is the response — not a paragraph of "Great! I've completed the analysis. Here's what I found: [summary]." The result speaks for itself.

The orchestrator only speaks when:
- Acknowledging a new run request ("Running now")
- Reporting a failure in plain language
- Asking for required operator input (checkpoint)
- Answering a direct question about status or output

Brevity is a product decision, not an implementation detail.

---

## Part VIII — Phased Implementation

### Phase 0 — Remove the Kanban (1 day)

| # | Task |
|---|------|
| 0-1 | Delete `IssueLane`, `issueLane()`, `acceptIssue()` from `AppDetailPage.tsx` |
| 0-2 | Replace Output tab content with placeholder: results hero + thread scaffold (empty state OK) |
| 0-3 | Keep `IssueService` backend intact — do not break existing runs triggered via issues |
| 0-4 | Update tab order: Results → Performance → Activity (remove Issues tab) |

### Phase 1 — Thread MVP + Results Store (3–4 days)

| # | Task |
|---|------|
| 1-1 | Create `app_thread_messages` table + migration |
| 1-2 | Create `app_results` table + FTS5 shadow table + insert trigger (§5.6) |
| 1-3 | Add `POST /v1/apps/:appId/thread/send` (SSE) — scoped ChatSessionExecutor with app prompt |
| 1-4 | Add `GET /v1/apps/:appId/thread` — history endpoint |
| 1-5 | Build `AppThread` React component: message list + composer + message type renderers |
| 1-6 | Wire realtime: two-step subscription — `workflow(entryWorkflowId)` room on mount, then `run(runId)` room on RUN_CREATED (§5.4) |
| 1-7 | Progress card: live node label + progress bar from RUN_RUNNING / NODE_STARTED events |
| 1-8 | Register `bus.subscribe(RUN_COMPLETED)` in bootstrap → call `AppResultsService.materialize(runId)` → write `app_results` row(s); add `APP_THREAD_MESSAGE_APPENDED` to REALTIME_EVENTS |
| 1-9 | Result notification in Conversation: compact card with `summary` from `app_results`, links to hero |

### Phase 2 — Results Hero + Activity Feed (2–3 days)

| # | Task |
|---|------|
| 2-1 | Hero: query `app_results WHERE appId=? ORDER BY createdAt DESC LIMIT 1`, render at full fidelity |
| 2-2 | Activity Feed: query `app_results` for feed entries; ◀/▶ navigation via keyset pagination |
| 2-3 | [view] in feed promotes `app_results.content` to hero (no re-fetch — content already in row) |
| 2-4 | Running banner: detect active `workflow_runs` on load, show progress banner above hero |
| 2-5 | State C empty state: no `app_results` rows → hero empty state + pre-filled composer suggestion |
| 2-6 | Add `GET /v1/apps/:appId/results` + `GET /v1/apps/:appId/results/:resultId` endpoints |
| 2-7 | Build `ResultDetailPage` (`/apps/:slug/results/:resultId`): full-viewport renderer + header + prev/next nav |
| 2-8 | Slide-in transition: result detail slides over Output surface, back chevron restores scroll position |

### Phase 3 — App Thread Orchestrator Scoping (2 days)

> **Blocked on agent hierarchy architecture document.**
> §5.2 open question must be resolved before 3-1 is implemented.
> Tasks 3-2, 3-3, 3-4 are unblocked and can be parallelised with that work.

| # | Task | Status |
|---|------|--------|
| 3-1 | Build app-scoped system prompt (`appOrchestratorPrompt.ts`) — resolve agent identity from hierarchy | Blocked |
| 3-2 | Restrict tool catalog to App Thread tool subset (no workspace-level tools) | Unblocked |
| 3-3 | Wire entry workflow from `app_instances.entryWorkflowId` (direct column — not nested in `packageContents`) | Unblocked |
| 3-4 | Plain-language error cards: translate `RUN_FAILED` to operator-friendly message | Unblocked |

### Phase 4 — Checkpoint Cards in Thread (1 day)

| # | Task |
|---|------|
| 4-1 | Detect `APPROVAL_REQUESTED` in App Thread subscription |
| 4-2 | Render checkpoint card inline with Accept / Reject (or custom options from approval schema) |
| 4-3 | Call `agentis.approval.resolve` on operator action, update card state |

### Phase 5 — Deprecate Issues API (post-Phase 4)

| # | Task |
|---|------|
| 5-1 | Archive existing issue rows to run history (one-time migration) |
| 5-2 | Mark issues endpoints as deprecated in OpenAPI spec |
| 5-3 | Drop `issues` table and remove `IssueService` |

---

## Part IX — What Good Looks Like (Reference Mental Model)

> An operator opens their "Social Listening" app at 10:45 AM.
>
> The hero area shows the morning digest the app produced at 10:00 AM. It ran on schedule.
> Three brand mentions are flagged. One is urgent.
>
> The operator types in the thread: "Pull everything related to the Series B announcement from the last 48h."
>
> The app replies: "On it." A progress card appears — "Scanning Twitter, Reddit, LinkedIn" — and a counter ticks up.
>
> Two minutes later, the progress card becomes a result card. The operator reads 12 mentions, ranked by reach.
>
> They reply: "Send the top 5 to the #comms Slack channel."
>
> The app does it. A short confirmation appears in the thread.
>
> The operator closes the tab. They never touched a kanban column, never set a priority, never filed an issue.
> They talked to the app. The app worked.

---

## Part X — Surface Routing: App Thread vs `/chat`

### 10.1 The Problem

The plan defines the App Thread well but does not define what `/chat` becomes relative to it. At scale — dozens of apps, hundreds of agents — operators need a clear mental model for which surface to open. Without an explicit routing rule, they will try to use `/chat` for everything (wrong) or search for App Threads for platform-level questions (also wrong).

### 10.2 The Routing Rule

The distinction is **scope of intent**:

| Intent | Surface | Example |
|--------|---------|--------|
| Operate one specific app | App Thread | "Pull mentions from the last 72h" in Social Listening |
| Cross-app question or comparison | `/chat` | "How did all my apps perform this week?" |
| Build or modify workspace resources | `/chat` | "Create a new workflow for X", "Add an agent to Y" |
| Platform-level status | `/chat` | "What are all my apps doing right now?" |
| Ask about one app's output | App Thread | "What was the top mention in yesterday's digest?" |
| Direct an app to run something | App Thread | "Run a competitor analysis on the last 7 days" |

The rule stated simply: **if the operator's intent names or implies one specific app, they use that App Thread. Everything else goes to `/chat`.**

This maps naturally onto the agent hierarchy (§5.2): `/chat` is the workspace orchestrator surface — cross-app, platform-level, build operations. App Threads are where that same orchestrator (or a space manager) operates in the context of a single app.

### 10.3 The Handoff Mechanism

The workspace orchestrator at `/chat` is app-aware. When an operator types something clearly app-specific, the orchestrator routes them to the correct App Thread rather than answering from the workspace level:

> **Operator at `/chat`:** "What did Social Listening find today?"
> **Workspace orchestrator:** "That's in your Social Listening app — opening it now." → navigates UI to that app's Output surface, pre-fills the composer with the operator's original message.

This uses a new tool `agentis.app.thread.open` available only to the workspace orchestrator. The operator's message is carried over so they do not re-type it.

The App Thread orchestrator has no equivalent tool — it cannot navigate elsewhere. It is intentionally scoped in.

### 10.4 Cross-App Visibility from `/chat`

The workspace orchestrator at `/chat` has read access to all App Thread activity without needing to open individual threads.

> **Codebase note:** `agentis.apps.status` (registered in `chatToolCatalog.ts` + `environment.ts`) currently returns OpenClaw **gateway health** rows and live adapter health registrations — not per-app run status. The cross-app run overview shown below requires a separate tool `agentis.apps.run_status` that queries `app_instances` + recent `workflow_runs`. This tool does not yet exist; it is a Phase 3 addition to the tool catalog.

> **Operator:** "What are all my apps doing right now?"
> **Workspace orchestrator response (requires `agentis.apps.run_status`):**
> ```
> Social Listening:   Running now  · Daily digest · 60%
> Campaign Tracker:   Completed    · 2h ago · [view]
> Release Monitor:    Idle         · Last ran yesterday
> ```

The operator gets the fleet overview from `/chat` without opening each App Thread. This is the right architecture: `/chat` = situational awareness and build surface; App Thread = focused execution surface for one app.

### 10.5 Space Threads (V2 Extension)

In a large workspace with multiple spaces, a natural intermediate surface emerges: a **Space Thread** that covers all apps in a space. An operator managing a "Marketing ops" space might want to direct multiple apps together without switching between individual App Threads or going all the way to the workspace `/chat`.

This is not required for V1. It is a natural extension of the same routing pattern and should be considered when the agent hierarchy document is written. The architecture does not block it — the hierarchy (workspace orchestrator → space manager → app) already provides the conceptual slot for it.

---

## Related Documents

- [APP-EXPERIENCE-REPLAN.md](APP-EXPERIENCE-REPLAN.md) — D-10, D-11, D-13 remain valid; D-12 (issues kanban) is superseded by this document
- [APP-CANVAS-ARCHITECTURE.md](APP-CANVAS-ARCHITECTURE.md) — app shell, Output/Canvas/Brain layers
- [ORCHESTRATOR.md](../ORCHESTRATOR.md) — ChatSessionExecutor, AgentisToolRegistry, tool catalog
- [AGENTIS-UX-V2.md](../AGENTIS-UX-V2.md) — shell and navigation model
- [AGENTIS-APP-FORMAT.md](../AGENTIS-APP-FORMAT.md) — package model, entryWorkflowId, outputComponents
- **Agent hierarchy architecture** — to be written; unblocks §5.2 / Phase 3-1. Must define: workspace orchestrator, space managers, per-app agent roster, hierarchy editability via canvas, and how `/chat` relates to App Threads at scale.
