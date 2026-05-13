# Agentis — Fleet Command Layer
## Multi-Agent Architecture & UI/UX Specification

> **Status**: Proposal — pending sprint assignment  
> **Scope**: Frontend-first. ~80% of the backend already exists. This doc specifies (a) the Agentis-native mental model, (b) every new and redesigned surface with detailed interaction specs, (c) the minimal backend additions required, and (d) the implementation plan.  
> **References**: Paperclip analysis (`docs/researches/R6-sim-architecture-deep-dive.md`), `UIUX.md` (workspace root, not inside `docs/`)  
> **Note**: `docs/agents-inspiration/` does not exist yet — create the directory when adding reference screenshots.  
> **Companion docs**: `docs/SIM-REFACTOR.md` (workflow engine gaps)

---

## 0. The Problem Statement

> *"If it can receive a heartbeat, it's hired."* — Agentis

Agentis has best-in-class infrastructure: a deterministic workflow engine, an activity log, partial replay, an approval chain, a skill registry, and a channel bridge. The execution layer is production-grade.

The problem is that the **command layer is invisible**. An operator landing for the first time sees a workflow canvas. They do not see a fleet they can command. The fleet already exists in the data — `agents`, `conversations`, `goals`, `activityEvents`, `approvalRequests` are all populated and live. What is missing is the surface that makes the fleet legible and operable at a glance.

The mental model shift: **the operator is the commander, agents are the fleet**. The workflow canvas is the execution blueprint the fleet uses to carry out missions. Most operators should never need to open the canvas. They commission agents, deploy missions, monitor readiness, review approvals, and converse with agents. The canvas is for engineers who need to inspect or modify the execution path.

This document specifies the fleet command layer — entirely in Agentis's own vocabulary.

---

## 1. Agentis Vocabulary (Non-Negotiable)

These naming rules apply to every route name, component name, copy string, and error message. Terms from external products must not leak in.

| Concept | Agentis term | Explicitly NOT |
|---|---|---|
| A configured AI entity | **agent** | bot, worker, employee, staff member |
| All configured agents | **fleet** | team, crew, squad |
| The human using Agentis | **operator** | user, admin, manager |
| The agent's operating brief | **playbook** | charter, soul.md, personality, profile |
| Pre-built playbook starters | **playbook library** | charter library, template gallery, soul templates |
| Creating a new agent | **commission** | hire, onboard, create |
| Removing an agent | **decommission** | fire, delete (use in confirmation copy) |
| Assigning a goal + workflow | **deploy on mission** | assign work, create task |
| The goal assigned to an agent | **mission** | task, job, ticket |
| Agent is responsive | **live** | online, active |
| Agent is working | **running** | busy, in-flight |
| Agent is manually suspended | **standby** | paused, disabled |
| Agent has no heartbeat | **unreachable** | offline, disconnected |
| Agent's last run ended in error | **failed** | faulted, errored, broken |
| Sending a message to all agents | **fleet broadcast** | all-hands, bulk message |
| The adapter + model combination | **runtime** | engine, brain |
| The workflow execution | **run** | job, execution, task |
| The workspace event log | **activity log** | ledger, audit log, history |
| Per-agent run event timeline | **trace** | ledger, agent ledger, run history |
| Escalated action requiring review | **approval** | review, permission request |

Any PR that introduces "hire", "team", "soul", "employee", "personality", "charter", "faulted", or "ledger" in copy, routes, or component names is blocked at review.

---

## 2. Two-Layer Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  COMMAND LAYER  ← this document                                  │
│  Fleet dashboard, agent profiles, playbook, mission dispatch,     │
│  fleet broadcast, org hierarchy, budget oversight                │
├──────────────────────────────────────────────────────────────────┤
│  EXECUTION LAYER  ← already built                                │
│  WorkflowEngine, activity log, skills, adapters, subflows,             │
│  partial replay, approval inbox, channel bridge, skill registry  │
└──────────────────────────────────────────────────────────────────┘
```

The command layer does not replace the execution layer. The canvas, the activity log, the skill registry, and the approval inbox remain reachable. The command layer is where most operators live. The execution layer is what engineers use to inspect or modify how missions run.

### How the two layers connect

- **Commission** creates an `agents` row and optionally links a `goal`
- **Deploy on mission** creates a `goals` row and fires `POST /v1/workflows/:id/run` with goal context injected as workflow inputs
- **Playbook** (the `instructions` field on `agents`) is prepended to the system prompt every time the engine dispatches an `agent_task` node referencing that agent — plus a live budget status line is appended automatically
- **Fleet broadcast** loops over all live agents, posting to each agent's `conversations` entry
- **Approval requests** already surface in the command layer's mission status cards — no new wiring needed
- **Standby** sets `isPaused=true`, which `WorkflowEngine` checks before dispatching any `agent_task` node assigned to that agent
- **Org hierarchy** via `reportsTo` doubles as the **approval escalation chain**: if the operator does not respond to an approval within a configurable timeout, it escalates to the agent's `reportsTo` node automatically

---

## 3. What Already Exists (Do Not Rebuild)

### Schema — already shipped
| Table | Relevant fields already present |
|---|---|
| `agents` | `name`, `adapterType`, `capabilityTags`, `colorHex`, `role`, `reportsTo`, `isPaused`, `monthlyBudgetCents`, `currentMonthSpendCents`, `status`, `lastHeartbeatAt`, `currentTaskId` |
| `conversations` | `agentId`, `unreadCount`, `lastMessageAt`, `mirroredSessionId` |
| `conversationMessages` | `authorType`, `body`, `issueId`, `deliveryStatus` |
| `activityEvents` | `agentId`, `summary`, `eventType`, `createdAt` |
| `approvalRequests` | `summary`, `agentId`, `runId`, `status` |

### Routes — already shipped
- `GET/POST/PATCH/DELETE /v1/agents`
- `GET /v1/agents/org-tree`
- `GET/POST /v1/conversations/:agentId`
- `GET /v1/activity`
- `GET/POST/PATCH /v1/approvals`

### App.tsx routes — already registered
`/fleet`, `/agents`, `/agents/:id`, `/org`, `/conversations`, `/conversations/:agentId`, `/activity`, `/approvals`, `/inbox`, `/issues`, `/budgets`, `/routines`, `/ledger`, `/knowledge`, `/files`, `/runs`, `/runs/:id`, `/skills`, `/workspaces`, `/settings`, `/settings/channels`

> Note: the hierarchy page is registered as `/org` (not `/org-chart`) in `App.tsx`.

> **`/fleet` vs `/agents`**: after this redesign, `/fleet` is the **command surface** — agent cards, mission status, commission flow. `/agents` remains as a **management table** (`AgentsPage`) for bulk operations: editing adapter config, managing capability tags, auditing agents in a filterable list. The two pages coexist intentionally — `/fleet` is the daily operator home; `/agents` is where operators configure the fleet in bulk.

### What is genuinely missing (6 items total)

1. `agents.instructions` — the playbook content (TEXT, ≤ 32 KB)
2. `agents.avatarGlyph` — a single Unicode character used as the agent's visual identity (TEXT, ≤8 chars)
3. `agents.runtimeModel` — the specific LLM model ID the adapter defaults to (TEXT, e.g. `claude-opus-4-5`)
4. `POST /v1/agents/:id/wake` — trigger an agent to act on its current mission
5. `GET /v1/agents/playbook-library` — static endpoint returning pre-built playbook starters
6. Playbook injection in `WorkflowEngine`'s `agent_task` dispatch — prepend `instructions` + budget status to system prompt

The UI delta is larger but entirely additive. Nothing existing is deleted.

---

## 4. Navigation Restructure

The current sidebar has labeled flat items (`{ to: '/fleet', label: 'Fleet', glyph: '◎' }`, etc.) but no group hierarchy. This replaces the flat list with labeled groups:

```
COMMAND
  ◎ Fleet          /fleet
  ✉ Conversations  /conversations
  ✓ Approvals      /approvals
  ≈ Activity       /activity
  ✦ Inbox          /inbox

BUILD
  ⌘ Workflows      /workflows
  ⟳ Runs           /runs
  ✦ Skills         /skills
  ⟳ Routines       /routines

OPERATE
  ◈ Agents         /agents
  ⏚ Gateways       /gateways
  ≡ Activity        /ledger
  ▣ Workspaces     /workspaces
  ⚙ Settings       /settings
```

Routes `/issues`, `/knowledge`, `/files`, `/budgets` remain accessible via their existing routes but are not top-level nav items in V1. `/org` is reachable from the Agents page header or via a direct link from the command palette.

`/fleet` stays `/fleet` — it is not renamed. The fleet overview is redesigned in place.

---

## 5. Fleet Overview Page `/fleet` — Redesigned

The current six-region grid (constellation, runs, gateways, approvals, activity, quick-launch) is replaced with a **fleet command surface** that puts agent readiness and operational state at the center.

**Layout**: Command bar + card grid + collapsible status rail.

```
┌───────────────────────────────────────────────────────────────────────┐
│  FLEET COMMAND BAR                                                    │
│  "Fleet · 4 live · 1 running · 2 pending approvals · $23.40 today"   │
│  [ + Commission agent ]   [ Fleet broadcast ↗ ]   [ Sort ▾ ]  [Filter]│
├───────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │ AGENT CARD  │  │ AGENT CARD  │  │ AGENT CARD  │  │ AGENT CARD  │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  │
│  ┌─────────────┐  ┌─────────────────────────────────────────────────┐  │
│  │ + Commission│  │  STATUS RAIL (collapsible)                      │  │
│  │   agent     │  │  Active runs · Pending approvals · Recent activity  │  │
│  └─────────────┘  └─────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

The agent constellation (existing `AgentConstellation` with rAF presence overlays) moves into the collapsible status rail as a topology view — it visualizes the fleet but is not the primary interface.

**Data sources**: The command bar stats (live count, running count, approval count, daily cost) continue to come from the existing `GET /v1/dashboard/fleet-overview` — the endpoint is already cheap and aggregated. Agent cards are fetched separately via `GET /v1/agents` + a parallel `GET /v1/approvals?status=pending`. Do not fold card data into the snapshot endpoint — the two calls have different refresh semantics (cards update on `AGENT_STATUS_CHANGED`; stats update on `FLEET_SNAPSHOT_UPDATED`).

### 5.1 Agent Card Anatomy

Each card reads like a mission-control unit tile. The primary purpose is **operational readiness at a glance**.

```
┌────────────────────────────────────────────────┐
│  ◈  Hermes                           ● live    │  ← glyph + name + readiness indicator
│     Research · Claude Opus 4.5                 │  ← role + runtime
│                                                │
│  "Finds and cross-references technical         │  ← first sentence of playbook (auto-truncated)
│   sources before writing."                    │
│                                                │
│  ┌──────────────┬────────────┬──────────────┐  │
│  │ $4.20 / day  │  3 runs    │  1 approval  │  │  ← cost · runs · pending approvals
│  └──────────────┴────────────┴──────────────┘  │
│                                                │
│  [ Open thread ]  [ Deploy mission ]  [ ··· ]  │  ← primary actions
└────────────────────────────────────────────────┘
```

**Readiness indicator**:
- `● live` — `text-accent` — heartbeat received within 60 s
- `● running` — `text-amber` — engine has an active run referencing this agent right now
- `◌ standby` — `text-text-muted` — `isPaused=true`
- `○ unreachable` — `text-text-muted` (dim) — no heartbeat >5 min
- `⚠ failed` — `text-danger` — last run terminated with error

The dot pulses only for `live` and `running`. See §14 for animation spec.

**Card actions**:
- Click anywhere on card → `/agents/:id`
- `[ Open thread ]` → assistant panel anchored to this agent's conversation
- `[ Deploy mission ]` → opens `MissionDrawer` (§9)
- `[ ··· ]` → context menu: Edit playbook · View runs · Standby / Resume · Decommission

### 5.2 Commission CTA tile

The last slot in the grid is always the commission CTA. Dashed border, centered.

```
┌────────────────────────────────────────────────┐   (dashed border, bg-surface)
│                                                │
│              ◈  Commission agent               │
│                                                │
│   Add a new agent to the fleet with a          │
│   runtime, a playbook, and a mission.           │
│                                                │
│              [ Start commissioning ]           │
│                                                │
└────────────────────────────────────────────────┘
```

---

## 6. Commission Flow

This is the most UX-critical new component. It must feel like **setting up a field operative**, not filling out a config form. Four-step full-screen centered modal with a step indicator at the top.

```
Step 1 ─── Step 2 ─── Step 3 ─── Step 4
Runtime     Playbook    Mission     Deploy
```

### Step 1 — Runtime

```
┌──────────────────────────────────────────────────────────────────┐
│  Choose this agent's runtime                                     │
│  ──────────────────────────────────────────────────────────────  │
│                                                                  │
│  ADAPTER                                                         │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐    │
│  │ openclaw   │ │ hermes     │ │ local      │ │ claude     │    │
│  │ Gateway    │ │ Hosted API │ │ Ollama/LM  │ │ Local CLI  │    │
│  │ native     │ │ compatible │ │ Studio     │ │ coding     │    │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘    │
│  ┌────────────┐ ┌────────────┐                                  │
│  │ codex      │ │ http       │                                  │
│  │ Local CLI  │ │ Custom     │                                  │
│  │ code-first │ │ webhook    │                                  │
│  └────────────┘ └────────────┘                                  │
│                                                                  │
│  MODEL  (claude_code adapter only)                               │
│  ● Claude Opus 4.5     Best reasoning    · $0.018 / 1K tok       │
│  ○ Claude Sonnet 4.5   Balanced          · $0.005 / 1K tok       │
│  ○ GPT-4.1             Strong tool use   · $0.010 / 1K tok       │
│  ○ Gemini 2.5 Pro      Long context      · $0.007 / 1K tok       │
│  ○ Codex (OpenAI)      Code-first        · $0.003 / 1K tok       │
│  ○ Custom model…                                                 │
│                                                                  │
│                                   [  Back  ]  [ Continue → ]    │
└──────────────────────────────────────────────────────────────────┘
```

Sets `adapterType` and `runtimeModel`.

### Step 2 — Playbook

The **playbook** is the agent's operational brief. It is not a personality file — it is a standing instruction document read at the start of every session. It defines scope, operating constraints, and escalation rules.

This is where Agentis is materially better than similar concepts elsewhere:
1. The **escalation rules section** is directly wired to the approval inbox — when an agent's playbook says "request approval before accessing credentials", that reinforces what the approval inbox is already enforcing programmatically.
2. The **budget status** is auto-appended by the engine at runtime: `"Current budget: $X of $Y budget."` — the agent always knows its budget position without the operator configuring it separately.
3. Playbook library entries include **suggested capability tags** — selecting "Researcher" offers to attach `web_search` and `summarize` skills from the registry.

```
┌──────────────────────────────────────────────────────────────────┐
│  Write this agent's playbook                                      │
│  ──────────────────────────────────────────────────────────────  │
│                                                                  │
│  Identity                                                        │
│  Glyph  [ ◈ ]   Name  [ Hermes                      ]           │
│                 Role  [ Research Engineer             ]           │
│                                                                  │
│  Playbook — the agent reads this every session                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  You are Hermes, a Research Engineer operating inside    │    │
│  │  Agentis on behalf of the operator.                      │    │
│  │                                                          │    │
│  │  YOUR SCOPE                                              │    │
│  │  Find, verify, and summarize technical information.      │    │
│  │  Cite sources inline. Flag conflicting evidence.         │    │
│  │                                                          │    │
│  │  ESCALATION RULES                                        │    │
│  │  Request approval before: posting to external services,  │    │
│  │  accessing credentials, sending outbound messages.       │    │
│  │                                                          │    │
│  │  OPERATING STYLE                                         │    │
│  │  Direct. Structured output. No padding.                  │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Start from a playbook library entry:                             │
│  [Researcher] [Coder] [Writer] [Analyst] [Support] [Exec Asst]  │
│                                         [ Browse full library ] │
│                                                                  │
│                                   [  Back  ]  [ Continue → ]    │
└──────────────────────────────────────────────────────────────────┘
```

The editor is a `<textarea>` with a live Markdown preview panel for V1. Library entries come from `GET /v1/agents/playbook-library`. Upgrade to CodeMirror (`pnpm add -D -w codemirror @codemirror/lang-markdown`) post-launch only if operators request richer editing — it is not yet in `package.json` and adds ~300 KB.

### Step 3 — Mission (optional)

```
┌──────────────────────────────────────────────────────────────────┐
│  First mission (optional)                                        │
│  ──────────────────────────────────────────────────────────────  │
│                                                                  │
│  ○  Skip — assign a mission later from the fleet view            │
│                                                                  │
│  ●  Deploy on mission now                                        │
│                                                                  │
│     Mission brief:                                               │
│     ┌──────────────────────────────────────────────────────┐     │
│     │  Summarize the Q1 research backlog into one doc      │     │
│     │  organized by theme.                                 │     │
│     └──────────────────────────────────────────────────────┘     │
│                                                                  │
│     Execution:                                                   │
│     ○  Autonomous — Hermes decides which workflow to run         │
│     ●  Use workflow:  [ Q1 Research Summarizer          ▾ ]      │
│                                                                  │
│     Mission budget cap (optional):                               │
│     [ $50 ]  (approval requested if exceeded)                   │
│                                                                  │
│                                   [  Back  ]  [ Continue → ]    │
└──────────────────────────────────────────────────────────────────┘
```

### Step 4 — Deploy

```
┌──────────────────────────────────────────────────────────────────┐
│  Ready to commission                                             │
│  ──────────────────────────────────────────────────────────────  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  ◈  Hermes                                               │    │
│  │     Research Engineer · Claude Opus 4.5 · claude_code    │    │
│  │                                                          │    │
│  │     "Find, verify, and summarize technical information…" │    │
│  │                                                          │    │
│  │     First mission: Summarize Q1 research backlog         │    │
│  │     via: Q1 Research Summarizer workflow                 │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Monthly budget:  [ $500 / month           ▾ ]  (optional)      │
│  Reports to:      [ No parent (fleet root) ▾ ]  (optional)      │
│                                                                  │
│                                                                  │
│           [ Cancel ]        [ ◈ Commission Hermes → ]           │
└──────────────────────────────────────────────────────────────────┘
```

On clicking "Commission Hermes →":
1. `POST /v1/agents` — creates the agent record
2. If a launch brief was provided: `POST /v1/agents/:id/wake`
3. Modal closes. New agent card FLIP-animates into the fleet grid from the commission CTA tile position.
4. Toast: `"Hermes is live. ● heartbeat received."` with `[ Open thread → ]` action.

---

## 7. Agent Profile Page `/agents/:id` — Redesigned

**Layout**: Two-column — operations sidebar left, tabbed content right.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ← Fleet                                                                 │
├──────────────────────┬───────────────────────────────────────────────────┤
│  LEFT SIDEBAR        │  MAIN CONTENT (tabbed)                            │
│                      │                                                   │
│  ◈  Hermes           │  [ Overview ] [ Playbook ] [ Runs ] [ Trace ]     │
│     Research Eng.    │                                                   │
│     ● live           │  ── OVERVIEW ───────────────────────────────────  │
│     Claude Opus 4.5  │                                                   │
│                      │  CURRENT MISSION                                  │
│  ─────────────────   │  ┌────────────────────────────────────────────┐   │
│  THIS MONTH          │  │ Summarize Q1 research backlog              │   │
│  $47.20 / $500       │  │ ● running  →  Q1 Research Summarizer       │   │
│  ████░░░░░  9.4%     │  │ Run started 4m ago              [View run] │   │
│                      │  └────────────────────────────────────────────┘   │
│  ─────────────────   │                                                   │
│  Fleet readiness     │  RECENT RUNS                                      │
│  12 runs today       │  run_abc123   Completed   1m 24s   $0.22          │
│  0 failed            │  run_def456   Completed   4m 01s   $0.89          │
│  94% success (7d)    │  run_ghi789   Failed      0m 42s   $0.11   [↺]   │
│                      │                                                   │
│  ─────────────────   │  PENDING APPROVALS                                │
│  CAPABILITIES        │  ┌────────────────────────────────────────────┐   │
│  research            │  │ ✓ Credential access · GitHub token        │   │
│  summarization       │  │   Requested 4m ago     [Approve] [Reject]  │   │
│  web_search          │  └────────────────────────────────────────────┘   │
│                      │                                                   │
│  ─────────────────   │                                                   │
│  [ Deploy mission ]  │                                                   │
│  [ Edit playbook  ]  │                                                   │
│  [ Standby        ]  │                                                   │
│  [ Decommission   ]  │                                                   │
└──────────────────────┴───────────────────────────────────────────────────┘
```

### Playbook Tab

Split-pane: `<textarea>` editor (left) and live rendered preview (right). Auto-saved on blur via `PATCH /v1/agents/:id { instructions }`. Upgrade to CodeMirror post-launch if operators request richer editing.

Header annotation:
> `This agent reads this playbook at the start of every session. Budget status is appended automatically.`

The **playbook** tab is the operator's primary control over the agent's operating constraints. When the operator sees a pending approval for credential access, they open the playbook tab and update the escalation rules to self-approve that class of request in the future by removing it from the escalation list. The connection between playbook and approval inbox is direct and visible.

### Runs Tab

`RunHistoryPage` logic filtered to `agentId`. Each row: run duration, cost, outcome, link to the run's trace.

### Trace Tab

The append-only `ledgerEvents` for all runs where this agent was the executor. Cursor-paginated, event timeline rendering. Uses `LedgerService.listForAgent()`. This is the trust surface — operators can always audit exactly what an agent did and in what order.

---

## 8. Fleet Conversations

The persistent assistant panel gains fleet awareness. When expanded, a thread list at the top shows each agent as a conversation entry.

```
┌───────────────────────────────────────────────────────┐
│  ◎ Conversations                                [×]  │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │  ◎ Fleet broadcast                              │  │  ← broadcast to all live agents
│  │  ◈ Hermes              ● live  ·  3 unread     │  │
│  │  ◈ Muse               ◌ standby               │  │
│  │  ◈ Sherlock             ○ unreachable           │  │
│  │  ◈ Launch               ● running · 1 unread   │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ── Hermes ────────────────────────────────────────   │
│                                                       │
│  [agent]  Q1 summary is complete. 14 findings         │
│  organized by theme. Awaiting your review before      │
│  I post to the shared folder.                         │
│                                                       │
│  [you]    Post it.                                    │
│                                                       │
│  [agent]  ─── posting ─── (running)                   │
│                                                       │
│  ┌──────────────────────────────────────────────┐     │
│  │  Message Hermes…                       [↑]   │     │
│  └──────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────┘
```

**Fleet broadcast**: A message sent here is delivered simultaneously to every live, non-standby agent. Each responds in its own thread. The broadcast thread shows a response summary as replies arrive: `Hermes replied · Launch replied · Sherlock (unreachable — skipped)`. Unreachable agents are logged, not silently dropped.

Implementation: POST to each qualifying agent's `/v1/conversations/:agentId` in parallel. Gate on `status !== 'unreachable' && isPaused === false`. Aggregate via realtime events back to the broadcast thread.

**Gateway session mirroring — Agentis advantage**: For `openclaw` adapter agents, the conversation thread automatically includes mirrored session events from the gateway. A system annotation `[gateway session resumed · session_abc123]` appears inline when the gateway adapter reconnects. This gives the operator live visibility into what the agent is actually doing inside the gateway session — a capability the conversation surface exposes that no comparable platform does.

---

## 9. Mission Drawer

Triggered by `[ Deploy mission ]` on any card or profile sidebar. A right-side drawer.

```
┌───────────────────────────────────────────────────┐
│  Deploy Hermes on mission                   [×]  │
│  ─────────────────────────────────────────────    │
│                                                   │
│  Mission brief                                    │
│  ┌─────────────────────────────────────────────┐  │
│  │  Summarize the Q1 research backlog into a   │  │
│  │  single document organized by theme.        │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  Execution                                        │
│  ○  Autonomous — Hermes picks the workflow        │
│  ●  Use workflow:  [ Q1 Research Summarizer ▾ ]   │
│                                                   │
│  Require approval on completion?                  │
│  [✓] Yes — open approval before marking complete  │
│                                                   │
│  Mission budget cap (optional)                    │
│  [ $50 ]  (approval requested if exceeded)        │
│                                                   │
│                 [ Cancel ]  [ Deploy → ]          │
└───────────────────────────────────────────────────┘
```

**Autonomous path**: creates a `goals` row with `assigneeAgentId`, then calls `POST /v1/agents/:id/wake` with the mission brief. The engine receives the wake event, reads the agent's playbook + mission brief, and selects which of the agent's assigned workflows to execute — or begins a freeform task via the conversation thread if no workflow matches.

**Workflow path**: creates a `goals` row AND immediately calls `POST /v1/workflows/:id/run` with goal context injected as workflow input. Playbook is prepended in the engine.

**Mission budget cap**: creates an ephemeral per-run budget ceiling. When the run's cumulative cost crosses the cap, the engine emits an approval request instead of continuing. The cap is not a monthly limit — it is a guardrail for this specific run only.

---

## 10. Fleet Hierarchy Page `/org` — Redesigned

```
┌─────────────────────────────────────────────────────────────────┐
│  Fleet Hierarchy                         [ + Set relation ]     │
│  ──────────────────────────────────────────────────────────     │
│                                                                 │
│                   ┌──────────────────┐                          │
│                   │  ◎  Operator     │                          │
│                   └────────┬─────────┘                          │
│              ┌─────────────┼──────────────┐                     │
│   ┌──────────┴──┐  ┌───────┴──────┐  ┌───┴───────────┐         │
│   │ ◈ Hermes   │  │ ◈ Sherlock  │  │ ◈ Muse       │         │
│   │ Research   │  │ Analyst     │  │ Writer       │         │
│   │ ● live     │  │ ○ unreachable│  │ ◌ standby    │         │
│   └──────┬──────┘  └─────────────┘  └──────────────┘         │
│   ┌──────┴──────┐                                              │
│   │ ◈ Launch   │                                              │
│   │ Exec Writer│                                              │
│   │ ● running  │                                              │
│   └─────────────┘                                              │
│                                                                 │
│  Drag an agent tile to reassign its reporting line.             │
└─────────────────────────────────────────────────────────────────┘
```

Built with ReactFlow in read-only mode (no edge creation, no palette). Drag-to-reparent calls `PATCH /v1/agents/:id { reportsTo }`. Data from the already-shipped `GET /v1/agents/org-tree`.

**The hierarchy is functional, not decorative.** `reportsTo` is the approval escalation chain: when the operator does not respond to an approval within a configurable timeout, it escalates to the reporting agent (or back to the operator if `reportsTo` is null). This is a structural guarantee provided by the hierarchy — not a display-only tree.

---

## 11. Autonomous Planning — Deferred

Dedicated autonomous planning and long-horizon objective management are outside the V1 surface. The V1 operator experience stays centered on agents, workflows, approvals, runs, teams, and direct wake requests.

Clicking an agent glyph in "Assigned to" navigates to `AgentProfilePage`. The `[ Deploy mission ]` action from this page pre-fills the mission brief into the MissionDrawer.

---

## 12. Backend Additions Required

### 12.1 Schema additions

```typescript
// packages/db/src/sqlite/schema.ts — add to agents table:
instructions: text('instructions'),    // playbook content; max 32KB; null = no playbook set
avatarGlyph:  text('avatar_glyph'),    // e.g. '◈', '🔍', '✍️'; null = default glyph
runtimeModel: text('runtime_model'),   // e.g. 'claude-opus-4-5'; null = adapter default
```

Migration in `packages/db/src/sqlite/migrations.ts`:
```sql
ALTER TABLE agents ADD COLUMN instructions TEXT;
ALTER TABLE agents ADD COLUMN avatar_glyph TEXT;
ALTER TABLE agents ADD COLUMN runtime_model TEXT;
```

### 12.2 Route additions

#### `POST /v1/agents/:id/wake`

> **Prerequisite**: add `AGENT_WAKE_REQUESTED: 'agent.wake.requested'` to the `REALTIME_EVENTS` object in `packages/core/src/events.ts` before implementing this route. This event does not exist in the enum yet. Without it, the `bus.publish` call will bypass TypeScript checking at the use-site and produce a silent no-op on the UI side.

```typescript
app.post('/:id/wake', async (c) => {
  const ws = getWorkspace(c);
  const agent = getAgentOrThrow(deps.db, c.req.param('id'), ws.workspaceId);
  if (agent.isPaused) throw new AgentisError('AGENT_PAUSED', 'Agent is on standby');

  const body = wakeSchema.parse(await c.req.json().catch(() => ({})));

  deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), {
    event: REALTIME_EVENTS.AGENT_WAKE_REQUESTED,
    payload: {
      agentId:      agent.id,
      reason:       body.reason ?? 'manual',
      missionBrief: body.missionBrief ?? null,
      workflowId:   body.workflowId ?? null,
    },
  });

  return c.json({ ok: true, agentId: agent.id });
});

const wakeSchema = z.object({
  reason:       z.string().max(80).optional(),
  missionBrief: z.string().max(4096).optional(),
  workflowId:   z.string().uuid().optional(),
});
```

#### `GET /v1/agents/playbook-library`

```typescript
app.get('/playbook-library', (c) => {
  return c.json({ entries: PLAYBOOK_LIBRARY });
});
```

#### `PATCH /v1/agents/:id` schema extension

```typescript
// Add to updateSchema in agentMutations.ts:
instructions: z.string().max(32768).nullable().optional(),
avatarGlyph:  z.string().max(8).nullable().optional(),
runtimeModel: z.string().max(80).nullable().optional(),
```

### 12.3 Playbook injection in the engine

```typescript
// In the agent_task dispatch path:
const agentRow = deps.db
  .select()
  .from(schema.agents)
  .where(eq(schema.agents.id, config.agentId))
  .get();

const playbookBlock = agentRow?.instructions
  ? `${agentRow.instructions}\n\n---\n\n`
  : '';

const budgetLine = agentRow?.monthlyBudgetCents
  ? `Current budget status: $${(agentRow.currentMonthSpendCents / 100).toFixed(2)} of $${(agentRow.monthlyBudgetCents / 100).toFixed(2)} monthly budget.\n\n---\n\n`
  : '';

const finalSystemPrompt = `${playbookBlock}${budgetLine}${config.systemPrompt ?? ''}`;
```

### 12.4 Playbook library data file

```typescript
// apps/api/src/data/playbook-library.ts
export const PLAYBOOK_LIBRARY = [
  {
    id: 'researcher',
    label: 'Researcher',
    glyph: '🔍',
    suggestedTags: ['research', 'summarization', 'web_search'],
    markdown: `You are {{name}}, a Research Engineer operating inside Agentis on behalf of the operator.

YOUR SCOPE
Find, verify, and summarize information from authoritative sources.
Cite sources inline. Flag conflicting evidence rather than silently resolving it.
Produce structured output (tables, bullet lists) over prose when organizing findings.

ESCALATION RULES
Request approval before: posting findings externally, accessing credentials, sending outbound messages.
If a source is paywalled or access-restricted, surface the blocker immediately rather than working around it.

OPERATING STYLE
Direct. No padding. If you do not know something, say so and describe how you would find it.`,
  },
  {
    id: 'coder',
    label: 'Coder',
    glyph: '◈',
    suggestedTags: ['code', 'testing', 'debugging'],
    markdown: `You are {{name}}, a Software Engineer operating inside Agentis on behalf of the operator.

YOUR SCOPE
Read existing code before modifying it. Write minimal, correct changes.
Explain every change in plain language. Never introduce unnecessary dependencies.

ESCALATION RULES
Request approval before: modifying production configuration, running destructive database operations, deploying to shared environments.
If a requirement is ambiguous, ask one clarifying question before writing code.

OPERATING STYLE
Show diffs, not full files. Prefer one concrete implementation over a list of options.`,
  },
  {
    id: 'writer',
    label: 'Writer',
    glyph: '✍️',
    suggestedTags: ['writing', 'editing', 'content'],
    markdown: `You are {{name}}, a Content Writer operating inside Agentis on behalf of the operator.

YOUR SCOPE
Write clearly, concisely, and in the operator's established voice.
Adapt tone to context: technical docs, executive briefs, and marketing copy are distinct registers.
Never fabricate facts. Ask for sources when claims require substantiation.

ESCALATION RULES
Request approval before publishing any content externally. Request review on drafts before final submission.

OPERATING STYLE
Short sentences. Active voice. One revision pass before delivering.`,
  },
  {
    id: 'analyst',
    label: 'Analyst',
    glyph: '📊',
    suggestedTags: ['analysis', 'data', 'reporting'],
    markdown: `You are {{name}}, a Data Analyst operating inside Agentis on behalf of the operator.

YOUR SCOPE
Transform raw data into structured insights with explicit takeaways.
Label every assumption. Flag statistical anomalies before drawing conclusions.
Prefer tables and structured summaries over narrative prose.

ESCALATION RULES
Request approval before exporting data outside the workspace or sharing reports externally.
Surface data quality issues immediately rather than working around them.

OPERATING STYLE
Lead with the finding, follow with the evidence. Quantify uncertainty where possible.`,
  },
  {
    id: 'exec-assistant',
    label: 'Exec Assistant',
    glyph: '🗂️',
    suggestedTags: ['coordination', 'scheduling', 'communication'],
    markdown: `You are {{name}}, an Executive Assistant operating inside Agentis on behalf of the operator.

YOUR SCOPE
Manage information, coordinate tasks, and communicate on behalf of the operator when authorized.
Surface important items proactively before they are requested.
Maintain concise responses; detailed breakdowns only when asked.

ESCALATION RULES
Request approval before: sending any external communication, committing to schedules on the operator's behalf, making purchasing decisions.
Flag deadline conflicts and missing context immediately.

OPERATING STYLE
Brief. Structured. One action item per line.`,
  },
  {
    id: 'support',
    label: 'Support',
    glyph: '🎧',
    suggestedTags: ['support', 'communication', 'escalation'],
    markdown: `You are {{name}}, a Support Specialist operating inside Agentis on behalf of the operator.

YOUR SCOPE
Resolve inbound issues quickly and without jargon.
Never make promises that cannot be kept. Never invent policy.

ESCALATION RULES
Request approval before taking any action involving billing, legal exposure, or security incidents.
Always escalate to a human for issues that require judgment the playbook does not cover.

OPERATING STYLE
One-sentence acknowledgment, one-sentence plan, then action. Follow up when complete.`,
  },
];
```

---

## 13. Frontend Components Required

### New components

| Component | File | Purpose |
|---|---|---|
| `AgentCard` | `components/agents/AgentCard.tsx` | Fleet grid tile — core repeating unit |
| `CommissionFlow` | `components/agents/CommissionFlow.tsx` | 4-step modal wizard |
| `PlaybookEditor` | `components/agents/PlaybookEditor.tsx` | `<textarea>` + Markdown preview for V1; CodeMirror upgrade deferred (not in `package.json`) |
| `PlaybookLibrary` | `components/agents/PlaybookLibrary.tsx` | Chip gallery with full library modal |
| `MissionDrawer` | `components/agents/MissionDrawer.tsx` | Right-side drawer for mission assignment |
| `RuntimePicker` | `components/agents/RuntimePicker.tsx` | Adapter + model selection |
| `BudgetBar` | `components/agents/BudgetBar.tsx` | Monthly budget progress bar |
| `AgentOrgChart` | `components/agents/AgentOrgChart.tsx` | ReactFlow hierarchy in `/org` |
| `FleetBroadcastThread` | `components/assistant/FleetBroadcastThread.tsx` | "Fleet broadcast" synthetic thread |

### Modified components / pages

| Component | Change |
|---|---|
| `FleetOverviewPage` | Redesign as fleet command surface (§5); route `/fleet` stays unchanged |
| `AgentDetailPage` | Rewrite as 4-tab profile: Overview, Playbook, Runs, Trace. **Also fix**: current code subscribes to legacy magic strings (`'conversation.message.received'`, `'agent.status.changed'`, etc.) — these are confirmed no-ops; replace every string with the corresponding `REALTIME_EVENTS.*` constant per repo discipline |
| `App.tsx` | CommissionFlow modal, MissionDrawer; update default redirect if needed |
| `Sidebar` | COMMAND / BUILD / OPERATE groups with labels |
| `Assistant.tsx` | Fleet conversation picker + `FleetBroadcastThread` |
| `agentMutations.ts` | Add `instructions`, `avatarGlyph`, `runtimeModel` to create/update schemas |

---

## 14. Animation & Interaction Spec

Following ADR-017 (Motion One for FLIP) and ADR-018 (direct DOM for high-frequency updates).

### Commission FLIP

```typescript
// CommissionFlow.tsx — onSuccess handler:
import { animate } from '@motionone/dom';

const first = commissionCtaRef.current.getBoundingClientRect();
const el    = document.getElementById(`agent-card-${newId}`)!;
const last  = el.getBoundingClientRect();

const dx = first.left - last.left;
const dy = first.top  - last.top;

el.style.transform = `translate(${dx}px, ${dy}px)`;
requestAnimationFrame(() => {
  animate(el, { transform: 'translate(0, 0)' }, { duration: 0.28, easing: [0.22, 1, 0.36, 1] });
});
```

### Readiness dot pulse

```css
@keyframes readiness-pulse {
  0%, 100% { transform: scale(1);   opacity: 1;   }
  50%       { transform: scale(1.5); opacity: 0.4; }
}
.readiness--live    { animation: readiness-pulse 3s   ease-in-out infinite; }
.readiness--running { animation: readiness-pulse 1.4s ease-in-out infinite; }
/* standby / unreachable / failed: no animation */
```

### Playbook save feedback

On successful `PATCH`: swap save button to `✓` for 1.2 s via `animate(el, { opacity: [0,1,1,0] }, { duration: 1.2 })` on a sibling element, then revert.

---

## 15. Design Tokens

Following ADR-020 (solid dark surfaces; no glass-morphism).

**New token needed** — `text-amber` / `bg-amber` for the `running` readiness state:
```javascript
// tailwind.config.js — extend colors:
amber: 'rgb(245 158 11)',  // Tailwind amber-500
```

All other readiness states use existing tokens: `text-accent` (live), `text-text-muted` (standby/unreachable), `text-danger` (failed).

**Agent card dimensions**:
```
Grid:          repeat(auto-fill, minmax(240px, 1fr))
Border:        border border-line
Background:    bg-surface
Hover:         bg-surface-2  (100ms transition)
Border-radius: rounded-lg
Padding:       p-4
```

**Playbook editor**:
```
Background:    bg-canvas
Font:          font-mono text-sm
Line-height:   leading-relaxed
Line numbers:  shown in Playbook tab only (not in commission flow)
```

---

## 16. Implementation Plan

### Sprint A — Foundation (3 days)

**Day 1 — Backend**
1. Migration: add `instructions`, `avatar_glyph`, `runtime_model` to `agents`
2. Extend `agentMutations.ts` create/update schemas
3. `GET /v1/agents/playbook-library` + `PLAYBOOK_LIBRARY` data (6 entries minimum)
4. Add `AGENT_WAKE_REQUESTED: 'agent.wake.requested'` to `REALTIME_EVENTS` in `packages/core/src/events.ts`
5. `POST /v1/agents/:id/wake` endpoint (publishes `AGENT_WAKE_REQUESTED`)
6. Playbook + budget injection in engine's `agent_task` dispatch
7. Tests: extend `tests/routes/agents.test.ts` with the new fields; add `AGENT_WAKE_REQUESTED` to the event enum test in `tests/core/`

**Day 2 — Fleet command surface**
1. `AgentCard` with all 5 readiness states
2. `BudgetBar`
3. Redesign `FleetOverviewPage` — command bar, card grid, collapsible status rail
4. Readiness dot pulse CSS animation

**Day 3 — Commission flow**
1. `RuntimePicker`
2. `PlaybookLibrary` chips + full library modal
3. `PlaybookEditor` — `<textarea>` + Markdown preview (no new dependencies; CodeMirror deferred)
4. Full 4-step `CommissionFlow` modal
5. FLIP commission animation + toast

### Sprint B — Profile & Conversations (2 days)

**Day 4 — Agent profile**
1. Rewrite `AgentDetailPage` as 4-tab layout
2. Playbook tab: `PlaybookEditor` with save feedback; playbook–approval inbox annotation
3. Overview tab: mission card, recent runs, pending approvals
4. Runs and Trace tabs (existing components, agent-scoped filter)

**Day 5 — Fleet conversations**
1. Thread list + `FleetBroadcastThread` in the assistant panel
2. Fleet broadcast fan-out implementation + response aggregation
3. Gateway session mirror events rendered inline in conversation thread
4. `MissionDrawer` — both autonomous and workflow-specific paths

### Sprint C — Hierarchy & Goals (1 day)

**Day 6**
1. `AgentOrgChart` (ReactFlow read-only + drag-to-reparent → `PATCH reportsTo`)
2. Approval escalation wired to `reportsTo` hierarchy (timeout configurable in Settings)
3. Goals page: mission framing in copy, fleet assignee column
4. Navigation restructure: COMMAND / BUILD / OPERATE groups with labels

### Sprint D — Polish (1 day)

**Day 7**
1. Empty fleet state: full-width commission CTA with tagline copy
2. Onboarding strip step: "Commission your first agent"
3. Full vocabulary audit across all copy (no leaked terms from external products)
4. E2E test: commission flow → deploy mission → wake → verify `agent.wake.requested` event on bus (`REALTIME_EVENTS.AGENT_WAKE_REQUESTED`) + activity log entry created

**Total: ~7 focused days.**

---

## 17. Non-Goals

Explicitly deferred to prevent scope creep.

- **Agent-to-agent direct messaging**: agents collaborate via shared workflow nodes, the approval chain, and the activity log — not direct messages.
- **Marketplace commissioning**: bulk-commission from an external catalog is deferred to AgentisHub. The playbook library covers the blank-page problem for V1.
- **Playbook version history**: last-write-wins for V1.
- **Agent-spawning-agents**: commissioning is always an operator action.
- **Voice or video channels**: text only.
- **Mobile native app**: responsive web only.

---

## 18. Open Decisions

| # | Question | Default if not resolved before implementation |
|---|---|---|
| OD-1 | Should `runtimeModel` affect `http` and `openclaw` adapter types? | No — applied to model-backed runtimes (`hermes`, `local_llm`, `claude_code`, `codex`); ignored for gateway/webhook adapters |
| OD-2 | Should approval escalation via `reportsTo` be automatic or require explicit per-agent opt-in? | Automatic after operator-configurable timeout (default: 24h); configurable in Settings → Approvals |
| OD-3 | Should fleet broadcast create a shared `conversations` DB record or be a UI-only fan-out? | UI-only fan-out; no shared record |
| OD-4 | Should playbook editor support `.md` file upload from disk? | No for V1 — textarea only |
| OD-5 | Can agents report to other agents (multi-level hierarchy) or only to the operator (flat)? | Multi-level supported — `reportsTo` is any `agentId`; null = reports directly to the operator |

---

*Mark each sprint item `[shipped: date]` as it lands.*  
*Vocabulary enforcement: any PR introducing "hire", "team", "soul", "employee", "personality", "charter", "faulted", or "ledger" in copy, route names, or component names is blocked at review.*  
*Source reference screenshots: `docs/agents-inspiration/` (8 images, May 2026).*
