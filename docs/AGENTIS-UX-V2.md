# Agentis — Chat-First Platform Redesign v2
## Built for Anyone Who Runs Agents

> **Status:** Design Blueprint v2 — May 2026
> **Replaces:** AGENTIS-UX-V2.md v1 (which was directionally correct but missed key product insights)
> **Scope:** Full shell, navigation, home experience, artifact system, notification system, chat & rooms, packages, theme. Infrastructure unchanged — only surfaces redesigned.
> **Philosophy:** The human directs. The agents build. The platform shows everything.

---

## 0. The Foundational Thesis

The previous shell framing was backwards in one critical place: it called the workflow engine "mostly invisible." That was wrong.

The workflow engine is the most spectacular part of this platform. When an agent builds a workflow live — nodes appearing one by one, edges connecting, canvas breathing — that is the demo that converts. That is the moment no competitor can replicate. Every design decision must protect and amplify that moment, not bury it.

The correct framing:

| When | The stage | What the human sees |
|---|---|---|
| Idle | Chat interface | Command bar, recent activity, fleet status |
| Agent running a workflow | Canvas overlays (live) | Nodes executing, data flowing, artifacts emerging |
| Agent BUILDING a workflow | Canvas construction (live) | Nodes appearing, agent narrating, platform becoming |
| Artifact just completed | Artifact panel (auto-opens) | The thing that was built, rendered at full fidelity |
| Background / historical | Engine layer (accessible) | Power users inspect, debug, modify |

The engine is never invisible when it is working. It is hidden only when nothing is happening.

---

## 1. The Three-Layer Model

```
┌──────────────────────────────────────────────────────────────────────┐
│  DIRECTOR LAYER  ← where the operator lives                          │
│  Home (command bar), Chat & Rooms, Notifications, Artifacts          │
├──────────────────────────────────────────────────────────────────────┤
│  CREW LAYER  ← where agents are managed                              │
│  Agents fleet, Teams, Goals, live work strips                        │
├──────────────────────────────────────────────────────────────────────┤
│  STAGE LAYER  ← foregrounded when active, accessible always          │
│  Workflow canvas (live construction + live execution), History,      │
│  Packages (saveable configs), Settings                               │
└──────────────────────────────────────────────────────────────────────┘
```

The Stage Layer is not background infrastructure. It is the *show*. An agent building a workflow live is a front-row seat at the most interesting thing happening on your platform. The design surfaces it aggressively when it is happening and recedes it gracefully when it is not.

### 1.1 Vocabulary (Binding)

| Concept | Term | Notes |
|---|---|---|
| Human using the platform | **operator** | Not user, not admin |
| Something an agent produced | **artifact** | HTML, image, doc, code, data |
| Deliverables library | **Artifacts** | Gallery-first, thumbnail cards |
| Saved config bundle | **Package** | agent / workflow / skill / bundle type — deployable to AgentisHub |
| Persistent chat space | **Room** | Multi-participant, agents + operator |
| 1:1 agent conversation | **Thread** | Existing, unchanged concept |
| Action needing operator review | **notification** | Bell in header, not a nav page |
| Named operating context | **workspace** | Unchanged |
| Sub-context within workspace | **environment** | Replaces "ambient" in UI copy |
| Agent execution event trail | **History** | Not "ledger" in copy |
| Structured data tables | **Data** | The existing LedgerPage, demoted |

---

## 2. Shell Architecture

### 2.1 Three-Zone Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│  HEADER (48px)                                                         │
│  [● Agentis] / [workspace▾] / [team TEAM]  [🔔 N] [⌘K] [TH▾]        │
├────────┬───────────────────────────────────────────┬───────────────────┤
│        │                                           │                   │
│  RAIL  │  PRIMARY ZONE                             │  ARTIFACT PANEL   │
│ 56px   │                                           │  (slides in,      │
│ icons  │                                           │   360-480px,      │
│  or    │                                           │   pinnable)       │
│  240px │                                           │                   │
│ labels │                                           │                   │
│        │                                           │                   │
└────────┴───────────────────────────────────────────┴───────────────────┘
│  LIVE STRIP (28px — visible only when runs are active)                 │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Header

The header is a context declaration: you always know which workspace and which team you are operating in.

```
[● Agentis]  /  [workspace ▾]  /  [team  TEAM]        [🔔 N]  [⌘K]  [TH ▾]
     ↑                ↑                  ↑               ↑       ↑      ↑
  home nav      workspace         team context      notif   search  avatar
                switcher         breadcrumb (KEEP)  bell     pill   menu
```

**Team context breadcrumb (KEEP — not removed):**
- Shows the currently active team context as `[team name]  TEAM` pill
- Clicking it opens the team switcher (switch team scope without switching workspace)
- Appears only when a team context is active

**Notification bell:**
- Badge: sum of `pending_approvals + failed_runs_last_hour + unread_room_mentions`
- Opens the notification dropdown inline (no navigation)

**Avatar dropdown (local/self-hosted context):**
```
[TH]  Thomas
      ─────────────────────
      🌙 Dark  /  ☀ Light
      ─────────────────────
      ⚙  Settings
      ↪  Sign out
```
No cloud account management, no billing, no profile photo upload — this is a local platform. Keep it minimal.

**Removed from header:**
- The standalone `Sign out` button (LogOut icon next to Search) — moves to avatar dropdown only

### 2.3 Navigation Rail

**Principle:** The rail is a compass, not a menu. 5 primary destinations + Settings. Everything else is ⌘K.

```
●  Home
◎  Agents            (badge: live count)
   └─ marketing      (team sub-items, accordion)
   └─ engineers
✦  Workflows         (badge: active run count)
□  Artifacts
▣  Packages

──────────────────────

⚙  Settings
```

**No workspace block in sidebar.** Workspace context lives exclusively in the header.

**Teams as Agents sub-items:**
- Accordion under the Agents nav item (expand/collapse)
- Each sub-item: team color dot + team name + optional live-agent badge
- Collapsed rail: team sub-items hidden; Agents icon shows "has teams" dot
- Click Agents → fleet view of all agents
- Click team sub-item → `/teams/:id` team-scoped view

**Removed from nav entirely (pages stay but nav item gone):**
- Goals
- Memory
- Scheduler
- Routines
- Approvals (replaced by bell)
- Teams (top-level) — becomes Agents sub-items
- Records / Ledger — becomes `/data`, ⌘K accessible

---

## 3. Home Page — The Launcher

The home page has one job: get the operator into a productive session as fast as possible. It is a launcher, not a dashboard. The command bar is the hero. Everything else exists below the fold and is surfaced contextually when it matters.

There are two layout states:

| State | Triggered by | What the operator sees |
|---|---|---|
| **Launcher** | Landing on `/home` | Centered command bar, greeting, contextual chips, activity below fold |
| **Session** | Sending a message | Full-area chat session, sidebar narrows, artifact panel available on right |

The transition between them is an animation, not a page reload.

---

### 3.1 Launcher Layout

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                   │
│                                                                   │
│                                                                   │
│            Good morning, Thomas.                                  │
│            Your fleet is ready.                                   │
│                                                                   │
│   ┌───────────────────────────────────────────────────────┐     │
│   │  💬 General ▾  │  What do you need done?              │     │
│   │               │                                 [→]   │     │
│   └───────────────────────────────────────────────────────┘     │
│                                                                   │
│   [contextual chip 1]  [contextual chip 2]  [contextual chip 3]  │
│                                                                   │
│                                                                   │
│   ───────────── scroll for current activity ─────────────        │
│                                                                   │
│   ● thomas    Writing Q2 copy...    [View]                       │
│   ⚠ Approval needed from thomas     [Review]                     │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

The greeting adapts:
- Morning / Afternoon / Evening
- `"Your fleet is ready."` (all agents idle)
- `"2 agents are working."` (active runs)
- `"thomas needs your attention."` (pending approval)
- `"3 things built today."` (recent artifact day)

The activity strip below the fold is a lightweight, compact summary — not a full dashboard. It shows a maximum of 3 lines: active runs (one line each with agent name + current step) + any pending approvals. No section headers, no card decorations. Scroll reveals the full [Running Now / Needs Attention / Recently Built] layout described in §3.5.

---

### 3.2 The Universal Command Bar

The command bar is the single most important UI element on the platform. It is not a search box and not a chatbot input. It is the operator's primary control surface for the entire fleet.

**Anatomy:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  [💬 General ▾]  │  Ask thomas to write the weekly newsletter...  [→]  │
└──────────────────────────────────────────────────────────────────────────┘
       ↑                      ↑                                        ↑
   recipient             free input                               send
   selector           (text, slash, @, #,                        button
   (last used,         URL paste, file drop)
   defaults to
   💬 General)
```

**Animated placeholder — the typewriter:**

The placeholder text is never static. It cycles through platform-specific phrases using a typewriter animation: type in character by character at ~40ms/char, pause 2.5s, fade out, next phrase. The cycle is curated — not random — and reflects what this platform actually does.

The phrase pool is split into two layers:

**Layer 1: Workspace-aware (uses live data, highest priority)**

These pull from actual workspace state on mount (same context as the suggestion chips). Evaluated first:

```typescript
// If agents exist, pull their names into phrases:
"Ask @thomas to write the weekly newsletter..."
"Check if @shoulder has finished the Q2 research..."
"Run the Content Pipeline workflow again..."
"Send an update request to the Marketing team..."
"Show me what thomas built today..."
"What's the Engineering team working on right now?"
"Ask all agents for a status update..."
```

**Layer 2: Platform-feature fallbacks (used when no context or on cold start)**

These showcase what the platform can do — without being generic:

```typescript
"Build a workflow that posts to LinkedIn every Monday..."
"Create an agent for customer support research..."
"Set up a routine that emails the weekly digest..."
"Deploy the Q2 Marketing bundle to this workspace..."
"Research competitors in the CRM space..."
"Ask an agent to build a landing page for this idea..."
"Schedule the newsletter workflow for every Friday at 9am..."
"Set a goal: generate 10 content pieces per week..."
"Which agents are online right now?"
```

**Rules:**
- Layer 1 phrases take slots 1–3 of the cycle; Layer 2 fills slots 4–6
- If no agents yet (cold start): all slots are Layer 2, seeded toward onboarding phrases
- Phrases never start with "I" (platform-focused, not self-referential)
- Every phrase ends with `...` — it feels like an invitation, not an instruction
- When the user starts typing, the placeholder immediately disappears (no awkward overlap)
- Phrase list is defined in `placeholderPhrases.ts` — editable without code changes

**Cold render note:** Layer 1 phrases (workspace-aware) require agent names to be loaded. On first render, if agents have not yet resolved from the workspace context, the cycle begins with Layer 2 fallbacks. When agents load, Layer 1 phrases enter rotation on the next cycle — no jump, no restart. The transition is seamless because the cycle is sequential, not random.

**Recipient selector** (left pill — the key addition):

The operator always knows WHERE their message is going. The pill shows the current routing target. Default: last used recipient, falling back to `💬 General` (the workspace room) on first use. Click to open the picker.

There is no AI auto-routing. The operator explicitly selects every destination. The system remembers the last selection so experienced operators never re-pick. New operators always land somewhere safe (General).

```
┌─────────────────────────────────────────────────────────────┐
│  Route this to...                                           │
├─────────────────────────────────────────────────────────────┤
│  🔁 💬 Marketing              (last used)                   │
├─────────────────────────────────────────────────────────────┤
│  ── Rooms ──────────────────────────────────────────────── │
│  🏠 General                  (workspace-wide, always safe)  │
│  ● MARKETING                                                │
│    💬 Marketing room         (team's default)               │
│    💬 Campaign Q3            (custom room)                  │
│  ● ENGINEERING                                              │
│    💬 Engineering            (team's default)               │
│                                                             │
│  ── Direct to agent ────────────────────────────────────── │
│  🤖 thomas         ●M        (Marketing team)              │
│  🤖 shoulder       ●M                                       │
│  🤖 claude-dev     ●E        (Engineering team)            │
│                                                             │
│  ── Broadcast ──────────────────────────────────────────── │
│  📢 All agents               (fleet broadcast)             │
│  📢 MARKETING team           (team broadcast)              │
│  📢 ENGINEERING team                                        │
└─────────────────────────────────────────────────────────────┘
```

**Inline routing shortcuts (type in the bar, recipient auto-switches):**
- Type `@thomas` → recipient snaps to `🤖 thomas ●M`
- Type `#marketing` → recipient snaps to `💬 Marketing room`
- Type `/broadcast` → recipient snaps to `📢 All agents`
- Delete the `@` or `#` → recipient reverts to the previously selected recipient

**Input behaviors:**
- Plain text → natural language task, routes to selected recipient
- `/` → slash command autocomplete panel (autocomplete pops above the bar)
- `@name` → inline @mention (different from recipient selector — this @mentions someone within the message)
- `#resource` → attaches a resource reference
- Paste a URL → bar detects URL, shows inline prompt below: "Analyze this page / Research this / Import as resource"
- Drop a file or image → shows inline: "What should I do with this?" with agent suggestions
- `↑` → cycle through last 5 sent messages (command history)

**Keyboard:** `Enter` to send. `Shift+Enter` for newline. `Escape` to close suggestions or clear routing shortcuts.

---

### 3.3 Contextual Suggestions (The Chips)

The chips below the command bar are NOT static, pre-written prompts. They are computed dynamically from the current workspace state every time the home page loads and whenever a relevant realtime event arrives.

**Architecture:**

```typescript
// useContextualSuggestions.ts — pure function, no API calls
// Called on mount and on AGENT_WORK_STEP / RUN_COMPLETED / APPROVAL_REQUESTED events

type SuggestionContext = {
  activeRuns:       Run[]   | null   // null = socket not yet connected
  recentArtifacts:  Artifact[] | null  // null = API cache not yet populated
  pendingApprovals: Approval[] | null  // null = API cache not yet populated
  agents:           Agent[]           // always available from workspace context
  teams:            Team[]            // always available from workspace context
  workspaceAge:     number            // days since first run (cold-start detection)
  lastActivityAt:   Date | null
}

// When a source is null, skip that priority tier and continue to the next.
// This prevents suggestions from flickering as async sources resolve.
// Returns max 4 suggestions, ordered by priority
function computeSuggestions(ctx: SuggestionContext): Suggestion[]
```

**Priority hierarchy (first match wins for each slot):**

| Priority | Condition | Suggestion label | Pre-fills |
|---|---|---|---|
| 1 | `pendingApprovals.length > 0` | "Review [agent]'s request" | Recipient: `@agent`, prompt: `/approve` |
| 2 | `activeRuns.length > 0` | "Ask [agent] for a status update" | Recipient: `@agent`, prompt: `/status` |
| 3 | `recentArtifacts[0]` exists | "Improve '[artifact title]'" | Recipient: `@agent`, prompt seeded with artifact context |
| 4 | `recentArtifacts.length > 0` | "Run '[workflow]' again" | `/run [workflow-name]` |
| 5 | Agent has `defaultSuggestion` field | That agent's configured suggestion | Recipient: that agent |
| 6 | Cold start (`workspaceAge < 1d`, no runs) | "Create your first workflow" | `/create workflow` |
| 7 | Cold start, no agents | "Set up an agent" | Route: `/agents/new` |

**Rules:**
- Suggestions never repeat the same agent twice in one set
- If `activeRuns.length > 2`: one suggestion is always a broadcast status check: "Ask the team for an update"
- Suggestions update on each realtime event — they are reactive, not stale
- Operator can dismiss individual chips (persisted in `localStorage` for 24h, then they return)
- The chips are small pills, not big buttons. They feel like hints, not a menu.

---

### 3.4 Session Layout Transition (The Send)

When the operator submits a message from the home launcher, the platform transitions to **session mode**. This is a fluid animation — not a page navigation.

**What happens on send:**

```
Frame 0 (on Enter):
  → The greeting and contextual chips fade out upward (200ms, ease-out)
  → The command bar anchors to the bottom of the content area

Frame 1 (100ms in):
  → The message appears at the bottom of an expanding thread area
  → The thread area grows upward from the command bar
  → The sidebar narrows from 240px to 56px (icon-rail mode)
  → URL updates to /chat/:sessionId (history.pushState — no reload)

Frame 2 (300ms in):
  → The agent typing indicator appears in the thread
  → The session is live
  → The artifact panel slot becomes available on the right (collapsed, waiting)

Reverse (back to launcher):
  → User clicks Home nav item, or presses Escape with empty composer
  → Thread collapses back down with a fade
  → Sidebar expands back to label mode
  → Greeting and chips fade in
  → URL returns to /home
  → The thread persists — accessible from Chat panel anytime
```

**Session layout (post-send):**

```
┌────┬────────────────────────────────────────────┬───────────────────┐
│    │                                            │                   │
│ 56 │  ACTIVE THREAD / ROOM                      │  ARTIFACT PANEL   │
│ px │                                            │  (slides in when  │
│    │  [Agent response + rich cards streaming]   │   RUN_COMPLETED   │
│    │                                            │   or pinned)      │
│    │                                            │                   │
│    │  ────────────────────────────────────────  │                   │
│    │  [💬 General ▾]  Continue or new message  [→]  │                │
└────┴────────────────────────────────────────────┴───────────────────┘
```

The command bar at the bottom now composites the running thread. Recipient pill stays — the operator can switch mid-session to redirect to a different agent or room without leaving the session.

If the operator sends a second message while the first is still running, a second thread card appears in the session. The session is multi-track.

**Implementation note:**
- Layout mode managed via `useLayoutMode()` context (`'launcher' | 'session'`), shared across `Sidebar`, `HomePage`, and `ChatPanel`. All three must be children of the same provider to animate simultaneously.
- `/chat/:sessionId` is a React Router route (not `history.pushState`). This keeps the navigation stack correct — the browser back button collapses the session properly.
- `sessionId` is created optimistically on send (client-generated `nanoid()`), written to the URL immediately. The server confirms or creates the conversation row on first response. If the request fails, the session URL is cleaned up silently.
- Sidebar width transition: `transition: width 300ms ease-in-out`. Both `Sidebar` and the primary zone must live inside the same CSS grid container (three-column: `[rail] [main] [panel]`) so the grid re-flow drives the animation — no JavaScript animation library required.

---

### 3.5 Below-the-Fold Activity (Scroll Content)

Scrolling down on the home launcher reveals the full ops view. This content is not the hero — it surfaces only when the operator wants it. It does not fight for attention with the command bar.

**Running Now:**

Each active run is a compact card using `AGENT_WORK_STEP` events. Workflows frequently involve multiple agents — the card reflects this:
- Workflow name + status glow (`● Running`)
- Agent row: stacked avatars (team color rings) + first 2 agent names with team badges + "+N" if more than 2 (e.g., `thomas ●M · shoulder ●M · +1`)
- Current step text (typewriter effect as steps change)
- Last 3 step names inline (from `NODE_STARTED/NODE_COMPLETED` events)
- `[View]` → opens `/workflows/:id` with live canvas overlays
- `[×]` → dismiss from strip (run continues)

If the run is in `CANVAS_NODE_PLACED` state (agent building a workflow): card upgrades to show the mini canvas embed inline. This is the 10x moment visible even from the home screen.

**Needs Attention:**

Compact inline items — not a table, not a page:
- Pending approvals: agent name + question summary + `[Approve]` + `[Reject]` (inline, fires API)
- Failed runs: workflow name + failed node name + `[Retry]`
- Max 3 items shown; `"View all →"` to notification bell panel
- Inline approve/reject resolves the item immediately without navigation

**Recently Built:**

3-column artifact thumbnail grid, last 6 artifacts. Tertiary. `"View all →"` to `/artifacts`. If there are no artifacts yet: replaced with a contextual prompt — "Your agents haven't built anything yet. Try asking one to create something."

---

### 3.6 Session History

History on Agentis is not a chat log. It is an operational record of everything that happened across the workspace — sessions with agents, team rooms, runs triggered, artifacts produced, approvals given. It is organized by context (who, which team, what was built) rather than by timestamp alone.

**Distinction from `/history` (HistoryPage):** Both exist and serve different purposes.
- **Session History** (this section) = the operator's *communication* record — chat sessions, room activity, broadcasts. Organized by conversation partner and team. Lives in the Chat Panel drawer.
- **HistoryPage** (`/history`) = the *execution* record — workflow runs, node-by-node traces, durations, failures. Organized by workflow and chronology. Lives at its own route, accessible from the Workflows section and ⌘K.

Neither replaces the other. Session History is "who did I talk to and what did we accomplish." HistoryPage is "what did the engine execute."

#### Where History Lives

History is accessible from three places:

**1. The Chat Panel history button** — a small clock icon in the panel header opens the Session History panel. This is the primary access point.

**2. ⌘K → "Open history"** — keyboard-first operators use this.

**3. `/history` command in any composer** — `/history @thomas` shows thomas's recent sessions inline as a card stack.

History is NOT a top-level nav item. It does not compete for sidebar real estate with the five primary destinations. It is a drawer — always available but never in the way.

#### Session History Panel

Slides in from the left over the Chat Panel (or replaces the rooms sidebar in full-screen `/chat`).

```
┌──────────────────────────────────────────────────────────────┐
│  ← Back     Session History                     [🔍 Search] │
├──────────────────────────────────────────────────────────────┤
│  Filter:  [All ▾]  [Any team ▾]  [Any agent ▾]              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Today                                                       │
│  ──────────────────────────────────────────────────────────  │
│  ● thomas  ●M  │  "Write Q2 landing page"           2:14pm  │
│    3 artifacts · 1 approval · Workflow run                   │
│    [Resume]                                                  │
│                                                              │
│  💬 Marketing  ●M  │  Team session                  11:02am  │
│    thomas · shoulder · 12 messages · 2 artifacts             │
│    [Open]                                                    │
│                                                              │
│  Yesterday                                                   │
│  ──────────────────────────────────────────────────────────  │
│  ● shoulder  ●M  │  "Q2 market research deep dive"  3:41pm  │
│    1 artifact · 40 web searches · Workflow run               │
│    [Open]                                                    │
│                                                              │
│  💬 Engineering  ●E  │  Team session               10:15am  │
│    claude-dev · 8 messages                                   │
│    [Open]                                                    │
│                                                              │
│  📢 Broadcast  │  Fleet status check                  9:00am │
│    "All agents: report status" · 3 responses                 │
│    [View responses]                                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

#### Session Entry Types

Each history entry is typed, not just a flat list of messages:

| Type | Icon | What it shows |
|---|---|---|
| Agent thread | 🤖 + team badge | 1:1 session with an agent. Subtitle shows task description (first message, truncated), artifact count, run count |
| Room session | 💬 | Multi-agent room activity period. Shows participating agents with team badges, message count, artifacts produced |
| Team session | 👥 + team color | Filtered view: all activity within a specific team for a time range |
| Broadcast | 📢 | A fleet broadcast event + the responses it received |
| Run | ▶ | A workflow run not attached to a chat session (e.g. scheduled). Shows workflow name, status, artifact |

#### Filtering & Search

- **All / Agent threads / Rooms / Broadcasts / Runs** — type filter tabs
- **Any team** → filter by team (MARKETING, ENGINEERING, etc.) — this is the MAS-critical filter
- **Any agent** → filter by specific agent
- **Search** → full-text search over session titles (first messages), artifact names, and room names

When filtered by team, the history shows everything that happened in that team's scope: threads with team agents, the team room, any runs triggered within that team context.

#### Resuming a Session

**[Resume]** on a thread re-opens it in the current session layout. The full message history loads; the agent is ready for follow-up. The command bar pre-selects that agent as recipient.

**[Open]** on a room re-opens the room at its last message. The operator can scroll up to read history, or continue messaging.

This is particularly important for multi-agent handoffs: the operator might have started something with `thomas`, which triggered a run that `shoulder` later completed. The session history shows this lineage as connected entries on the same day.

---

## 4. The 10x Moments

These are the two experiences that no other platform has. They must be protected, amplified, and never buried behind navigation.

### 4.1 Live Canvas Construction (Agent Builds a Workflow)

When an agent is building a workflow via the Goals planner or a `/create workflow` command, the engine emits `CANVAS_NODE_PLACED`, `CANVAS_EDGE_CONNECTED`, and `CANVAS_BUILD_COMPLETE` events.

This sequence must be surfaced as a LIVE VISUAL EXPERIENCE, not a background process.

**Where it appears:**
1. **In the chat thread** that triggered the build: a live canvas embed appears inside the message thread. Nodes appear one by one. The agent narrates in text alongside. The canvas is interactive — tap any node to see its config.
2. **In the artifact panel** (auto-opens): the panel switches to "canvas mode" showing the full mini canvas being built. At `CANVAS_BUILD_COMPLETE`, a CTA appears: "View full workflow →"
3. **In the home Running Now strip** (if active): the run card upgrades to show the mini canvas embed

**The sequence in the chat thread:**

```
[thomas]
  I'll build this workflow for you. Let me start with the trigger...

  ┌─────────────────────────────────────────────────────┐
  │ ░ Building workflow — live                          │
  │                                                     │
  │  [Trigger] ──→ [Web Search] ──→ [Summarize]        │
  │     ✓              ▌ placing...       ○             │
  │                                                     │
  │  3 of 6 nodes placed                               │
  └─────────────────────────────────────────────────────┘

  Adding a web search node to gather competitor data...

[thomas]
  Done! Here's the full workflow. [View on canvas →]
  ┌─────────────────────────────────────────────────────┐
  │ ✓ Workflow complete — 6 nodes                       │
  │  [Trigger]→[Search]→[Analyze]→[Write]→[Review]→[Send]│
  │                              [Run now]  [View full]  │
  └─────────────────────────────────────────────────────┘
```

**Technical wire:**
- Subscribe to `CANVAS_NODE_PLACED`, `CANVAS_EDGE_CONNECTED`, `CANVAS_BUILD_COMPLETE` in the thread view
- Filter by `runId` that spawned this thread
- Use a mini React Flow instance (read-only, no handles) for the live embed
- `CANVAS_BUILD_COMPLETE` fires a confetti/glow pulse and shows the Run + View CTAs

### 4.2 Artifact Reveal (Run Completes, Output Appears)

When a `response` node completes a run that produces an artifact:
1. `RUN_COMPLETED` event fires
2. The artifact panel slides open automatically (no click required)
3. The artifact renders at full fidelity in the panel
4. The chat thread updates with a completion card

This must feel instantaneous. Zero navigation. The thing appears.

---

### 4.3 Interaction States & Display Intelligence

This is the platform's "routing brain." It determines what layout, what panel, and what content to show in response to each type of operator action and each type of agent event. These are not rigid rules — they are signal → response mappings that stack and override based on priority.

#### Intent Classification (Client-Side, Before AI Response)

When the operator submits a message, the platform does a lightweight client-side pass to predict the intent and set up the correct layout BEFORE the server responds. This makes the platform feel instantaneous.

| Input signal | Classified intent | Immediate UI response |
|---|---|---|
| Free text → recipient is a room | Room message | Room view expands, message appears in thread immediately (optimistic) |
| Free text → recipient is an agent or Auto | Agent task | Thread opens, agent typing indicator appears |
| `/create workflow` (explicit slash command) or high-confidence natural language match (`/(create|build|set up|make)\s+(me\s+)?(a\s+)?workflow/i`, confidence ≥ 0.85) | Workflow build intent | Canvas embed placeholder pre-loads in thread; canvas panel slot activates on right. **Low-confidence matches** (e.g., `"does this workflow exist"`, `"run the workflow"`) do NOT trigger canvas mode — a small intent clarification row appears below the message: `"Did you mean to build a new workflow? [Yes, build one] [No, just asking]"` |
| `/run [name]` | Explicit workflow trigger | Run status card skeleton appears in thread |
| URL pasted into bar | External resource | Below-bar suggestion row: "Research this page / Analyze this site / Import as resource" — operator picks before sending |
| Image or file dropped | Media input | Below-bar row: agent suggestions based on file type + detected agents' capabilities |
| Second message while run in progress | Continuation or new track | New message adds to the active session; parallel run card shows if intent is different task |
| `@agentname` typed inline | Direct address mid-message | Recipient pill snaps to that agent silently |

The classification is purely lexical + pattern-matching — no AI call. The AI is called once, on send.

#### Agent Event → Display Mode Mapping

These are the realtime event hooks that drive what surfaces in the UI. They are independent of which page the operator is on — they fire globally through the shell.

| Realtime event | Primary surface | What shows |
|---|---|---|
| `AGENT_WORK_STEP` | Active thread or session home strip | Live step text update (typewriter) |
| `CANVAS_NODE_PLACED` | Active thread (canvas embed) | New node appears in the mini React Flow; step counter increments |
| `CANVAS_EDGE_CONNECTED` | Active thread (canvas embed) | Edge animates in |
| `CANVAS_BUILD_COMPLETE` | Active thread + artifact panel | Canvas embed freezes into a final state; "Run now / View full" CTAs appear; artifact panel switches to canvas mode |
| `RUN_COMPLETED` with artifact | Shell (artifact panel) | Artifact panel slides in (floating mode, 360px); artifact renders at full fidelity |
| `RUN_COMPLETED` without artifact | Active thread | Agent posts a completion summary message |
| `RUN_FAILED` | Bell + active thread or agent's home room | Failure card with error summary + [Retry] |
| `APPROVAL_REQUESTED` | Active thread or agent's home room + bell | Inline approval card in the thread; bell badge increments |
| `AGENT_PROACTIVE_PUSH` | Agent's home room | Rich message of the appropriate type |
| `NODE_STARTED` | Active thread (run status card) | Step row updates from queued → live |
| `NODE_COMPLETED` | Active thread (run status card) | Step row updates from live → done + duration |

#### When the Canvas Shows vs. When It Stays Hidden

**Canvas (full-page or embedded) appears when:**
- User navigates explicitly to `/workflows/:id`
- A `CANVAS_NODE_PLACED` event arrives for an active run in the current thread (mini embed in thread)
- User sends `/create workflow` or `/run`
- User clicks "View full canvas →" on any canvas embed card or run card

**Canvas does NOT appear for:**
- Simple conversational agent replies (text answers, document output, code snippets)
- Background scheduled runs — these appear in the home strip and bell, not as canvas overlays unless opened
- Multi-step agent tasks that don't use the workflow canvas (e.g., direct tool calls without a visual graph)
- Artifact generation by an agent that uses internal steps without a named workflow

**The rule:** Canvas is the show when there IS a canvas. When there isn't, the output (artifact, text, code) is the show. Never show an empty canvas as a default state.

#### Session Continuation Logic

A session persists as long as the thread is open. The operator can:
- Send follow-ups in the same thread (continues the same agent context)
- Switch the recipient mid-session (new branch, tracked as a separate thread)
- Send to a room while a thread is active (room message is sent; thread stays active in panel)

Session ends:
- Operator navigates to a page other than `/home` or `/chat` (session becomes background; thread accessible from Chat panel)
- Thread receives `RUN_COMPLETED` or agent sends a conversation-ending signal

---

## 5. The Artifact System

### 5.1 What Is an Artifact

An artifact is any structured output produced by a `response` node, or a direct agent conversation reply containing renderable content. It is:

- **Typed:** `html | image | document | code | data`
- **Sourced:** linked to `workflowRunId + nodeId` or `conversationId`
- **Titled:** auto-generated from content (first heading / filename / content hash), manually editable
- **Thumbnailed:** captured server-side or inferred (type icon fallback)
- **Versioned:** multiple runs of the same workflow produce linked versions

**DB schema (new `artifacts` table):**
```sql
artifacts:
  id           TEXT PK
  workspaceId  TEXT FK workspaces.id
  userId       TEXT FK users.id
  runId        TEXT FK workflow_runs.id  (nullable)
  nodeId       TEXT                      (nullable, which node produced it)
  conversationId TEXT FK conversations.agentId (nullable)
  type         TEXT  -- html|image|document|code|data
  title        TEXT
  content      TEXT  -- raw output (HTML string, image URL, markdown, code)
  thumbnailUrl TEXT  (nullable)
  metadata     TEXT  -- JSON: {agentId, workflowId, sourceNodeKind, sizebytes}
  createdAt    TEXT
  updatedAt    TEXT
```

**API:**
- `GET /v1/artifacts` — list, supports `?type=&agentId=&workflowId=&limit=&cursor=`
- `POST /v1/artifacts` — create manually or from engine hook
- `PATCH /v1/artifacts/:id` — rename, update metadata
- `DELETE /v1/artifacts/:id`

**Engine hook:** when `#executeResponse` completes in `WorkflowEngine`, auto-insert artifact row with type inferred from output shape.

### 5.2 The Artifact Panel

The most important new component. Lives in the right zone of the shell.

**States:**
- `closed` — invisible, zero width, default on load
- `floating` — slides in at 360px on `RUN_COMPLETED` (auto-triggered), dismissible, does not compress main content
- `docked` — pinned by operator, main content compresses to accommodate, persisted in `localStorage`
- `fullscreen` — panel expands to full viewport width (escape key or button to exit)

**Panel structure:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  [← Artifacts]  Q2 Landing Page              [⊞ Dock]  [⤢]  [×]   │
│  ─────────────────────────────────────────────────────────────────  │
│  [Iterate]  [Store]  [Download ↓]  [Share ↗]  ···                  │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                      │
│  [RENDERED CONTENT AREA]                                             │
│                                                                      │
│  HTML     → <iframe sandbox="allow-scripts allow-forms" srcdoc>     │
│             shown inside a browser chrome mock (address bar, etc.)  │
│  Image    → <img> with zoom (scroll to zoom), download button       │
│  Document → rendered markdown with floating outline sidebar         │
│  Code     → syntax-highlighted, language tag, copy + run buttons    │
│  Data     → responsive table with export (CSV/JSON) options         │
│                                                                      │
│  ─────────────────────────────────────────────────────────────────  │
│  ▾ Source info                                                       │
│    Agent: thomas  ·  Workflow: Q2 Campaign  ·  Built: 2h ago        │
│    [View workflow →]  [View run →]                                   │
│                                                                      │
│  ▾ Versions  (if multiple runs produced this artifact)              │
│    v3  Today (current)                                               │
│    v2  Yesterday                                                     │
│    v1  3 days ago                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Toolbar actions:**
- **Iterate** — opens the chat composer pre-filled with `"Improve this: [artifact title]"` + artifact context injected
- **Store** — prompts for a title if auto-generated, then persists to the artifacts table (marks artifact as `stored`)
- **Download** — for HTML: downloads as `.html` file. Image: raw file. Doc: `.md`. Code: extension-matched.
- **Share** — copies a `/artifacts/:id` deep link to clipboard
- **`···`** — overflow: Rename, Duplicate, Link to goal, Delete

**Security:** HTML artifacts render in a sandboxed iframe with `sandbox="allow-scripts allow-forms"`. No `allow-same-origin`. No parent domain access. The iframe is served from a separate origin (`artifact.agentis.local` or data URI) to prevent any DOM escape.

**Canvas mode:** When the artifact panel is in canvas-construction mode (§4.1), the panel toolbar changes:
```
[▶ Run now]  [✎ Edit]  [View full canvas →]
```
The rendered content area shows the mini React Flow canvas embed.

### 5.3 The Artifacts Page (`/artifacts`)

The deliverables library. Gallery-first.

```
Artifacts                    [🔍 Search]            [+ Import]
──────────────────────────────────────────────────────────────
[All] [HTML] [Images] [Docs] [Code] [Data]    Date ▾  Agent ▾
──────────────────────────────────────────────────────────────

 ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
 │ [screenshot/icon]│  │ [screenshot/icon]│  │ [doc icon]       │
 │                  │  │                  │  │                  │
 │ Q2 Landing Page  │  │ Market Research  │  │ Product Spec     │
 │ HTML · thomas    │  │ Doc · shoulder   │  │ Doc · thomas     │
 │ 2 hours ago      │  │ Yesterday        │  │ 3 days ago       │
 │ [Open]  [···]    │  │ [Open]  [···]    │  │ [Open]  [···]    │
 └──────────────────┘  └──────────────────┘  └──────────────────┘
```

Clicking a card opens the artifact in the panel (floating or docked). Card `[···]` menu: Rename · Duplicate · Link to goal · Download · Delete.

The existing `LedgerPage` (structured data tables) moves to `/data`. It does NOT become the Artifacts page. It is a different tool for structured records and is accessible via ⌘K.

---

## 6. Chat & Rooms — The Platform Command Surface

This is the most ambitious section of the redesign and the one that will make or break the "every person on earth" thesis. Chat on Agentis is not a chatbot interface. It is the primary control surface for the entire platform. The operator runs their whole agent operation from here.

### 6.1 The Principle

Every meaningful action on the platform must be possible from the chat interface. Not as a power-user workaround — as the primary path. If you have to leave chat to do something, the chat experience is incomplete.

Chat replaces:
- Manual workflow triggers (type the goal, the workflow runs)
- Approval modals (approve/reject inline in the thread)
- Status dashboards (ask for status, get a live status card)
- External Slack/Discord rooms for coordinating with agents (Rooms handle this)
- Email-style notifications (proactive agent messages land in the right room)

### 6.2 Two Chat Surfaces, One Mental Model

There is no conceptual split between "chat" and "rooms." From the operator's perspective, every conversation has a recipient and a thread. The difference is in the recipient type:

| Recipient | Surface | Persistence | Participants |
|---|---|---|---|
| One agent | **Thread** | Ephemeral or saved | Operator + 1 agent |
| A room | **Room** | Always persistent | Operator + multiple agents + (future) multiple operators |
| A team | **Team room** | Auto-created, always persistent | Operator + all team agents |
| All agents | **Broadcast** | Ephemeral (no history) | Operator → all agents |

Threads (existing) are unchanged conceptually. Rooms are the new primitive.

---

### 6.3 Rooms & Teams — Deep Design

#### The Core Principle: Rooms Follow Teams

Every team gets a room automatically. Creating a team creates its room. Deleting a team archives (does not delete) its room. This means operators never have to set up communication infrastructure — it exists the moment they create a team.

Beyond the team default room, operators can create custom rooms with any combination of agents regardless of team. This handles cross-team projects and special-purpose channels.

#### Room Types

| Type | Created by | Agents | Visibility |
|---|---|---|---|
| `workspace` | System (1 per workspace, "General") | All agents auto-added | All operators in workspace |
| `team` | Auto on team creation | All team agents auto-added | Team members |
| `custom` | Operator | Manually selected | Private or workspace-scoped |
| `thread` | On any direct agent message | 1 agent | Private |

#### Team Room Auto-Creation Rule

```
ON team.created:
  INSERT INTO rooms (id, workspaceId, teamId, name, isTeamDefault, visibility)
  VALUES (uuid(), team.workspaceId, team.id, team.name, true, 'team')

  FOR each agent in team.agentIds:
    INSERT INTO room_agents (roomId, agentId)
```

When an agent is added to or removed from a team, `room_agents` updates automatically for that team's default room.

**Migration note for existing workspaces:** When this schema lands in a workspace that already has teams, a one-time migration must create default rooms retroactively. Add to the DB migration file:

```sql
-- One-time: create default rooms for all pre-existing teams
INSERT INTO rooms (id, workspaceId, teamId, name, isTeamDefault, visibility, createdAt)
SELECT hex(randomblob(16)), workspaceId, id, name, 1, 'team', CURRENT_TIMESTAMP
FROM teams
WHERE id NOT IN (
  SELECT teamId FROM rooms WHERE teamId IS NOT NULL AND isTeamDefault = 1
);

-- One-time: populate room_agents for those rooms from existing team membership
INSERT INTO room_agents (roomId, agentId, addedAt, addedBy)
SELECT r.id, ta.agentId, CURRENT_TIMESTAMP, 'system'
FROM rooms r
JOIN team_agents ta ON ta.teamId = r.teamId
WHERE r.isTeamDefault = 1
  AND NOT EXISTS (
    SELECT 1 FROM room_agents ra
    WHERE ra.roomId = r.id AND ra.agentId = ta.agentId
  );
```

This runs once at migration time. The trigger handles all future teams.

#### Agent Team Indicators (Everywhere)

Agents are never shown as a flat list. Whenever an agent appears — in a dropdown, a room member list, a thread header, a notification card — they carry their team affiliation as a small colored badge.

**Visual spec:**
- Badge: a `4×4px` colored circle (team accent color) + 1–2 letter team abbreviation, shown to the right of the agent name
- No badge if the agent doesn't belong to a team
- If agent belongs to multiple teams: show their primary team badge, `+N` for others on hover

Examples:
```
🤖 thomas      ●M    (MARKETING team, team color = orange)
🤖 shoulder    ●M
🤖 claude-dev  ●E    (ENGINEERING team, team color = blue)
🤖 ada                (no team — general agent)
```

This appears in:
- Recipient picker dropdown (command bar)
- Room member avatars
- Thread header
- Notification cards
- Agent list pages
- Any @mention autocomplete

#### DB Schema Additions

```sql
rooms:
  id             TEXT PK
  workspaceId    TEXT FK workspaces.id
  teamId         TEXT FK teams.id  (nullable — null for custom/workspace rooms)
  name           TEXT
  description    TEXT (nullable)
  isTeamDefault  INTEGER DEFAULT 0  -- 1 for the auto-created team room
  visibility     TEXT  -- workspace|team|private
  pinnedAt       TEXT  (nullable)
  createdAt      TEXT

room_agents:
  roomId         TEXT FK rooms.id
  agentId        TEXT FK agents.id
  addedAt        TEXT
  addedBy        TEXT  -- 'system' (team sync) or userId

room_messages:
  id             TEXT PK
  roomId         TEXT FK rooms.id
  authorType     TEXT  -- operator|agent|system
  authorId       TEXT  -- userId or agentId
  contentType    TEXT  -- text|artifact_card|run_card|approval_card|canvas_embed|
                       --   code|image|document|diff|data_table|system
  content        TEXT  -- JSON blob per contentType
  replyToId      TEXT  (nullable — threaded replies within a message)
  mentions       TEXT  -- JSON array of {type: 'agent'|'operator', id}
  createdAt      TEXT
```

**Realtime events (new):**
```typescript
ROOM_MESSAGE_SENT:     'room.message.sent'
ROOM_MESSAGE_RECEIVED: 'room.message.received'
ROOM_AGENT_JOINED:     'room.agent.joined'    // system: team sync
ROOM_AGENT_LEFT:       'room.agent.left'      // system: team sync
```

**Routes:**
- `GET /v1/rooms` — list rooms, includes `team` relation for grouping
- `POST /v1/rooms` — create custom room
- `PATCH /v1/rooms/:id` — rename, pin, update agent list
- `DELETE /v1/rooms/:id`
- `GET /v1/rooms/:id/messages` — paginated, cursor-based
- `POST /v1/rooms/:id/messages` — send message
- `GET /v1/rooms/for-team/:teamId` — returns the team's default room + custom rooms

---

### 6.4 Rooms Sidebar (All Chat Surfaces)

The rooms sidebar appears in both the slide-in `ChatPanel` and the full-screen `/chat` layout. It is organized by team structure, not by alphabetical order.

```
┌─────────────────────────────────────────────────────────┐
│  Rooms & Threads                          [+ New room]  │
├─────────────────────────────────────────────────────────┤
│  📌 Pinned                                              │
│    💬 Marketing    ● 2 new                              │
│    💬 General                                           │
├─────────────────────────────────────────────────────────┤
│  ● MARKETING                          [orange dot]      │
│    💬 Marketing           (team default, auto)  ● 2    │
│    💬 Campaign Q3         (custom room)                 │
│  ● ENGINEERING                        [blue dot]        │
│    💬 Engineering         (team default, auto)          │
├─────────────────────────────────────────────────────────┤
│  🏠 General               (workspace-wide)              │
├─────────────────────────────────────────────────────────┤
│  Custom rooms                                           │
│    💬 Research             (cross-team custom)          │
├─────────────────────────────────────────────────────────┤
│  Direct threads                                         │
│    🤖 thomas   ●M  ●      (online indicator)           │
│    🤖 shoulder ●M                                       │
│    🤖 claude-dev ●E                                     │
├─────────────────────────────────────────────────────────┤
│  📢 Fleet broadcast                                     │
└─────────────────────────────────────────────────────────┘
```

**Design rules for the sidebar:**
- Team sections are headers (non-clickable), not nav items — they are organizational dividers
- Team section header shows the team's color dot + team name in uppercase + agent count badge on hover
- `(auto)` label on team default rooms makes it clear they were system-created
- Unread indicator `● N` on rooms with unseen messages
- Pin any room to Pinned section (drag or right-click)
- Fleet broadcast is always at the bottom — not a room, fires a broadcast to all agents

---

### 6.5 Rich Message Types

Both Threads and Rooms render messages natively. No "follow this link to see the result." The result is in the message.

**1. Text** — Markdown rendered. `@mentions`, `#references`, code blocks inline.

**2. Artifact Card** — auto-posted by agent on `RUN_COMPLETED` with artifact:
```
┌─────────────────────────────────────────────────────────┐
│ 🖼  Q2 Landing Page                               HTML  │
│     Built just now · thomas ●M                         │
│     [Open artifact]  [Iterate]  [Download ↓]           │
└─────────────────────────────────────────────────────────┘
```

**3. Run Status Card** (in-flight):
```
┌─────────────────────────────────────────────────────────┐
│ ▶  Weekly Digest                              ● Running │
│    ✓ Gather news  ✓ Summarize  ▌ Write  ○ Send         │
│    [View live canvas →]                                 │
└─────────────────────────────────────────────────────────┘
```

**4. Approval Card** — inline, no modal:
```
┌─────────────────────────────────────────────────────────┐
│ ⚠  thomas ●M needs your approval                       │
│    "Proceed with outbound email to 2,400 prospects?"   │
│    [✓ Approve]  [✗ Reject]  [✎ Edit plan]              │
└─────────────────────────────────────────────────────────┘
```
Fires `POST /v1/approvals/:id/decide`. Card updates in-place.

**5. Canvas Embed** (live workflow build — the 10x moment):
```
┌─────────────────────────────────────────────────────────┐
│ ░  Building workflow — live                   4/6 nodes │
│    [Trigger]→[Search]→[Analyze]→[Write]→···            │
│                                ▌ placing...             │
└─────────────────────────────────────────────────────────┘
```
Mini React Flow instance, read-only, auto-updating from `CANVAS_NODE_PLACED` events.

**6. Code** — syntax-highlighted, language tag, copy button

**7. Image** — inline `<img>`, click to zoom (lightbox), download button. Shows generating agent + team badge.

**8. Document preview** — first ~150 words, word count, "Open full →" to Artifact Panel

**9. Diff card** — before/after split for when an agent edits something. Syntax highlighting on code diffs.

**10. Data table** — inline scrollable table, column headers, export CSV/JSON

**11. Team broadcast message** — distinct visual treatment: shows the broadcast icon + "Sent to all agents" or "Sent to MARKETING team"

**12. System message** — muted, small: agent joined room, run started, team member added

---

### 6.6 Slash Commands

Available in all composers (thread, room, home command bar). Autocomplete pops above the input.

| Command | Effect |
|---|---|
| `/run [name]` | Trigger a workflow → Run Status Card |
| `/create workflow` | Agent builds a workflow live → Canvas Embed |
| `/approve [id]` | Approve a pending approval by ID |
| `/reject [id]` | Reject a pending approval by ID |
| `/pause [@agent]` | Put agent on standby |
| `/wake [@agent]` | Wake agent from standby |
| `/status` | Fleet status card: live agents, active runs, pending approvals |
| `/artifacts [n]` | Last n artifacts as a carousel (default 6) |
| `/history [workflow]` | Last 5 run cards for a workflow |
| `/broadcast [message]` | Send to all agents (fleet broadcast) |
| `/broadcast @team [message]` | Send to all agents in a team |
| `/room [name]` | Jump to or create a room |
| `/deploy [package]` | Deploy a package to current workspace |

---

### 6.7 Proactive Agent Posting

Agents post to rooms without being asked. **This is the feature that replaces external Slack.** The agent's "home room" is set in their config — it defaults to their team's default room.

| Trigger | What agent posts | To |
|---|---|---|
| `AGENT_WORK_STEP` (major steps only, throttled) | Short text update: "Working on X..." | Home room |
| `RUN_COMPLETED` with artifact | Artifact Card | Home room |
| `RUN_COMPLETED` without artifact | Brief completion summary | Home room |
| `RUN_FAILED` | Failure card + [Retry] | Home room |
| `APPROVAL_REQUESTED` | Approval Card | Home room + bell |
| `AGENT_PROACTIVE_PUSH` | Structured message (any type) | As configured |

**Throttling rule:** `AGENT_WORK_STEP` proactive posts are throttled to at most 1 per 30 seconds per agent. The realtime step indicator in threads updates every event, but proactive room posts are batched. Otherwise rooms become noise.

---

### 6.8 Team Broadcasts

Sending a broadcast to a team is a first-class action — not a workaround.

**How it works:**
1. Operator selects "📢 MARKETING team" in the recipient picker (or types `/broadcast @marketing`)
2. The message is delivered to each agent in the MARKETING team as a direct instruction
3. A broadcast message card appears in the Marketing room showing what was sent and to whom
4. Each agent responds in their own direct thread (not in the room — responses are private unless the agent posts to the room proactively)
5. The broadcast card in the room shows "Received by 3/3 agents" and updates as agents acknowledge

Broadcast is not a room message — it is a fleet instruction. The room just records that it happened.

---

### 6.9 Full-Screen Chat (`/chat`)

Full-screen chat for focused operators. Same components, expanded layout. The session-mode layout from §3.4 is effectively this view.

```
┌─────────────────┬──────────────────────────────────────────────────┐
│  ROOMS SIDEBAR  │  ACTIVE ROOM / THREAD                            │
│  (240px)        │                                                   │
│                 │  💬 Marketing  ●M  [thomas ●M]  [shoulder ●M]    │
│  [see §6.4]     │  ────────────────────────────────────────────    │
│                 │  [message stream with rich type cards]            │
│                 │                                                   │
│                 │                                                   │
│                 │  ────────────────────────────────────────────    │
│                 │  [💬 General ▾]  Message...                    [→]   │
│                 │                                                   │
└─────────────────┴──────────────────────────────────────────────────┤
                  │  ARTIFACT PANEL  (pinnable, same as shell panel)  │
                  └──────────────────────────────────────────────────┘
```

The artifact panel is available in the full-screen chat view as well, pinnable to the right. This means: the operator can have the full-screen chat open with a room on the left and a live artifact being built on the right — the complete picture.

---

## 7. Packages — Saveable, Deployable Configurations

Packages are NOT just a renamed skill library. They are first-class, versioned, exportable configuration bundles that operators create from their own work and can re-use, share, and eventually deploy to AgentisHub.

### 7.1 What a Package Is

A Package is a named, versioned bundle of one of four types:

| Type | What it contains | Created from |
|---|---|---|
| `workflow` | A workflow graph + settings + trigger config | "Save as package" from WorkflowCanvasPage |
| `agent` | An agent's config: model, playbook, skills, budget, channels | "Save as package" from AgentDetailPage |
| `skill` | A skill manifest + runtime + entrypoint | From SkillsPage or installed registry artifact |
| `bundle` | Any combination of the above — an entire use-case kit | Assembled in PackagesPage |

### 7.2 Package Lifecycle

```
Create → Test → Version → Export / Deploy
  ↑                              ↓
  └──────── Import from file ────┘
                                 ↓
                          AgentisHub (future)
```

1. **Create** — from any asset's "Save as package" action, or assembled from scratch in PackagesPage
2. **Test** — one-click deploy to current workspace (replaces existing config)
3. **Version** — bump version, write changelog, tag as stable/beta
4. **Export** — download as `.agentis-pkg` file (JSON + checksum)
5. **Import** — drag `.agentis-pkg` onto PackagesPage or use "Import" button
6. **Deploy to AgentisHub** — greyed out with "Coming with AgentisHub" until V2 (but the button exists now)

### 7.3 PackagesPage (`/packages`)

Same route (`/library` deleted from code — not redirected). Redesigned content:

```
Packages                              [+ New package]  [↑ Import]
──────────────────────────────────────────────────────────────────
[All] [Workflows] [Agents] [Skills] [Bundles]
──────────────────────────────────────────────────────────────────

 ┌─────────────────────────────────────────────────────────────┐
 │ ⬡ Q2 Marketing Bundle            bundle  v1.2.0            │
 │   3 workflows · 2 agents · 4 skills                        │
 │   [Deploy]  [Export]  [AgentisHub ↗ (coming soon)]  [···] │
 └─────────────────────────────────────────────────────────────┘
 ┌─────────────────────────────────────────────────────────────┐
 │ ✦ Content Pipeline Workflow       workflow  v2.0.1          │
 │   Auto-triggered · 8 nodes · Used in 3 workspaces          │
 │   [Deploy]  [Export]  [View graph]  [···]                  │
 └─────────────────────────────────────────────────────────────┘
```

---

## 8. Navigation & Route Map

### 8.1 Route Table

| Route | Component | Status |
|---|---|---|
| `/home` | `HomePage` (rebuilt) | Redesigned |
| `/agents` | `AgentsPage` | Keep, minor changes |
| `/agents/:id` | `AgentDetailPage` | Keep — **own phase** (Goals tab + Memory tab + Workflows tab + Save as package) |
| `/teams/:id` | `TeamPage` | Keep |
| `/workflows` | `WorkflowsPage` | Keep |
| `/workflows/:id` | `WorkflowCanvasPage` | Keep, add artifact panel wire |
| `/history` | `HistoryPage` | Keep |
| `/runs/:id` | `RunDetailPage` | Keep |
| `/artifacts` | `ArtifactsPage` (new) | New page |
| `/artifacts/:id` | opens artifact panel | Redirect to `/artifacts?open=:id` |
| `/packages` | `PackagesPage` (was LibraryPage) | Renamed, redesigned |
| `/data` | `LedgerPage` (renamed) | Renamed, removed from nav |
| `/chat` | `ChatPage` (extended) | Redesigned with Rooms sidebar |
| `/settings` | `SettingsPage` | Redesigned, add Account section |

### 8.2 Routes That Get DELETED (Not Redirected)

The codebase is cleaned. Dead code is removed. No redirect graveyard.

**Deleted from `App.tsx` entirely:**
- `/approvals` route and `ApprovalsPage` import — functionality absorbed into notification bell + inline approval cards in chat
- `/library` route and `LibraryPage` import — replaced by `/packages` and `PackagesPage`
- `/records` route and `LedgerPage` as "Records" — renamed to `/data`, demoted
- `/memory` route as primary destination — moved into `/settings?tab=memory`
- `/scheduler` and `SchedulerPage` route — merged into `/workflows?tab=schedules`
- `/routines` and `RoutinesPage` route — merged into same
- `/conversations` route — `/chat` covers it completely
- All back-compat redirect `<Navigate>` entries that point to removed pages

**Deleted page files:**
- `apps/web/src/pages/ApprovalsPage.tsx` (notification bell + inline cards replace it)
- `apps/web/src/pages/LibraryPage.tsx` (replaced by `PackagesPage.tsx`)
- `apps/web/src/pages/RoutinesPage.tsx` (merged into workflows schedules tab)

**Files renamed:**
- `LibraryPage.tsx` → `PackagesPage.tsx`
- `LedgerPage.tsx` remains but route changes from `/records` to `/data`

**Sidebar changes (Sidebar.tsx):**
- Remove: Goals, Memory, Scheduler, Approvals, Teams (top-level) nav items
- Remove: `WorkspaceContextBlock` import and render
- Add: Teams as accordion sub-items under Agents
- Reduce to 5 primary + Settings

### 8.3 Sidebar Final State

```typescript
const PRIMARY: NavItem[] = [
  { to: '/home',      label: 'Home',      icon: Home },
  { to: '/agents',    label: 'Agents',    icon: Bot,      badge: 'liveAgents' },
  { to: '/workflows', label: 'Workflows', icon: Workflow, badge: 'activeRuns' },
  { to: '/artifacts', label: 'Artifacts', icon: Frame },
  { to: '/packages',  label: 'Packages',  icon: PackageOpen },
];
// Teams render as sub-items under Agents (separate TeamSubItems component)
```

---

## 9. Displaced Features — Where They Live Now

Several features were removed from the primary navigation: Memory, Scheduler, Routines, and long-horizon objective management. The first three were redistributed to the surfaces where they are most relevant. Objective management is deferred beyond V1.

### 9.1 Objective Management

V1 removes the standalone objective surface and related persistence. Future work should reintroduce this as a cohesive V2 product area with fresh routes, schemas, planning controls, and operator UX rather than carrying the former V1 implementation forward.

---

### 9.2 Memory

**Old:** `/memory` — a page listing the workspace's shared memory entries.

**New:** Memory is split into two scopes, accessible from two places:

| Scope | Surface | Route |
|---|---|---|
| **Agent memory** (what a specific agent remembers) | Agent detail page → Memory tab | `/agents/:id?tab=memory` |
| **Workspace memory** (shared context available to all agents) | Settings → Memory tab | `/settings?tab=memory` |

**Why the split:** Agent memory is specific to that agent's context — it is most useful to see it alongside the agent's config, goals, and history. Workspace memory is global and belongs in Settings alongside other workspace-level configuration.

**Accessing agent memory from chat:** Asking `@thomas what do you remember about our product?` is the natural interface. The agent responds. The `/agents/:id?tab=memory` UI is for structured editing when needed.

**⌘K:** "Manage workspace memory" → Settings memory tab. "View thomas's memory" → Agent detail memory tab.

---

### 9.3 Scheduler

**Old:** `/scheduler` — a page for scheduling workflow runs at a time or interval.

**New:** Scheduling is a property of a workflow, not a separate place. It lives in two surfaces:

| Surface | How to access | What you can do |
|---|---|---|
| **Workflows page — Schedules tab** | `/workflows?tab=schedules` | View and manage all scheduled runs across all workflows in one place |
| **Workflow canvas page** | `/workflows/:id` → sidebar → Schedule | Set the schedule for that specific workflow. Cron or human-readable interval. Enable/disable. |
| **Command bar** | `Schedule 'Weekly digest' for every Friday at 9am` | Natural language schedule creation. Agent confirms with a schedule card. |

**Why:** Scheduling a workflow is a configuration detail of that workflow. Showing all schedules together in `/workflows?tab=schedules` gives the overview without needing a separate navigation destination.

**⌘K:** "View scheduled workflows" → `/workflows?tab=schedules`

---

### 9.4 Routines

**Old:** `/routines` — a page for defining recurring agent behaviors beyond simple schedules (conditional logic, event-triggered sequences).

**New:** Routines are merged into the Workflows concept. A Routine is a Workflow with a trigger type of `schedule` or `event` rather than `manual`. The distinction was implementation-level, not product-level.

| Surface | How to access |
|---|---|
| **Workflows page — Schedules tab** | `/workflows?tab=schedules` — shows both time-based and event-triggered workflows |
| **Workflow canvas page** | Trigger node → trigger type → `Manual / Schedule / Event / Webhook` |
| **Agent detail page** | `/agents/:id` → Workflows tab — shows all workflows (incl. routines) this agent runs |

**Why:** From the operator's perspective, "this workflow runs automatically when X" is the same mental model as "this workflow runs at time Y." The trigger type determines the behavior; there is no need for two separate concepts.

**⌘K:** "Create a routine" → creates a new workflow with event trigger pre-selected.

---

### 9.5 Summary Table

| Feature | Old route | Where it lives now | Primary access |
|---|---|---|
|---|
| Memory (agent) | `/memory` | `/agents/:id?tab=memory` | Agent detail page |
| Memory (workspace) | `/memory` | `/settings?tab=memory` | Settings |
| Scheduler | `/scheduler` | `/workflows?tab=schedules` | Workflows page |
| Routines | `/routines` | `/workflows?tab=schedules` | Workflows page |
| Approvals | `/approvals` | Notification bell dropdown | Header bell |
| Records / Ledger | `/records` | `/data` | ⌘K only |
| Library (packages) | `/library` | `/packages` | Nav sidebar |

All of these are also accessible via ⌘K with natural language. ⌘K is the escape hatch for any operator who cannot remember where something moved.

---

## 10. Theme System

### 9.1 Dark Mode (Default — Unchanged)

The existing dark theme is the Agentis brand. It is NOT changed. Colors confirmed from `tailwind.config.js`:

```
canvas:       #08090b   (page background)
surface:      #0f1014   (card backgrounds)
surface-2:    #15171c   (nested surfaces, hover)
line:         #22262d   (borders, dividers)
text-primary: #e8eaee
text-muted:   #7a8390
accent:       #9cffb0   ← the green. This is correct. Keep it.
accent-soft:  #9cffb01a
danger:       #ff7a7a
warn:         #f6c177
```

The green `#9cffb0` is the signal color throughout: live indicators, active states, glow effects. Do not introduce purple. The green is the brand.

### 9.2 Light Mode (New)

Applied via `html[data-theme="light"]`. Adapted from `PERPLEXITY-STYLE.md` into the Agentis token system:

```css
html[data-theme="light"] {
  --tw-canvas:        #FFFFFF;
  --tw-surface:       #F7F7F5;
  --tw-surface-2:     #EEECEA;
  --tw-line:          rgba(0,0,0,0.08);
  --tw-text-primary:  #0A0A0B;
  --tw-text-muted:    #72706B;
  --tw-accent:        #16a34a;   /* green-600 — the green, but richer in light mode */
  --tw-accent-soft:   #16a34a1a;
  --tw-danger:        #dc2626;
  --tw-warn:          #d97706;
}
```

In light mode the green accent shifts to a richer green-600 (#16a34a) which reads better on white backgrounds than the fluorescent mint.

**Typography in both modes:** Inter, weights 400 (body) and 500 (labels). No font change.

**Border radii (both modes, Perplexity-inspired):**
- Cards: `16px`
- Inputs: `8px`
- Buttons: `9999px` (pill shape — replace square buttons on CTAs)
- Nav items: `8px`

**Light mode elevations:** background color shifts only, no shadows. Perplexity style: Paper White → Parchment → Slightly Off creates depth without `box-shadow`.

### 9.3 Theme Toggle

- Avatar dropdown: `🌙 Dark / ☀ Light` toggle (sets `html[data-theme]` + `localStorage`)
- Also via ⌘K → "Switch to light mode"
- Persisted in user settings server-side: `PATCH /v1/settings {preferences: {theme: 'light'|'dark'}}`
- On login: restore from user preferences before first render (prevent flash)

---

## 11. Notification System

The bell is the ONLY interruption channel. No toast notifications for approvals. No banners. One place.

### 10.1 Bell Dropdown

Opens from the header bell. A floating panel, never a page navigation.

```
Notifications                                     [Mark all read]
──────────────────────────────────────────────────────────────────
⚠  thomas needs your approval               2 min ago
   "Proceed with outbound email to 2,400?"
   [✓ Approve]  [✗ Reject]  [View context →]
──────────────────────────────────────────────────────────────────
✓  Landing page complete                     1 hour ago
   Built by shoulder · HTML artifact
   [Open artifact →]
──────────────────────────────────────────────────────────────────
✗  Workflow "Weekly digest" failed           2 hours ago
   Node "Web search" timed out
   [Retry]  [View run →]
──────────────────────────────────────────────────────────────────
```

**Badge count:** `pending_approvals + failed_runs (unread) + room_mentions (unread)`

**Approve/reject inline:** fires `POST /v1/approvals/:id/decide`, card updates in-place.

**Approval detail:** clicking "View context →" opens a modal overlay (no navigation), shows plan graph + full context, with full Approve / Reject / Edit plan controls.

**Room mention:** clicking a room mention notification opens the Chat panel on that room + jumps to the message.

---

## 12. Implementation Phases

Two tracks. Ship Track A first. Track B (Rooms) is a separate release cycle.

**Track A — Core Platform (~7 weeks)**
Delivers: shell cleanup, notification bell, artifact system, home page, canvas-in-chat, AgentDetailPage tabs. Fully usable product without Rooms.

**Track B — Rooms (~3.5 weeks)**
Delivers: team rooms, proactive agent posting, rich message types. The platform communication layer.

---

### Phase 1 — Shell & Navigation (5 days)
Highest visibility, lowest risk.

- `Sidebar.tsx`: reduce to 5 items + Settings, add Teams accordion, remove WorkspaceContextBlock
- `App.tsx` Shell: remove LogOut button, add avatar dropdown (with sign-out + theme toggle placeholder), add notification bell placeholder
- `App.tsx` routes: delete `/approvals`, `/library`, `/records` as primary routes; rename `/library` component to `PackagesPage.tsx`
- Add `/artifacts` route (empty page placeholder)
- Add `/packages` route pointing at renamed `PackagesPage`
- **Establish CSS custom property token system** (`--color-canvas`, `--color-surface`, etc. mapped to current dark values) — 2-hour sub-task; enables light mode later without retrofitting every component
- Run tsc + vitest to confirm green

### Phase 2 — Notification Bell (3 days)

- Build `NotificationBell.tsx` + `NotificationDropdown.tsx` in `components/notifications/`
- Build `ApprovalDetailModal.tsx` (reuses decision UI from existing ApprovalsPage before deletion)
- Wire badge count from existing `/v1/approvals` + `/v1/runs` polling
- Subscribe to `APPROVAL_REQUESTED` + `RUN_FAILED` + `RUN_COMPLETED` realtime events
- Delete `ApprovalsPage.tsx` after NotificationDropdown covers all cases
- Vitest coverage for bell badge count

### Phase 3 — Artifact System Backend (5 days)

- Add `artifacts` table to `packages/db/src/sqlite/schema.ts` + `embedded-sql.ts`
- Build `apps/api/src/routes/artifacts.ts` (CRUD)
- Add engine hook in `WorkflowEngine.#executeResponse` to auto-insert artifact row
- `GET /v1/artifacts` with filter params
- Vitest: artifact creation, listing, type inference
- E2E: workflow run produces artifact in DB

### Phase 4 — Artifact Panel & Page (5 days)

- Build `apps/web/src/components/artifacts/ArtifactPanel.tsx`:
  - Closed / floating / docked states
  - HTML iframe renderer (sandboxed srcdoc)
  - Image, markdown, code, data renderers
  - Toolbar: Iterate, Store, Download, Share
  - Source metadata accordion
  - Version list
- Build `apps/web/src/pages/ArtifactsPage.tsx`:
  - Grid layout, filter bar, reads `/v1/artifacts`
  - Click card → open panel
- Wire `RUN_COMPLETED` event → auto-open panel in Shell
- Web vitest for ArtifactPanel render by type

### Phase 5 — Home Page Rebuild (8 days)

**Must come before Phase 6 (canvas embed).** Home rebuild establishes the final thread architecture (`useLayoutMode()` context, session routing, command bar positioning) that canvas embed wires into.

- Build `useLayoutMode()` context (`'launcher' | 'session'`) — shared provider wrapping `Sidebar`, `HomePage`, `ChatPanel`
- Rebuild `HomePage.tsx`: command bar with explicit recipient picker (last-used default: `💬 General`), typewriter placeholder (Layer 1 + Layer 2), contextual chips via `useContextualSuggestions`
- Implement `launcher → session` transition: CSS grid three-column layout (`[rail] [main] [panel]`), sidebar `transition: width 300ms ease-in-out`
- `/chat/:sessionId` React Router route — optimistic `sessionId` (nanoid on client), confirmed by server on first response
- Running Now section: multi-agent run cards (stacked avatars + names + team badges)
- Needs Attention section: inline approve/reject
- Recently Built grid: reads `/v1/artifacts?limit=6`
- Session History drawer: `SessionHistoryPanel.tsx` (clock icon in Chat Panel header)
- Delete old stat bar, GatewayHealthRail, AgentConstellation from HomePage

### Phase 6 — Live Canvas Embed in Chat (4 days)

- Build `CanvasEmbed.tsx` (read-only mini React Flow instance)
- Subscribe to `CANVAS_NODE_PLACED`, `CANVAS_EDGE_CONNECTED`, `CANVAS_BUILD_COMPLETE` in ThreadView
- Render embed as rich message type in thread (threads now in final Phase 5 architecture)
- `CANVAS_BUILD_COMPLETE` → transition card to completed state with Run + View CTAs
- E2E: goal-triggered workflow build shows canvas embed in thread

### Phase 7 — AgentDetailPage: Goals, Memory & Workflows Tabs (5 days)

These were listed as "minor changes" but require their own phase.

- `AgentDetailPage` gains Memory tab (`/agents/:id?tab=memory`): read/edit agent memory entries
- `AgentDetailPage` gains Workflows tab (`/agents/:id?tab=workflows`): all workflows this agent participates in
- Objective management remains deferred beyond V1 and should not be implemented as agent/team tabs in this iteration.

---

### Track B — Rooms

Ship as a separate release after Track A is live and stable.

### Phase 8a — Rooms: Core (10 days)

- DB: `rooms` + `room_agents` + `room_messages` tables
- Run one-time migration for existing teams (§6.3 migration SQL)
- API: `apps/api/src/routes/rooms.ts` (full CRUD + messages)
- New realtime events: `ROOM_MESSAGE_SENT`, `ROOM_MESSAGE_RECEIVED`, `ROOM_AGENT_JOINED`, `ROOM_AGENT_LEFT`
- Frontend: `RoomView.tsx` — renders **MVP message types only** (text, artifact card, run status card with multi-agent display, approval card, system message)
- Update ChatPanel: add Rooms tab + RoomView
- Update `/chat` full-screen: add rooms sidebar (§6.4)
- Proactive posting: engine hooks on `RUN_COMPLETED`, `APPROVAL_REQUESTED`, `RUN_FAILED` → post to agent home room (throttled: 1 per 30s per agent on `AGENT_WORK_STEP`)
- Team broadcast: deliver to each team agent, broadcast record card in room (§6.8)

### Phase 8b — Rooms: Extended Message Types (7 days)

- Canvas embed in rooms (`CANVAS_NODE_PLACED` in a room thread)
- Code message with syntax highlighting + copy button
- Image message (inline `<img>`, lightbox)
- Document preview (first ~150 words + "Open full →")
- Diff card (before/after split, syntax-highlighted)
- Data table (inline scrollable, CSV/JSON export)
- Team broadcast message distinct card style

### Light Mode — Deferred to v1.5

Light mode is deliberately excluded from v1. The CSS token system is established in Phase 1 (2-hour sub-task), so light mode can be implemented in a later release without touching every component.

When it ships:
- `data-theme` selector on `<html>` in `index.html`
- Tailwind config: `darkMode: ['selector', 'html[data-theme="dark"]']`
- Light mode token values in the CSS custom properties from Phase 1
- Avatar dropdown theme toggle
- Server-side preference persistence: `PATCH /v1/settings {preferences: {theme: 'light'|'dark'}}`

---

**Honest estimates:**

| Track | Phases | Estimate |
|---|---|---|
| Track A | Phases 1–7 | ~35 days (~7 weeks) |
| Track B | Phases 8a + 8b | ~17 days (~3.5 weeks) |
| **Combined** | | **~52 days (~10–11 weeks)** |

The original 38-day estimate omitted: `useLayoutMode()` animation architecture (+4 days to home page), AgentDetailPage tabs (5 days not in original plan), Rooms at 8 days (3× underestimate for this scope). Budget 50–55 days for combined Track A + B and track against it weekly.

---

## 13. Design Principles

1. **The canvas is the show, not the backstage.** When agents are building or executing, the canvas and its live overlays take center stage. It is never hidden during active work.

2. **Every output is visible.** Agents that produce invisible results are agents operators cannot trust. The artifact panel ensures every run completion has a face.

3. **Chat is control, not conversation.** The chat interface commands the entire platform. If you cannot do something from chat, the chat is incomplete.

4. **Rooms replace external tools.** Operators should never need to use Slack, Discord, or email to coordinate with their agents. Rooms make the platform the communication layer.

5. **Delete over redirect.** Obsolete code is removed. No redirect graveyard. The codebase is clean.

6. **Five nav items, not fifteen.** The sidebar is a compass. Everything else is ⌘K.

7. **Progressive disclosure, not progressive burial.** Power features exist — workflows, history, data tables — they are just not competing for attention on the home screen. They are one click away, always.

8. **Green is the signal.** `#9cffb0` is the live indicator, the accent, the "things are running" color. It is not diluted with other accent colors.

9. **Both themes are first-class.** Dark for operators who live in terminals. Light for everyone else. Neither is an afterthought.

10. **No jargon on primary surfaces.** "Ledger", "Ambient", "Gateway", "Runtime" exist internally. The home page, the chat bar, and artifact cards use plain language only.

---

## 14. What Gets Deleted From the Codebase

No redirects. Clean removal.

| File | Action |
|---|---|
| `apps/web/src/pages/ApprovalsPage.tsx` | **Delete** — notification bell + inline approval cards replace it entirely |
| `apps/web/src/pages/LibraryPage.tsx` | **Delete** — replace with `PackagesPage.tsx` (clean rewrite with correct concept) |
| `apps/web/src/pages/RoutinesPage.tsx` | **Delete** — merge scheduled routines into Workflows page schedules tab |
| `WorkspaceContextBlock` in `Sidebar.tsx` | **Delete** — workspace lives in header only |
| All `<Navigate>` back-compat redirect routes in `App.tsx` (fleet→home, runs→history, etc.) | **Delete** — it is 2026, no external bookmarks exist yet |
| `LogOut` button in Shell header | **Delete** — avatar dropdown is the only sign-out path |
| Teams breadcrumb remove-from-header logic (if any) | **Revert** — team context breadcrumb STAYS in header |
| All imports of deleted page components in `App.tsx` | **Delete** |

**What is NOT deleted:**
- The workflow canvas — unchanged
- All API routes — zero deletions on the backend
- The `ChatPanel/` directory — extended, not replaced
- All realtime events — unchanged
- All existing DB tables — additive only (`artifacts`, `rooms`, `room_messages` added)
- Auth, security, rate limiting — untouched
- E2E test selectors — updated to match new routes

