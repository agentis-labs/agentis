# Agents 10x Replan
## Total redesign of agent creation, configuration, and the hierarchy canvas

> **Status**: Implemented — Phases 1, 2, and 3 shipped on `/agents`; repo-wide typecheck/build remains blocked by unrelated existing errors outside the agents surfaces
> **Date**: May 14, 2026
> **Scope**: `/agents` page, agent creation wizard, agent config tab, adapter model selection, workspace hierarchy canvas
> **Architecture references**: `MULTI-AGENT-UX.md`, `ORCHESTRATOR.md`, `APP-CANVAS-ARCHITECTURE.md`, `AGENT-FIRST-ARCHITECTURE.md`, `V1-SPEC.md`, current `RuntimePicker.tsx`, `AgentCreateWizard.tsx`, `AgentDetailPage.tsx`
> **Thesis**: Every change here must deepen Agentis's actual value proposition — not just look better. The platform's moat is that the orchestrator does not just coordinate agents; it coordinates *apps, workflows, memory, skills, and other agents* through a deterministic engine. The agents page must make that hierarchy legible, operable, and editable.

---

## 0. Why this replan exists

Three specific failures currently undermine Agentis on the agents page:

### 0.1 Creation is confusing and slow

The two-step wizard exposes every adapter field in a single form section. An operator who just picked "OpenClaw" immediately sees `sessionKeyStrategy`, `payloadTemplate`, `deviceTokenCredentialId` — fields that mean nothing until after they understand what a gateway is. The mental model is not built up gradually; it is dumped all at once.

The new wizard must be **2 screens and done**. No more. An operator should be able to commission a new agent in under 30 seconds without reading documentation. Defaults must be good enough that the advanced fields never need to be touched on the happy path.

Paperclip's install flow confirms the right pattern: large icon cards for runtime selection, a clean model list next. We follow the same skeleton but compress it so both decisions land in 2 screens total.

### 0.2 Configuration is a flat sprawl

The config tab of `AgentDetailPage` is one long form dumping all adapter fields without structure or progressive disclosure. The most important missing piece: **there is no model picker**. If you configure a `hermes_agent` adapter, you type the model ID manually into a free-text input. You must already know the exact ID. Nothing shows you what models the adapter supports, how they compare, or which is the default.

Paperclip solves this by sourcing models dynamically from the adapter package's `models` array and rendering a searchable combobox or radio group — the list is adapter-specific and complete.

Our config page must surface a proper **model picker** that:
- Loads the model list from the adapter manifest (already defined per-adapter in `RuntimePicker.tsx`)
- Groups by provider tier (e.g. Opus → flagship, Sonnet → balanced, Haiku → fast)
- Allows free-text override for adapters where the server delivers its own list (OpenClaw gateway)
- Propagates the selected model to `agents.runtimeModel` and the adapter `config.model` field in one save

### 0.3 The grid is the wrong shape for the data

A flat card grid or table hides the most important property of Agentis agents: **they exist inside a command hierarchy that drives the actual execution**. In every workspace that uses Agentis properly, there is:

- An **Orchestrator** — the top-level entity the operator converses with; it uses `agentis.team.design`, `agentis.workflow.run`, `agentis.agent.spawn`, and `agentis.agent.dispatch` to build and run the system
- Zero or more **Space Managers** — agents scoped to a space that own that space's apps and workflows; they report to the orchestrator
- **Worker agents** — connected to specific apps, skills, workflows, and memory; they report to a manager

The existing `agents.reportsTo` column and `GET /v1/agents/org-tree` already encode this. It just isn't visualized. A flat grid turns a hierarchy into a pile.

The correct shape is a **canvas** — the same React Flow infrastructure already used in the workflow canvas. The canvas makes the hierarchy editable by drag-and-drop and shows live operational state on each node.

---

## 1. Platform value proposition (must be reflected in every change)

Before specifying any screen, it is worth stating the Agentis moat concisely. This is what every design decision in this replan must serve:

> **Agentis is the only platform where the orchestrator layer does not just route between agents — it builds and runs apps, workflows, skills, memory, and approvals as coordinated programs. The operator delegates goals; the platform executes them through a deterministic, observable, and auditable engine.**

Key implications for the agents page:

- An agent without a hierarchy relationship is a stub. The canvas should make "unassigned" agents visually obvious — they are floating nodes that need to be connected.
- The orchestrator is not just another agent. It is the composition root. It deserves a special visual treatment on the canvas.
- A worker agent is not just "an agent". It is an agent *plus its connections*: the apps it reads, the workflows it runs, the memory it writes to. The agent node on canvas should expose these connections as ports/edges.
- The LLM model an agent uses is a first-class runtime property. It affects cost, speed, and capability. It must be surfaced clearly in creation and config — not buried.

---

## 2. What already exists (do not rebuild)

### 2.1 Schema

| Field | Table | Status |
|---|---|---|
| `reportsTo` | `agents` | Exists — FK to agents.id |
| `adapterType` | `agents` | Exists |
| `runtimeModel` | `agents` | Exists |
| `config` | `agents` | Exists — JSON blob |
| `instructions` | `agents` | Exists |
| `avatarGlyph` | `agents` | Exists |
| `capabilityTags` | `agents` | Exists |
| `role` | `agents` | Exists |
| `isPaused` | `agents` | Exists |
| `monthlyBudgetCents` | `agents` | Exists |
| `currentMonthSpendCents` | `agents` | Exists |
| `colorHex` | `agents` | Exists |

### 2.2 API

- `GET /v1/agents` — list
- `GET /v1/agents/org-tree` — hierarchy tree (used by `/org` page)
- `POST /v1/agents` — create
- `PATCH /v1/agents/:id` — update
- `DELETE /v1/agents/:id` — delete
- `POST /v1/agents/:id/wake` — wake agent
- `POST /v1/agents/:id/test-harness` — test adapter connection

### 2.3 Frontend infrastructure

- `WorkflowCanvasPage.tsx` — React Flow canvas with undo/redo, node palette, run drawer, context inspector — **reuse the rendering engine**
- `AgentConstellation.tsx` — existing presence-overlay agent graph (rAF-based, not React) — provides the pattern for live status on nodes
- `AgentFocusOverlayManager` — DOM mutation overlay for agent presence — keep
- `RuntimePicker.tsx` — adapter cards + per-adapter field forms — **refactor, do not rebuild**
- `AgentCreateWizard.tsx` — 2-step modal — **replace with progressive multi-step flow**
- `AgentDetailPage.tsx` — agent detail with tabs — **refactor config tab, keep other tabs**
- `GET /v1/agents/org-tree` — already returns the tree format needed for canvas

---

## 3. Three change clusters

This replan is organized as three independent change clusters that can be shipped in order. Each cluster is self-contained.

```
Cluster A: Progressive creation wizard
Cluster B: Config page — model picker + structured runtime form
Cluster C: /agents canvas hierarchy (replaces the grid)
```

---

## 4. Cluster A — Creation wizard

### 4.1 Design principle

**2 screens. Done. Under 30 seconds.** The wizard must never ask a question that has a sensible default. Everything that can be configured later, goes into the agent config tab after creation. The creation path is purely about: *who is this agent, what role does it play, and how does it run?*

### 4.2 Wizard screens (2 steps only)

```
Step 1 — Identity + Role
Step 2 — Runtime + Model
```

Adapter-specific connection details (gateway URL, binary path, credentials, timeouts, session strategy, extra args) are **never shown during creation**. They live in the config tab after the agent exists. Defaults are applied automatically. An agent created with defaults can be tested and connected from its detail page without touching the wizard again.

#### Step 1: Identity + Role

Everything that defines *what this agent is* lands on one screen.

**Identity section (top)**:
- Avatar: auto-generated initials circle (color from `colorHex` — 6 swatches inline, no modal). Image upload is available but not required.
- Name field (required, ≥2 chars). Auto-focused.
- Description (optional, single line, max 160 chars)
- Space selector (optional dropdown)

**Role section (bottom of same screen)**:

Three large selectable cards, default = Worker.

```
┌──────────────────────────────────────────────────────────┐
│  Role in workspace                                        │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  ◈  Orchestrator                                   │  │
│  │     Top-level intelligence. Drives goals, builds   │  │
│  │     workflows, coordinates the entire workspace.   │  │  ← greyed + locked if one exists
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  ⬡  Manager                                        │  │
│  │     Owns a space. Coordinates its apps, workflows, │  │
│  │     and workers. Reports to the orchestrator.      │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  ◉  Worker                          (default) ●   │  │
│  │     Runs tasks. Connected to apps, workflows,      │  │
│  │     memory, and skills.                            │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Reports to:  [ select agent ▾ ]   (optional)            │
└──────────────────────────────────────────────────────────┘
```

**Orchestrator uniqueness**: If the workspace already has an agent with `role = 'orchestrator'`, the Orchestrator card is greyed out, not selectable, and shows: *"Already commissioned — {name}"*. This is enforced in **both the UI and the backend** (see §7 below). There is no path to creating a second orchestrator.

`Reports to` is pre-filled to the workspace orchestrator when it exists and the selected role is Worker or Manager.

#### Step 2: Runtime + Model

Everything that defines *how this agent executes* lands on one screen.

**Runtime section (top)** — adapter cards, same pattern as Paperclip's "Which runtime?":

```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  ⚙ OpenClaw      │  │  ⟳ Hermes        │  │  ◈ Claude Code   │
│  · live ●        │  │  · not found ○   │  │  · installed ●   │
└──────────────────┘  └──────────────────┘  └──────────────────┘
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  ◻ Codex         │  │  ⌗ Cursor        │  │  ↗ HTTP          │
│  · installed ●   │  │  · not found ○   │  │                  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

Install status badges come from `GET /v1/adapters/harness-status`. Adapters not installed are still selectable — the agent can be created offline and connected later from the config tab.

**Model section (below runtime cards)** — appears immediately after selecting an adapter, no page transition:

- Renders the adapter's model list from `ADAPTER_MODEL_REGISTRY` as a compact radio group
- Default = the adapter's recommended model (highlighted)
- Free-text override available as the last option in the list
- For `openclaw`: shows gateway dropdown first; model list loads from `GET /v1/gateways/:id/models` if available, else shows free-text only
- For `http`: no model section (HTTP adapter has no model concept)

The entire Step 2 is answerable with **2 clicks** on the happy path: click an adapter card, the model default is already selected, click Continue.

**No advanced config in the wizard.** Period. Advanced adapter settings (binary path, cwd, session strategy, extra args, credentials) are configured from the agent's Config tab after creation. A help text note at the bottom of Step 2 reads: *"Advanced connection settings are available in the agent's Config tab after commissioning."*

### 4.3 Completion

After Step 2, a **summary line** is shown inline at the bottom of the screen (not a new step or modal):

```
Ready to commission  ◉ Hermes · Worker · hermes-3-405b · Research space
                                              [ Back ]  [ Commission agent → ]
```

"Commission agent" fires `POST /v1/agents`, then **navigates directly to the new agent's `/agents/:id` page**. No confirmation screen. If the POST fails, the error is shown inline on Step 2 and the wizard stays open.

### 4.4 Implementation notes

- The wizard is a **slide-in panel** (right side of screen, ~480px wide) — not a full-screen takeover and not a modal. The canvas is still visible behind it, giving the operator context.
- Wizard state is a single `useState` object; no URL params.
- Add `ADAPTER_MODEL_REGISTRY: Record<AdapterType, Array<{id: string; label: string; recommended?: boolean}>>` to `RuntimePicker.tsx`.
- Add `GET /v1/adapters/harness-status` — lightweight binary probe for all adapters.
- The `reportsTo` auto-fill logic: on Step 1 load, fetch `GET /v1/agents?role=orchestrator` (or derive from the workspace agents list already in state). If exactly one orchestrator exists, set it as the default `reportsTo` when the selected role is Worker or Manager.



---

## 5. Cluster B — Config page: model picker and structured runtime

### 5.1 Current state

`AgentConfigPanel.tsx` renders `RuntimePicker` in a single block with all fields visible. It has no model picker — the `claudeModel` / `hermesModel` / `codexModel` fields are plain text inputs that require the operator to know the exact model ID.

### 5.2 Target state

The config tab is restructured into **three named sections**:

#### Section 1: Runtime

```
┌────────────────────────────────────────────────────┐
│  Runtime                                           │
│                                                    │
│  Adapter    [ Claude Code  ▾ ] (locked after save) │
│                                                    │
│  Model      ┌──────────────────────────────────┐  │
│             │ claude-sonnet-4-6                  │  │
│             └──────────────────────────────────┘  │
│             Recommended · balanced cost/quality    │
│             ┌───────────────────────────────────┐  │
│             │  claude-opus-4-7    flagship       │  │
│             │  claude-sonnet-4-6  recommended  ● │  │
│             │  claude-haiku-4-6   fast/cheap     │  │
│             │  [ custom ID... ]                  │  │
│             └───────────────────────────────────┘  │
│                                                    │
│  [ Advanced config ▸ ] (collapsed by default)      │
│                                                    │
│  [ Test connection ]          [ Save runtime ]     │
└────────────────────────────────────────────────────┘
```

**Model picker behavior**:
- On mount: load model list from `AdapterModelRegistry` (static) for the current adapter type
- Selected value defaults to `agent.runtimeModel` if set, else the adapter's first model
- Changing the selection updates `runtimeModel` and `config.model` simultaneously on save
- For `openclaw`: if the gateway is reachable, fire `GET /v1/gateways/:id/models` and merge with any static entries; if not reachable, show a free-text input with the current `runtimeModel` value pre-filled

The "Advanced config" expander contains the same per-adapter fields as today but in a cleaner layout — grouped under sub-headers (Connection, Session, Execution, Environment).

**Adapter selector**: The adapter `type` is displayed as a locked chip after initial save (changing adapters requires creating a new agent — the same behavior as today, but made explicit with a tooltip). This prevents the confusing state where an operator edits adapter fields and forgets which adapter they are configuring.

#### Section 2: Identity & Playbook

- Name, role, avatarGlyph, colorHex, capability tags
- Instructions (playbook) — full-height textarea, 32KB limit with character counter
- Space assignment

#### Section 3: Operations

- Monthly budget ($ input)
- Current month spend (read-only metric)
- Paused toggle (standby)
- Reports to picker (searchable agent selector — populates `reportsTo`)

### 5.3 Implementation notes

- Add `ADAPTER_MODEL_REGISTRY: Record<AdapterType, Array<{id: string; label: string; tier?: 'flagship' | 'balanced' | 'fast'}>>` to `RuntimePicker.tsx`
- Populate the registry from the existing per-adapter model arrays already present in `DEFAULT_RUNTIME_CONFIG` and the Paperclip adapter packages (claude-local, gemini-local, etc. serve as the reference)
- The `ModelPicker` component: a combobox-style selector that shows a dropdown with tier labels; falls back to a free-text input when the registry returns an empty array (covers `openclaw` with no gateway)
- Wire `modelPicker.onChange` to update both `runtimeConfig.{adapter}Model` and fire a save to `PATCH /v1/agents/:id` with `{ runtimeModel, config: { ...existingConfig, model } }`
- Keep the existing `Test connection` button wired to `POST /v1/agents/:id/test-harness`

---

## 6. Cluster C — Agents hierarchy canvas

This is the most impactful change and the one most native to Agentis's value proposition.

### 6.1 Design principle

> **The agents page should answer "how is my workforce structured?" in 3 seconds.**

The current grid answers "how many agents do I have?" — which is useless for a platform where relationships between agents *are* the product.

### 6.2 Canvas layout and tiers

The `/agents` page replaces the grid with a **3-tier canvas** built on React Flow (same library already used in `WorkflowCanvasPage.tsx`).

```
┌─────────────────────────────────────────────────────────────────────┐
│  TIER 0 — ORCHESTRATOR                                              │
│                                                                     │
│                  ┌─────────────────────┐                           │
│                  │  ◈  Orchestrator     │                           │
│                  │  claude-opus-4-7     │                           │
│                  │  ● live · $12 today  │                           │
│                  └─────────────────────┘                           │
│                           |                                         │
│       ┌───────────────────┼────────────────────┐                   │
│       |                   |                    |                   │
│  TIER 1 — MANAGERS                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ ⬡ Research   │  │ ⬡ Engineering│  │ ⬡ Marketing  │              │
│  │   Manager    │  │   Manager    │  │   Manager    │              │
│  │   hermes     │  │   claude     │  │   codex      │              │
│  │   ● live     │  │   ◌ standby  │  │   ✕ failed   │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│       |                   |                    |                   │
│  TIER 2 — WORKERS                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │◉ Writer  │  │◉ Coder   │  │◉ Tester  │  │◉ Analyst │            │
│  │ claude   │  │ codex    │  │ claude   │  │ hermes   │            │
│  │ ● 1 run  │  │ ● 3 runs │  │ ● idle   │  │ ✕ failed │            │
│  │ [app]    │  │ [app]    │  │ [wf]     │  │ [mem]    │            │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘            │
│                                                                     │
│  [ Unassigned ]                                                     │
│  ┌──────────────────────────────────────────────┐                   │
│  │  ○ Floating Agent A   ○ Floating Agent B     │  ← dim zone       │
│  └──────────────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────────┘
```

**Tier labels** are visual headers rendered as non-interactive React Flow background nodes or HTML overlay divs (not React Flow nodes themselves, to avoid cluttering the selection system).

**Floating / unassigned agents** appear in a distinct bottom zone — desaturated, labelled "Unassigned". The canvas makes it visually obvious that these agents are not connected to the operational structure.

### 6.3 Node anatomy (agent canvas node)

Each agent is a custom React Flow node type `AgentHierarchyNode`:

```
┌──────────────────────────────────────┐
│  ● ◈  Hermes                         │  ← status dot + glyph + name
│       Worker · hermes-3-405b         │  ← role + model ID
│                                      │
│  ▤ Research App   ⚡ 2 workflows      │  ← connected resources (chips)
│  ◌ Workspace KB                      │  ← memory connection
│                                      │
│  $4.20 today   2 runs   1 approval ⚠ │  ← operational metrics
└──────────────────────────────────────┘
         ○ (source handle)
```

The **source handle** at the bottom of each node is the drag-to-connect point for assigning `reportsTo`. Dragging from one node's source handle to another node's target handle fires `PATCH /v1/agents/:id` with `{ reportsTo: targetId }`.

**Connected resources chips** (apps, workflows, memory):
- These are cosmetic in V1 — they are read-only chips that link to the relevant resource
- They are computed from: tasks that reference this agent (`GET /v1/tasks?executorRef=agentId`), or a new lightweight `GET /v1/agents/:id/connections` endpoint that returns `{ apps, workflows, memoryPlanes }`
- In V2, these become actual React Flow ports with edges connecting to app/workflow nodes on the same canvas

**Status dot states** (mapped from `agents.status`):
- `● live` (green) — heartbeat within last 2 min
- `● running` (blue, pulsing) — `currentTaskId` set
- `◌ standby` (yellow) — `isPaused = true`
- `✕ failed` (red) — last run ended in error
- `○ offline` (grey) — no recent heartbeat, not paused

### 6.4 Canvas interactions

| Interaction | Action |
|---|---|
| Click node | Open agent detail panel (right-side drawer, same pattern as `ContextInspector` in workflow canvas) |
| Double-click node | Navigate to `/agents/:id` |
| Drag node | Reposition in canvas — persisted to `agents.canvasPosition` (new JSON column) |
| Drag handle → drop on target | Set `reportsTo` — fires `PATCH /v1/agents/:id` |
| Right-click node | Context menu: Open thread · Deploy mission · Pause / Resume · Decommission |
| Click "+" in unassigned zone | Open new agent creation wizard |
| Canvas toolbar: `[ Table view ]` | Switch back to the traditional table/grid view (kept as fallback) |

### 6.5 Canvas toolbar

```
┌──────────────────────────────────────────────────────────────────────┐
│ Agents       4 live · 1 running · 1 approval pending                 │
│                                       [ Canvas | Table ]  [ + Agent ] │
└──────────────────────────────────────────────────────────────────────┘
```

- **Canvas / Table toggle** (top-right) replaces the Grid / Table toggle — Table mode is the existing sortable agent table, preserved for bulk management
- **Stat badges** in the toolbar are live (subscribe to `AGENT_STATUS_CHANGED` / `AGENT_HEARTBEAT` realtime events)
- **`+ Agent` button** opens the new progressive creation wizard

### 6.6 Canvas position persistence

Add `canvasPosition JSON` column to `agents` table (nullable, schema migration required). Stored as `{ x: number, y: number }`. On `onNodeDragStop`, fire a debounced `PATCH /v1/agents/:id` with `{ canvasPosition }`. When no position is stored, auto-layout uses a tier-based default (orchestrator at `{x: 0, y: 0}`, managers spaced at `{x: spacing * i, y: 200}`, workers at `{x: spacing * i, y: 400}`).

Auto-layout button in the canvas toolbar resets all positions to the tier-based default.

### 6.7 Realtime integration

The canvas subscribes to the `workspace` room via `rtSubscribe('workspace', { workspaceId })` and handles:

- `AGENT_STATUS_CHANGED` → update node status dot
- `AGENT_HEARTBEAT` → update node last-active metric
- `AGENT_CREATED` → add new node (auto-placed in unassigned zone)
- `AGENT_UPDATED` → update node label/model/role
- `FLEET_SNAPSHOT_UPDATED` → update toolbar metrics

Presence overlays (`AGENT_PRESENCE_FOCUS`, `AGENT_PRESENCE_THINKING`) are handled by a lightweight `AgentNodePresenceOverlay` using the same rAF + direct DOM mutation pattern from `AgentFocusOverlayManager` — no React state updates on presence events.

### 6.8 Implementation notes

- Register a new React Flow node type `agent-hierarchy` in a new `AgentHierarchyCanvas.tsx` component
- Node data shape: `AgentHierarchyNodeData { agentId, name, role, status, adapterType, runtimeModel, avatarGlyph, colorHex, connections: {apps, workflows, memory}, metrics: {runsToday, spendToday, pendingApprovals} }`
- Initial node positions: load from `canvasPosition` field; fall back to tier auto-layout if null
- Edge type: `reportsTo` — rendered as a simple straight edge with an arrowhead; label is empty by default
- The **right-side detail drawer** reuses the same `ContextInspector` pattern (`position: fixed, right: 0`) — mount it inside `AgentHierarchyCanvas` and show `AgentDetailPanel` content inside it
- Auto-layout algorithm: group nodes by `role` (orchestrator → tier 0, manager → tier 1, worker → tier 2, null/other → unassigned zone); within each tier, sort by name and space evenly

---

## 7. Schema additions required

| Column | Table | Type | Purpose |
|---|---|---|---|
| `canvasPosition` | `agents` | `TEXT` (JSON `{x,y}`) nullable | Persists agent node position on hierarchy canvas |

Migration: `ALTER TABLE agents ADD COLUMN canvasPosition TEXT;`

### 7.1 Orchestrator uniqueness constraint

One orchestrator per workspace is a **hard constraint enforced at the database layer**, not just a UI hint.

**Backend enforcement (two layers)**:

1. **Unique partial index** (schema migration):
   ```sql
   CREATE UNIQUE INDEX agents_workspace_orchestrator
     ON agents (workspaceId)
     WHERE role = 'orchestrator';
   ```
   SQLite supports partial indexes. This makes it physically impossible for two rows with `role='orchestrator'` to share the same `workspaceId`.

2. **Route-level guard** in `POST /v1/agents` and `PATCH /v1/agents/:id`:
   ```
   if (body.role === 'orchestrator') {
     const existing = db.query('SELECT id, name FROM agents WHERE workspaceId=? AND role="orchestrator" AND id!=?', [workspaceId, agentId ?? '']);
     if (existing) throw AgentisError('WORKSPACE_ORCHESTRATOR_EXISTS', `Workspace already has an orchestrator: ${existing.name}`, 409);
   }
   ```
   This fires before the INSERT/UPDATE so the error is returned as a clean `409` with `WORKSPACE_ORCHESTRATOR_EXISTS` error code — never a raw SQLite constraint violation.

**Frontend enforcement (defence-in-depth)**:
- The wizard Step 1 greys out the Orchestrator role card and shows *"Already commissioned — {name}"* when `GET /v1/agents` returns any agent with `role = 'orchestrator'`
- If somehow the POST still returns `WORKSPACE_ORCHESTRATOR_EXISTS`, the wizard shows the error inline: *"This workspace already has an orchestrator ({name}). Each workspace can have only one."*

**What about renaming an existing orchestrator's role?** `PATCH /v1/agents/:id` with `{ role: 'orchestrator' }` on an agent that is already the orchestrator (same `id`) is a no-op at the constraint level — the partial index allows it because `id != existingId` excludes itself. The route guard's `AND id!=?` clause handles this correctly.

New error code to register in `packages/core/src/errors.ts` and `defaultStatusFor`:
```
'WORKSPACE_ORCHESTRATOR_EXISTS' → 409
```

---

## 8. New API endpoints required

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/adapters/harness-status` | Returns `{ adapters: [{type, installed: bool, installCommand?}] }` — lightweight binary probe for all adapters. Used in wizard Step 3 to show install badges. |
| `GET` | `/v1/agents/:id/connections` | Returns `{ apps: [], workflows: [], memoryPlanes: [] }` computed from tasks + workflow references. Used for canvas node resource chips. |
| `GET` | `/v1/gateways/:id/models` | Proxied query to the OpenClaw gateway's `/models` endpoint. Returns `{ models: [{id, label}] }`. Used for model picker when adapter is `openclaw`. Returns empty array if gateway unreachable — never errors the page. |

---

## 9. Phased delivery

### Phase 1 — Model picker and config cleanup (Cluster B)
**Scope**: `AgentConfigPanel.tsx` + `RuntimePicker.tsx` + `AgentDetailPage.tsx`
**Outcome**: Model picker in agent config. Operators can select a model from a list instead of typing free-text. Config page is organized into three named sections.
**Risk**: Low. No new routes, no schema changes. Pure frontend refactor.
**Estimated files touched**: 3

### Phase 2 — Creation wizard (Cluster A)
**Scope**: New wizard component replacing `AgentCreateWizard.tsx`. New `GET /v1/adapters/harness-status` endpoint. Orchestrator uniqueness: partial index migration + route guard + new `WORKSPACE_ORCHESTRATOR_EXISTS` error code.
**Outcome**: 2-step creation flow, under 30 seconds. Role cards with hard orchestrator uniqueness. Model picker in Step 2. No advanced config fields in wizard — all deferred to Config tab.
**Risk**: Medium. Requires new API endpoint, route guard, schema migration, full replacement of creation panel.
**Estimated files touched**: 6-8

### Phase 3 — Hierarchy canvas (Cluster C)
**Scope**: New `AgentHierarchyCanvas.tsx`. Schema migration for `canvasPosition`. New `GET /v1/agents/:id/connections` endpoint. View toggle in page header.
**Outcome**: Canvas replaces grid as the primary view. Operators can see and edit the agent hierarchy visually. Grid/table view preserved as fallback.
**Risk**: Medium. Requires schema migration and new React Flow node type. Canvas layout algorithm is non-trivial.
**Estimated files touched**: 8-10

---

## 10. What is explicitly NOT in this plan

- **Org chart page** (`/org`) is not touched — it already exists and serves a different purpose (formal org-tree view for approval chains). The hierarchy canvas at `/agents` complements it but does not replace it.
- **Fleet page** (`/fleet`) is not redesigned here — it is addressed separately in `MULTI-AGENT-UX.md`. The agents canvas at `/agents` focuses on configuration and structure; the fleet page focuses on operational status and mission dispatch.
- **App/workflow edges on the canvas** — in V1 the connections to apps and workflows are displayed as read-only chips on each agent node. Full bi-directional canvas linking (where agent nodes and app/workflow nodes coexist on the same canvas) is a V2 item.
- **Multi-workspace hierarchy** — agents currently exist within a single workspace. Cross-workspace hierarchies are a post-V1 scope item.
- **Orchestrator agent auto-provisioning** — the system does not auto-create an orchestrator. The operator creates one using the wizard. Auto-provisioning of the orchestrator on workspace creation is a UX improvement for V2.

---

## 11. Definition of done

Validation note: all feature-scope checks below are complete. The only unchecked items are the repo-wide `tsc` gates, which are currently blocked by unrelated existing errors outside this replan's implementation surface (`apps/api/src/routes/apps.ts`, `apps/api/src/routes/spaces.ts`, `apps/api/src/services/agentisToolHandlers/*`, `apps/api/src/services/partialReplay.ts`, and `apps/web/src/components/apps/AppThread.tsx`).

### Phase 1 (model picker)
- [x] `AgentConfigPanel` renders a `ModelPicker` component populated from `ADAPTER_MODEL_REGISTRY`
- [x] Selecting a model from the picker and saving updates both `runtimeModel` and `config.model`
- [x] `openclaw` adapter shows a free-text fallback when no gateway model list is available
- [x] Config tab is organized into Runtime / Identity & Playbook / Operations sections
- [ ] `pnpm tsc --noEmit` clean

### Phase 2 (creation wizard)
- [x] Wizard is a slide-in panel, 2 steps, Step 1 = Identity + Role, Step 2 = Runtime + Model
- [x] Orchestrator role card is greyed + locked when workspace already has an orchestrator
- [x] `POST /v1/agents` with `role='orchestrator'` returns `WORKSPACE_ORCHESTRATOR_EXISTS` (409) if one already exists — partial index migration applied
- [x] `WORKSPACE_ORCHESTRATOR_EXISTS` is registered in `AgentisErrorCode` union and `defaultStatusFor` maps it to 409
- [x] Step 2 shows adapter cards with install badges from `GET /v1/adapters/harness-status`
- [x] Step 2 renders `ModelPicker` inline after adapter selection (no page transition)
- [x] No advanced config fields in wizard — zero
- [x] `reportsTo` auto-fills to the workspace orchestrator for Worker / Manager roles when one exists
- [x] Submitting navigates directly to `/agents/:id` — no confirmation screen
- [x] New agent appears on the canvas in the correct tier
- [ ] `pnpm tsc --noEmit` clean

### Phase 3 (hierarchy canvas)
- [x] `/agents` defaults to canvas view; Table toggle switches to existing agent table
- [x] Canvas renders all agents grouped into 3 tiers based on `role`
- [x] Agents with no `role` appear in the Unassigned zone
- [x] Node shows: glyph, name, role, model, status dot, resource chips, and daily metrics
- [x] Dragging a node updates `canvasPosition` via debounced `PATCH /v1/agents/:id`
- [x] Connecting a node handle to another node updates `reportsTo` via `PATCH /v1/agents/:id`
- [x] Clicking a node opens the detail drawer (right-side panel)
- [x] Status dots update on `AGENT_STATUS_CHANGED` / `AGENT_HEARTBEAT` realtime events
- [x] Auto-layout button resets all positions to tier-based defaults
- [x] `canvasPosition` migration applied cleanly on `pnpm doctor`
- [ ] `pnpm tsc --noEmit` clean
- [x] At least one Playwright e2e spec covers canvas render, node click → detail panel

---

## 12. Key design constraints (non-negotiable)

1. **No new external libraries** for the canvas — React Flow is already installed. No new rendering engine.
2. **Realtime updates use `REALTIME_EVENTS.*` constants** — no magic strings. Presence events use rAF + direct DOM mutation per ADR-018. No React state for presence overlay positions.
3. **Model list is never hard-coded outside `ADAPTER_MODEL_REGISTRY`** — the registry is the single source of truth for static model lists. Per-adapter packages (like Paperclip's `@paperclipai/adapter-claude-local`) define the canonical list; the registry in `RuntimePicker.tsx` mirrors them.
4. **The `openclaw` adapter never errors if the gateway is unreachable** — model list falls back to free-text, connections fall back to empty, test-harness returns a warn result. The page never breaks because a gateway is offline.
5. **`canvasPosition` is optional** — the canvas must render correctly with no positions stored (auto-layout from tier groups). Saved positions are a convenience, not a requirement.
6. **Table view is preserved** — the canvas is the new default but the table view remains. Operators doing bulk operations (tagging 20 agents, changing adapter configs for a fleet) use the table. The canvas is not a replacement for the table; it is an addition.
