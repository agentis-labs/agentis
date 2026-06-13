# Agents Page Redesign
## Fleet View, Quick-Detail Modal, Config Page, and Commission Wizard

> **Status:** Design spec — May 2026
> **Scope:** `AgentsPage`, `AgentHierarchyCanvas`, `AgentCard`, `AgentDetailPage`, `AgentCreateWizard`
> **Trigger:** Full UI/UX audit — fleet view cards are useless, quick-detail modal doesn't exist,
> config page has wrong tab anatomy, and the commission wizard still doesn't match
> the spec already written in `AGENT-ONBOARDING-REPLAN.md`.

---

## Diagnosis

| Surface | Problem |
|---|---|
| Fleet canvas (renamed from "Canvas") | Cards show $0.00 / 0 runs / 0 approvals — three meaningless numbers for idle agents; rest of the card anatomy adds no value; "Canvas" is the wrong name — canvas implies building |
| No quick-detail modal | Clicking a card navigates to the full config page; the operator has no lightweight way to check status or channels without losing context |
| Config page — Identity tab | Name, description, space, adapter type, model, createdAt all dumped in three generic `Stat` boxes — no actionable structure |
| Config page — Instructions tab | Works OK but cannot create a new file (operators starting fresh have no way to paste initial instructions); "No instruction files" empty state is a dead end |
| Config page — Connections tab | Shows reports-to + supervised agents as dropdown selects — this is the least-used config and the most confusingly named tab |
| Config page — no Channels tab | Channel status (Telegram/Discord/Slack) is buried in Settings > Channels; operators cannot see or manage an agent's channels from the agent's page |
| Commission wizard | Despite `AGENT-ONBOARDING-REPLAN.md` being marked "Implemented", the live wizard still shows the Space field on orchestrator, still shows the full raw playbook textarea on step 3, and still doesn't have inline install for runtimes; the replan was documented but not applied |

---

## Design Principles

1. **Hierarchy is the canvas** — the fleet view is a hierarchy tree, not a grid of cards; the visual structure communicates rank and reporting chain instantly
2. **Cards tell you what the agent is doing, not what it has done** — if an agent is idle, the card shows last activity; if running, it shows the live task name; cost/runs are statistics, not status
3. **Two levels of detail** — quick-detail modal for operators checking in; full config page for operators changing things; they serve different intents and should look very different
4. **Channels belong with the agent** — an agent's inbox (Telegram, Discord, Slack) is agent-level config, not workspace-level settings
5. **Identity means who, not how** — name, role, avatar; the technical harness/model fields belong in a separate Runtime tab
6. **Instructions means all instruction files** — soul.md, agent.md, CLAUDE.md, any file the harness ships; plus an "Add file" button so operators can paste instructions immediately for brand-new agents
7. **Commission is a hiring act** — `AGENT-ONBOARDING-REPLAN.md` already fully specifies the correct wizard; this spec references it and documents what was not yet applied

---

## Part 1 — Fleet View (AgentsPage)

### 1.1 Rename

| Old name | New name | Rationale |
|---|---|---|
| "Canvas" view | "Fleet" view | Canvas implies building a workflow; Fleet is the command hierarchy |
| localStorage key `agentis.agents.view` | keep key, change values from `'canvas' \| 'table'` to `'fleet' \| 'table'` | |
| "Canvas" button label | "Fleet" | |

### 1.2 Fleet Canvas Layout

The hierarchy canvas must visually express command structure, not just arrange cards in rows.

```
+--------------------------------------------------------------------------+
|  Agents                              [Fleet | Table]   [+ Add agent]     |
|  4 agents                                                                 |
+--------------------------------------------------------------------------+
|  [All] [Active] [Idle] [Setup needed]            [Search agents...    ]  |
+--------------------------------------------------------------------------+
|                                                                          |
|  ORCHESTRATOR                                                            |
|                      +------------------------+                          |
|                      |  [hex] shoulderjhv  •  |  <- violet hex glyph    |
|                      |  Orchestrator          |                          |
|                      |  Hermes-3-Llama-3.1    |                          |
|                      |  idle — last active 2h |                          |
|                      +------------------------+                          |
|                         |           |                                    |
|         +---------------+           +-------------+                     |
|  MANAGERS                                                                |
|  +----------------------+     +----------------------+                  |
|  |  [dia] sdfg  •       |     |  [dia] Social Analyst|                  |
|  |  Manager · Claude    |     |  Manager · Runtime   |                  |
|  |  running: code rev.. |     |  idle — 1 workflow   |                  |
|  +----------------------+     +----------------------+                  |
|           |                            |                                 |
|  WORKERS                               |                                 |
|  +----------------------+    +----------------------+                   |
|  |  [sq]  shoulder  ○   |    |  [ghost node]        |                   |
|  |  Worker · OpenClaw   |    |  + Add worker to     |                   |
|  |  setup needed        |    |    Social Analyst     |                   |
|  +----------------------+    +----------------------+                   |
|                                                                          |
|  [status bar]  1 worker needs setup                                     |
+--------------------------------------------------------------------------+
```

### 1.3 New Agent Card Anatomy

The card must answer: **who is this agent, and what is it doing right now?**

```
+----------------------------------------------+
|  [role-glyph]  {Name}            {status-dot} |
|  {Role} · {harness-label}                     |
|  ------------------------------------------  |
|  {live-activity-line}                         |
+----------------------------------------------+
```

**Live activity line rules:**

| Agent state | Line shown |
|---|---|
| `running` / `busy` | "running: {truncated current task name}" (amber text) |
| `online` / `live` | "ready — {capability-tags[0..1]}" (green text) |
| `idle` / `offline` | "idle — last active {relative time}" (muted text) |
| setup needed (no harness) | "setup needed · connect harness" (warn text, clickable) |
| `error` | "failed: {last error short}" (red text) |

**What is removed vs current:**
- ❌ $0.00 / 0 runs / 0 approvals metric grid
- ❌ Budget bar (meaningless for idle agents)
- ❌ Playbook excerpt ("No playbook set yet." adds zero value in the hierarchy view)
- ❌ Thread / MoreHorizontal footer buttons (these belong in the quick-detail modal)

**What is added:**
- ✅ Role glyph (hexagon/diamond/square SVG) with tier-specific border color
- ✅ Live activity line (single sentence, changes in real time via AGENT_STATUS_CHANGED)
- ✅ Status dot with correct animation: amber pulse for running, green solid for live, grey for idle, red for error

**Tier-specific border colors:**
- Orchestrator: `border-[#8b5cf6]` (violet)
- Manager: `border-[#06b6d4]` (cyan)
- Worker: `border-line` (default — workers are many, visual noise must be low)

### 1.4 Ghost Nodes

Ghost nodes for missing hierarchy positions remain but with corrected copy:

| Ghost type | Copy |
|---|---|
| Missing orchestrator | "Set up the workspace brain → " (neutral border, no color) |
| Missing manager for a space | "+ Add manager for {space}" (cyan border, dim) |
| Missing worker under manager | "+ Add worker to {manager name}" (dim, square glyph) |

Clicking any ghost opens `AgentCreateWizard` with `initialRole` and `lockInitialRole: true` pre-set.

---

## Part 2 — Agent Quick-Detail Modal

When an operator **clicks a card** in Fleet view, instead of navigating to the full config page, a **right-anchored slide-over panel** opens. This is the daily check-in surface.

### 2.1 Layout

```
+-------------------------------------------------+
|  [close x]                                      |
|                                                  |
|  [avatar]  {Name}            {status-dot}        |
|  {Role} · {harness-label} · {model}              |
|  [Talk ->]  [Open agent ->]                      |
|                                                  |
|  LIVE STATUS                                     |
|  +---------------------------------------------+|
|  | {if running:}                                ||
|  | {task-name}                                  ||
|  | {spinner} {last tool call or streaming text} ||
|  | [Cancel task]                                ||
|  | {if idle:}                                   ||
|  | Waiting for work.   Last: {time}             ||
|  +---------------------------------------------+|
|                                                  |
|  CHANNELS                                        |
|  +---------------------------------------------+|
|  | Telegram   • connected   {chat name}  [...]  ||
|  | Discord    ○ not set     [Connect]           ||
|  | Slack      ○ not set     [Connect]           ||
|  +---------------------------------------------+|
|                                                  |
|  QUICK STATS  (only meaningful values)           |
|  Runs today: {N}   Budget: ${spent}/${cap}       |
|  Pending approvals: {N}                          |
|                                                  |
|  [Open agent config ->]                          |
+-------------------------------------------------+
```

### 2.2 Rules

- **Live status** subscribes to `agent(agentId)` room: `AGENT_STATUS_CHANGED`, `AGENT_PRESENCE_THINKING`, `AGENT_TERMINAL_TOOL_CALL`, `AGENT_TERMINAL_MESSAGE`
- **Channel status** fetches `GET /v1/channels?agentId={id}` and shows connected/not-set per provider
- **"Talk →"** button navigates to `/chat/agent/{id}`
- **"Open agent →"** navigates to `/agents/{id}` (the full config page)
- **Quick stats** shows nothing if all zeros (no phantom metric grids)
- Slide-over width: `w-[400px]`, opens with `translate-x-full → translate-x-0` transition
- Does NOT exist in Table view — table rows navigate directly to the config page

---

## Part 3 — Agent Config Page (`/agents/:id`)

This is where operators make changes. Not a status surface — a configuration surface.

### 3.1 Tab Restructure

| Old tab | New tab | Change |
|---|---|---|
| Overview | Identity | Renamed; stripped to name + role + avatar only |
| Instructions | Instructions | Keep + add "New file" button |
| Memory | Memory | Keep as-is |
| Connections | Runtime | Renamed and rewritten — shows harness config, not hierarchy |
| _(missing)_ | Channels | New tab for Telegram / Discord / Slack / WhatsApp |
| History | History | Keep as-is |

```
[Identity] [Instructions] [Memory] [Runtime] [Channels] [History]
```

### 3.2 Identity Tab

Strip this down to the three fields that define *who the agent is*:

```
+-------------------------------------------------------+
|  [avatar circle + upload overlay]                     |
|                                                        |
|  Name ______________________________                  |
|  Role   [Orchestrator / Manager / Worker]             |
|  Description (optional) ________________              |
|                                                        |
|  Reports to   [select, only for managers/workers]     |
|  Space        [select, only for managers/workers]     |
|                                                        |
|               [Save identity]                         |
+-------------------------------------------------------+
```

**Remove from Identity:**
- Adapter type label
- Runtime model label
- Created-at timestamp
- The three generic `Stat` boxes (Status / Harness / Model)
- Capability tags (move to Runtime tab)

### 3.3 Instructions Tab

The instructions tab is the agent's soul — every file the harness ships plus any manually added files.

```
+--[sidebar: file list]--------+--[editor]----------------------------+
|  soul.md         harness     |  soul.md                             |
|  agent.md        harness     |  ---                                 |
|  CLAUDE.md       platform    |  [textarea, full height, monospace]  |
|  +-------+                   |                                      |
|  | + New |                   |  [Save]                              |
|  +-------+                   |                                      |
+------------------------------+--------------------------------------+
```

**"+ New file" button:**
- Opens a small name input: "File name (e.g. persona.md)"
- Creates a blank file in the list with `source: 'platform'`, editable immediately
- Saves via `PUT /v1/agents/:id/instructions/:filename`
- This resolves the "new agent with no instruction files" dead-end empty state

**Updated empty state (when no files at all):**
```
+-------------------------------------------------------+
|  No instruction files yet.                            |
|  Start by creating one — give this agent a persona,   |
|  a role, or standing operating instructions.          |
|                                                        |
|  [+ Create first file]                                |
+-------------------------------------------------------+
```

### 3.4 Runtime Tab (renamed from Connections)

This tab handles how the agent connects to a harness and what model it uses.

```
+-------------------------------------------------------+
|  HARNESS                                              |
|  {runtime-icon}  {harness-label}  {status-dot}        |
|  Binary path   ________________                       |
|  Model         ________________  (optional override)  |
|                                                        |
|  [Test connection]  [Change harness]                   |
|                                                        |
|  CAPABILITY TAGS                                      |
|  [tag1 x]  [tag2 x]  [+ Add tag]                     |
|                                                        |
|  BUDGET                                               |
|  Monthly cap  [$ 500     ]                            |
|  Current spend: $12.40 this month                     |
|                                                        |
|  SUPERVISOR                                           |
|  Reports to: {agent-name}   [Change]                  |
+-------------------------------------------------------+
```

This is the technical config that was incorrectly living in "Connections". "Reports to" is chain-of-command, which is closer to runtime behavior than identity.

### 3.5 Channels Tab (new)

Currently channels live in Settings > Channels. Operators should manage an agent's channels from the agent's page.

```
+-------------------------------------------------------+
|  CHANNELS                                             |
|  Connect messaging channels to this agent's inbox.    |
|                                                        |
|  +--------------------------------------------------+ |
|  | Telegram         • connected                     | |
|  | @my_bot · chat ID: -100xxxxx                     | |
|  | [Test]  [Edit]  [Disconnect]                     | |
|  +--------------------------------------------------+ |
|                                                        |
|  +--------------------------------------------------+ |
|  | Discord          ○ not connected                 | |
|  | [Connect Discord]                                | |
|  +--------------------------------------------------+ |
|                                                        |
|  +--------------------------------------------------+ |
|  | Slack            ○ not connected                 | |
|  | [Connect Slack]                                  | |
|  +--------------------------------------------------+ |
|                                                        |
|  +--------------------------------------------------+ |
|  | WhatsApp         ○ not connected                 | |
|  | [Connect WhatsApp]                               | |
|  +--------------------------------------------------+ |
+-------------------------------------------------------+
```

Each channel card:
- Connected: shows username/chat-id + Test + Edit + Disconnect buttons
- Not connected: shows a single [Connect {provider}] button that opens an inline form (same inline form as the wizard channel accordion in AGENT-ONBOARDING-REPLAN.md §1.3.3)
- Test sends a "hello" message and shows `Delivered ✓` / `Failed ✗` inline

---

## Part 4 — Commission Wizard

> The full specification is in `docs/AGENT-ONBOARDING-REPLAN.md`. The design is correct and complete. This section documents what has **not yet been applied** based on the current wizard code, so the implementer knows exactly what to fix.

### 4.1 Gaps Between Spec and Current Implementation

| Gap | Spec says | Current code does | File + approx line |
|---|---|---|---|
| Space field on orchestrator | Hidden when `role === 'orchestrator'` | Rendered unconditionally | `AgentCreateWizard.tsx` ~L242 |
| Avatar upload affordance | Permanent camera icon at bottom-right, `opacity-60` rest, `opacity-100` hover | Upload icon disappears once name is typed (initials show but circle is not clearly clickable) | `AgentCreateWizard.tsx` ~L206 |
| Color swatches | Removed; color auto-assigned by role | 6 `SWATCHES` color pickers shown in step 1 | `AgentCreateWizard.tsx` ~L233 |
| Runtime detection → auto-select | If exactly one runtime found, auto-select silently + pre-fill binary path | Detection shown as badge only; no auto-selection | `RuntimePicker.tsx` |
| "Not installed" → Install inline | Each `Not installed` tile shows `[Install]` opening `HarnessInstallSlideOver` | No install path — static string only | Wizard step 2 |
| Runtime step — `ADAPTER_MODEL_REGISTRY` | Removed; model field is a free-text passthrough | Hardcoded dropdown list per adapter | `RuntimePicker.tsx` ~L148 |
| OpenClaw gateway gate | Blocking state shown when no gateway; "Connect a gateway →" CTA | Silently disables the commission button with no guidance | `AgentCreateWizard.tsx` |
| Playbook step — template picker | Role-filtered templates from `GET /v1/agents/playbook-library`; role-specific templates shown first | Templates not filtered by role | `AgentCreateWizard.tsx` |
| Playbook step — budget field | `monthlyBudgetCents` default $500 shown in playbook step | Present but the field appears under playbook text — visual hierarchy unclear | `AgentCreateWizard.tsx` |
| Commission step — canvas entrance | On success, `onCreated` fires → canvas FLIP animation; new node materializes at tier position | Commission closes modal but no canvas entrance animation | `AgentCreateWizard.tsx` / `AgentHierarchyCanvas.tsx` |
| Ghost node → wizard pre-set | Ghost node click opens wizard with `initialRole` + `lockInitialRole: true`; FLIP source rect = ghost position | Ghost nodes exist but wizard opens without correct pre-set role lock | `AgentHierarchyCanvas.tsx` |

### 4.2 Wizard Step Summary (What It Should Look Like)

**Step 1 — Identity and hierarchy** (current screenshots show this mostly right, but with the gaps above):

```
+-------------------------------------------------------+
|  Commission agent                                     |
|  Step 1 of 4 — identity and hierarchy     [====    ]  |
+-------------------------------------------------------+
|                                                        |
|  [avatar circle + camera overlay]                     |
|                                                        |
|  Name ________________________________                |
|  Description _________________________                |
|  ← Space field hidden for orchestrator →              |
|                                                        |
|  ROLE IN WORKSPACE                                    |
|  [hex Orchestrator]  [dia Manager]  [sq Worker]       |
|                                                        |
|  ← if Orchestrator selected: hierarchy context note → |
|  ← if Manager: Reports to selector →                  |
|  ← if Worker: Supervised by selector →                |
|                                                        |
|  ← if Orchestrator: [+ Connect inbox] accordion →     |
+-------------------------------------------------------+
|  [Cancel]                           [Continue →]      |
+-------------------------------------------------------+
```

**Step 2 — Runtime** (current screenshots show too many fields exposed, no detection-to-auto-select):

```
+-------------------------------------------------------+
|  FOUND ON THIS MACHINE (if any detected)              |
|  [Claude Code — Ready — Select]                       |
|                                                        |
|  ALL RUNTIMES                                         |
|  [Claw][Hermes][Claude•][Codex•][Cursor][HTTP]        |
|    install  install  ready   ready  install  —        |
|                                                        |
|  SELECTED: Claude Code                                |
|  Binary path   [/usr/bin/claude  ← pre-filled]       |
|  > Model override (optional, collapsed)               |
|  > Connection details (collapsed)                     |
|                                                        |
|  [Test connection]                                    |
+-------------------------------------------------------+
```

**Step 3 — Playbook** (current screenshots show raw textarea with no clear template hierarchy):

```
+-------------------------------------------------------+
|  START FROM A TEMPLATE                               |
|  [Workspace Brain] [Dept Manager] [Exec Assistant]   |
|  [or start blank]                                    |
|                                                        |
|  [textarea: playbook]    PREVIEW                     |
|                          {rendered markdown}         |
|                                                        |
|  Monthly budget  [$ 500  ]  per month                |
+-------------------------------------------------------+
```

**Step 4 — Commission** (summary + fire):

```
+-------------------------------------------------------+
|  [avatar]  {Name}                                    |
|  {Role} — {role summary}                             |
|                                                        |
|  Runtime    {harness}  {version}                     |
|  Model      {model or "harness default"}             |
|  Budget     ${budget}/month                          |
|  Inbox      {channels or "None set"}                 |
+-------------------------------------------------------+
|                          [Commission agent]           |
+-------------------------------------------------------+
```

---

## Part 5 — Files to Create / Modify

### New files

| File | Purpose |
|---|---|
| `apps/web/src/components/agents/AgentQuickDetailPanel.tsx` | Right slide-over quick-detail modal (live status + channels + quick stats) |
| `apps/web/src/components/agents/AgentChannelsTab.tsx` | New Channels tab content for `AgentDetailPage` |
| `apps/web/src/components/agents/HarnessInstallSlideOver.tsx` | Inline runtime install (referenced in AGENT-ONBOARDING-REPLAN.md §4.2 — still missing) |

### Modified files

| File | Change |
|---|---|
| `apps/web/src/components/agents/AgentCard.tsx` | Full card anatomy rewrite: remove metric grid + budget bar + excerpt; add live activity line + tier border color |
| `apps/web/src/components/agents/AgentHierarchyCanvas.tsx` | Wire card click → `AgentQuickDetailPanel` instead of navigation; fix ghost node `initialRole` + `lockInitialRole`; remove tier label left panel |
| `apps/web/src/pages/AgentsPage.tsx` | Rename view values `'canvas' → 'fleet'`; update toggle label to "Fleet"; pass selected agent state to `AgentQuickDetailPanel` |
| `apps/web/src/pages/AgentDetailPage.tsx` | Rename/rewrite tabs: Overview → Identity, Connections → Runtime; add Channels tab; update Identity to name/role/avatar only |
| `apps/web/src/components/agents/AgentCreateWizard.tsx` | Apply all AGENT-ONBOARDING-REPLAN.md gaps (§4.1 above): hide Space for orchestrator, fix avatar overlay, remove swatches, detection auto-select, OpenClaw gate, budget in playbook step |
| `apps/web/src/components/agents/RuntimePicker.tsx` | Remove `ADAPTER_MODEL_REGISTRY`, replace model dropdown with free-text passthrough, add `[Install]` button to not-found tiles, add detection → auto-select logic |

---

## Part 6 — Accessibility

| Component | Requirement |
|---|---|
| Fleet canvas tier labels | `role="region"` `aria-label="Orchestrator tier"` etc. |
| Agent card | `role="article"` `aria-label="{name} — {status}"` |
| Quick-detail panel | `role="dialog"` `aria-label="{name} — agent details"` `aria-modal="true"` |
| Live activity line | `aria-live="polite"` — updates announced when agent transitions state |
| Channel connect button | `aria-label="Connect {provider} to {agent name}"` |
| Commission button | `aria-disabled` when orchestrator conflict blocks it; tooltip explains why |

---

## Implementation Log — May 2026

> Status: **Parts 1–3 implemented end-to-end.** Part 4 (commission wizard
> gaps) is documented as deferred — see *Deferred* below.

### Summary

The Agents page was rebuilt around the redesign: the fleet view is now named
"Fleet", agent cards answer *what the agent is doing right now* instead of
showing meaningless idle metrics, a real quick-detail slide-over replaced the
old config-panel-in-a-drawer, and the config page tabs were restructured into
Identity / Instructions / Memory / Runtime / Channels / History.

### Part 1 — Fleet view

| File | Change |
|---|---|
| `apps/web/src/pages/AgentsPage.tsx` | `View` type `'canvas' \| 'table'` → `'fleet' \| 'table'`. The `agentis.agents.view` localStorage key is kept; the legacy `'canvas'` value migrates to `'fleet'` on read. Toggle button label and `aria-label` are now "Fleet". |
| `apps/web/src/components/agents/AgentHierarchyCanvas.tsx` | `AgentHierarchyNode` card anatomy fully rewritten — removed the `$0.00 / 0 runs / 0 approvals` metric grid, connection chips, and description excerpt. Added a single **live activity line** (running → amber task name, live → green capability tags, idle → muted last-active, setup-needed → warn, error → red) and **tier-specific border colors** (orchestrator violet `#8b5cf6`, manager cyan `#06b6d4`, worker default). Status dot animates (amber ping for running). Running cards get an ambient tier-color glow. `role="article"`, `aria-label`, `aria-live="polite"` on the activity line. Ghost orchestrator copy updated to "Set up the workspace brain". `AgentHierarchyAgent` extended with `currentTask`, `capabilityTags`, `lastActiveAt`. |

### Part 2 — Quick-detail panel

| File | Change |
|---|---|
| `apps/web/src/components/agents/AgentQuickDetailPanel.tsx` | **New.** Right-anchored `w-[400px]` slide-over (`role="dialog"`, `aria-modal`, overlay, Escape-to-close, slide transition). Header with avatar + status dot + Talk / Open agent. **Live status** subscribes to the `agent(agentId)` realtime room (`AGENT_STATUS_CHANGED`, `AGENT_PRESENCE_THINKING`, `AGENT_TERMINAL_TOOL_CALL`, `AGENT_TERMINAL_MESSAGE`) — running shows the task + streaming line + **Cancel task** (`POST /v1/agents/:id/cancel-task/:taskId`); idle shows "Waiting for work". **Channels** lists Telegram/Discord connection state from `GET /v1/channels`. **Quick stats** render only when non-zero (no phantom metric grids). |
| `apps/web/src/components/agents/AgentHierarchyCanvas.tsx` | Card click now opens `AgentQuickDetailPanel` instead of the old `AgentHierarchyDetailPanel`; the unused `allAgents` prop was dropped. |
| `apps/web/src/pages/AgentsPage.tsx` | Stopped passing `allAgents` to the canvas. |

### Part 3 — Config page

| File | Change |
|---|---|
| `apps/web/src/pages/AgentDetailPage.tsx` | Tabs restructured: **Overview → Identity**, **Connections → Runtime**, new **Channels** tab; legacy `?tab=overview`/`?tab=connections` URLs are normalized. The Identity tab is a clean editable form — name, role (Orchestrator/Manager/Worker), description, and (for managers/workers) Reports-to + Space — saved via `PATCH /v1/agents/:id`. The old three generic `Stat` boxes were removed. The Instructions tab gained a **"+ New file"** affordance (sidebar button + a real first-file empty state) that creates an editable `platform`-source file persisted on first save via `PUT /v1/agents/:id/instructions/:filename`. |
| `apps/web/src/components/agents/AgentChannelsTab.tsx` | **New.** Per-provider channel cards (Telegram, Discord). Connected → name + chat-id + Test (`Delivered ✓` / `Failed ✗`) + Disconnect. Not connected → inline connect form (name / bot token / default chat id) posting to `POST /v1/channels`. |

### Gaps found

- **`/v1/agents` PATCH has no `avatarUrl`** — only `avatarGlyph`. The Identity-tab
  avatar is therefore display-only (glyph/initials); a true image-upload overlay
  would need a new endpoint and is out of scope.
- **Channel bridge only registers Telegram + Discord adapters** — Slack and
  WhatsApp from the §3.5 mock are not yet backable, so only the two supported
  providers are rendered (in the panel and the Channels tab).
- **`AgentHierarchyDetailPanel.tsx`** is now orphaned (the canvas uses the new
  quick-detail panel). Left in place rather than deleted to keep the change
  scoped; safe to remove in cleanup.

### Part 4 — Commission wizard (completed in a follow-up pass)

Auditing the live code against the §4.1 gap table showed `AGENT-ONBOARDING-REPLAN.md`
had in fact been applied to `AgentCreateWizard.tsx` and `RuntimePicker.tsx` — the
4-step flow, role-filtered playbooks, OpenClaw gateway gate, free-text model
passthrough, detection auto-select, and the install-tile UI were all already
present. **The §4.1 gap table was stale.** Two things were genuinely broken or
missing, and both are now fixed:

| What was actually wrong | Fix |
|---|---|
| `RuntimePicker` / `HarnessInstallSlideOver` called `GET /v1/harness/install-options` and `POST /v1/harness/install` — **neither route existed**. The `harnessInstall.ts` *service* was complete but unwired, so the entire "no runtime? install it here" flow failed at runtime. | Added both endpoints to `apps/api/src/routes/harness.ts`: `install-options` (returns `listHarnessInstallOptions()`) and `install` (SSE — streams `step`/`log`/`complete`/`error` from `installHarness()`). Whitelist-guarded (`isAutoInstallableAdapter`), fixed install commands, `execFile` (no shell), and rate-limited to 2 attempts/workspace/minute. |
| Ghost-node entry pre-set the role but never **locked** it — `lockInitialRole` was supported by the wizard but never passed. | `AgentsPage` now passes `lockInitialRole` whenever the wizard opens from a ghost-node preset. |

**Beautiful easiness — `RuntimeReadinessBanner` (new, in `RuntimePicker.tsx`).**
The runtime step now opens with a single at-a-glance card that does the operator's
thinking, paperclip-style:

- *scanning* → "Scanning this machine for installed runtimes…"
- *runtime detected & auto-selected* → green "✓ {harness} is installed and selected"
  with version/path — the operator just clicks Continue.
- *another runtime installed* → "{names} ready — pick it below, or install {harness}".
- *nothing installed* → a prominent **Install {harness}** primary button that opens
  the install slide-over inline; on completion detection re-runs and the harness
  auto-selects. One click from empty machine to commissionable agent.

The redundant "Detected … at …" notice in the wizard's runtime step was removed —
the banner supersedes it.

### Verification

- `tsc --noEmit` clean for `apps/web` and `apps/api`.
- `apps/web` — all 5 `AgentsPage` tests pass (the stale "Step 1 of 2" assertion
  was corrected to "Step 1 of 4" to match the shipped 4-step wizard);
  `AgentHierarchyNode`, `AgentNode` pass.
- `apps/api` — new `tests/routes/harnessInstall.test.ts` (3 tests) verifies
  install-options and install-validation; `testHarness` suite passes.

### Deferred

- **Avatar image upload (§4.1 gap 2 / §3.2).** The agent has no `avatarUrl` field
  in either the create or update schema — only `avatarGlyph`. A real image-upload
  affordance needs a backend column + endpoint; the glyph/initials avatar stands
  until then.
- **Post-commission canvas FLIP (§4.1 gap 10 / §1.7).** Depends on the home
  `WorkspaceEcosystemCanvas` entrance choreography; the `flipFrom` prop is plumbed
  but unused. `onCreated` navigates to the new agent today.
- **§7 visual polish** (inline tier section headers, home-canvas-grade edges) and
  manager/worker ghost nodes (§1.4) — the orchestrator ghost is still the only
  one the fleet canvas synthesizes.

---

## Part 7 — Visual Quality Bar

The fleet view should match the visual quality of `WorkspaceEcosystemCanvas` on the home page:
- Edges between tier levels use the same subtle connector lines as the home canvas
- Tier labels (`ORCHESTRATOR` / `MANAGERS` / `WORKERS`) are small-caps, muted text, not a left-side panel but inline section headers above each tier row
- Background: `bg-canvas` — same dark field as home canvas
- The hierarchy is centered horizontally, not left-aligned
- Cards have a `shadow-card` treatment; active/running cards have a subtle ambient glow in their tier color (`box-shadow: 0 0 12px {tierColor}22`)
