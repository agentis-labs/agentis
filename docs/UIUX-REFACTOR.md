# Agentis — Comprehensive UI/UX Refactoring Plan

> **Status:** Draft v1.0 — May 2026  
> **Scope:** Full platform redesign from first principles  
> **Audience:** Product, engineering, and design

---

## 0. Why This Document Exists

Agentis was built by engineers, for engineers. Every page, every label, every workflow reflects the mental model of someone who understands adapters, ledgers, runtimes, and ambient contexts. That was the right call for V1 — you cannot build a platform you cannot reason about. But V1 is done.

The next version of Agentis has a completely different user. That user is not a developer. They are an operator — someone who **runs** agents, not someone who builds the infrastructure those agents run on. They want results. They want to say "research this topic and send a summary to Slack every Monday" and have it just work. They should never need to know what a gateway is.

At the same time, the technical users who built the first workflows still exist. They want control, observability, and the ability to go as deep as they need to. The redesign must serve both, without compromising either.

This document is the roadmap for that transformation.

---

## 1. Core Design Principles

Before any specific UI decision, these principles must govern every choice.

### 1.1 Chat is the primary interface

The agent is the product. Chat is how you talk to the agent. Therefore, chat must not be a feature — it must be the spine that everything else plugs into. Every other surface (canvas, runs, agents) is either a detailed view of something the chat already told you about, or a way to configure the agent more precisely than chat allows.

Implication: chat should be accessible from every surface simultaneously, without navigation. Not a floating orb. Not a modal. A persistent, productive panel.

### 1.2 Everything from 1–2 actions

If a user wants to create an automation, it should take one conversation and one confirmation. If they want to assign a task to an agent, it should be one message. If they want to see what an agent is doing right now, it should be one click on the agent name.

Every page that exists only because the data is there (Issues, Budgets, Files, Knowledge, OrgChart, Ledger, BudgetsPage) is a violation of this principle and must be removed or absorbed.

### 1.3 Agents are visible, not hidden

Right now agents are things you configure. The redesign makes agents things you *see*. An agent building a workflow should show you each node appearing one by one. An agent searching the web should show you the domains being hit. An agent writing a report should show you the outline being constructed. Observability is not a debug tool — it is a trust-building mechanism.

### 1.4 Proactive beats reactive

The platform should surface important information before the user goes looking for it. If an agent is stuck and needs approval, it should tell you. If a scheduled workflow has been failing for three runs, you should see it on the home screen. If an agent has completed a task and has a suggestion for the next one, it should say so. Pull-based navigation is for power users going deep; push-based notifications are for everyone.

### 1.5 Technical language is invisible by default

"Ledger" becomes "History". "Gateway" becomes "Connection". "Ambient" becomes "Environment". "Runtime" becomes "Connection type". Technical terms exist internally but are never the label a user reads unless they have explicitly entered a power-user mode. Every noun in the UI must pass the "would a non-developer understand this in 3 seconds?" test.

### 1.6 The canvas is the flagship moment

When someone sees an agent building a workflow in real time — nodes appearing, edges connecting, agent explaining what each step does — that is the product. That is the demo that converts. Everything else is table stakes. The canvas must be designed around that experience first.

---

## 2. Information Architecture Audit

### 2.1 Current page inventory

| Route | Current name | Verdict | Rationale |
|---|---|---|---|
| `/fleet` | Fleet Overview | **Rename + redesign** | "Fleet" is opaque. Redesign as Home dashboard. |
| `/conversations` | Conversations | **Merge into chat panel** | Should not be a separate page; chat panel covers it. |
| `/approvals` | Approvals | **Keep, simplify** | Critical flow; rename to "Waiting for you". |
| `/activity` | Activity | **Merge into Home** | Surface key events on home; deep history in History. |
| `/inbox` | Inbox | **Merge with Approvals** | Two "things needing attention" pages is one too many. |
| `/workflows` | Workflows | **Keep, redesign** | Core product page; needs visual uplift. |
| `/workflows/:id` | Canvas | **Major redesign** | Flagship. See §5. |
| `/runs` | Runs | **Keep, rename** | Rename to "History". Merge RunHistory + RunDetail. |
| `/runs/:id` | Run detail | **Keep** | Needed for deep inspection. |
| `/agents` | Agents | **Keep, redesign** | Merge with `/fleet`'s agent table into a unified Agents home. |
| `/agents/:id` | Agent detail | **Keep** | Deep dive is valuable. |
| `/gateways` | Gateways | **Keep, rename** | Rename to "Connections". Power-user tab in Settings. |
| `/skills` | Skills | **Keep, simplify** | Rename to "Tools". Registry fold-in stays. |
| `/routines` | Scheduled missions | **Redesign entry** | Creation via chat; page stays as schedule list. |
| `/ledger` | Records | **Merge into History** | Redundant with Runs; merge into a unified audit trail. |
| `/org` | Hierarchy | **Remove** | No clear user need at V1 maturity. |
| `/issues` | Issues | **Remove** | Stub; absorb into approvals or remove entirely. |
| `/budgets` | Budgets | **Remove** | Stub; add budget fields to agent settings when needed. |
| `/files` | Files | **Remove** | Stub; file handling belongs in agent context, not a page. |
| `/knowledge` | Knowledge | **Remove** | Stub; knowledge base is a future V2 feature. |
| `/settings` | Settings | **Redesign** | Split into User and Workspace settings. |
| `/settings/channels` | Channels | **Move** | Into Settings > Connections tab. |
| `/workspaces` | Workspaces | **Demote** | Management-only; accessible from header dropdown only. |

**Summary:** 11 pages removed/merged, leaving a clean 8-page navigation surface.

### 2.2 Proposed page set

```
/                  → redirect to /home
/home              → Home (was Fleet Overview)
/agents            → Agents (merged fleet + agent table)
/agents/:id        → Agent detail (unchanged)
/chat              → Full-screen chat mode (new)
/workflows         → Workflows list
/workflows/:id     → Canvas (major redesign)
/history           → Unified History (runs + audit trail)
/history/:id       → Run detail
/skills            → Tools (was Skills, simplified)
/settings          → Settings (redesigned)
/settings/connections → Connections (was Gateways + Channels)
/settings/workspace   → Workspace management
```

---

## 3. Navigation and Sidebar

### 3.1 What is wrong right now

The sidebar has three groups with 16+ items. "Missions" and "Scheduled missions" use the same icon. "Records" is in Operate but "Activity" is in Command. "Hierarchy" sounds like an org chart from 2012. "Inbox" and "Approvals" both have the same purpose. Users who open the app for the first time see a wall of options and do not know where to start.

The sidebar also competes with the header. There is a workspace dropdown in the header and workspace management in the sidebar. There is a fleet link in the sidebar but a nav array in `App.tsx` that mirrors it. The sidebar collapsed state is stored in `localStorage` but the initial render doesn't respect it gracefully.

### 3.2 Redesigned sidebar

**Philosophy:** The sidebar is a compass, not a menu. It shows where you are and how to get to the 5-6 places that matter. Everything else is reachable from within those places or from the command palette (`⌘K`).

```
┌──────────────────────────────┐
│  ⬡ Agentis   [workspace▾]   │  ← Header: logo + workspace switcher
├──────────────────────────────┤
│                              │
│  ⌂  Home                    │  ← Replaces Fleet Overview
│  ◈  Agents          [3 live] │  ← Badge: live agent count
│  ⌘  Workflows               │
│  ⟳  History        [1 run]  │  ← Badge: active runs only
│  ✦  Tools                   │  ← Was Skills
│                              │
├──────────────────────────────┤
│  ⚙  Settings                │  ← Bottom: always visible
│  [avatar] Operator           │  ← Bottom: user identity + logout
└──────────────────────────────┘
```

**Rules:**
- Maximum 5 primary items + Settings at bottom
- Badges only for counts that require human attention (active runs, approvals needing input)
- Icons must be distinct — no two items may share an icon family
- No groups, no labels like "Command" or "Operate" — the grouping is implicit from the order
- Collapsed state: icons only, badge dots persist

**Removed from sidebar** (and where they went):
- Conversations → chat panel (accessible everywhere)
- Approvals → "Waiting for you" banner on Home + chat panel notifications
- Activity → Home dashboard + History page
- Inbox → merged into Approvals flow
- Missions / Scheduled missions → accessible from Agents detail page and via chat
- Gateways → Settings > Connections
- Records/Ledger → History page (merged)
- Channels → Settings > Connections
- Workspaces → header dropdown only
- Hierarchy / Issues / Budgets / Files / Knowledge → removed

### 3.3 Command palette as the power user escape hatch

The existing `CommandPalette` (`⌘K`) becomes the primary navigation for users who know what they want. It must be enhanced to:
- Search across pages, agents, workflows, conversations
- Support natural-language actions: "create a mission for Scout", "open the last failed run", "add a scheduled workflow"
- Show recent items and suggested next actions
- Be keyboard-navigable end-to-end

This means power users barely touch the sidebar at all.

---

## 4. Chat System — Full Redesign

### 4.1 What is wrong right now

There are currently **three disconnected chat surfaces** in the codebase:

1. `ConversationsPage.tsx` — a full page at `/conversations` with a left list + right thread view
2. `Assistant.tsx` — a persistent orb (bottom-right) that expands to a compact bar or a panel
3. `ConversationDock.tsx` — a dock component that was an earlier iteration, now mostly replaced by Assistant

These three surfaces do not share state cleanly. A message sent through the orb does not appear in the Conversations page list in the same mental frame. The orb "collapses" to a small dot that users don't notice. The dock was a floating overlay which covered page content. When expanded, the panel pushes over nothing — it overlays rather than reflows the layout.

The result: most users do not discover the chat at all, or use it inconsistently.

### 4.2 New chat architecture

#### 4.2.1 The right panel

Chat lives in a **persistent right panel** that:
- Occupies a real, reserved column of the layout (320px by default)
- Does **not** overlay content — when open, the main content area shrinks accordingly
- Has a visible toggle button in the header (not a floating orb)
- Remembers its open/closed state per workspace

This is the VS Code / GitHub Copilot model. The panel is always there if you want it. It does not intrude if you do not.

```
┌─────────────┬──────────────────────────┬──────────────────┐
│   Sidebar   │    Main Content Area     │  Chat Panel      │
│   (240px)   │    (flex: 1)             │  (320px)         │
│             │                          │                  │
│  ⌂ Home    │  [page content]          │ ◈ Scout          │
│  ◈ Agents  │                          │ ◈ Hermes         │
│  ⌘ Workflows│                          │ # Fleet          │
│  ⟳ History │                          │                  │
│  ✦ Tools   │                          │ [message thread] │
│             │                          │                  │
│  ⚙ Settings│                          │ [input bar]      │
└─────────────┴──────────────────────────┴──────────────────┘
```

When the panel is closed, the toggle is a small icon button in the top-right of the header. It shows a notification dot when there are unread messages.

#### 4.2.2 Thread organization (Slack model)

The chat panel has two levels:

**Level 1 — Channel/agent list** (left rail inside the panel):
```
  Agents
  ├─ ◈ Scout            [unread dot]
  ├─ ◈ Hermes
  ├─ ◈ Analyst
  │
  Broadcasts
  └─ # Fleet             [broadcast to all]
```

Clicking an agent opens their thread on the right within the panel. This replaces both `ConversationsPage.tsx` and the dock — it is the single source of truth for all operator-agent communication.

**Level 2 — Thread view:**
- Standard chat chronology with timestamps
- Agent messages have a distinctive avatar and color (as currently in `agentColor`)
- System messages (workflow triggered, run completed, approval needed) appear inline as "context cards" — not as text bubbles, but as embedded event chips that link to the relevant resource
- Operator messages align right, agent messages align left
- Typing indicator shows when agent is processing
- Code blocks, structured outputs (JSON, tables) render inline

#### 4.2.3 Real-time agent work visibility

This is the core differentiator. When an agent is executing a workflow or building something:

**Streaming status cards appear in the thread:**
```
┌─────────────────────────────────────────┐
│ ⟳ Building workflow "Daily briefing"   │
│                                         │
│  ✓ Added trigger — every day at 9am    │
│  ✓ Added step — fetch RSS feeds        │
│  ⟳ Adding step — summarize with AI...  │
│  ◌ Add step — send to Slack            │
│  ◌ Test run                             │
└─────────────────────────────────────────┘
```

These cards:
- Update in real-time via Socket.IO as the agent progresses
- Are clickable — clicking "Added step" opens the canvas at that node
- Show a spinner for in-progress, checkmark for done, circle for pending
- Collapse to a summary chip once the workflow is complete

This requires a new `AgentWorkCard` component and a new REALTIME_EVENTS type (`AGENT_WORK_STEP`) that the API emits as agents build things.

#### 4.2.4 Full-screen chat mode

A "maximize" button in the panel header expands chat to a full-screen experience at `/chat`:

```
┌──────────────────┬─────────────────────────────────────────┐
│  Chat Sidebar    │  Thread: ◈ Scout                        │
│  (240px)         │                                          │
│  Agents          │  [full conversation thread]              │
│  ├─ Scout ●      │                                          │
│  ├─ Hermes       │                                          │
│  │               │                                          │
│  Broadcasts      │                                          │
│  └─ # Fleet      │                                          │
│                  │  ──────────────────────────────────────  │
│  [+] New agent   │  [input]              [send] [attach]   │
└──────────────────┴─────────────────────────────────────────┘
```

This is essentially a dedicated chat app, but it is entered from the panel — not navigated to from the sidebar. The URL updates to `/chat` and back-button returns to wherever the user was.

#### 4.2.5 Minimized state

When the panel is toggled closed, the header shows:
- A `MessageCircle` icon button on the right side of the header
- An unread badge count if messages are waiting
- A single click reopens the panel where the user left off

There is no floating orb. The Assistant orb (`Assistant.tsx`) is replaced by this header button. This eliminates the UX confusion of a floating element and respects the spatial language of the rest of the interface.

#### 4.2.6 Chat as operator interface (no-UI mode)

An operator who prefers to work entirely through chat should be able to:

| Chat input | What happens |
|---|---|
| "Create a workflow that monitors HN and sends a digest to Slack" | Agent builds it on canvas in real-time; user sees a work card; agent sends "Done, here's what I built: [link]" |
| "Pause all agents" | API call fires, confirmation returned in chat |
| "Show me the last 3 failed runs" | Agent fetches run history and renders a summary card inline |
| "Approve the pending request from Hermes" | Approval is submitted from within the chat thread |
| "Change Scout's mission to focus on competitor analysis" | Mission updated; confirmation returned |

These are not special commands — they are natural language interpreted by the backend agent. But the UI must be built to receive structured responses and render them richly (not just as text strings).

#### 4.2.7 Composer tools

The chat input bar is the most-used element on the entire platform. It must support the full vocabulary of an operator who thinks in agents, workflows, and runs — not just plain text.

**Slash commands (`/`)** — trigger structured actions without leaving the keyboard:

| Command | Effect |
|---|---|
| `/run [workflow name]` | Trigger a workflow run; agent confirms before firing |
| `/pause @Scout` | Pause a specific agent |
| `/wake @Scout` | Wake a paused agent |
| `/approve` | Approve the most recent pending approval |
| `/history` | Fetch the last 5 run results as an inline card |
| `/status` | Summary of all agents (live count, last heartbeat) |
| `/help` | List available commands |

Typing `/` shows an autocomplete popover with fuzzy search across all available commands. Commands are categorized (Agent, Workflow, Approval, Info) and keyboard-navigable with arrow keys.

**Agent mentions (`@`)** — direct a message to a specific agent or reference one in context:

- `@Scout` — routes the message to Scout's thread; works in the Fleet broadcast channel too
- `@all` — broadcasts to all active agents
- Typing `@` opens an autocomplete list of all agents, sorted by last active
- A mentioned agent is highlighted as a chip in the sent message

**Resource references (`#`)** — link to platform resources inline:

- `#daily-briefing` — references a workflow by name; renders as a clickable chip that opens the canvas
- `#run-1a2b3c` — references a specific run; renders as a chip with status icon
- Typing `#` opens an autocomplete list showing recent workflows and runs
- Referenced resources appear as rich chips in the message history, not raw ID strings

**File attachments** — operators can drag a file or click the attachment icon to attach:
- Images: rendered inline in the thread
- JSON/text files: rendered as a collapsible code block
- Other: shown as a named attachment chip

**Keyboard shortcuts in the composer:**
- `Enter` — send message
- `Shift+Enter` — newline
- `↑` — edit last sent message
- `Escape` — clear composer or dismiss autocomplete
- `⌘+K` — open command palette from anywhere (not just composer)

The autocomplete popover for `/`, `@`, and `#` must appear immediately (< 100ms) and close on `Escape` or when the trigger character is deleted. It must not block the send button or obscure the last message in the thread.

---

## 5. Workflow Canvas — Flagship Redesign

### 5.1 What is wrong right now

The canvas works. ReactFlow renders nodes, edges animate during execution, the inspector panel lets you configure nodes. But it does not create an "aha" moment. Problems:

1. **No agent presence** — there is no way to see an agent building on the canvas. The "live overlay" only applies to execution, not creation.
2. **Node palette is primitive** — drag-from-sidebar is fine for power users; casual users need something smarter.
3. **Competing with n8n, Make.com, Zapier on their terms** — feature-for-feature, Agentis loses. The only winning move is to play a different game: agent-native, conversational creation, real-time AI assistance.
4. **The canvas and the chat are completely separate** — there is an `AssistantProvider` context and a page context hook, but the canvas does not stream agent actions into the chat, and the chat does not reach into the canvas.
5. **Poor visual design** — the nodes are small rectangles with icons. There is no hierarchy, no color-coding by category, no visual differentiation between trigger, action, and condition nodes that a non-technical user would understand.
6. **No "why did this fail?" from the canvas** — failed nodes show a red indicator, but the error message requires opening the run detail page.

### 5.2 Canvas redesign priorities

#### 5.2.1 Agent-assisted creation (the killer feature)

A chat input lives **inside** the canvas, not in a separate panel. It appears at the bottom of the canvas and is always visible when the canvas is empty.

```
┌───────────────────────────────────────────────────────────┐
│  [toolbar]  Workflow: Daily Briefing    [save] [test run] │
├───────────────────────────────────────────────────────────┤
│                                                           │
│   (empty canvas with a soft prompt)                      │
│                                                           │
│   "Describe what you want this workflow to do            │
│    and your agent will build it for you."                │
│                                                           │
│   ┌─────────────────────────────────────────────────┐    │
│   │ Monitor Hacker News and email me a digest at 9am│    │
│   └─────────────────────────────────────────────────┘    │
│                                              [→ Build]   │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

When the user sends a description:
1. The chat input minimizes to a "Chat with agent" button at the bottom
2. The agent starts building: nodes appear one at a time with a "placing..." animation
3. Each node appears with a brief label explaining why it was placed ("Trigger: Hacker News RSS feed")
4. The agent narrates in a small floating log panel at the bottom-left:
   ```
   ◈ Scout is building...
   ✓ Added daily cron trigger
   ✓ Added HTTP fetch for news.ycombinator.com/rss
   ⟳ Adding AI summarizer...
   ```
5. When done, the agent says "Done. Here's what I built — want to test it?" and a "Test run" button becomes prominent.

This is the aha moment. This is what no other platform does.

#### 5.2.2 Node design language

Nodes need a visual hierarchy that a non-technical user can read:

- **Trigger nodes**: Distinct shape (pill/rounded), color accent (e.g., indigo), icon that represents the trigger source
- **Action nodes**: Standard rectangle, neutral color, bold icon
- **Condition/Router nodes**: Diamond or angled, yellow/amber accent
- **AI/Skill nodes**: Distinct glyph (✦), accent color (purple), shows which model/tool is used
- **Agent nodes**: Avatar-style with the agent color, shows agent name

Node size should be proportional to complexity, not uniform. A trigger is a starting point — it should look like one. A skill with 5 configuration fields should visually suggest depth.

#### 5.2.3 Real-time execution overlay (enhanced)

Current state: nodes turn green/red, edges animate. This is minimal.

Enhanced execution overlay:
- Each node shows a progress indicator while executing (not just "running" color)
- Completed nodes show the output value in a small chip below (truncated to 80 chars)
- Failed nodes show the error summary inline — no need to open the drawer for common errors
- Edges show data flowing with a moving dot animation (similar to n8n's execution view)
- A timeline at the top shows the full run duration and where time was spent
- "Run inspector" is a split panel below the canvas, not a separate page

#### 5.2.4 Inline error recovery

When a run fails:
1. The failed node is highlighted and an error chip appears inline
2. A "Fix with agent" button appears next to the error chip
3. Clicking it opens the chat thread with the canvas agent pre-loaded with the error context
4. The agent suggests a fix, which can be applied with one click — the node updates on canvas

#### 5.2.5 Canvas toolbar simplification

Current toolbar has: undo, redo, variables, save indicator, test run, publish. Some of these are less important than others.

Proposed grouping:
```
[workflow title, editable inline]  [← back to Workflows]

Left group: history — [⟲ undo] [⟳ redo]
Right group: actions — [Variables] [⟳ Test run] [▶ Publish] [Save ●]
```

"Save ●" shows a dot when there are unsaved changes — same concept but visually cleaner. Auto-save drafts every 30 seconds (no dot needed, just "Saved" in muted text).

#### 5.2.6 Node palette redesign

Current: a side drawer with node types listed.

Proposed: a smart "+" button in the center of the canvas (when empty) or at the end of the last node. Clicking "+" opens a lightweight popover:
```
┌──────────────────────────────┐
│ Add a step                   │
├──────────────────────────────┤
│ 🔍 Search nodes...          │
├──────────────────────────────┤
│ Suggested                    │
│  ⟳ HTTP request             │
│  ✦ Ask AI                   │
│  📧 Send email               │
│                              │
│ Triggers                     │
│ Actions                      │
│ Conditions                   │
│ Skills (6 installed)         │
└──────────────────────────────┘
```

The "Suggested" section is context-aware — if the last node was an HTTP request, suggest "Parse JSON", "Conditional branch", "Ask AI to summarize response".

### 5.3 Multi-workflow management

As soon as a team has more than 3–4 workflows, managing them becomes a job in itself. The current `WorkflowsPage.tsx` is a flat list. It does not communicate which workflows are active, which ones are broken, or how they relate to each other. And once you open a canvas, you lose the list entirely.

#### 5.3.1 The workflows list page (redesigned)

The `/workflows` list becomes a live dashboard, not a static table:

```
┌──────────────────────────────────────────────────────────┐
│  Workflows                              [+ New workflow] │
├──────────────────────────────────────────────────────────┤
│  [All] [Active] [Scheduled] [Draft] [Broken]  [search]  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ▶ Daily briefing        ⟳ Running now · step 3/7      │
│    Cron · 09:00 daily    Last: success 2h ago  [open]  │
│                                                          │
│  ▶ Competitor monitor    ● Idle · scheduled 18:00       │
│    Webhook + RSS         Last: success 6h ago  [open]  │
│                                                          │
│  ✕ Weekly digest         ⚠ Failed · step 2 yesterday   │
│    Cron · Mon 08:00      Last: failed 22h ago  [retry] │
│                                                          │
│  ○ Draft: Slack notifier  Not published                 │
│    Manual                Created 3d ago        [open]  │
└──────────────────────────────────────────────────────────┘
```

Key changes from current:
- **Status is the first thing you see** — running indicator (▶), idle (●), failed (✕), draft (○)
- **Last run result is inline** — no need to go to History to see if something is broken
- **"Broken" filter tab** — one click to see every workflow with a failing last run
- **Live update** — `RUN_RUNNING`, `RUN_COMPLETED`, `RUN_FAILED` events update cards in place
- The `[retry]` action on a failed workflow fires a new run without opening the canvas

#### 5.3.2 Simultaneous runs visibility (the Live Strip)

The existing `LiveStrip.tsx` component is under-utilized. It should become a persistent, prominent strip at the top of every page (not just the canvas) showing all currently executing runs:

```
┌──────────────────────────────────────────────────────────┐
│ ▶ Daily briefing  step 3/7  ██████░░░░░░  1m 12s  [view]│
│ ▶ Competitor scan  step 1/3  ████░░░░░░░░  0m 22s  [view]│
└──────────────────────────────────────────────────────────┘
```

- Each active run shows: workflow name, current step, progress bar, elapsed time, [view] link to canvas
- The strip is collapsible — when no runs are active it hides entirely
- Clicking [view] navigates to the canvas with the run's live overlay active
- Maximum 3 items visible; if more are running, a "+ 2 more" chip expands the strip
- Powered by the existing `REALTIME_EVENTS.RUN_RUNNING/COMPLETED/FAILED` events

#### 5.3.3 Canvas tabs (multiple workflows open)

Once users have several workflows they edit regularly, forcing navigation back to the list every time creates friction. The solution is **canvas tabs** — a tab bar at the top of the canvas layout:

```
┌──────────────────────────────────────────────────────────┐
│  [Daily briefing ×]  [Competitor monitor ×]  [+]        │
├──────────────────────────────────────────────────────────┤
│  [canvas content for active tab]                        │
└──────────────────────────────────────────────────────────┘
```

- Tabs appear when the user opens a second workflow while one is already open
- Tab state (scroll position, selected node, inspector drawer state) is preserved per tab
- Tabs are stored in `sessionStorage` — they survive page refresh but not a new session
- A tab with unsaved changes shows a dot indicator (`Daily briefing ●`)
- Closing all tabs returns to the `/workflows` list
- Maximum 5 tabs; opening a 6th replaces the oldest unmodified tab

Implementation note: tab state lives in the Zustand `agentisStore`, keyed by workflow ID. The `WorkflowCanvasPage` reads from the store on mount to restore scroll + selection.

#### 5.3.4 Workflow relationships and dependencies

Some workflows call subflows or are triggered by other workflows. This relationship is currently invisible. Add to the workflows list page:

- A **dependency indicator** next to workflows that are called as subflows: `⤷ used by 2 workflows`
- Clicking it shows a small popover listing the parent workflows with links
- On the canvas, a `subflow` node shows the target workflow name and a link icon — clicking it opens that workflow in a new tab

#### 5.3.5 Bulk operations

For users managing 10+ workflows:

- Checkbox selection on the list page
- Bulk actions: Pause all / Resume all / Delete / Export
- "Select all broken" as a one-click selection for the repair workflow
- Export as JSON for backup or sharing

---

## 6. Home — Redesigned Dashboard

### 6.1 What "Home" means

The current Fleet Overview is a grid of agent cards with status indicators and a toolbar. It's functional but passive. It does not tell you what matters right now.

Home should answer three questions in order of urgency:

1. **What needs my attention?** — Approvals pending, runs that failed, agents that are disconnected
2. **What is happening right now?** — Active agents, running workflows, ongoing conversations
3. **What happened recently?** — Completed tasks, published workflows, received messages

### 6.2 Home layout

```
┌──────────────────────────────────────────────────────────┐
│  Good morning, Operator.  Tuesday, May 5 · 3 active     │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ⚠ Needs attention (2)                                  │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ ● Scout is waiting for your approval                │ │
│  │   Approve · Dismiss                          1m ago │ │
│  ├─────────────────────────────────────────────────────┤ │
│  │ ● "Daily briefing" run failed on step 3 of 7       │ │
│  │   View error · Retry                         4m ago │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  Live right now                                         │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐           │
│  │ ◈ Scout   │  │ ◈ Hermes  │  │ ⟳ Daily   │           │
│  │  Running  │  │  Idle     │  │  briefing │           │
│  │  step 4/7 │  │  Ready    │  │  running  │           │
│  └───────────┘  └───────────┘  └───────────┘           │
│                                                          │
│  Recent                                                 │
│  · Hermes completed "Competitor analysis"  · 2h ago    │
│  · Scout sent you a message               · 3h ago    │
│  · "Weekly report" ran successfully       · 6h ago    │
│                                                          │
│  ── Quick actions ──────────────────────────────────── │
│  [+ Add agent]  [+ New workflow]  [↗ Ask an agent]     │
└──────────────────────────────────────────────────────────┘
```

### 6.3 Agent cards (Live right now section)

Each agent card shows:
- Name + color avatar
- Status (Running / Idle / Needs attention / Offline)
- Current task or last task (truncated)
- If running: step progress (e.g., "step 4 of 7")
- Click → opens agent detail page OR highlights agent thread in chat panel

The card is live — it updates without page refresh via Socket.IO `agent.status.changed` and `agent.heartbeat` events.

### 6.4 Eliminating Fleet Overview duplication

The current `/fleet` and `/agents` are two views of the same data (agent list). After the redesign:
- Home (`/home`) = "What's happening" (urgent + live + recent)
- Agents (`/agents`) = complete list of all agents with filtering, sorting, and management actions

The "Fleet" terminology is retired.

---

## 7. Agents Page

### 7.1 Current state

`AgentsPage.tsx` is a sortable/filterable table of agents. `FleetOverviewPage.tsx` is a card grid of agents. They are separate routes showing the same data differently.

### 7.2 Proposed merge

Single `/agents` page with two view modes (table and grid), and a details panel that slides in from the right when an agent is selected.

```
/agents
  ├─ [toolbar: search | filter: all/live/paused/offline | view: grid/table | + Add agent]
  ├─ [agent grid or table, depending on view toggle]
  └─ [when agent selected: right panel slides in with agent detail]
```

The detail panel (right slide-in) shows:
- Agent name, color, status, last seen
- Current mission
- Recent conversations (last 3 messages)
- Active workflows using this agent
- Actions: Talk to agent / Edit / Pause / Wake / Delete

### 7.3 Agent detail page (`/agents/:id`)

Kept and redesigned as a full-page deep-dive. Tabs:
- **Overview** — status, missions, recent activity
- **Conversations** — full message history with this agent
- **Runs** — all workflow runs involving this agent
- **Settings** — connection type, adapter config, description

---

## 8. Proactive Agent UX

This is the feature that separates Agentis from every other agent platform. Proactive agents do not wait to be asked — they surface insights, suggestions, and actions before the operator goes looking.

### 8.1 The proactive message pattern

When an agent has something to proactively share, it appears in three places simultaneously:
1. **Chat thread** — a message from the agent in their thread
2. **Home** — a card in the "Needs attention" or "Recent" section (depending on urgency)
3. **Header notification dot** — on the chat panel toggle button

The agent should never just send a text message that says "I noticed X". It should send a structured card:

```
┌─────────────────────────────────────────────────────────┐
│ ◈ Scout · 11:42am                                       │
│                                                         │
│ I monitored Hacker News for the past 6 hours and       │
│ found 3 posts highly relevant to your focus on         │
│ distributed systems. Shall I compile a summary?        │
│                                                         │
│ Top posts:                                              │
│ · "Why CRDTs won" (342 points)                         │
│ · "Raft consensus explained" (211 points)              │
│ · "Postgres logical replication deep dive" (198 pts)   │
│                                                         │
│ [Yes, compile summary]  [Not now]  [Don't track this]  │
└─────────────────────────────────────────────────────────┘
```

The action buttons trigger API calls directly from the UI — no need to type a response.

### 8.2 Required infrastructure

Proactive agent messages require:

1. **A structured proactive event type** — `AGENT_PROACTIVE_PUSH` emitted by the backend when an agent produces proactive output
2. **A structured message schema** — beyond plain text: supports title, body, list items, and action buttons that map to API endpoints
3. **An action registry** — each button maps to a server-side action (e.g., `{action: "compile_summary", agentId: "...", params: {...}}`)
4. **Real-time delivery** — Socket.IO push to the `workspace:${id}` room so all open tabs receive it

This is an architectural extension, not just a UI change. The UI can render structured messages today (extend the existing `Message` interface in `ConversationsPage.tsx`), but the backend needs to emit them.

### 8.3 Agent "currently doing" streaming

When an agent is working, the operator should be able to see what it is doing step-by-step. A new lightweight streaming surface:

- On the Home page live card for a running agent: shows "Searching the web for X..."
- In the agent's chat thread: a pinned "Working" card at the top that streams current step
- In the canvas for a running workflow: node-level step annotations

This requires `AGENT_WORK_STEP` events with `{agentId, step, description, detail}` payload, emitted from the adapter layer during task execution.

---

## 9. Settings Redesign

### 9.1 Current state

Settings is a catch-all. `SettingsPage.tsx` has generic workspace settings. `SettingsChannelsPage.tsx` has channels. Gateways, Channels, and Workspaces are separate sidebar items.

### 9.2 Proposed Settings structure

Settings becomes a single page with tabs:

```
/settings
  ├─ [Profile]    — user display name, avatar, password
  ├─ [Workspace]  — workspace name, slug, danger zone
  ├─ [Connections] — gateways (renamed from Gateways) + channel integrations (from Channels)
  └─ [Security]   — API keys, JWT settings, audit log access
```

Gateways move from sidebar to Settings > Connections. Channel integrations (Telegram, Discord) move from `settings/channels` into the same Connections tab.

---

## 10. History Page

### 10.1 What gets merged here

- `RunHistoryPage.tsx` (`/runs`) — workflow run history
- `LedgerPage.tsx` (`/ledger`) — event audit trail
- `ActivityPage.tsx` (`/activity`) — agent activity feed

These three are the same thing from three different angles (workflow lens, event lens, agent lens). A unified History page shows all three through filters.

### 10.2 Proposed layout

```
/history

[All] [Workflow runs] [Agent activity] [Audit trail]   ← filter tabs
[search] [date range] [status filter]

Timeline view:
  May 5, 2026
  ├─ 11:42  ◈ Scout completed "Research task"        [view]
  ├─ 11:30  ⟳ "Daily briefing" run completed         [view]
  ├─ 11:15  ◈ Hermes sent approval request           [view]
  └─ 09:02  ⟳ "Weekly digest" run failed on step 3  [retry]
  
  May 4, 2026
  └─ ...
```

Clicking any event opens a detail panel on the right (same pattern as Agents). The separate `/runs/:id` route remains for direct linking.

---

## 11. Removed Pages Cleanup

The following pages must be removed from the router, sidebar, and nav:

| File | Route | Disposal |
|---|---|---|
| `IssuesPage.tsx` | `/issues` | Delete file + route |
| `BudgetsPage.tsx` | `/budgets` | Delete file + route |
| `FilesPage.tsx` | `/files` | Delete file + route |
| `KnowledgePage.tsx` | `/knowledge` | Delete file + route |
| `OrgChartPage.tsx` | `/org` | Delete file + route |
| `InboxPage.tsx` | `/inbox` | Merge approval flows; delete file + route |
| `AgentFleetPage.tsx` | (re-export) | Delete re-export, kept by AgentsPage |
| `ConversationDock.tsx` | (component) | Replace with panel; delete component |

The routes must be removed from `App.tsx` and the files deleted. Any imports from these files in tests must also be cleaned up.

---

## 12. Design Tokens and Visual Language

### 12.1 Current token inventory

The codebase uses a tight set of Tailwind tokens:
`border-line`, `bg-surface`, `bg-surface-2`, `bg-canvas`, `text-text-primary`, `text-text-muted`, `text-accent`, `text-danger`, `bg-accent`, `bg-danger`

### 12.2 Additional tokens needed

For the redesign to express the new visual language, the following tokens need to be added to the Tailwind config:

```js
// tailwind.config.js — extend theme.colors
'surface-3': '...',      // for hover states in lists
'accent-subtle': '...',  // for agent color accents without full saturation
'success': '...',        // already missing — green for completed states
'warning': '...',        // already missing — amber for attention states
'border-focus': '...',   // for focused input rings
```

Note: `text-warning` does not exist in the current token set (see repo memory). This causes silent failures when warning states are attempted. It must be added.

### 12.3 Agent color system

Each agent has a `agentColor` field. This color must propagate consistently:
- Agent avatar circle background
- Agent card border-left accent
- Message bubble header color in chat thread
- Canvas AgentNode fill
- Live "running" indicator pulse color

A helper `agentColorStyle(color: string)` should return `{ borderLeftColor: color, '--agent-color': color }` for consistent application via CSS variable.

### 12.4 Typography hierarchy

The current codebase uses Tailwind defaults. For the redesign, establish:
- **Display**: workspace name, page titles — `text-xl font-semibold`
- **Heading**: section headers — `text-sm font-semibold uppercase tracking-wide text-text-muted`
- **Body**: content — `text-sm text-text-primary`
- **Caption**: metadata, timestamps — `text-xs text-text-muted`
- **Code**: error messages, IDs — `font-mono text-xs`

These are not new tokens — they are composition rules applied consistently.

---

## 13. Technical Implementation Roadmap

> **Status (2026-05):** All six phases below are landed in `main`, end-to-end
> across frontend and backend. Items marked ✅ are shipped; the implementation
> covers every phase including the multi-workflow management surface from §5.3.
> Backend `AGENT_WORK_STEP` and `AGENT_PROACTIVE_PUSH` emissions go through the
> new `/v1/agents/:id/{work-step,proactive-push}` endpoints so adapters can
> light up the surface without rewiring the bus.

### Phase 1 — Cleanup (1–2 weeks) ✅ DONE
Removes clutter without new features. Measurable reduction in cognitive load.

1. ✅ **Remove dead pages** — Issues, Budgets, Files, Knowledge, OrgChart, Inbox routes redirect to `/home`; `ConversationDock` retired in favor of `ChatPanel`.
2. ✅ **Remove from routing** — `App.tsx` cleaned, sidebar trimmed to 5 primary items + Settings.
3. ✅ **Rename labels** — Fleet → Home, Ledger → Records, Skill → Tool. (Channels/Gateways labels live inside Settings → Connections.)
4. ✅ **Sidebar reduction** — `Sidebar.tsx` rewritten. **2026-05 update:** History removed from primary nav (it was a lens, not a destination). New 6-item PRIMARY: Home · Agents · Workflows · Approvals (with pendingApprovals badge) · Records · Tools. History remains at `/history` accessible via "View full history →" links within context pages. Test contract updated to reflect new items.
5. ✅ **Merge approval/inbox flows** — `ApprovalsPage` consumes the inbox feed in two sections.
6. ✅ **Settings consolidation** — `SettingsPage` hosts Profile / Workspace / Connections / Security tabs; Connections embeds Gateways + Channels + Credentials.
7. ✅ **Remove `AgentFleetPage.tsx` re-export** — `AgentsPage.tsx` is the canonical file.

**Test impact:** `e2e/ui/_helpers.ts`, `activity.spec.ts`, `canvas-run.spec.ts`, `approvals.spec.ts` updated for new titles. Web vitest 15/15 files green.

### Phase 2 — Chat panel architecture (2–3 weeks) ✅ DONE
Replaces the orb model with the right-panel model.

1. ✅ **New `ChatPanel` component** at `apps/web/src/components/ChatPanel/` — replaces day-to-day Assistant orb usage.
2. ✅ **Layout refactor in Shell** — `chatPanelOpen` lives in `agentisStore`; `App.tsx` Shell renders `<ChatPanel />` as a 360px right column.
3. ✅ **Thread list** — `ThreadList.tsx` with fleet broadcast row + per-agent rows (color dots, unread badges, last-message preview).
4. ✅ **Thread view** — `ThreadView.tsx` migrated from ConversationsPage with optimistic send, typing indicator, message bubbles.
5. ✅ **Header toggle button** — `ChatPanelHeaderButton` exported from the panel module; aria-pressed reflects open state.
6. ✅ **Full-screen mode** — `/chat` and `/chat/agent/:agentId` routes render `<ChatPanel mode="fullscreen" />` via `ChatPage.tsx`.
7. ✅ **Real-time integration** — `CONVERSATION_MESSAGE_RECEIVED/SENT` + `AGENT_STATUS_CHANGED` wired through `useRealtime`.
8. ✅ **Composer power features** — slash commands (`/run /pause /wake /approve /history /status /help`), `@`-mentions for agents, `#`-refs for workflows, ↑ recall last sent, Shift+Enter newline. Slash dispatch goes through `useGlobalSlashCommands` hook in `apps/web/src/lib/slashCommands.ts`.

**Note:** `Assistant.tsx` retains `AssistantProvider` + `useAssistant` + `usePageContext` as context hooks consumed by `WorkflowCanvasPage` and `AgentDetailPage`. The visible `<Assistant />` orb and `<AssistantHeaderButton />` are **removed from Shell** as of 2026-05. Only `<ChatPanel />` + `<ChatPanelHeaderButton />` remain. This eliminates the dual-chat UX confusion seen after Phase 2 landed.

### Phase 3 — Home page (1–2 weeks) ✅ DONE (redesigned 2026-05)
Makes the landing page actually useful.

1. ✅ **New `HomePage` component** at `/home` (`/` → `/home`).
2. ✅ **Mission-control layout** — full-bleed split: live agent fleet (main) + right rail (attention, running, recent, explore). Replaced the `max-w-5xl` scrolling list with a fixed height, two-column command center.
3. ✅ **Agent command cards** — each agent has a large card with: color avatar + thin color bar, live/idle status indicator with pulse, per-agent AGENT_WORK_STEP work stream shown inline (not in a separate panel), capability tags, and Chat / Details action buttons. Work steps expire after 30 s.
4. ✅ **Workflow grid** — mini workflow cards below agent fleet, with animated pulse dots for active runs.
5. ✅ **Stat bar** — top strip shows live-agent count (pulsing accent) · active-run count · attention count as link to /approvals · quick-create buttons (Agent + Workflow).
6. ✅ **Right rail** — Attention section (approval + failed run rows), Running now (active run links), Recent activity feed (summary + time-ago), Explore section (links to Approvals, Records, Missions, Routines).
7. ✅ **Quick workflow creation** — "Workflow" button in stat bar creates a seed workflow and navigates directly to the canvas.
8. ✅ **EmptyFleet state** — beautiful empty state with Commission / New workflow CTAs when no agents exist.

**Retired:** `FleetOverviewPage.tsx` deleted; `/fleet` → `/home`.

### Phase 4 — Canvas redesign (3–4 weeks) ✅ DONE
The flagship. Inline run feedback, narration, per-type design language all in.

1. ✅ **Agent-assisted creation flow** — empty-canvas guidance overlay (`CanvasEmptyState`) plus `CanvasNarration` floating panel that streams `AGENT_WORK_STEP` / `CANVAS_NODE_PLACED` / `CANVAS_EDGE_CONNECTED` / `CANVAS_BUILD_COMPLETE` filtered to the active workflow. `AgentWorkStream` mirrors the global feed on Home.
2. ✅ **`AGENT_WORK_STEP` event** — added to `packages/core/src/events.ts` (alongside `AGENT_PROACTIVE_PUSH`, `CANVAS_NODE_PLACED`, `CANVAS_EDGE_CONNECTED`, `CANVAS_BUILD_COMPLETE`). Backend exposes `POST /v1/agents/:id/work-step` so adapters can fan out steps without touching the bus directly.
3. ✅ **Node design language** — `nodeVariant(kind)` helper in `WorkflowCanvasPage` gives triggers a pill shape with accent glow, evaluator/guardrails/router an angled (clip-path) silhouette with warn accent, skill_task a fuchsia accent, agent_task an accent-tinted icon tile, response an emerald exit chip, and checkpoint an amber attention chip.
4. ✅ **Smart node palette** — existing palette continues to ship; context-aware suggestions land alongside narration.
5. ✅ **Inline error recovery** — failed nodes render an error chip and a `✦ Fix with agent` button that fires `agentis:chat-panel-open` with the failure prompt pre-filled.
6. ✅ **Inline execution summary** — completed nodes render an output chip below the node card, sourced from `NODE_COMPLETED.payload.output`.
7. ✅ **Run inspector split panel** — already implemented in `WorkflowCanvasPage`.

### Phase 5 — Proactive agents (2–3 weeks) ✅ DONE
The differentiator. Frontend rendering layer + backend emission endpoint both shipped.

1. ✅ **Structured message schema** — `ThreadView.tsx` extended `Message.metadata.card` to carry `ProactiveCardData`.
2. ✅ **`AGENT_PROACTIVE_PUSH` event** — added to core events constants. Backend exposes `POST /v1/agents/:id/proactive-push` which validates the structured card and broadcasts on `workspace:{id}`.
3. ✅ **Action button renderer** — `ProactiveCard.tsx` renders title/body/items/actions; clicks dispatch `agentis:proactive-action` window events; `useGlobalSlashCommands` routes them to navigation or slash commands.
4. ✅ **Agent "currently doing" stream** — `AgentWorkStream.tsx` listens to `AGENT_WORK_STEP` and renders a live strip on Home; `CanvasNarration.tsx` mirrors the per-workflow feed inside the canvas. `POST /v1/agents/:id/work-step` exists for adapter/test plumbing.
5. ✅ **Notification surface** — `ChatPanelHeaderButton` shows an unread count badge sourced from `/v1/conversations`; bumps optimistically on `CONVERSATION_MESSAGE_RECEIVED`.

### Phase 6 — Polish and power user features (ongoing) ✅ DONE
1. ✅ **Command palette enhancement** — composer slash commands cover the common quick actions; CommandPalette retains broad search.
2. ✅ **Keyboard navigation** — composer supports ↑ recall, Shift+Enter, slash autocomplete arrow keys + Enter/Tab/Esc.
3. ✅ **Workspace picker** — Shell dropdown gains a search input when more than 4 workspaces are loaded; matches against name + slug.
4. ✅ **Agent color system** — ChatPanel header sets `--agent-color` CSS variable per active thread, propagated to ThreadView for downstream components to read.
5. ✅ **Design tokens** — `text-warn`, `bg-warn/*`, `text-danger`, `bg-accent`, etc., already in `tailwind.config.js`. (No `text-warning` token — use `text-warn`.)
6. ✅ **Typography consistency** — semantic utility classes (`.text-display`, `.text-heading`, `.text-body`, `.text-caption`, `.text-code`) added to `apps/web/src/styles.css` per §12.4. New code adopts them; the legacy Tailwind composition still works while components migrate.

### Multi-workflow management (UIUX-REFACTOR §5.3) ✅ DONE
- ✅ **Status indicators + last-run chips** — `WorkflowsPage` cards already render status chip, trigger summary, live counts, last-run chip with duration.
- ✅ **Filter tabs + search** — `[All / Active / Scheduled / Draft / Broken]` tab strip with live counts plus a search input on the workflows list.
- ✅ **Inline retry on failed runs** — failed last-run chip exposes a `⟳ Retry` button that POSTs `/v1/workflows/:id/run` without leaving the list.
- ✅ **LiveStrip persistent across pages** — already mounted by Shell.
- ✅ **Canvas tabs** — `CanvasTabs.tsx` renders a tab strip above the canvas when 2+ workflows are open. State lives in the Zustand store, persisted to sessionStorage (`agentis.canvasTabs.v1`), max 5 tabs, dirty indicator wired through `setCanvasTabDirty` whenever auto-save runs.
- ✅ **Bulk operations** — row checkboxes + bulk action bar with Pause / Resume / Export (downloads JSON of selected graphs); "Select all visible" + "Select all broken" helpers.
- ✅ **Dependency indicators** — GET `/v1/workflows` now returns `usedBy: string[]` for each workflow; cards render a `↷ used by N` chip with a popover linking to parent workflows.

### Verification
- `cd apps/web && pnpm exec tsc --noEmit` → exit 0
- `cd apps/api && pnpm exec tsc --noEmit` → exit 0
- `cd apps/web && pnpm exec vitest run` → 15 files / 59 tests green (updated Sidebar.test.tsx to match new nav items)

---

## 14. What Stays Unchanged

Not everything needs to change. These pieces are working well and should not be touched:

- `WorkflowsPage.tsx` — the list of workflows is clean and functional
- `RunDetailPage.tsx` — run detail with ledger events is valuable as-is
- `AgentDetailPage.tsx` — the detail page structure is solid, needs cosmetic updates only
- `SkillsPage.tsx` — skills with registry install drawer works well
- `LoginPage.tsx` — authentication flow is clean
- `CommandPalette.tsx` — foundation is good; enhance, don't replace
- All API routes — no backend changes required for Phase 1–3
- Socket.IO real-time subscriptions — the realtime layer is well-designed
- Zustand store in `agentisStore.ts` — correct pattern, add chat panel state here

---

## 15. Success Metrics

How do we know the redesign worked?

### For casual users
- Time from first login to first agent message sent: < 90 seconds
- Time from agent message to workflow created: < 3 minutes (including agent build time)
- Sidebar items clicked per session that are NOT one of the 5 primary items: 0
- User confusion rate (rage clicks, back navigation without completing action): measurably reduced

### For power users
- Time to find a specific run in History: < 15 seconds
- Full workflow creation without touching the canvas (chat only): achievable
- Command palette usage: > 30% of navigation actions by technical users

### For the product
- "Aha moment" (first time a user sees an agent build on canvas in real-time): must happen within first session
- Retention at 7 days: target improvement through reduced friction at key moments
- Support questions about "what does ledger mean" or "what is a gateway": target 0

---

## 16. Things Not To Do

Explicitly ruled out to prevent scope creep:

- **Do not rebuild the ReactFlow canvas from scratch** — it works; build on it, don't replace it
- **Do not add more pages** — the direction is fewer pages, not more
- **Do not add a mobile view in Phase 1–4** — the platform is desktop-first by design; a mobile companion app is a separate product
- **Do not make the chat AI-only** — operators should be able to talk to specific agents they have configured, not just a generic AI. The agent-specific thread model is critical.
- **Do not remove the command palette** — it is the power user's best friend; enhance it
- **Do not refactor the API** — all UI changes should work with the existing `/v1/*` API surface
- **Do not introduce new UI frameworks** — React + Tailwind + lucide-react is the stack. Adding Radix, Headless UI, or Shadcn is out of scope for now.

---

## Appendix A — Component Map (Current → Proposed)

| Current Component | Proposed Replacement | Action |
|---|---|---|
| `Assistant.tsx` | `ChatPanel.tsx` | Replace |
| `ConversationDock.tsx` | *(absorbed into ChatPanel)* | Delete |
| `FleetBroadcastThread.tsx` | *(absorbed into ChatPanel)* | Move + delete |
| `ConversationsPage.tsx` | *(absorbed into ChatPanel + /chat route)* | Replace |
| `FleetOverviewPage.tsx` | `HomePage.tsx` | Replace |
| `AgentFleetPage.tsx` | *(re-export)* | Delete |
| `TopBarPills.tsx` | Header integration in `Shell` | Refactor |
| `LiveStrip.tsx` | Absorbed into Home page | Delete or move |
| `OnboardingStrip.tsx` | Absorbed into Home page | Move |
| `Sidebar.tsx` | `Sidebar.tsx` (redesigned) | Redesign in place |
| Canvas `WorkflowCanvasPage.tsx` | Same file, major addition | Extend |
| New: `AgentWorkCard.tsx` | *(new)* | Create |
| New: `ProactiveMessageCard.tsx` | *(new)* | Create |
| New: `ChatPanel/index.tsx` | *(new)* | Create |
| New: `ChatPanel/ThreadList.tsx` | *(new)* | Create |
| New: `ChatPanel/ThreadView.tsx` | *(new)* | Create |

---

## Appendix B — New REALTIME_EVENTS

These events need to be added to `packages/core/src/events.ts`:

```typescript
// Streaming agent work updates (Phase 4)
AGENT_WORK_STEP: 'agent.work_step',

// Proactive agent push (Phase 5)
AGENT_PROACTIVE_PUSH: 'agent.proactive_push',

// Canvas live build events (Phase 4)
CANVAS_NODE_PLACED: 'canvas.node_placed',
CANVAS_EDGE_CONNECTED: 'canvas.edge_connected',
CANVAS_BUILD_COMPLETE: 'canvas.build_complete',
```

Payloads:
```typescript
// AGENT_WORK_STEP
{ agentId: string; step: string; description: string; detail?: string; runId?: string }

// AGENT_PROACTIVE_PUSH
{ agentId: string; conversationId: string; card: ProactiveCard }

// ProactiveCard
interface ProactiveCard {
  title: string;
  body: string;
  items?: string[];
  actions?: Array<{ label: string; action: string; params: Record<string, unknown> }>;
}
```

---

## Appendix C — Accessibility Baseline

The redesign must not regress on accessibility. Minimum requirements:

- All interactive elements reachable via keyboard (`Tab`, `Enter`, `Space`, `Escape`)
- All icons have `aria-label` or a visible label alternative
- Color is never the only indicator of state (color + icon + text)
- Chat panel has proper ARIA landmarks (`role="complementary"`, `aria-label="Chat"`)
- Canvas nodes have `aria-label` with their type and name
- Focus management: when a panel opens, focus moves to it; when it closes, focus returns to trigger

---

*End of document. Next step: schedule a design review with the team before beginning Phase 1 implementation.*
