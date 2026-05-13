# Agentis — Definitive UI/UX Specification

> **Status:** CANONICAL — replaces UIUX.md, AGENTIS-UX-V2.md, and UIUX-REFACTOR.md entirely.
> **Scope:** Shell, navigation, home, chat & rooms, canvas, agents, artifacts, settings, design tokens.
> **Architecture integration:** This document is the UI/UX counterpart to CHAT-AGENT-LOOP.md. Every chat interaction described there has a corresponding UX spec here.
> **Date:** May 2026
>
> **Implementation progress (this branch):**
> - §23 Spaces: DB migration v25, full CRUD + `/summary` API, `agentis.space.summary` chat tool + executor, Sidebar SPACES section, AppsPage grouped view + inline create + move menu — **shipped**.
> - Follow-up UIUX batch: App Performance `outputLabels` stat bar, docked ChatPanel, Run Detail in-shell route, ContextInspector I/O redesign, streaming deltas + canvas embed UI, History merge, Settings Connections tab, Home Spaces view, and viewport `spaceId`/`spaceName` emission are implemented.
> - Built-in app catalog: 12 V1 `agentis` package manifests live under `packages/core/src/data/builtin-apps/` and are seeded idempotently for existing and newly-created workspaces.
> - Cleanup: dead `ConversationDock` and `MemoryPage` removed; `/teams` and `/teams/:id` redirect to `/apps`; `Artifacts` removed from primary nav (still reachable via deep link / palette).

---

## 0. The Platform North Star

Agentis is a mission-control surface for autonomous work. Not a collection of admin pages. The user should land anywhere and immediately answer four questions:

1. **What is running right now?**
2. **What needs my attention?**
3. **What can I safely do from here?**
4. **Where is the AI conversation attached to this work?**

The experience is sharp, dark, technical, and spatial. Dense enough for operators. Never cryptic. **Action-first** — every empty state, card, and modal makes the next useful action obvious. **Chat-first** — the chat is a durable object that follows the user everywhere, not a destination page.

### 0.1 The Foundational Hierarchy

```
┌──────────────────────────────────────────────────────────────────────┐
│  DIRECTOR LAYER  ← where the operator lives                          │
│  Home (command bar), Chat, Notifications, Artifacts                  │
├──────────────────────────────────────────────────────────────────────┤
│  CREW LAYER  ← where agents are managed                              │
│  Agents, Teams (sub-items), Workflows, Runs                          │
├──────────────────────────────────────────────────────────────────────┤
│  STAGE LAYER  ← foregrounded when active, accessible always          │
│  Canvas (live construction + execution), History, Settings           │
└──────────────────────────────────────────────────────────────────────┘
```

The canvas is not infrastructure. It is the **show** when an agent is building. When it is active it takes the foreground. When nothing is happening it recedes gracefully.

### 0.2 Vocabulary (Binding — used everywhere in copy)

| Concept | Display Term | Notes |
|---|---|---|
| Human using the platform | **operator** | Not "user" or "admin" |
| Workflow execution | **run** | Not "mission" |
| Agent output | **artifact** | HTML, image, doc, code, data |
| Deliverables library | **Artifacts** | Gallery, not a log |
| Saved config bundle | **Package** | Deployable to AgentisHub |
| Persistent chat space | **Room** | Multi-agent |
| 1:1 agent conversation | **Thread** | Direct, ephemeral or saved |
| Named sub-context | **Environment** | Not "ambient" in UI copy |
| Agent execution event trail | **History** | Not "ledger" |
| Self-hosted connection | **Connection** | Not "gateway" in UI copy |
| OpenClaw internal ref | Gateway | Backend/dev-facing only |
| Token / scratchpad | Internal | Never surfaces to operator |

---

## 1. Emergency Fixes (Track A — Status)

> [!NOTE]
> Items in this section were originally open defects. Status as of latest codebase review is noted per item.

### 1.1 Replace window.prompt() with RoomNameDialog — ✅ RESOLVED

`RoomView.tsx` previously used a native browser `window.prompt()` to name new rooms.

**Implemented:** `ChatPanel.tsx` now renders an inline `RoomNameDialog` — a fixed-position modal div with:
- Autofocused text input (`maxLength=80`)
- Keyboard: `Enter` to confirm, `Escape` to cancel
- No browser chrome
- `roomDialogOpen` state in `ChatPanel` drives visibility

### 1.2 Fix ChatPanel / ChatPage duplication — ✅ RESOLVED

When the side ChatPanel is open AND the user navigates to `/chat`, the same thread renders twice.

**Implemented:** `Shell` in `App.tsx` detects `location.pathname.startsWith('/chat')` and suppresses `<ChatPanel />` rendering when the full-screen chat page is active (App.tsx line 275).

### 1.3 Empty state in conversation threads

Empty/unanswered threads need honest empty states:

- Thread with 0 messages: `"Send a message to start a conversation with [agent name]."`
- Thread with outbound messages but no agent response: show a subtle `"[agent] hasn't responded yet"` below the last message, not silence.

### 1.4 Approval cards on Home need context

Approval card must always show: agent name + workflow/run name + approval summary text + `Approve` / `Reject` buttons.

### 1.5 MANUAL badge is confusing — ✅ RESOLVED

The `MANUAL` source badge has been removed from the codebase entirely (zero occurrences). Replace pattern:
- No badge for normal operator messages
- A small source label only when notable: `via Telegram`, `via Discord`, `via Workflow`

---

## 2. Shell Architecture

### 2.1 Three-Zone Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│  HEADER (48px)                                                         │
│  [● Agentis] / [workspace▾] / [team TEAM]    [🔔N]  [⌘K]  [T▾]       │
├─────────┬──────────────────────────────────────┬────────────────────── ┤
│         │                                      │                       │
│  RAIL   │  PRIMARY ZONE                        │  ARTIFACT PANEL       │
│  240px  │  (route content)                     │  (slides in,          │
│  labels │                                      │   360-480px,          │
│  56px   │                                      │   pinnable)           │
│  icons  │                                      │                       │
│  (resp) │                                      │                       │
│         │                                      │                       │
├─────────┴──────────────────────────────────────┴───────────────────────┤
│  LIVE STRIP (28px — visible only when runs are active)                 │
└────────────────────────────────────────────────────────────────────────┘
```

The three zones share a single CSS grid: `[rail] [main] [panel]`. All width transitions are CSS grid re-flows — no JavaScript animation for layout changes.

### 2.2 Header

```
[● Agentis]  /  [workspace ▾]  /  [team TEAM]          [🔔 N]  [⌘K]  [T▾]
     ↑                ↑                  ↑                ↑       ↑      ↑
  home link      workspace         active team        notif   search  avatar
                switcher          breadcrumb pill      bell    pill    menu
```

**Notification bell:** badge = `pending_approvals + failed_runs_last_hour + unread_room_mentions`. Opens an inline panel (not a new page). Shows max 5 items, each with one-click resolution. `[See all →]` navigates to a filtered History view.

**Avatar menu:**
```
[T]  Operator
     ─────────────────────
     🌙 Dark  /  ☀ Light
     ─────────────────────
     ⚙  Settings
     ↪  Sign out
```

**Team breadcrumb pill:** shows the active team context. Click → team switcher dropdown (switch team without switching workspace). Appears only when a team is active.

**Removed from header:** standalone logout icon. Moved to avatar menu only.

### 2.3 Navigation Rail

**4 primary destinations + Packages + Settings. Everything else is reachable via ⌘K or from within those destinations.**

> [!NOTE]
> **Implemented state:** The sidebar uses the target primary rail, Artifacts are removed from primary nav, and the SPACES section is backed by the `spaces` table. `/teams` and `/teams/:id` now redirect to `/apps`; the `teams` table remains only as the multi-agent coordination primitive.

**Nav structure (post-Spaces migration):**

```
●  Home
◎  Agents               badge: live count
✦  Workflows            badge: active run count
◈  Apps
▣  Packages
──────────────────────────────────────────────
  SPACES
  ├─ ● Marketing           3 apps
  ├─ ● Sales               2 apps
  └─ ● Operations          1 app
  [+ New Space]
──────────────────────────────────────────────
⚙  Settings
```

**Current nav structure (as-implemented):** matches the post-Spaces structure above. Artifacts remain reachable through Home, context links, deep links, and command palette, but are no longer a primary rail item.

**Implemented rules:**
- Sidebar defaults to **label mode** (240px) on desktop. Collapses to icon rail (56px) in session mode.
- No workspace block in the sidebar. Workspace is exclusively in the header.
- **Artifacts removed from primary rail** — accessible from context links, Home recently-built, ⌘K. See §8.4.
- **Teams accordion replaced by SPACES section**. localStorage key: `agentis.sidebar.spacesOpen`.
- No top-level items for: Goals, Memory, Scheduler, Routines, Approvals (→ bell), Ledger/Records (→ `/data`, ⌘K only), Artifacts (→ context links + ⌘K).

**SPACES sidebar section (implemented):**
- Appears below the separator, above Settings
- One row per Space: `[space-color-dot] [space name]  [app count]`
- Clicking a Space row navigates to `/apps?space=:spaceId`
- Section collapses/expands as a whole (localStorage key `agentis.sidebar.spacesOpen`)
- `[+ New Space]` at the bottom — inline input, type name + Enter to create
- When zero spaces exist: the SPACES section and its separator are hidden entirely

### 2.4 ChatPanel — The Persistent Brain Layer

The ChatPanel is **always mounted in `Shell`**, on every route. It is a persistent layer, not a page. It coexists with every surface.

**States (current implementation):**

| State | Width | Trigger | Status |
|---|---|---|---|
| `hidden` | 0 | Default on load, or on `/chat` route | ✅ Implemented |
| `open` | 360px fixed | User clicks Chat button in header | ✅ Implemented |
| `docked` | 480px, compresses main zone | User pins the panel | ✅ Implemented |

> [!NOTE]
> The side panel now supports a pinned wide mode persisted in `agentis.chatPanelDocked`. The `collapsed` state maps to the current `hidden` state — the `ChatPanelHeaderButton` provides the toggle.

**Panel contents:**
- Header: `Chat` label + session history button (clock icon) + close button
- Agent thread list (rooms, direct threads, broadcasts)
- Active thread view (when agent is selected)
- Composer (always visible at bottom when a thread is selected)
- Viewport awareness pill (when surface context is active — see §9)

**The Chat button in the header** (top-right, always visible) shows:
- Unread count badge (red dot)
- Typing shimmer when any agent is typing
- Pulsing amber ring when a pending approval exists

---

## 3. Route Map (Canonical)

```
/                           → redirect to /home
/home                       → Home (launcher + live activity)
/agents                     → Agents (fleet view)
/agents/:id                 → Agent detail
/workflows                  → Workflows list (live status)
/workflows/:id              → Canvas (construction + execution)
/runs/:id                   → Run detail
/history                    → Unified history (runs + activity)
/apps                       → Apps list
/apps/:slug                 → App detail (tabs: Performance / Intelligence / Data / Decisions / Workflows)
/artifacts                  → Artifacts gallery
/artifacts/:id              → (redirect → /artifacts?open=:id)
/packages                   → Packages
/skills                     → Skills
/chat                       → Full-screen chat (ChatPanel suppressed)
/chat/agent/:agentId        → Full-screen chat, agent pre-selected
/data                       → Ledger / structured records (⌘K or power-user link only)
/settings                   → Settings (tabs: Profile / Workspace / Connections / Security)
/workspaces                 → Workspace switcher page (header dropdown → manage)
```

**Routes removed from App.tsx (verified):** `/fleet`, `/conversations`, `/approvals`, `/inbox`, `/activity`, `/runs` (list), `/gateways`, `/settings/channels` — none of these are in the current `App.tsx`.

**Routes migrated from legacy structure:**

> [!NOTE]
> - `/teams` → redirects to `/apps`
> - `/teams/:id` → redirects to `/apps`
> - `/ledger` is mapped to `/data` in `App.tsx` (`LedgerPage` serves at `/data`)

**Legacy files still present by design / embedding:**
- `GatewaysPage.tsx` — embedded in Settings/Connections flows (no standalone route)
- `SettingsChannelsPage.tsx` — embedded in Settings/Connections flows (no standalone route)
- `ConversationDock.tsx` — removed
- `MemoryPage.tsx` — removed

---

## 4. Home Page — Launcher + Ops View

### 4.1 Two Layout States

| State | When | What the operator sees |
|---|---|---|
| **Launcher** | `/home` on arrival | Centered command bar, greeting, chips, activity below fold |
| **Session** | After sending a first message | Expanded thread, sidebar narrows, artifact panel slot ready |

The transition is animated (not a route change): greeting fades up, command bar anchors to bottom, thread area grows upward. URL updates via `history.pushState` to `/chat/:sessionId` without a reload.

### 4.2 Launcher Layout

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│                                                                  │
│               Good morning, Thomas.                              │
│               Your fleet is ready.                               │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ [💬 General ▾] │  Ask thomas to write the weekly...  [→] │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  [chip: Review thomas's request]  [chip: Ask team for update]    │
│                                                                  │
│  ──────────── scroll for current activity ───────────────        │
│                                                                  │
│  ▶ Lead Enrichment · step 3/6 · thomas ●M      [View]           │
│  ⚠ Approval needed from thomas                 [Review]         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Greeting variants:** "Your fleet is ready." / "2 agents are working." / "thomas needs your attention." / "3 things built today."

### 4.3 The Universal Command Bar

The most important UI element on the platform. It is the operator's primary control surface.

```
┌──────────────────────────────────────────────────────────────────────┐
│  [💬 General ▾]  │  Ask thomas to write the weekly newsletter...  [→]│
└──────────────────────────────────────────────────────────────────────┘
       ↑                         ↑                                   ↑
  Recipient selector         Free input                           Send
  (last used, defaults        (text, /, @, #,                    button
   to General)                 URL paste, drop)
```

**Animated typewriter placeholder:** never static. Cycles through platform-specific phrases at ~40ms/char, pauses 2.5s, fades, repeats. Two layers:

- **Layer 1 (workspace-aware, slots 1–3):** pulls from live agent names and workflows: `"Ask @thomas to write the weekly newsletter..."`, `"Run the Content Pipeline workflow again..."`
- **Layer 2 (fallback, slots 4–6):** platform feature discovery: `"Build a workflow that posts to LinkedIn every Monday..."`, `"Schedule the newsletter workflow for every Friday at 9am..."`

On user keydown → placeholder disappears immediately.

**Recipient selector pill:**
- Clicking opens a picker with: Rooms (General, team rooms, custom rooms), Direct to agent (with team badges), Broadcast (All agents, team broadcasts)
- Inline routing shortcuts: type `@thomas` → recipient snaps to thomas's thread. Type `#marketing` → snaps to Marketing room. Delete the trigger → reverts.

**Input capabilities:**
- `/` → slash command autocomplete (categorized: Agent, Workflow, Approval, Info)
- `@name` → @mention agent (different from recipient selector — this is an inline ref)
- `#resource` → attach workflow or run as chip
- URL paste → below-bar suggestion row: `"Research / Analyze / Import"`
- File/image drop → `"What should I do with this?"` with agent suggestions
- `↑` → cycle last 5 sent messages (command history)
- `Enter` = send, `Shift+Enter` = newline, `Escape` = dismiss suggestions

### 4.4 Contextual Suggestion Chips

Dynamically computed from workspace state on mount + on relevant realtime events. Max 4 chips. Priority:

| Priority | Condition | Chip label |
|---|---|---|
| 1 | `pendingApprovals.length > 0` | "Review [agent]'s request" |
| 2 | `activeRuns.length > 0` | "Ask [agent] for a status update" |
| 3 | `recentArtifacts[0]` exists | "Improve '[artifact title]'" |
| 4 | `recentArtifacts.length > 0` | "Run '[workflow]' again" |
| 5 | Cold start (no runs, < 1d old) | "Create your first workflow" |
| 6 | No agents | "Set up an agent" |

Chips are dismissible (localStorage, 24h). They are hints, not a menu.

### 4.5 Below-Fold Activity (Scroll Content)

**Running Now:** Each active run is a compact card. Shows: workflow name + status glow, stacked agent avatars with team badges, current step text (typewriter as steps change), `[View]` link to canvas. If agent is building a workflow: card upgrades to include mini canvas embed inline.

**Needs Attention:** Inline items (not a table): pending approvals with `[Approve]` `[Reject]` that fire API in place + failed runs with `[Retry]`. Max 3 items, `"View all →"` to notification bell panel.

**Recently Built:** 3-column artifact thumbnail grid, last 6. `"View all →"` to `/artifacts`.

---

## 5. Chat & Rooms — The Platform Brain

### 5.1 The Principle

Every meaningful platform action must be possible from chat. Not as a workaround — as the primary path. Chat replaces: manual workflow triggers, approval modals, status dashboards, fleet broadcast emails.

### 5.2 Room Types

| Type | Created by | Agents | Persistence | Data model |
|---|---|---|---|---|
| `workspace` | System (1 per workspace — "General") | All agents | Always | `rooms` table |
| `team` | Auto on team creation | Team agents auto-added/removed | Always | `rooms` table, `teamId` FK |
| `custom` | Operator | Manually selected | Always | `rooms` table |
| `thread` | `rooms` schema value; not auto-created from direct messages | N/A | N/A | `rooms` table |

> [!NOTE]
> Direct 1:1 agent conversations ("Thread" in UX copy) use the **`conversations` + `conversationMessages`** tables, not the `rooms` table. The `rooms` table `kind='thread'` value exists in the schema but is not currently wired to direct-message creation. `ThreadView` in `ChatPanel` reads from `/v1/conversations/:agentId`, not `/v1/rooms`.

**Team room auto-creation rule:** creating a team creates its room. Adding/removing an agent from a team updates `room_agents` for that team's default room. This is a backend invariant — the UI never has to create rooms manually.

### 5.3 Chat Panel — Panel-State UX

**Thread list view (rooms + direct threads):**

```
┌────────────────────────────────────────────────────┐
│  Chat                          [🕐 history]  [×]  │
├────────────────────────────────────────────────────┤
│  Rooms & Threads                      [+ New room] │
│                                                    │
│  ● MARKETING                              0        │
│    💬 marketing    AUTO                            │
│       Default room for marketing                   │
│                                                    │
│  ● ENGINEERS                              0        │
│    💬 engineers    AUTO                            │
│                                                    │
│  GENERAL                                           │
│    # General   workspace                           │
│                                                    │
│  DIRECT THREADS                                    │
│    ● thomas    Offline  ·  last message preview    │
│    ● shoulder  Offline                             │
│                                                    │
│  📢 Fleet broadcast                                │
│     One message to every live agent                │
└────────────────────────────────────────────────────┘
```

**"New room" button**: opens an inline `RoomNameDialog` (not `window.prompt()`). A small in-panel modal with a single text input and `Create` / `Cancel` buttons.

**Thread view:**

```
┌────────────────────────────────────────────────────┐
│  ← Back   ● thomas                    [options]   │
│  Agentis direct thread                             │
├────────────────────────────────────────────────────┤
│                                                    │
│  [viewport awareness pill, if active]              │
│  [ Viewing: Lead Enrichment canvas · RUNNING ] ×  │
│                                                    │
│                            hi        4:27 PM       │
│                                                    │
│  [thinking]                                        │
│  I'll check the workflow status...     streaming   │
│                                                    │
│  ●●● thomas is typing                              │
│                                                    │
│  [tool_result card — collapsed]                    │
│  ▶ agentis.workflow.status    0.3ms    [expand]   │
│                                                    │
│              The Lead Enrichment run is            │
│              60% done — email_node is              │
│              currently processing.                 │
│                                                    │
├────────────────────────────────────────────────────┤
│  Message · / for commands · @ for agents · # refs  │
│                                              [→]  │
└────────────────────────────────────────────────────┘
```

### 5.4 Streaming Deltas Rendering (CRITICAL — not in any previous doc)

When the agentic loop is active, the thread renders `ChatDelta` events progressively. This is NOT the same as existing simple message rendering:

| Delta type | How it renders |
|---|---|
| `thinking` | Italic muted text, slightly indented: `"I'll check the workflow status first..."` — collapses when a text delta follows |
| `text` | Streams character by character into the current assistant bubble (blinking cursor during stream) |
| `tool_call` | A pill appears immediately: `▶ agentis.workflow.status  ●  running` — spinner inside |
| `tool_result` | Pill updates: `▶ agentis.workflow.status  ✓  0.3ms  [expand]` — collapsible. Default collapsed. |
| `tool_result` (error) | Pill: `▶ agentis.workflow.status  ✕  error` — red, always expanded with error message |
| `done` (max_turns) | Warning bar: `"Reached maximum tool calls. Showing partial result."` |
| `done` (error) | Error bar with retry button |

**Tool result expand:** clicking `[expand]` on a tool result shows a `<pre>` JSON block of the returned data. This is the operator's debuggability surface — not a modal, not a new page, inline in the thread.

**Parallel tool calls:** if the orchestrator fires multiple tools in one turn, the pills stack vertically and all animate the spinner simultaneously. They resolve independently as results arrive.

### 5.5 The Orchestrator Agent (Distinct from Regular Agents)

The orchestrator agent is a special agent that has:
- Full platform tool catalog (not just workflow skills)
- Viewport awareness (§9)
- The `agentis.` tool namespace

**Visual distinction in the thread list:** the orchestrator agent's thread is pinned at the top of "Direct Threads" and carries a `◎ Orchestrator` label rather than just the agent name. A small platform-badge icon (the Agentis logo dot) appears next to its avatar.

**The operator should never need to know the orchestrator is "different" architecturally.** From their perspective it is just the smartest agent — the one that knows everything about the platform.

### 5.6 Composer Slash Commands

| Command | Effect |
|---|---|
| `/run [workflow name]` | Start a workflow run; shows confirmation before firing |
| `/pause @agent` | Pause a specific agent |
| `/wake @agent` | Wake a paused agent |
| `/approve` | Approve the most recent pending approval |
| `/history` | Fetch last 5 run results as inline card stack |
| `/status` | Summary of all agents (live/paused/offline counts) |
| `/help` | List available commands |

Typing `/` shows a categorized autocomplete popover above the bar: Agent, Workflow, Approval, Info. Keyboard navigable. Closes on Escape or trigger deletion.

### 5.7 Session History Panel

Accessible from the clock icon in the ChatPanel header. Slides in over the thread list.

```
┌──────────────────────────────────────────────────┐
│  ← Back     Session History           [🔍]       │
├──────────────────────────────────────────────────┤
│  [All] [Thread] [Room] [Broadcast] [Run]         │
│  [Any team ▾]                                    │
├──────────────────────────────────────────────────┤
│  Today                                           │
│  ● thomas ●M  "Write Q2 landing page"   2:14pm  │
│    3 artifacts · 1 approval · run        [Resume]│
│                                                  │
│  💬 Marketing ●M  Team session         11:02am  │
│    thomas · shoulder · 2 artifacts       [Open]  │
│                                                  │
│  Yesterday                                       │
│  ● shoulder ●M  "Q2 market research"   3:41pm   │
│    1 artifact · 40 searches              [Open]  │
│                                                  │
│  📢 Broadcast  Fleet status check       9:00am  │
│    3 responses                    [View responses]│
│                                                  │
│  ▶ Workflow run ec8ff114  COMPLETED     5/5       │
│    0 artifacts                           [Open]  │
└──────────────────────────────────────────────────┘
```

**Session History is NOT the same as HistoryPage.** Session History = communication record (who, what was built). HistoryPage (`/history`) = execution record (what the engine ran).

---

## 6. Canvas — The 10x Moment

The canvas is the spectacle of the platform. When an agent builds a workflow live, this is the moment that converts. Every design decision protects and amplifies this.

### 6.1 What Is Wrong Right Now

- No agent presence during construction (live overlay only applies to execution)
- Node palette is a primitive side drawer
- Chat and canvas are completely separate — the canvas does not stream into chat, chat cannot reach the canvas
- Nodes are small uniform rectangles with no visual hierarchy
- Errors require opening a separate run detail page
- React Flow edge warnings: `"Couldn't create edge for source handle id: null"` — broken handles

### 6.2 Agent-Assisted Creation (The Killer Feature)

When the canvas is empty, a chat input lives **inside** the canvas:

```
┌───────────────────────────────────────────────────────────┐
│  [toolbar]  Workflow: Untitled         [save] [test run]  │
├───────────────────────────────────────────────────────────┤
│                                                           │
│            Describe what this workflow should do          │
│            and your agent will build it for you.         │
│                                                           │
│   ┌─────────────────────────────────────────────────┐    │
│   │  Monitor Hacker News and email me a digest at 9am│   │
│   └─────────────────────────────────────────────────┘    │
│                                               [→ Build]   │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

**On send:**
1. Input minimizes to a `"Chat with agent"` button at canvas bottom
2. Agent builds: nodes appear one-by-one with a `placing...` animation
3. Floating build log at bottom-left:
   ```
   ◈ thomas is building...
   ✓ Added daily cron trigger
   ✓ Added HTTP fetch node
   ⟳ Adding AI summarizer...
   ```
4. On `CANVAS_BUILD_COMPLETE`: `"Done! Here's what I built — want to test it?"` + prominent `[Test run]` button

### 6.3 Live Canvas in Chat Thread

When an agent builds a workflow triggered from chat, a mini canvas embed appears inside the chat thread:

```
┌───────────────────────────────────────────────────────┐
│ ░ Building workflow — live                            │
│                                                       │
│  [Trigger] ──→ [Web Search] ──→ [Summarize]          │
│     ✓              ▌ placing...       ○               │
│                                                       │
│  3 of 6 nodes placed                                  │
│  thomas is adding a web search node...                │
└───────────────────────────────────────────────────────┘
```

On `CANVAS_BUILD_COMPLETE`: embed freezes, a `[Run now]` and `[View full canvas →]` CTA appear.

**Technical:** subscribe to `CANVAS_NODE_PLACED`, `CANVAS_EDGE_CONNECTED`, `CANVAS_BUILD_COMPLETE` in `ThreadView`, filtered by the runId that spawned the thread. Mini React Flow instance, read-only, no handles.

### 6.4 Node Visual Language

| Node type | Shape | Color accent | Icon |
|---|---|---|---|
| Trigger | Pill / rounded | Indigo | Source-specific icon |
| Action | Rectangle | Neutral dark | Bold action icon |
| Condition / Router | Angled / diamond | Amber | Branch icon |
| Skill / AI | Rectangle | Purple | ✦ glyph |
| Agent | Avatar-style | Agent color | Agent initial |

Node size is proportional to complexity. Triggers are entry points — they should look like one. Deep-config nodes should look deeper.

### 6.5 Execution Overlay (Enhanced)

- Each node shows a progress indicator while running (not just a "running" color)
- Completed nodes show the output value as a small chip below (truncated 80 chars)
- Failed nodes show the error summary **inline** — no page navigation for common errors
- Edges show data flowing as a moving-dot animation
- Timeline at top: total duration + where time was spent per node
- "Run inspector" is a split panel **below** the canvas, not a separate page

### 6.6 Inline Error Recovery

1. Failed node highlighted — error chip appears inline
2. `"Fix with agent"` button next to the error chip
3. Click → opens chat thread with the canvas agent, pre-loaded with error context
4. Agent suggests fix → one-click apply → node updates on canvas

### 6.7 Canvas Toolbar

```
[workflow title — editable inline]                    [← back to Workflows]

Left:   [⟲ undo]  [⟳ redo]
Right:  [Variables]  [⟳ Test run]  [▶ Publish]  [Saved ·]
```

Auto-save every 30s. `"Saved"` in muted text; dot indicator only when unsaved changes exist.

### 6.8 Smart Node Palette

Clicking `+` (center of canvas or after last node) opens a smart popover:

```
┌──────────────────────────────┐
│  Add a step                  │
│  🔍 Search nodes...          │
├──────────────────────────────┤
│  Suggested                   │
│   ⟳ HTTP request             │
│   ✦ Ask AI                   │
│   📧 Send email               │
├──────────────────────────────┤
│  Triggers / Actions /        │
│  Conditions / Skills (N)     │
└──────────────────────────────┘
```

"Suggested" is context-aware: if last node was HTTP fetch, suggest "Parse JSON", "Condition", "Summarize with AI".

### 6.9 Workflows List Page (Live Status)

```
┌──────────────────────────────────────────────────────────┐
│  Workflows                              [+ New workflow] │
├──────────────────────────────────────────────────────────┤
│  [All] [Active] [Scheduled] [Draft] [Broken]  [search]  │
├──────────────────────────────────────────────────────────┤
│  ▶ Lead Enrichment   ⟳ Running · step 3/6  · 1m 14s    │
│    Webhook           Last: success 2h ago      [open]   │
│                                                          │
│  ● Daily briefing    Idle · next run at 09:00           │
│    Cron              Last: success 6h ago      [open]   │
│                                                          │
│  ✕ Weekly digest     Failed · step 2 yesterday          │
│    Cron              Last: failed 22h ago      [retry]  │
│                                                          │
│  ○ Draft: Slack notifier  Not published                 │
│                           Created 3d ago       [open]   │
└──────────────────────────────────────────────────────────┘
```

Status is the first thing visible. Last run result is inline. `[retry]` fires without opening canvas. The "Broken" filter tab = one click to find everything failing.

### 6.10 Canvas Tabs

When a user opens a second workflow while one is open: a tab bar appears:

```
[Lead Enrichment ×]  [Daily briefing ● ×]  [+]
```

Tab state (scroll, selected node, inspector) is preserved per tab in Zustand, keyed by workflowId. Max 5 tabs. Stored in `sessionStorage`. Dot = unsaved changes.

---

## 7. Live Strip (Always On When Runs Are Active)

The `LiveStrip` is a persistent bottom bar visible on every page — not just the canvas.

```
┌──────────────────────────────────────────────────────────┐
│  ▶ Lead Enrichment  step 3/6  ██████░░░░  1m 12s  [view]│
│  ▶ Daily briefing   step 1/3  ████░░░░░░  0m 22s  [view]│
└──────────────────────────────────────────────────────────┘
```

- Collapses to zero height when no runs are active
- Max 3 items, `"+ 2 more"` chip if more are running
- `[view]` → canvas with live overlay
- Powered by existing `RUN_RUNNING/COMPLETED/FAILED` realtime events

---

## 8. Artifact System

### 8.1 Artifact Reveal — Zero Navigation

When a `response` node completes a run with artifact output:
1. `RUN_COMPLETED` event fires
2. Artifact panel **slides in automatically** (no click required) at 360px floating
3. Artifact renders at full fidelity
4. Chat thread updates with a completion card

The artifact appears. The user does nothing. This must feel instantaneous.

### 8.2 Artifact Panel States

| State | Width | Trigger |
|---|---|---|
| `closed` | 0 | Default |
| `floating` | 360px | `RUN_COMPLETED` with artifact output |
| `docked` | 480px, compresses main | User pins the panel |
| `fullscreen` | Full viewport | User clicks ⤢ |

### 8.3 Panel Structure

```
┌────────────────────────────────────────────────────────────────────┐
│  [← Artifacts]  Q2 Landing Page              [⊞ Dock]  [⤢]  [×] │
│  ───────────────────────────────────────────────────────────────── │
│  [Iterate]  [Store]  [Download ↓]  [Share ↗]  ···                 │
│  ───────────────────────────────────────────────────────────────── │
│                                                                    │
│  HTML   → <iframe sandbox="allow-scripts allow-forms" srcdoc>     │
│           inside a browser chrome mock                             │
│  Image  → <img> with scroll-to-zoom                               │
│  Doc    → rendered markdown with floating outline                  │
│  Code   → syntax-highlighted + copy + run buttons                  │
│  Data   → responsive table + CSV/JSON export                       │
│                                                                    │
│  ▾ Source: thomas · Lead Enrichment · 2h ago                      │
│    [View workflow →]  [View run →]                                 │
│                                                                    │
│  ▾ Versions  v3 (current) · v2 yesterday · v1 3 days ago          │
└────────────────────────────────────────────────────────────────────┘
```

**Toolbar actions:**
- **Iterate:** opens composer pre-filled with `"Improve this: [title]"` + artifact context
- **Store:** persists to artifacts table
- **Download:** file by type (`.html`, `.md`, etc.)
- **Share:** copies `/artifacts/:id` deep link
- **`···`:** Rename, Duplicate, Delete

**Security:** HTML artifacts render in sandboxed iframe (`sandbox="allow-scripts allow-forms"`, no `allow-same-origin`). Served from separate origin or data URI.

**Canvas mode:** when the panel is in canvas-build mode (during construction), toolbar becomes `[▶ Run now]  [✎ Edit]  [View full canvas →]`.

### 8.4 Artifacts Page (`/artifacts`)

Gallery-first. 3-column thumbnail grid. Filter tabs: All / HTML / Images / Docs / Code / Data. Sort by date, agent.

Card `[Open]` → artifact in panel. Card `[···]` → Rename, Duplicate, Link, Download, Delete.

**Narrowed role:** The Artifacts page is a cross-app, cross-workflow output search and retrieval surface. Use it when you want "all HTML reports from the last month" regardless of which app produced them. The **primary consumption view for a specific app's outputs is the App Performance tab** (`/apps/:slug` → Performance). The global Artifacts page is the power-user escape hatch, not the default destination for reviewing results.

---

## 9. Full-Application Awareness (Viewport Context)

The ChatPanel is always mounted in `Shell` on every route. The orchestrator agent knows what the user is looking at. This is not optional — it is the core promise of "chat as platform brain."

### 9.1 ViewportContext Signal

The frontend emits a `viewport_context` socket event on every meaningful route change or selection:

```typescript
// Every page/surface emits this on relevant state changes
socket.emit('viewport_context', {
  surface: 'canvas',
  workflowId: 'wf_abc',
  workflowName: 'Lead Enrichment',
  selectedNodeId: 'email_node',
  selectedNodeKind: 'skill',
  activeRunId: 'run_9f3a2b',
  activeRunStatus: 'RUNNING'
})
```

The API stores this in a per-user in-memory map. `ChatSessionExecutor.turn()` reads it and injects as a system context block on every turn.

| Surface | Signals emitted |
|---|---|
| `/home` | surface: home, active run count, pending approvals count |
| `/workflows/:id` | surface: canvas, workflowId, workflowName, selectedNodeId, selectedNodeKind, activeRunId, activeRunStatus |
| `/runs/:id` | surface: run_detail, runId, runWorkflowName, runStatus |
| `/agents/:id` | surface: agent_detail, agentId, agentName |
| `/apps/:slug` | surface: app_detail, appSlug, appName |
| `/history` | surface: history |
| `/skills` | surface: skills |
| `/chat` | surface: chat |

### 9.2 Awareness Pill (UI Surface)

When viewport context is active, the Composer shows a subtle pill above the input:

```
[ Viewing: Lead Enrichment canvas · run_9f3a2b running ]  ×
```

Clicking `×` clears the viewport injection for that turn only. The pill disappears after the turn completes.

This is the **only UI element** for this feature. No other chrome needed.

### 9.3 Context-Sensitive Placeholder Text

The Composer placeholder text changes per surface:

| Surface | Placeholder |
|---|---|
| Canvas (with active run) | `"Ask why this run is slow..."` |
| Canvas (FAILED run) | `"Ask what went wrong..."` |
| Run detail | `"Ask about this run..."` |
| Agent detail | `"Ask or command this agent..."` |
| Approvals | `"Ask about this approval..."` |
| Home | `"What do you need done?"` |

---

## 10. Home Page — Ops View (Below Fold)

Scroll content below the command bar. Three blocks in order of urgency:

### 10.1 Needs Attention

- Pending approvals: agent name + summary text + `[Approve]` `[Reject]` (inline, no navigation)
- Failed runs: workflow name + failed node + `[Retry]`
- Max 3, `"View all →"` to bell panel
- **Critical requirement:** approval cards always show context. No bare Approve/Reject buttons without a summary.

### 10.2 Live Right Now

Each active run card:
- Workflow name + green status pulse
- Stacked agent avatars with team color rings
- Current step text (updates via `AGENT_WORK_STEP`, typewriter)
- `[View]` → canvas with live overlay
- If run is building a workflow: upgrades to mini canvas embed inline

### 10.3 Recently Built

3-column artifact grid, last 6 artifacts. If empty: `"Your agents haven't built anything yet. Try asking one to create something."` with a `[Ask an agent]` CTA — never just gray text.

---

## 11. Agents Page

### 11.1 Two View Modes

Single `/agents` page with grid / table toggle. Right-panel detail slides in when an agent is selected.

**Grid card per agent:**
- Name + team color avatar + team badges
- Status: `Running / Idle / Needs attention / Offline`
- Current task or last task (truncated, live via Socket.IO)
- If running: step progress

**Detail panel (slide in from right):**
- Status, last seen
- Current task
- Recent 3 messages
- Active workflows using this agent
- Actions: `[Talk to agent]` `[Edit]` `[Pause]` `[Wake]` `[Delete]`

### 11.2 Agent Detail Page (`/agents/:id`)

Tabs: Overview / Conversations / Runs / Settings

Settings tab includes: connection type, adapter config, system prompt, description. Gateways ("Connections") are configured here, not as a top-level page.

---

## 12. Settings — One Page, Tabs

```
/settings
  ├─ Profile        — display name, password
  ├─ Workspace      — name, slug, danger zone
  ├─ Connections    — OpenClaw gateways + Telegram/Discord/Slack channel connections
  └─ Security       — API keys, JWT settings
```

**Gateways move from sidebar to Settings > Connections.** Channel integrations move from `/settings/channels` into the same tab. One place for all connections.

---

## 13. History Page — Unified

```
/history

[All] [Workflow runs] [Agent activity] [Audit trail]
[search] [date range] [status] [agent ▾]

May 5, 2026
├─ 11:42  ◈ thomas  completed "Research task"           [view]
├─ 11:30  ⟳ Lead Enrichment  run completed              [view]
├─ 11:15  ◈ thomas  sent approval request               [view]
└─ 09:02  ⟳ Weekly digest  failed on step 3            [retry]

May 4, 2026
└─ ...
```

Clicking any event opens a detail panel on the right. `/runs/:id` route remains for direct linking.

**This page merges:** `RunHistoryPage`, `LedgerPage`, `ActivityPage`. Three views of the same data through filter tabs, not three separate routes.

---

## 14. Empty States (Every Surface)

No surface renders plain muted text as an empty state. Every empty state has:
1. A clear label of what is missing
2. A concrete CTA button for the most likely next action

| Surface | Empty state copy | CTA |
|---|---|---|
| Workflows list | "No workflows yet." | `[+ New workflow]` |
| Canvas (empty) | "Describe what this workflow should do..." | In-canvas chat input |
| Agents page | "No agents in this workspace." | `[+ Add agent]` |
| Artifacts | "Your agents haven't built anything yet." | `[Ask an agent]` |
| Apps list | "No apps installed yet. Install one from Packages to get started." | `[Browse Packages]` |
| App Performance (no runs in window) | "No runs in this period. The app hasn't been triggered yet." | `[Run now]` (only if `entryWorkflowId` present) |
| App Performance (no outputLabels) | Shows success rate + run count + cost only, no custom metrics. Inline tip: "Add output labels in the Workflows tab to track business metrics." | (no CTA — the data still shows) |
| Thread (no messages) | "Send a message to start a conversation with [agent]." | (Composer focus) |
| Thread (unanswered) | "[agent] hasn't responded yet." | (Subtle, below last message) |
| History | "No runs yet. Workflows you run will appear here." | `[View workflows]` |
| Needs Attention | "Nothing needs your attention right now." | (No CTA — this is the good state) |
| Gateways (Connections) | "No connections. Connect an OpenClaw gateway to bring agents online." | `[+ Add connection]` |

---

## 15. Loading & Skeleton States

Every data-fetching surface renders a skeleton, not a blank space or a spinner centered on the page.

| Component | Skeleton |
|---|---|
| Thread message list | 3-4 message-shaped rectangles at varying widths |
| Agent card grid | Gray card outlines with avatar circle and 2-line text blocks |
| Workflow list | 4 rows of gray lines: status dot + title + action |
| Artifact gallery | 3 card outlines with thumbnail rectangle |
| Canvas | Gray node shapes at approximate positions (use last known graph if cached) |
| Run detail | Timeline skeleton: 5 rows of dot + title + progress bar |

Skeleton duration: 150ms minimum before showing (prevents flash on fast loads). Transition: fade-in over 100ms.

---

## 16. Design Tokens

### 16.1 Colors

| Token | Value | Role |
|---|---|---|
| `--color-canvas` | `#0d0f11` | App background, canvas background |
| `--color-surface` | `#161a1f` | Card backgrounds, panels |
| `--color-surface-2` | `#1e2329` | Input backgrounds, secondary cards |
| `--color-line` | `#2a2f37` | Borders, dividers |
| `--color-text-primary` | `#e8ecf0` | Primary text |
| `--color-text-muted` | `#6b7685` | Secondary, labels, metadata |
| `--color-text-disabled` | `#3d4550` | Disabled states |
| `--color-accent` | `#4ade80` | Active states, the green dot, live indicators |
| `--color-accent-hover` | `#22c55e` | Hover on accent elements |
| `--color-warning` | `#f59e0b` | Attention items, pending approvals badge |
| `--color-error` | `#ef4444` | Failed states, error text |
| `--color-info` | `#60a5fa` | Informational, neutral status |

**Team colors (6 slots, reused by rotation):**
`#f97316` (orange) · `#3b82f6` (blue) · `#a855f7` (purple) · `#14b8a6` (teal) · `#f43f5e` (rose) · `#84cc16` (lime)

**Rule: no glass-morphism.** `backdrop-filter: blur()` incurs GPU compositing cost on every repaint. Use solid dark layered surfaces with border contrast for depth. Zero GPU cost, same visual hierarchy.

### 16.2 Typography

| Scale | Size | Weight | Line height | Usage |
|---|---|---|---|---|
| display | 28px | 600 | 1.2 | Page titles |
| heading | 18px | 600 | 1.3 | Section headings |
| subheading | 14px | 500 | 1.4 | Card titles, labels |
| body | 14px | 400 | 1.5 | Default text |
| caption | 12px | 400 | 1.4 | Timestamps, metadata, badges |
| code | 13px mono | 400 | 1.5 | Code, IDs, technical values |

Font family: system-ui, -apple-system, "Segoe UI", sans-serif. Monospace: "JetBrains Mono", "Fira Code", monospace.

### 16.3 Spacing

Base unit: 4px. Scale: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64.

### 16.4 Shapes

| Element | Border radius |
|---|---|
| Cards | 8px |
| Inputs | 6px |
| Buttons | 6px |
| Pill badges | 9999px |
| Modal | 10px |
| Tool call pill | 6px |
| Avatar | 50% (circle) |

### 16.5 Animation System

All animations use CSS transitions or Motion One (`@motionone/dom` — 2KB). No Framer Motion (31KB).

| Animation | Duration | Easing |
|---|---|---|
| Panel slide in/out | 250ms | ease-out |
| Sidebar width | 300ms | ease-in-out |
| Modal open | 180ms | ease-out (scale 0.96 → 1 + fade) |
| Skeleton fade | 100ms | ease |
| Session launcher → session | 300ms | ease-in-out |
| Tool call pill appear | 120ms | ease-out |
| Live strip show/hide | 200ms | ease |
| Notification dot pulse | 1.5s | ease-in-out (loop) |

**For agent presence overlays (up to 20 events/second):** use `useRef` + `element.style.transform` via `requestAnimationFrame` — never route through React state. This keeps overlay updates off the reconciler and compositor-only.

### 16.6 Icon System

Icon set: `lucide-react` exclusively. No custom SVG icons, no mixed icon sets. Size: 16px for inline (body text level), 18px for nav rail, 20px for action buttons, 24px for empty states.

---

## 17. Mobile / Responsive Breakpoints

The platform is primarily desktop. But the ChatPanel must be usable on tablet (768px+) and the home page must not break on narrow viewports.

| Breakpoint | Behavior |
|---|---|
| `>= 1280px` | Full three-zone layout: rail (240px) + main + panel |
| `>= 1024px` | Rail collapses to icon-only (56px). Panel floats over main. |
| `>= 768px` | Rail hidden (burger menu). ChatPanel as full-screen modal. |
| `< 768px` | Not supported for full app. `/chat/:deploymentId` (public deployment) works at any width. |

---

## 18. Proactive Agent Messages

When an agent has something to surface proactively, it sends a structured card — not a plain text message:

```
┌──────────────────────────────────────────────────────┐
│ ◈ thomas  ·  11:42am                                 │
│                                                      │
│ I monitored Hacker News for 6 hours and found       │
│ 3 posts relevant to your distributed systems focus.  │
│                                                      │
│ · "Why CRDTs won"  (342 points)                     │
│ · "Raft consensus explained"  (211 points)           │
│ · "Postgres logical replication"  (198 points)       │
│                                                      │
│ [Yes, compile summary]  [Not now]  [Don't track this]│
└──────────────────────────────────────────────────────┘
```

Action buttons map to server-side action registry entries — they fire API calls directly. The operator never has to type a response to structured prompts.

**Infrastructure required:** `AGENT_PROACTIVE_PUSH` realtime event from backend, structured message schema on `Message` interface (extends existing), action registry (`{action, agentId, params}`).

---

## 19. Removed Files / Cleanup Checklist

Legend: ✅ Complete · ⏳ File exists but not routed (dead code) · ❌ Not done

| File | Route | Action | Status |
|---|---|---|---|
| `IssuesPage.tsx` | `/issues` | Delete file + App.tsx route | ✅ Not in App.tsx |
| `BudgetsPage.tsx` | `/budgets` | Delete file + route | ✅ Not in App.tsx |
| `FilesPage.tsx` | `/files` | Delete file + route | ✅ Not in App.tsx |
| `KnowledgePage.tsx` | `/knowledge` | Delete file + route | ✅ Not in App.tsx |
| `OrgChartPage.tsx` | `/org` | Delete file + route | ✅ Not in App.tsx |
| `InboxPage.tsx` | `/inbox` | Delete; merge into bell panel | ✅ Not in App.tsx |
| `FleetOverviewPage.tsx` | `/fleet` | Delete; merged into `/home` | ✅ Not in App.tsx |
| `RunHistoryPage.tsx` | `/runs` (list) | Merge into `/history` | ✅ Not in App.tsx |
| `ActivityPage.tsx` | `/activity` | Delete; merged into `/history` | ✅ Not in App.tsx |
| `LedgerPage.tsx` | `/ledger` | Rename route to `/data`, keep file | ✅ Serves at `/data` |
| `GatewaysPage.tsx` | `/gateways` | Delete; move to Settings > Connections | ⏳ File exists, not routed |
| `SettingsChannelsPage.tsx` | `/settings/channels` | Delete; move to Settings > Connections tab | ⏳ File exists, not routed |
| `ConversationDock.tsx` | (component) | Delete; replaced by ChatPanel | ⏳ File exists, not used |
| `MemoryPage.tsx` | `/memory` | Delete (not in spec scope) | ⏳ File exists, not routed |
| Sidebar entries for removed pages | (App.tsx) | Remove dead imports + nav items | ✅ App.tsx clean |

---

## 20. Conflict Resolution (What Previous Docs Said, What This Decides)

| Conflict | Old docs | This decision |
|---|---|---|
| Chat position | UIUX.md: orb → bar → panel. UX-V2: persistent rail panel. REFACTOR: merge into panel. | **Panel in Shell, always mounted, 3 states: collapsed/open/docked.** No orb, no separate destination behavior. |
| Navigation groups | UIUX.md: Monitor/Build/Operate/Admin. UX-V2: 5-icon rail. REFACTOR: 8-page flat. | **4 primary destinations + Packages + Settings. SPACES section in sidebar. Teams-as-Agents-sub-items approach is replaced by Teams → Spaces migration. See §23.0.** |
| Artifacts in primary nav | Previous specs placed Artifacts as a primary rail item. | **Removed from primary nav. Accessible via context links, Home recently-built section, and ⌘K. See §8.4.** |
| Packages in primary nav | Some analysis suggested moving Packages under Apps. | **Packages stays in the primary nav rail. It is a user-owned library for saving and reusing agent/workflow/skill bundles — it serves power-users and the orchestrator equally. It is not a marketplace hub (no remote hub in V1). See §26.** |
| "Ambient" display term | UIUX.md: not addressed. UX-V2: "Environment". REFACTOR: not addressed. | **"Environment" everywhere in UI copy. "Ambient" is internal only.** |
| Full-screen `/chat` route | UX-V2: exists. UIUX.md: yes. REFACTOR: yes. | **Exists. ChatPanel suppressed when on this route.** |
| Session history location | UX-V2: Clock icon in panel header. UIUX.md: not explicit. | **Clock icon in ChatPanel header. Not a sidebar item.** |
| Sidebar default state | UIUX.md: expanded with labels. UX-V2: 56px icon rail. | **Expanded labels (240px) by default on desktop. Collapses to 56px in session mode.** |
| Streaming rendering | Not in any previous doc. | **Defined in §5.4 of this document.** |
| Orchestrator distinction | Not in any previous doc. | **Defined in §5.5 of this document.** |
| Viewport awareness pill | Not in any previous doc. | **Defined in §9.2 of this document.** |
| window.prompt() for rooms | Not addressed. | **Banned. RoomNameDialog component, §1.1.** |
| App Performance tab | AppDetailPage showed structural inventory counts (agents: 2, workflows: 3). | **Completely redesigned: time-scoped output metrics from `outputLabels` + run cards with per-run values + inline approvals. §21.4.** |
| Artifacts page role | Global output gallery treated as the primary results destination. | **Narrowed to cross-app search tool. Per-app operational results live in the App Performance tab. §8.4 + §21.** |
| Run detail page layout | Separate full-page layout that breaks Shell context (no ChatPanel, no rail). | **Must stay inside Shell with persistent ChatPanel + rail. Node timeline + Node Inspector panel slides in on click. §22.1.** |
| ContextInspector I/O tab | Functional but rendered as raw JSON blobs — unreadable for non-technical operators. | **Redesigned: side-by-side input/output layout, evaluator nodes show rejected-items table with scores + reasons, CSV export. §22.2.** |

---

## 21. Apps — The Operational Layer

### 21.1 The Mental Model

A workflow is the architecture. An App is the deployed product running on top of that architecture. The operator who built the SDR workflow is the same operator who uses the SDR App — but they are asking different questions at different times:

- **Builder mode** (canvas, `/workflows/:id`): "How does it work? What does each node do?"
- **Operator mode** (app, `/apps/:slug`): "What did it do? How many leads did it qualify this week?"

Both modes are first-class. Neither is secondary. The Canvas tab and the Performance tab are two views of the same underlying system, answering different questions with the same data.

### 21.2 App List Page (`/apps`)

```
┌──────────────────────────────────────────────────────────────┐
│  Apps                                                        │
│  Your deployed AI applications                               │
├──────────────────────────────────────────────────────────────┤
│  [All]  [Active]  [Setup needed]  [Paused]  [Error]          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌───────────────────────────────┐  ┌──────────────────────┐ │
│  │ ◈  Autonomous SDR             │  │ ◈  Content Pipeline  │ │
│  │    ACTIVE · v1.2.0            │  │    ACTIVE · v2.0.1   │ │
│  │    3 meetings booked · 7d     │  │    12 posts · 7d     │ │
│  │    [Open]                     │  │    [Open]            │ │
│  └───────────────────────────────┘  └──────────────────────┘ │
│                                                              │
│  ┌───────────────────────────────┐                           │
│  │ ◈  Legal Review               │                           │
│  │    SETUP NEEDED               │                           │
│  │    Connect credentials first  │                           │
│  │    [Continue setup]           │                           │
│  └───────────────────────────────┘                           │
└──────────────────────────────────────────────────────────────┘
```

**App card shows:**
- Name + version + status badge
- Primary output metric for the last 7 days (from `outputLabels[0]`, if configured)
- `[Open]` → App detail page
- Setup-needed apps show the blocking step inline — not a metric

### 21.3 App Detail Page — Tab Structure

```
[Performance]  [Intelligence]  [Data]  [Decisions]  [Workflows]
     ↑               ↑           ↑          ↑            ↑
  Redesign       Keep as-is   Keep       Keep         Keep
  (§21.4)
```

The **Performance** tab is completely redesigned (see §21.4). All other tabs keep their current structure — they are the builder/admin surfaces for configuring the app, not the operational view.

### 21.4 Performance Tab — Complete Redesign

This is the primary view for anyone operating a deployed app. It answers: "what happened since I last looked?"

```
┌──────────────────────────────────────────────────────────────────────┐
│  [Today]  [7 days]  [30 days]                   Refreshed: 2m ago   │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────┬────────────────┬────────────────┬─────────────┐ │
│  │ 47             │ 3 ↗            │ 98%            │ $1.24       │ │
│  │ Leads          │ Meetings       │ Success        │ Cost        │ │
│  │ Qualified      │ Booked         │ Rate           │ this period │ │
│  └────────────────┴────────────────┴────────────────┴─────────────┘ │
│                  ↑ click any metric → filtered run cards below       │
│                                                                      │
│  ┌─ Needs Attention ──────────────────────────────────────────────┐ │
│  │  ⚠ Approval needed: "Enrich Alice Chen for ACME deal"         │ │
│  │     Lead Enrichment · run_abc123 · 2h ago                     │ │
│  │     [Approve]  [Reject]                                        │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─ Recent Runs ──────────────────────────────────────────────────┐ │
│  │  ✓  run_9f3a2b  ·  1h ago  ·  1m 32s  ·  $0.03               │ │
│  │     Meetings booked: 1  ·  Leads qualified: 8                  │ │
│  │     [View run →]                                               │ │
│  │                                                                │ │
│  │  ✓  run_8e2b4a  ·  3h ago  ·  2m 14s  ·  $0.04               │ │
│  │     Meetings booked: 1  ·  Leads qualified: 12                 │ │
│  │     [View run →]                                               │ │
│  │                                                                │ │
│  │  ✕  run_7d1a3c  ·  5h ago  ·  FAILED at enrichment_node       │ │
│  │     [View run →]  [Retry]                                      │ │
│  └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

**Stat bar rules:**
- Columns shown: `outputLabels` values (aggregated across runs in window) + Success Rate + Cost
- If `outputLabels` is empty: show Success Rate + run count + avg duration + cost — still useful without custom labels
- Trend arrow (↗ ↘ →): compares the current window against the previous equal-length window
- Clicking a metric **filters the run cards below** to runs where that output value > 0 — this is the top of the glass floor (see §21.5)

**Pending approvals block:**
- Appears only when runs belonging to this app have pending approval requests
- Shows: approval title + workflow/run name + age
- `[Approve]` `[Reject]` fire the API in-place — block disappears on resolution
- **This is the primary action surface.** The operator never navigates to a separate approvals page from here.

**Run cards:**
- Every run that executed in the time window (COMPLETED or FAILED)
- Status icon + short run ID + timestamp + duration + cost
- Per-run output label values extracted from the run's response artifact content
- `[View run →]` navigates to `/runs/:id` (RunDetailPage)
- `[Retry]` fires inline for failed runs without navigation

### 21.5 The Glass Floor — Navigation Chain

The defining design property of the Performance tab: every aggregate number is drillable. The operator must always be able to ask "which ones?" and immediately get an answer.

```
"3 meetings booked"  (stat bar — click)
         ↓
Run cards filtered to: runs where meetings_booked > 0
         ↓  click [View run →]
RunDetailPage (/runs/:id)
         ↓  click a node row in the timeline
Node Inspector slides in from the right  (ContextInspector)
         ↓  I/O tab
Raw input + output for that specific node execution
   e.g. Evaluator node:
        602 leads evaluated
        47 passed (score ≥ threshold)
        555 rejected — each with: name · score · reason
```

No modals. No new pages beyond RunDetailPage. The data was always there in `blockData`; the glass floor is the navigation chain that connects the aggregate to the atomic record.

**Rule:** Every count displayed on the Performance tab must be clickable. Clicking it either filters the run cards (for output metrics) or navigates directly (for success rate → run list filtered by COMPLETED, for cost → nothing, it is display-only).

### 21.6 outputLabels — Per-App Output Contract

The stat bar is powered by an optional `outputLabels` field in `workflow.settings` on the app's entry workflow:

```json
{
  "outputLabels": [
    { "label": "Leads Qualified", "path": "leads_qualified",  "format": "number"   },
    { "label": "Meetings Booked", "path": "meetings_booked",  "format": "number"   },
    { "label": "Emails Sent",     "path": "emails_sent",      "format": "number"   },
    { "label": "Revenue Impact",  "path": "revenue_usd",      "format": "currency" }
  ]
}
```

`format` values: `number` · `currency` · `percent` · `text`

The backend `GET /v1/apps/:slug/results?window=7d` aggregates these paths across all artifact content (stored as JSON) from runs in the window. If a run's artifact does not contain a given path, it contributes 0 to the aggregate.

**This is not a new schema system.** It is two optional fields in an existing JSON column. Setting `outputLabels` is what converts a generic workflow into a typed operational app with a meaningful stat bar. Without them, the Performance tab still renders — just with health metrics only.

**Where to set it:** The Workflows tab inside App Detail → click the entry workflow → a dedicated "Output Labels" field in its settings panel. Not on the canvas node — on the workflow metadata.

---

## 22. Run Detail Page & ContextInspector — Visual Alignment

These pages exist in the codebase and are functional. This section specifies what they must look like to match the new visual language and to serve as the bottom layer of the glass floor.

### 22.1 Run Detail Page (`/runs/:id`) — Required Changes

**What is wrong right now:**
- Uses a full-page layout that breaks the Shell — the persistent ChatPanel and rail disappear
- No clear visual hierarchy between run metadata and the node timeline
- Per-node I/O requires clicking through to a separate surface or buried tab
- Failed runs don't surface the failure point prominently

**Corrected layout (stays inside Shell):**

```
┌────────────────────────────────────────────────────────────────────────┐
│  [← Lead Enrichment]  or  [← Autonomous SDR · Performance]            │
│  run_9f3a2b   COMPLETED   1m 32s   $0.03   2h ago                     │
│  ──────────────────────────────────────────────────────────────────── │
│  [Timeline]  [Raw Ledger]                                              │
├────────────────────────┬───────────────────────────────────────────── ┤
│                        │                                               │
│  TIMELINE              │  NODE INSPECTOR  (empty until node clicked)  │
│                        │                                               │
│  ● trigger_1    0ms    │  enrichment_node  (skill: evaluator)         │
│    Manual              │  ───────────────────────────────────────      │
│                        │  [Input]  [Output]  [Config]                  │
│  ✓ fetch_leads  440ms  │                                               │
│    52 leads            │  OUTPUT                                       │
│                        │  leads_qualified: 47                          │
│  ✓ enrichment   58s ◀  │  leads_rejected: 555                          │
│    47 of 602     ←     │  pass_rate: 0.078                             │
│    qualified ←─────── click opens this panel                          │
│    [details →]         │  ▾ Rejected items  (555)                      │
│                        │  ┌─────────────────────────────────────────┐ │
│  ✓ response_1   2ms    │  │ Alice Chen   0.23   No LinkedIn profile │ │
│    1 meeting           │  │ Bob Kim      0.41   Seniority too low   │ │
│    booked              │  │ Carol Li     0.31   Wrong industry      │ │
│                        │  │ ... 552 more   (50 per page)            │ │
│                        │  └─────────────────────────────────────────┘ │
│                        │  [↓ Export CSV]   [View raw JSON ↗]          │
└────────────────────────┴───────────────────────────────────────────── ┘
```

**Rules:**
- Run detail **stays inside the Shell** — ChatPanel, rail, and live strip remain visible
- Back link context-awareness: if the user arrived from App Performance → back goes to `/apps/:slug`, from canvas history → back goes to `/workflows/:id`, from History page → back goes to `/history`
- Timeline nodes are clickable rows — clicking opens the Node Inspector panel on the right
- Failed node is highlighted with a red-left-border + shown at the top of the timeline regardless of execution order
- The `[details →]` chip on each node row is a shortcut to open the Node Inspector to the I/O tab
- Duration bar at top of timeline shows relative time spent per node (visual proportion)

**Timeline node row anatomy:**

```
[status icon]  [node title]       [duration]   [output chip — truncated 60 chars]
     ✓         enrichment_node       58s        "47 qualified, 555 rejected"
```

### 22.2 ContextInspector — I/O Tab Alignment

The I/O tab is the terminus of the glass floor — where the operator sees exactly what went into and out of a node in a specific run execution.

```
┌──────────────────────────────────────────────────────────────────┐
│  enrichment_node  (skill: evaluator)                             │
│  ─────────────────────────────────────────────────────────────── │
│  [Configure]  [I/O]  [Run history]  [Notes]                      │
│  ─────────────────────────────────────────────────────────────── │
│                                                                  │
│  INPUT                              OUTPUT                       │
│  ──────────────────────             ──────────────────────       │
│  leads: Array[602]      →           leads_qualified: 47          │
│  criteria: "senior      →           leads_rejected:  555         │
│  director or above..."              pass_rate:        0.078      │
│  threshold: 0.5         →           meetings_booked:  1          │
│                                                                  │
│  ──────────────────────────────────────────────────────────      │
│                                                                  │
│  ▾ Rejected items  (555)                                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  #  │  Name        │  Score  │  Reason                   │   │
│  ├─────┼──────────────┼─────────┼───────────────────────────┤   │
│  │  1  │  Alice Chen  │  0.23   │  No LinkedIn profile       │   │
│  │  2  │  Bob Kim     │  0.41   │  Seniority below threshold │   │
│  │  3  │  Carol Li    │  0.31   │  Wrong industry            │   │
│  │  …553 more                          [← prev]  [next →]   │   │
│  └──────────────────────────────────────────────────────────┘   │
│  [↓ Export CSV]   [View raw JSON ↗]                              │
└──────────────────────────────────────────────────────────────────┘
```

**Rules per node kind:**

| Node kind | I/O tab renders |
|---|---|
| `evaluator` | Side-by-side I/O + rejected items table with score + reason. Always expanded by default. |
| `agent_task` | Side-by-side I/O + collapsible LLM conversation turns (mini thread view) |
| `skill_task` | Input mapping → raw output. Large outputs truncated with `[expand]` |
| `condition` / `router` | Input data + which branch was taken + the expression that matched |
| `http_fetch` | Request details (URL, method, headers) + response (status, body truncated) |
| `response` | Output content at full fidelity (same renderer as artifact panel) |
| Any | `[View raw JSON ↗]` always available — opens full JSON in a fullscreen modal with copy button |

**Array display rule:** Arrays of any kind show: count badge first (`Array[602]`), first 3 items inline, then `▾ See all (N)` expandable. Never dump a full array into the panel by default.

**Export rule:** `[↓ Export CSV]` appears for any array output with more than 10 items. For evaluator rejected items this is the primary way operators export failed leads for manual review.

**Timestamps:** all relative ("2h ago") with ISO-8601 shown on hover.

### 22.3 ContextInspector — Run History Tab Alignment

When the user is on the canvas (not inside a specific run), the "Run history" tab shows the last 20 executions of the selected node across all runs of this workflow:

```
┌────────────────────────────────────────────────────┐
│  Run history  (last 20 executions of this node)    │
├────────────────────────────────────────────────────┤
│  ✓  run_9f3a  1h ago   58s   leads_qualified: 47   │
│  ✓  run_8e2b  3h ago   61s   leads_qualified: 52   │
│  ✕  run_7d1a  5h ago   12s   FAILED: timeout       │
│  ✓  run_6c0e  7h ago   55s   leads_qualified: 39   │
└────────────────────────────────────────────────────┘
```

Clicking any row expands it inline to show the full I/O for that execution. This is the per-node operational history view — the same data as I/O tab but browsable across runs.

---

## 23. Spaces — Business Unit Grouping

### 23.0 The Migration: Teams → Spaces

#### Why This Is a Migration, Not a New Feature

> [!IMPORTANT]
> **Migration status: IMPLEMENTED.**
> The DB now has a `spaces` table and `app_instances.space_id`. `Sidebar.tsx` renders the SPACES section, `/teams` and `/teams/:id` redirect to `/apps`, and AppsPage uses `/apps?space=:id` as the space-filtered destination. The `teams` table remains intentionally as the multi-agent coordination primitive, not as the business-unit grouping UI.

The `teams` table already exists in the database today:

```sql
teams {
  id, workspaceId, ambientId, userId,
  name, slug, description, iconGlyph, colorHex,
  profile JSON
}

teamContext {
  teamId, workspaceId, userId,
  operatingPrinciples, constraints, handoffs,
  successMetrics, escalationRules, sharedPrompt
}
```

The `TeamsPage.tsx` component exists and is routed at `/teams` and `/teams/:id`. The sidebar currently shows teams as accordion sub-items under Agents. The UI copy says "Teams." The concept in the code is real — it just has the wrong name and the wrong home in the nav.

**What `teams` actually is in the codebase:** A named group of agents with optional coordination context (operating principles, handoff rules, escalation logic, shared prompt). It was designed as a multi-agent coordination primitive.

**What operators think it is when they first see it:** A business unit. "Marketing team", "Sales team", "Operations team". The words are identical. The confusion is baked into the name.

**The architectural diagnosis:** The `teams` concept conflates two things that should be separated:

| Concern | What teams currently holds | Where it belongs |
|---|---|---|
| Business unit grouping | `name`, `slug`, `iconGlyph`, `colorHex` | `spaces` table (new name) |
| Multi-agent coordination config | `teamContext.operatingPrinciples`, `constraints`, `handoffs`, `successMetrics`, `escalationRules`, `sharedPrompt` | `spaces.coordinationContext` JSON column (migrated in place) |

Both concerns are valid and both should exist. They just need to be under the right roof with the right label.

#### The Migration Plan

**DB changes (zero data loss):**

```sql
-- Option A: Rename in place (simplest, no data loss)
ALTER TABLE teams RENAME TO spaces;

-- Add coordinationContext as a JSON column absorbing teamContext fields
ALTER TABLE spaces ADD COLUMN coordinationContext TEXT DEFAULT '{}';

-- Migrate existing teamContext rows into spaces.coordinationContext
UPDATE spaces
SET coordinationContext = (
  SELECT json_object(
    'operatingPrinciples', tc.operating_principles,
    'constraints',         tc.constraints,
    'handoffs',            tc.handoffs,
    'successMetrics',      tc.success_metrics,
    'escalationRules',     tc.escalation_rules,
    'sharedPrompt',        tc.shared_prompt
  )
  FROM team_context tc
  WHERE tc.team_id = spaces.id
)
WHERE EXISTS (SELECT 1 FROM team_context tc WHERE tc.team_id = spaces.id);

-- Drop teamContext table after migration
DROP TABLE team_context;

-- Add spaceId to app_instances (apps)
ALTER TABLE app_instances ADD COLUMN spaceId TEXT REFERENCES spaces(id);

-- Add optional spaceId to agents and workflows for native grouping
ALTER TABLE agents    ADD COLUMN spaceId TEXT REFERENCES spaces(id);
ALTER TABLE workflows ADD COLUMN spaceId TEXT REFERENCES spaces(id);
```

**Option B:** Keep `teams` table, add a `spaces` view alias + a separate `spaces` table for new workspaces. Migrate old workspaces in a background job. More complexity, no benefit. **Use Option A.**

**API changes:**
- Rename all `/v1/teams` routes to `/v1/spaces`
- Keep `/v1/teams` as a deprecated alias (backward compat for 1 release cycle)
- Drizzle schema: rename `teams` export to `spaces`, update all relations
- All TypeScript interfaces: `Team` → `Space`, `teamId` → `spaceId`

**Frontend changes:**
- Rename `TeamsPage.tsx` → `SpacesPage.tsx` (this page becomes `/spaces/:id` detail view)
- Remove Teams accordion from Sidebar.tsx under Agents
- Add SPACES section to Sidebar.tsx (see §2.3)
- Update all `useTeams()` hooks → `useSpaces()`
- Route `/teams` → redirect to `/apps` (flat view); `/teams/:id` → `/spaces/:id`
- `AgentCoordinationContext` (what was `teamContext`) becomes a tab inside `/spaces/:id`

**What `/spaces/:id` looks like:**

```
/spaces/:id
  [Overview]  [Apps]  [Agents]  [Workflows]  [Coordination]

  Overview:   Space stat bar (aggregated from agentis.space.summary)
              Recent activity across all apps in this space
  Apps:       Filtered app list (same cards as /apps)
  Agents:     Agents assigned to this space
  Workflows:  Workflows assigned to this space
  Coordination: The coordination context (operating principles, handoffs, etc.)
               — this is the old teamContext data, now surfaced at the right level
```

The Coordination tab is a **builder surface** (set it once, rarely revisit). The Overview tab is the **operator surface** (check it daily). The space is both an org chart node and an operational dashboard.

**Multi-agent coordination is not lost — it moves.** The `operatingPrinciples`, `handoffs`, and `sharedPrompt` fields from `teamContext` are not deleted. They migrate into `spaces.coordinationContext` and surface in the Coordination tab. The orchestrator agent can read them via a new `agentis.space.context` tool, giving multi-agent runs that coordinate within a space access to the same principles as before.

#### What Changes in the UI Today vs After Migration

| Surface | Before migration | After migration |
|---|---|---|
| Sidebar | Teams accordion under Agents | SPACES section below primary nav |
| Header | "team TEAM" breadcrumb pill | Remove — Spaces are not session-scoped |
| Agents page | "Teams" tab in agent detail | "Space" field in agent settings |
| `/teams` route | TeamsPage (team list) | Redirect to `/apps` |
| `/teams/:id` route | Team detail | `/spaces/:id` (SpacePage) |
| Chat orchestrator | No team awareness | `agentis.space.summary` + `agentis.space.context` |
| DB `teams` table | Active | Renamed to `spaces` |
| DB `team_context` table | Active | Merged into `spaces.coordinationContext`, then dropped |

#### Orchestrator Platform Knowledge Update

The §11.2 vocabulary block in CHAT-AGENT-LOOP.md gains an updated entry:

```
Space (formerly Team)
  A named business unit container within a workspace. Examples: "Marketing", "Sales",
  "Operations". Each space can contain apps, agents, and workflows. Spaces are optional
  and purely organizational — they do not restrict access. A space also carries optional
  coordination context (operating principles, handoffs, escalation rules) that governs
  how agents in that space work together.

  Key tools:
  - agentis.space.summary   — aggregate output metrics across all apps in a space
  - agentis.space.context   — fetch the coordination context (operating principles, etc.)
```

---

### 23.1 The Problem Spaces Solve

A workspace starts flat: a list of apps, workflows, agents. At 3–5 apps this is fine. At 15–30 apps — which is what a growing company running Agentis seriously looks like — the flat list is a navigation problem. More importantly, it is a **context problem**: the orchestrator in chat has no way to reason about "the marketing operation" as a coherent unit, because the platform has no concept of one.

Spaces solve both problems simultaneously: they are the organizational primitive that gives the operator a mental map of their platform, and they are the unit the orchestrator uses to frame cross-app intelligence.

The closest industry analogs are Linear (Teams → Projects), Notion (Teamspaces → Databases), and Vercel (Teams → Projects). All three independently arrived at the same pattern. The key insight from all three: **grouping is a navigation shortcut when small, and a cognitive frame when large.**

### 23.2 Core Design Decisions

**Spaces are optional, not required.** A new workspace starts without any spaces. The `/apps` page renders as a flat list. When the operator creates the first space, the apps page reorganizes into grouped sections. A user running 3 apps should never see or think about spaces. The feature activates by usage, not by force.

**One app belongs to one space.** Multi-membership sounds flexible; it is actually confusing. If an app genuinely serves two business units, it belongs to the primary owner's space. Tags handle edge-case cross-referencing. The constraint makes the space a predictable organizational unit — not a fuzzy label.

**Spaces appear in the sidebar as a dedicated section.** Below the primary nav items (Home, Agents, Workflows, Apps, Packages), a collapsible SPACES section lists every space with its app count. Clicking a space navigates to `/apps?space=:spaceId`. This is not a separate top-level destination — it is a shortcut into the Apps page pre-filtered to that space. The distinction matters: the sidebar entry takes you into `/apps` with a filter active, not to a separate page. See §2.3 for the full sidebar structure.

**Spaces are not a permission boundary in V1.** The right architectural direction long-term is Role-Based Access Control scoped to spaces (e.g., the marketing team can only see the Marketing space). But that is V2 scope. In V1, spaces are purely organizational — same access model as the flat app list, just grouped.

### 23.3 Data Model

Minimal schema, zero new conceptual complexity:

```sql
-- New table
CREATE TABLE spaces (
  id          TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id),
  name        TEXT NOT NULL,        -- "Marketing", "Sales", "Operations"
  color       TEXT,                 -- optional accent hex, e.g. "#7C3AED"
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);

-- One column added to apps table
ALTER TABLE apps ADD COLUMN spaceId TEXT REFERENCES spaces(id);
```

That is the entire data model change. No foreign key drama, no migration risk. An app with `spaceId = null` belongs to "General" — the implicit uncategorized group that always renders last.

### 23.4 App List Page — Grouped Mode

When at least one space exists, `/apps` switches to grouped view automatically:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Apps                                                                │
│  [All]  [Active]  [Setup needed]  [Paused]  [Error]    [+ New space] │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ● Marketing                                              [···]      │
│  ─────────────────────────────────────────────────────────────────   │
│  ┌─────────────────────┐  ┌─────────────────────┐                   │
│  │ ◈ Autonomous SDR    │  │ ◈ Content Pipeline  │                   │
│  │   ACTIVE · v1.2.0   │  │   ACTIVE · v2.0.1   │                   │
│  │   3 meetings · 7d   │  │   12 posts · 7d     │                   │
│  │   [Open]            │  │   [Open]            │                   │
│  └─────────────────────┘  └─────────────────────┘                   │
│                                                                      │
│  ● Sales                                                  [···]      │
│  ─────────────────────────────────────────────────────────────────   │
│  ┌─────────────────────┐                                             │
│  │ ◈ Lead Enrichment   │                                             │
│  │   ACTIVE · v1.0.0   │                                             │
│  │   47 leads · 7d     │                                             │
│  │   [Open]            │                                             │
│  └─────────────────────┘                                             │
│                                                                      │
│  ● General                                                           │
│  ─────────────────────────────────────────────────────────────────   │
│  ┌─────────────────────┐                                             │
│  │ ◈ Legal Review      │                                             │
│  │   SETUP NEEDED      │                                             │
│  │   [Continue setup]  │                                             │
│  └─────────────────────┘                                             │
└──────────────────────────────────────────────────────────────────────┘
```

**Group header rules:**
- `● [space name]` — colored dot uses the space's accent color (or default `text-accent` if none set)
- `[···]` menu: Rename, Change color, Delete space (with confirmation: apps stay in General)
- Collapsible — click header row to collapse/expand the group, persisted in localStorage

**`[+ New space]` button:** Opens an inline input directly in the page header (not a modal). Type the name, press Enter, done. The new space appears at the bottom of the list with zero apps in it, immediately ready to receive apps via drag or the `[···]` menu on an app card.

**Assigning apps to spaces:** App card `[···]` menu gains a `Move to space →` submenu showing all existing spaces + "General". Drag-and-drop between groups is also supported but not required for V1.

**Filter bar interaction:** The status filters (`[All] [Active] [Setup needed]...`) apply within and across spaces. When a filter is active, only matching app cards render; space headers with zero matching apps are hidden entirely.

### 23.5 The Real Payoff — Chat Orchestrator Awareness

Spaces are not a folder feature. They are a **business context frame** for the orchestrator. This is what makes the feature architecturally meaningful rather than just organizational chrome.

When the operator is on a space view, the `ViewportContext` signals:

```typescript
// Addition to ViewportContext (packages/core/src/types/chat.ts)
spaceId?:   string;   // e.g. "space_marketing"
spaceName?: string;   // e.g. "Marketing"
```

`AgentisSurface` gains a new value:
```typescript
| 'apps_space'   // /apps, filtered to a specific space
```

The new platform tool `agentis.space.summary` can then answer holistic questions about a business unit:

```typescript
{
  name: 'agentis.space.summary',
  description:
    'Aggregate operational metrics across all apps in a named space (business unit). ' +
    'Use this when the user asks how a department or product area is performing — e.g. ' +
    '"how is marketing doing this week?" or "give me the sales ops summary." ' +
    'Returns: per-app output label totals, combined success rate, total cost, pending approvals.',
  parameters: {
    type: 'object',
    properties: {
      spaceId:  { type: 'string', description: 'The space ID to summarize.' },
      window:   { type: 'string', description: '24h | 7d | 30d', enum: ['24h', '7d', '30d'] }
    },
    required: ['spaceId', 'window']
  }
}
```

**The interaction that justifies this entire feature:**

```
User: "How is the marketing operation doing this week?"

[ViewportContext → spaceId: 'space_marketing', spaceName: 'Marketing']

Thinking: The user is asking about the Marketing space. I'll call agentis.space.summary
          to get aggregated metrics across all apps in that space.

[tool_call: agentis.space.summary({ spaceId: 'space_marketing', window: '7d' })]
→ {
    apps: [
      { name: 'Autonomous SDR',   outputs: { meetings_booked: 3, leads_qualified: 47 } },
      { name: 'Content Pipeline', outputs: { posts_published: 12, drafts_created: 18 } }
    ],
    combined: { successRate: 0.97, totalCostMicros: 215000, pendingApprovals: 1 }
  }

"Marketing had a strong week:
 - SDR: 3 meetings booked, 47 leads qualified (↗ vs last week)
 - Content: 12 posts published, 18 drafts in progress

 One thing needs attention: there's a pending approval for a lead enrichment run
 from 2 hours ago. Want me to pull it up?"
```

No platform in this category can answer that question today. The orchestrator understands "marketing" as a coherent operational unit with real output data, not just a folder label.

### 23.6 System Prompt Vocabulary Addition

The Orchestrator platform knowledge block (§11.2 of CHAT-AGENT-LOOP.md) gains one new entry:

```
Space
  An optional business unit grouping for apps within a workspace. Examples: "Marketing",
  "Sales", "Operations". One app belongs to one space. Apps without a space belong to
  "General." Spaces are organizational — they do not restrict access or change execution
  semantics. Use agentis.space.summary to get aggregate metrics for a space.
```

### 23.7 New Routes

```
/apps                → Apps list (flat if no spaces; grouped if spaces exist)
/apps?space=:spaceId → Apps list filtered to a specific space (shareable URL)
/apps/:slug          → App detail (Performance / Intelligence / Data / Decisions / Workflows)
```

No new top-level route. Spaces live entirely within `/apps`.

### 23.8 Implementation Checklist

**DB (migration):**
- [x] `spaces` table (`id, workspaceId, name, color, createdAt, updatedAt`)
- [x] `spaceId TEXT` column on `apps` table (nullable, FK to spaces)

**API (new endpoints):**
- [x] `GET /v1/spaces` — list spaces for workspace (ordered by name)
- [x] `POST /v1/spaces` — create space (`{ name, color? }`)
- [x] `PATCH /v1/spaces/:id` — rename or change color
- [x] `DELETE /v1/spaces/:id` — delete space; affected apps get `spaceId = null`
- [x] `PATCH /v1/spaces/:id/apps/:slug` — move app into / out of a space (replaces direct `spaceId` on apps PATCH)
- [x] `GET /v1/spaces/:id/summary?window=7d` — the orchestrator tool endpoint

**Core types:**
- [x] Add `spaceId?: string`, `spaceName?: string` to `ViewportContext`
- [x] Add `'apps_space'` to `AgentisSurface` union

**Chat catalog:**
- [x] Add `agentis.space.summary` to `CHAT_TOOL_CATALOG`
- [x] Add `agentis.space.summary` executor to `BUILTIN_REGISTRY`
- [x] Add `Space` entry to orchestrator platform vocabulary (§11.2)

**Frontend:**
- [x] `useSpaces()` hook — fetches and caches spaces list
- [x] `AppsPage.tsx` — grouped view when `spaces.length > 0`, flat view otherwise
- [x] Space group header component (colored dot + name + count)
- [x] `[+ New space]` inline creation in AppsPage
- [x] App card `Move to space →` menu
- [x] `useViewportContext()` — emit `spaceId` + `spaceName` when space filter is active
- [x] Filter bar: hide empty space headers when a status filter is active

### 23.9 What Not to Build in V1

| Feature | Reason to defer |
|---|---|
| Per-space RBAC / access control | Needs full permissions system. V2. |
| Space-scoped run history page | Valuable but adds a whole new list surface. V2. |
| Apps in multiple spaces | Conceptually appealing, practically confusing. Rejected. |
| Space as a standalone full-page destination | Would create a parallel to `/apps` with no clear distinction. Space sidebar entries navigate into `/apps?space=:id` — they are filter shortcuts into the existing Apps page, not a new page. |
| Space-level budget tracking | Budget system itself is V1 — space-level aggregation is V2. |
| Space templates ("Marketing starter pack") | Registry feature, not a spaces feature. Separate concern. |

---

## 24. Home Page — Chat-First Layout (Perplexity-Style)

### 24.1 The Central Decision

The home page is a **chat surface that happens to have operational data below it.** Not the other way around. This is the inversion that Perplexity validated and that Agentis must adopt.

The Perplexity insight applied to Agentis: a user who lands on the home page does not want to read a status dashboard — they want to act. The chat composer, centered and dominant, is the act. The operational data (what is running, what needs attention) is the context that enriches the next action — but it is scroll content, not above-the-fold content.

**What this is NOT:** A stripped-down page. The operational data does not disappear. The HomeLauncher, AgentWorkStream, pending approvals, recently-built artifacts — all of it remains. It moves to its proper position: below the fold, readable after the user has decided what they want to do or when they specifically come to check on things.

### 24.2 Above-the-Fold Layout

```
+------------------------------------------------------------------+
|                                                                  |
|   (header: Agentis / workspace-name             [bell] [K] [T]) |
|                                                                  |
+------------------------------------------------------------------+
|                                                                  |
|  SIDEBAR  |                                                      |
|           |                                                      |
|  Home     |                                                      |
|  Agents   |     Good morning, Thomas.                            |
|  Workflows|     3 runs active. 1 needs your attention.           |
|  Apps     |                                                      |
|  Packages |   +------------------------------------------------+ |
|           |   |  [@ General v]  What should I work on?    [->] | |
|  ──────── |   +------------------------------------------------+ |
|  SPACES   |                                                      |
|   Market. |   [Review thomas's approval]  [Run SDR again]       |
|   Sales   |                                                      |
|           |   --------------- scroll for activity ------------- |
|           |                                                      |
|  Settings |                                                      |
+-----------+--------------------------------------------------+---+
```

**Greeting line rules:**
- First token of day: `"Good morning, [name]."` / `"Good afternoon, [name]."` / `"Good evening, [name]."`
- Second line adapts to state:
  - 0 runs, 0 apps: `"Your workspace is ready. Build your first automation below."`
  - n active runs, 0 pending: `"[n] run[s] active. Everything looks good."`
  - n active runs, m pending: `"[n] run[s] active. [m] thing[s] need your attention."`
  - All agents offline: `"No agents online. Connect an AI provider to bring your fleet to life."`
- Text is **not animated** on repeat visits. Typewriter effect only on first visit (after account creation).

### 24.3 The Composer (Above the Fold)

Same component as §4.3 (Universal Command Bar). On the home page it renders at full width, vertically centered between header and first scroll indicator. This is the dominant UI element.

```
+---------------------------------------------------------------+
|  [@ General v]  |  What do you want to build or run?    [->] |
+---------------------------------------------------------------+
```

- `[@General v]` = recipient selector (same as §4.3) — defaults to the last-used room/agent
- Placeholder cycles through workspace-aware prompts (see §4.3 typewriter behavior)
- `[->]` = send button, becomes animated spinner during stream

**On first load (empty workspace, 0 apps):** the placeholder is not workspace-aware yet. It defaults to value-discovery prompts:
```
"Build an SDR automation that books meetings..."
"Monitor my competitors and email me a weekly report..."
"Enrich my lead list with LinkedIn data every morning..."
```

These are **not random.** They are the 12 built-in app categories (see §26). The prompt cycles suggest real things the platform can do.

### 24.4 Contextual Action Chips

Below the composer, max 4 chips derived from workspace state (see §4.4 for priority order). They are pills, not buttons — visual weight is deliberately low. They are suggestions, not menus.

```
[Review thomas's approval]  [Re-run Lead Enrichment]  [Build a workflow]
```

On cold start (0 apps, 0 runs): chips show the 3 most relevant built-in apps:
```
[Try: Autonomous SDR]  [Try: Content Pipeline]  [Try: Lead Enrichment]
```

Clicking a cold-start chip pre-fills the composer with the app's description and a suggestion: `"I want to set up an Autonomous SDR app. Help me configure it."` — the orchestrator takes it from there.

### 24.5 Scroll Divider

A visible affordance that the page continues below:

```
  ─────────────── ↓  your active platform ────────────────
```

Thin muted horizontal rule with centered text. On mouse-enter the rule gains a subtle glow. On click it scrolls to the first below-fold block.

This line makes the page contract clear: above = act, below = observe.

### 24.6 Below-Fold Blocks

**Block 1 — Needs Attention (appears first when pending items exist):**

Exact same component as §10.1 — inline approval + failed run cards with action buttons. This block renders at the top of the scroll area when it has content. When empty, it renders the good-state message and moves to last.

**Block 2 — Running Now:**

Exact same component as §10.2 — compact active-run cards with `AgentWorkStream` typewriter for current step.

When an agent is **building something in real time** (a workflow, via the canvas-from-chat flow, §25), the run card upgrades to a mini canvas embed inline:

```
+----------------------------------------------------+
|  thomas is building  •  LIVE                      |
|                                                    |
|  [Trigger] ---> [Fetch] ---> [Summarize] ---> ...  |
|     (done)       (done)     (building...)          |
|                                                    |
|  Step 3 of 6: Adding AI summarizer node...         |
+----------------------------------------------------+
```

This is not a full canvas — it is a read-only mini React Flow instance, 3-4 nodes visible at most, no handles or interact targets. The sole purpose is to show the operator that something is being assembled.

**Block 3 — Spaces Summary (appears when spaces exist):**

When the operator has created at least one Space, a compact summary row per Space shows its aggregate performance from `agentis.space.summary`:

```
+----------------------------------------------------------+
|  Marketing          3 meetings booked  47 leads  ACTIVE  |
|  Sales              12 posts published            ACTIVE  |
|  Operations         Last ran 3d ago               PAUSED  |
+----------------------------------------------------------+
             [View all spaces ->]
```

Clicking a row navigates to `/apps?space=:id`. This is the home page's only reference to the Spaces concept — it shows the operator their business units at a glance without requiring navigation.

**Block 4 — Recently Built:**

Exact same component as §10.3 — 3-column artifact thumbnail grid (last 6). `"Your agents haven't built anything yet."` with `[Ask an agent]` CTA when empty.

**Block 5 — Explore (cold start only, disappears after first artifact exists):**

Horizontal scrolling row of built-in app cards (see §26). Each card: app name + one-line description + `[Try it]` button that pre-fills the composer. This row is the discovery surface for operators who don't know where to start.

### 24.7 Adaptive Layout — Empty vs Active Workspace

| State | Above fold | Below fold |
|---|---|---|
| New workspace (0 apps, 0 runs, 0 agents) | Greeting: "ready" + composer centered | Block 5 (Explore) only — prominent, full width |
| Has apps, no active runs | Greeting: "fleet ready" + composer | Blocks 2 (empty — muted) + 4 + 5 (fades after first artifact) |
| Active runs | Greeting: "N active" + composer | Blocks 2 (prominent) + 1 (if pending) + 3 (if spaces) + 4 |
| Pending approvals | Greeting: "needs attention" + composer | Block 1 first, then 2, then 3, then 4 |

The layout responds to data — it does not force the operator to look at empty tables.

---

## 25. Canvas-from-Chat — The Platform's Defining Moment

### 25.1 The Vision

The most powerful feature of Agentis is invisible today: the `agentis.build_workflow` tool exists in the CHAT_TOOL_CATALOG spec (CHAT-AGENT-LOOP.md §3.5), but there is no UX for what happens when it runs. A user types a goal, the orchestrator scaffolds an entire workflow, agents, and app — and the operator sees... nothing, until a new route loads.

This section specifies the UX for the **canvas-from-chat** experience: the moment where a natural language goal becomes a visual workflow, assembled live, in front of the operator's eyes, driven entirely by the orchestrator agent.

This is Agentis's defining moment. It is the experience that converts a new user from "I understand the value" to "I cannot go back."

### 25.2 The Full Flow

**Step 1 — Operator types a goal in the home composer (or any chat thread):**
```
"Build me an SDR automation that finds leads on LinkedIn, enriches
 them with Apollo, scores them with AI, and books meetings for the
 top 10% using Calendly."
```

**Step 2 — Orchestrator enters the agentic loop (CHAT-AGENT-LOOP.md §2.3):**

```
Thinking: This is a multi-step app build request. I need to:
  1. Plan the app architecture
  2. Design the agent team
  3. Build the workflow graph
  4. Create the app instance
  5. Prompt for credentials

[tool: agentis.plan]
→ {
    steps: [
      "Create 3 agents: LinkedIn Researcher, Apollo Enricher, AI Scorer",
      "Build SDR Pipeline workflow: 6 nodes",
      "Create Autonomous SDR app instance",
      "Request credentials: Apollo API key, Calendly OAuth"
    ]
  }
```

The orchestrator streams text to the chat thread:

```
"Here's what I'll build for you:

  3 agents: LinkedIn Researcher, Apollo Enricher, AI Scorer
  1 workflow: SDR Pipeline (6 nodes)
  1 app: Autonomous SDR

  You'll need two credentials:
  - Apollo API key (for enrichment)
  - Calendly OAuth (for meeting booking)

  Shall I start building? [Yes, build it] [Let me adjust first]"
```

The `[Yes, build it]` and `[Let me adjust first]` buttons are inline structured response actions (§18 proactive message pattern) — not typed responses. One click each.

**Step 3 — Operator clicks [Yes, build it]:**

**Step 4 — The Canvas Panel slides in alongside the chat thread:**

```
+------------------------------------------+-----------------------------+
|  CHAT THREAD                             |  CANVAS  (live build)       |
|                                          |                             |
|  Here's what I'll build...               |  [toolbar: SDR Pipeline]    |
|                                          |                             |
|  [Yes, build it]  (clicked)             |                             |
|                                          |  Building...                |
|  thomas is building your SDR app...      |                             |
|                                          |  [Trigger] placing...       |
|  [live build log]                        |                             |
|  ✓ Created LinkedIn Researcher           |                             |
|  ✓ Created Apollo Enricher              |                             |
|  ⟳ Creating AI Scorer...                |                             |
|                                          |                             |
+------------------------------------------+-----------------------------+
```

The Canvas panel opens in a **split-screen mode** next to the chat thread — not full-screen, not a page transition. The operator can watch the chat log AND see the graph being assembled simultaneously.

**Step 5 — Nodes appear one by one on the canvas:**

Each node is placed with a brief animation:
1. Node appears at its intended position with `opacity: 0, scale: 0.8`
2. Transitions to `opacity: 1, scale: 1` in 150ms
3. After 200ms, the edge connecting to the previous node draws from left to right (path-length animation)
4. The build log in the chat thread updates: `"✓ Added LinkedIn fetch node"`

The orchestrator executes `agentis.build_workflow` which streams `CANVAS_NODE_PLACED` and `CANVAS_EDGE_CONNECTED` realtime events. The frontend subscribes to these events (keyed to the runId) and translates each to a React Flow graph update.

**Step 6 — Build completes:**

The canvas shows the completed workflow. The build log in the chat thread closes and is replaced by a summary:

```
+--------------------------------------------------------+
|  thomas finished building                              |
|                                                        |
|  SDR Pipeline                                          |
|  6 nodes · 3 agents · $0.00 / run                     |
|                                                        |
|  Now I need two credentials to activate this app:      |
|  1. Apollo API key — [Connect Apollo]                  |
|  2. Calendly OAuth — [Connect Calendly]                |
|                                                        |
|  You can also test it first with mock data:            |
|  [Test run (mock)]                                     |
+--------------------------------------------------------+
```

`[Connect Apollo]` and `[Connect Calendly]` are deep links to the credential setup for those specific integrations — not the generic settings page. The operator is never left to figure out where to configure something.

**Step 7 — After credentials are connected:**

The chat thread automatically receives a completion message:
```
"Apollo API key connected. One more: [Connect Calendly]"
```

When both are connected:
```
"Your SDR app is ready to run.

 [Launch first run]   [View app]   [Edit workflow]"
```

The first run of a newly-built app is always a **guided run**: the orchestrator pre-fills sensible defaults and explains what it will do before executing. The operator confirms. This prevents the fear of "I just pressed a button and something expensive happened."

### 25.3 The Canvas Panel — Split-Screen Mode

The canvas panel has a new mode: `'build'` (in addition to existing modes).

| Mode | Width | Trigger |
|---|---|---|
| `hidden` | 0 | Default when not building |
| `build` | 50% of main zone | `agentis.build_workflow` begins execution |
| `view` | 50% of main zone | After build completes, user can still inspect |
| `fullscreen` | Full viewport | User clicks ⤢ expand |

In `build` mode the canvas toolbar is minimal:
```
[SDR Pipeline]                              [Fullscreen ⤢]
```
No `[Save]`, `[Test run]`, `[Publish]` buttons during build — those appear after build completes.

**Layout mechanics:** When the canvas panel opens in `build` mode, the chat thread compresses from full width to 50% and the canvas takes the other 50%. This is a CSS grid transition (same grid column system as the main Shell, but applied inside the chat zone). The transition is 250ms ease-out.

On mobile / narrow viewports (< 1024px): the canvas panel does NOT appear. Instead, a toast notification slides up from the LiveStrip: `"thomas is building your workflow — [View canvas]"`. Tapping it navigates to the workflow canvas page.

### 25.4 Build Log Component

The build log appears inside the chat thread during construction. It is a collapsible block:

```
+-------------------------------------------------------+
|  ⟳  Building SDR Pipeline  LIVE                      |
|  ─────────────────────────────────────────────────── |
|  ✓  Created LinkedIn Researcher (agent)               |
|  ✓  Created Apollo Enricher (agent)                   |
|  ✓  Created AI Scorer (agent)                         |
|  ✓  Added webhook trigger node                        |
|  ✓  Added LinkedIn fetch node                         |
|  ⟳  Adding Apollo enrichment node...                  |
|  ○  AI scoring node (pending)                        |
|  ○  Condition / router node (pending)                 |
|  ○  Meeting booking node (pending)                   |
+-------------------------------------------------------+
```

- Green `✓` = completed step
- Spinning `⟳` = current step (animated CSS spinner, no GPU compositing)
- Empty `○` = pending steps
- When all complete: header changes to `"✓  SDR Pipeline built"` and block auto-collapses after 2 seconds

After collapse, a `[Show build log]` link remains for audit purposes.

### 25.5 Realtime Events Required

New realtime events to implement:

| Event | Payload | Consumer |
|---|---|---|
| `CANVAS_NODE_PLACED` | `{ runId, workflowId, node: { id, title, kind, position } }` | Mini canvas in chat thread, full canvas page |
| `CANVAS_EDGE_CONNECTED` | `{ runId, workflowId, edge: { source, target } }` | Same |
| `CANVAS_BUILD_COMPLETE` | `{ runId, workflowId, nodeCount, agentIds }` | Build log collapse, success card in thread |
| `CANVAS_BUILD_FAILED` | `{ runId, workflowId, step, error }` | Error card in thread, canvas shows last valid state |

These events are emitted by the `agentis.build_workflow` executor as it creates each entity.

### 25.6 Error Recovery During Build

If the build fails mid-way (e.g., agent creation fails, workflow validation error):

1. The canvas panel shows the partial graph in its last valid state
2. The build log shows the failing step in red: `"✕ Failed: Could not create AI Scorer — adapter config required"`
3. The chat thread shows an error card with a clear explanation and a recovery action: `[Retry]` or `[Fix manually]`
4. `[Fix manually]` opens the full canvas page where the operator can complete the graph

The partial graph is saved. Nothing is lost. The operator can finish the build manually from where the agent stopped.

### 25.7 Adjusting Before Building

When the operator clicks `[Let me adjust first]` (Step 2), the chat thread shows the plan in editable form:

```
+-------------------------------------------------------+
|  Adjust the plan before building:                    |
|                                                       |
|  Agents (3):                                         |
|  • LinkedIn Researcher      [Edit] [Remove]           |
|  • Apollo Enricher          [Edit] [Remove]           |
|  • AI Scorer                [Edit] [Remove]           |
|  [+ Add agent]                                        |
|                                                       |
|  Workflow: SDR Pipeline (6 nodes)    [View nodes]     |
|                                                       |
|  Credentials needed:                                  |
|  • Apollo API key                                     |
|  • Calendly OAuth                                     |
|                                                       |
|  [Build it now]                                       |
+-------------------------------------------------------+
```

This is a structured response rendered by the `ThreadView` component — not a modal, not a new page. The operator edits inline, then clicks `[Build it now]`. The orchestrator reads the adjusted plan and executes the corrected `agentis.build_workflow` call.

---

## 26. Apps Catalog — 12 Built-In Apps, No Remote Hub

### 26.1 The Decision

**V1 ships 12 apps locally. There is no remote hub.** The apps are seeded into every workspace as `libraryPackages` with `kind: 'agentis'` on workspace creation. The PackagesPage `agentis` tab shows these 12 apps for install. No network call required. No hub registration. No versioning complexity beyond what already exists in `libraryPackages.version`.

**Why this is right for V1:**
- A remote hub requires CDN, versioning infrastructure, auth, and trust anchors — V2 complexity
- The 12 apps cover the highest-value initial use cases for nearly every operator
- Local seeding means offline-capable installs and zero latency on the install flow
- Custom app creation via chat (§25) gives operators an unlimited path beyond the 12

**The hub is a V2 feature.** When it ships, the `libraryPackages` table already has `remoteId` and `checksum` columns for remote package tracking. The foundation is there.

### 26.2 The 12 Built-In Apps

These are seeded at workspace creation with `kind: 'agentis'` in `libraryPackages`:

| # | App Name | Description | outputLabels (primary metric) |
|---|---|---|---|
| 1 | Autonomous SDR | LinkedIn prospecting → Apollo enrichment → AI scoring → Calendly booking | `meetings_booked`, `leads_qualified` |
| 2 | Content Pipeline | Brief → draft → edit → publish to social/CMS | `posts_published`, `drafts_created` |
| 3 | Lead Enrichment | CRM import → web research → LinkedIn → enriched export | `leads_enriched`, `data_points_added` |
| 4 | Market Intelligence | Competitor monitoring → news aggregation → weekly digest | `reports_generated`, `sources_monitored` |
| 5 | Legal Review | Document intake → clause analysis → risk summary | `documents_reviewed`, `risks_flagged` |
| 6 | Customer Support | Ticket intake → classification → auto-response → escalation | `tickets_resolved`, `escalations_created` |
| 7 | Data Enrichment | Raw dataset → research → validation → enriched CSV | `records_enriched`, `accuracy_score` |
| 8 | Email Campaigns | Audience segment → copy generation → A/B test → send | `emails_sent`, `campaigns_launched` |
| 9 | Research Assistant | Topic → deep web research → summarization → citations | `reports_created`, `sources_cited` |
| 10 | Invoice Processing | PDF intake → data extraction → accounting entry → approval | `invoices_processed`, `approvals_requested` |
| 11 | Social Listening | Brand mentions → sentiment analysis → alert digest | `mentions_tracked`, `alerts_sent` |
| 12 | Competitive Analysis | Competitor URLs → weekly crawl → diff analysis → report | `analyses_run`, `changes_detected` |

### 26.3 Seeding Strategy

> [!NOTE]
> **Status: IMPLEMENTED.** The directory `packages/core/src/data/builtin-apps/` contains 12 V1 `agentis` app manifests. `seedBuiltinAppsForWorkspace()` idempotently inserts missing catalog rows when a workspace is created and when `/v1/packages` is listed, so existing workspaces receive the built-in catalog without a manual migration.

**Target implementation:**

Apps are seeded as JSON package manifests at:
```
packages/core/src/data/builtin-apps/
  autonomous-sdr.json
  content-pipeline.json
  ...
  competitive-analysis.json
```

Each manifest should follow the `libraryPackages.contents` JSON schema and include:
- Agent configurations (name, adapter type, system prompt template)
- Workflow graph definition (nodes, edges, trigger type)
- `outputLabels` array (see §21.6)
- `credentialBindings` schema (which credentials the operator must provide)
- `entryWorkflowId` reference
- Version: `"1.0.0"` for all V1 seeds

Seeding runs through `seedBuiltinAppsForWorkspace()` from workspace creation and package listing:

```typescript
// apps/api/src/routes/workspaces.ts
seedBuiltinAppsForWorkspace(deps.db, { workspaceId: id, ambientId: null, userId: user.id });

// apps/api/src/routes/packages.ts
seedBuiltinAppsForWorkspace(deps.db, { workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id });
```

Insert is idempotent by checking `(workspaceId, slug)` before inserting each built-in manifest.

### 26.4 Install Flow (User-Initiated)

When the operator wants to use a built-in app:

1. **PackagesPage** (`/packages`) — filter tab `agentis` — shows 12 cards with name + description + primary metric label + `[Install]` button
2. Click `[Install]` — calls `POST /v1/packages/:id/use` — creates an `appInstances` row with `status: 'setup'`
3. Redirects to `/apps/:slug?setup=1` — the App Detail page in setup mode
4. Setup wizard tabs through: `[Credentials]` → `[Activate]`
5. On `[Activate]` — `PATCH /v1/apps/:slug { status: 'active' }` — app becomes live

**Alternative: install via chat.** The operator types `"I want to use the SDR app"` and the orchestrator:
1. Calls `agentis.packages.install({ slug: 'autonomous-sdr' })`
2. Identifies missing credentials from the manifest's `credentialBindings`
3. Walks the operator through connecting each credential in the chat thread
4. Activates the app — thread ends with `"Your SDR app is live. [View app →]"`

This is the preferred path for new users. The PackagesPage is the power-user path.

### 26.5 Custom App Creation (Chat Path)

When the operator wants an app that is not in the catalog:

**Entry point 1 — Home composer:**
```
"Build me an app that monitors Amazon reviews for my product and emails
 me a weekly sentiment report"
```

**Entry point 2 — Apps page empty/cold-start:**
```
[+ Build a custom app]  →  pre-fills the home composer with:
"I want to build a custom app. What should it do?"
```

**Entry point 3 — PackagesPage footer:**
```
"Don't see what you need?  [Build a custom app with AI]"
```

In all cases, the orchestrator uses the canvas-from-chat flow (§25) to scaffold the custom app. The result is saved as a `libraryPackage` with `kind: 'workflow'` (user-created, not `agentis`) and a linked `appInstances` row.

**The `agentis.build_workflow` tool must emit `outputLabels`** in the manifest it generates. The orchestrator infers reasonable labels from the app description:
- "books meetings" → `meetings_booked`
- "sends emails" → `emails_sent`
- "generates reports" → `reports_generated`
- "processes documents" → `documents_processed`

If no output can be inferred, the orchestrator asks before building: `"What is the most important thing this app will produce? I'll use it to track results."` This ensures every custom app has a meaningful Performance tab.

### 26.6 Packages Page — Corrected Role

**Packages (`/packages`) is a user-owned library of saved assets:**

| Tab | Content | Who creates it |
|---|---|---|
| `all` | Everything | — |
| `agentis` | The 12 built-in apps | Seeded at workspace creation |
| `workflow` | Workflows the operator has saved as packages | Operator or agent |
| `agent` | Agent configurations saved as packages | Operator or agent |
| `skill` | Reusable skill modules | Developer or operator |
| `integration` | Integration connectors | Developer |

**This is not a marketplace.** It is a personal library. Operators save packages to reuse across projects or share with teammates (V2). Agents can save packages programmatically — the `agentis.build_workflow` tool creates both the workflow and its package manifest in one action.

**Package as a portable snapshot:** A package `contents` JSON captures the full configuration of an agent or workflow at a point in time — system prompt, node graph, skill bindings, credential schema. Exporting a package produces a `.agentis.json` file. Importing restores the configuration. This is the foundation for a future hub without needing the hub today.

**The Packages rail item stays.** Packages is a first-class user surface — daily-use for power operators, discoverable for newcomers via the `agentis` tab. It does not belong hidden in Settings.
