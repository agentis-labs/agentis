# Spaces / Domain Strategy — Global Platform Plan

> **Status:** Strategy spec — May 2026
> **Scope:** Global. Affects `AgentsPage`, `AgentCreateWizard`, `CommissionFlow`,
> `AgentHierarchyCanvas`, `WorkspaceEcosystemCanvas`, `HomePage`, `AgentDetailPage`,
> `WorkflowsPage`, and the `spaces` API surface.
> **Trigger:** Spaces are partially wired in DB + API but have no coherent management
> UI anywhere on the platform. The `Manager Lanes` panel is a read-only sidebar
> decoration. There is no way to create, rename, or organise spaces from within
> normal operator flow. The orchestrator card has regressed in sizing + centering.

---

## 1. Diagnosis — Current Reality

### 1.1 What exists in the codebase

| Layer | State |
|---|---|
| **DB** | `spaces` table: `id, workspaceId, name, slug, description, colorHex, iconEmoji, managerId, createdAt, updatedAt` ✅ |
| **Agents FK** | `agents.spaceId → spaces.id` (onDelete set null) ✅ |
| **Agents free text** | `agents.spaceTag` — parallel free-text field, redundant with spaceId ⚠️ |
| **Workflows FK** | `workflows.spaceId → spaces.id` ✅ |
| **API CRUD** | `GET/POST/PATCH/DELETE /v1/spaces` ✅ full CRUD |
| **Wizard space picker** | Only shown when `role === 'manager'` — orchestrators and workers cannot be assigned a space |
| **AgentCreateWizard** | `<select>` dropdown over existing spaces — no inline create option |
| **Manager Lanes panel** | Read-only floating panel on homepage canvas; shows spaces + manager name, no actions |
| **AgentsPage table** | Groups agents by `spaceId` in Table view, but `spaceId` is missing from fleet (canvas) view cards |
| **Homepage canvas** | `WorkspaceEcosystemCanvas` renders space cluster halos using `spaceTag` (not `spaceId`) |

### 1.2 Core problems

1. **No inline space creation anywhere.** If an operator wants a new space they must first go
   somewhere (undefined) to create it, then come back to the wizard. That path doesn't exist yet.

2. **Spaces are only assignable to managers in the wizard.** Workers inherit nothing. Orchestrators
   can't be in a space. Workflows assigned to spaces have no visible affiliation.

3. **`spaceTag` (free text) and `spaceId` (FK) are in conflict.** Canvas cluster halos use
   `spaceTag`; the wizard assigns `spaceId`. They can drift.

4. **Manager Lanes is a passive sidebar.** It shows what spaces exist but gives no path to:
   create a space, rename it, assign a manager, or browse the agents/workflows inside it.
   On the homepage the panel is floating right-anchored and disappears entirely on mobile.

5. **The commission dialog** (shown in screenshot) presents `Space` as a dropdown with no
   `+ New space` affordance and no explanation of what a space is.

6. **Orchestrator card sizing.** `NODE.orchestrator = { width: 292, height: 110 }` is a fixed
   constant. On narrower viewports the card overflows its centered placement because the virtual
   canvas `computeVirtualCanvasSize` uses a minimum of `1180px` width while `fitView` centers on
   the first render — then the centering breaks if the container is narrower. Additionally, the
   homepage canvas does not refit when the chat panel opens/closes (changing the effective width).

---

## 2. Mental Model — Spaces Are Domains

The term **Space** is confusing because "workspace" already exists at the top level. The right
mental model is a **domain** — a bounded operational area (e.g. Marketing, Engineering, Support).

A domain:
- Has a name, color, and optional icon
- Owns one **manager** agent that coordinates work inside it
- Contains one or more **worker** agents that do the work
- Contains **workflows** that run within it
- Can contain **knowledge bases** and **artifacts** scoped to it
- Is distinct from the global workspace (which is the entire tenant)

The platform currently uses `Space` as the DB/API name — keep that for technical compatibility —
but all UI copy should use **domain** or the user's configured name.

---

## 3. Strategy — Four Principles

### P1: Spaces are configured, not implied
A space must be explicitly created. Free-text `spaceTag` should be deprecated (still read for
backward compat, but no longer written by the wizard or canvas).

### P2: Space management lives on the Agents page
The Agents page is the command center for the fleet. It is the right place to manage the
organizational structure, including domains. Not a floating sidebar on the homepage.

### P3: Every creation path includes a space step
When creating an agent, a workflow, or a knowledge base, there must be an obvious answer to
"which domain does this belong to?" — and a path to create that domain inline if it doesn't
exist yet.

### P4: The homepage canvas visualises, the Agents page configures
The homepage ecosystem canvas shows the live state of the organization. It should NOT contain
management actions. Manager Lanes becomes a read-only navigational aid, not a configuration panel.

---

## 4. Platform-Wide Changes

### 4.1 Agents Page — Domain Management Section

Add a **Domains** bar between the page header and the agent list/canvas. This is the primary
management surface.

```
+------------------------------------------------------------------------+
|  Agents                                  [Fleet | Table]  [+ Add agent]|
|  4 agents                                                               |
+------------------------------------------------------------------------+
|  DOMAINS                                 [+ New domain]                |
|  +--------------+  +--------------+  +--------------+  +----------+  |
|  |  ● Marketing | |  ● Engineering| |  ● Support    | |  Unassigned|  |
|  |  Managy      | |  CodeBot      | |  HelpBot      | |  3 agents  |  |
|  |  2 agents    | |  4 agents     | |  1 agent      | |            |  |
|  |  3 workflows | |  2 workflows  | |  5 workflows  | |            |  |
|  +-[···]---------+  +-[···]---------+  +-[···]---------+            |  |
+------------------------------------------------------------------------+
|  [All] [Active] [Idle] [Setup needed]     [Search agents...        ]  |
+------------------------------------------------------------------------+
```

**Domain chip behaviour:**
- Clicking a domain chip filters the fleet canvas/table to show only that domain's agents.
- An active chip gets a colored border matching `colorHex`.
- `[···]` opens a context menu: Rename, Change color, Set manager, Delete.
- `[+ New domain]` opens the **Domain Create Sheet** (§4.2).
- `Unassigned` chip shows agents with `spaceId = null` — not deletable.

**Domain chips in Fleet canvas:**
- The hierarchy canvas shows cluster halos colored by domain when a domain is active.
- When no domain filter is active, all halos are visible simultaneously (semi-transparent).

### 4.2 Domain Create Sheet (inline modal, ~400px)

Replaces the need to navigate elsewhere to create a space. Triggered from:
- `[+ New domain]` button on Agents page
- `+ New domain` option inside any space `<select>` across the platform

```
+--------------------------------------------+
|  New domain               [×]              |
|                                            |
|  Name ______________________________       |
|  Color  [● #] [color swatches ×6]         |
|  Icon emoji  _____  (optional)             |
|  Manager   [select existing agent ▾]       |
|             or [Skip for now]              |
|                                            |
|  [Cancel]          [Create domain]         |
+--------------------------------------------+
```

- Creates via `POST /v1/spaces`.
- On success: the new domain chip appears in the Agents page bar; any open `<select>` dropdowns
  are refreshed and the new domain is auto-selected.

### 4.3 Agent Create Wizard — Space step for ALL roles

Remove the `role === 'manager'` gate on the space selector. All roles can belong to a domain.

| Role | Space behaviour |
|---|---|
| orchestrator | Space field hidden — the orchestrator belongs to the whole workspace |
| manager | **Space required** (or "Create new domain" inline) — this is the domain the manager owns |
| worker | **Space optional** — inherits the manager's space by default if `reportsTo` is set, but can be overridden |

**Inline create affordance** in the wizard selector:

```html
<select>
  <option value="">Unassigned</option>
  {spaces.map(s => <option value={s.id}>{s.name}</option>)}
  <option value="__new__">+ Create new domain</option>
</select>
```

When `__new__` is selected: open the Domain Create Sheet inline (as a modal-on-modal). On create,
inject the new space ID back into the wizard state and dismiss the sheet.

### 4.4 Agent Cards — Domain Badge

Add a **domain badge** to both the fleet card anatomy and the quick-detail panel.

**Fleet card (hierarchy canvas node):**

```
+----------------------------------------------+
|  [role-glyph]  {Name}            {status-dot} |
|  {Role} · {harness-label}                     |
|  [domain-pill]                                |   ← NEW: colored domain badge
|  ──────────────────────────────────────────  |
|  {live-activity-line}                         |
+----------------------------------------------+
```

- Domain pill: `background: colorHex + 18% opacity`, `border: colorHex + 55% opacity`, text = domain name, 10px, rounded-full.
- If no domain: no pill rendered (not "Unassigned" text — empty is fine).
- Clicking the domain pill filters the canvas to that domain.

**Table view** — add a `Domain` column (was absent, only appeared as a row group header).

### 4.5 Agent Config Page — Domain Field in Identity Tab

The `Identity` tab of `/agents/:id` must include the domain picker:

```
Name ________________________________
Role   [Orchestrator / Manager / Worker]
Domain   [Marketing ▾]   [+ Create]
Description (optional) ______________
```

`PATCH /v1/agents/:id` with `{ spaceId }` persists the change.
On save, emit `AGENT_UPDATED` → refresh the fleet canvas.

### 4.6 Workflows — Domain Association

Workflows already have `spaceId` in DB but no UI surfaces it.

**Workflows page** — add a `Domain` column/filter to the workflow list.
**Workflow canvas header** — add a domain badge (read/write) in the top-right metadata cluster.
**Agent Create Wizard** — when creating a workflow from within a domain context, pre-set `spaceId`.

### 4.7 Manager Lanes Panel — Demoted to Read-Only Nav

The `ManagerLanesPanel` component in `WorkspaceEcosystemCanvas.tsx` should:
1. Keep its visual form (floating aside, glassmorphism, right-anchored).
2. Remove the chat-with-manager inline button (move to quick-detail panel).
3. Add a "Manage domains →" link at the bottom that navigates to `/agents` with a domain filter
   pre-applied via URL query param (`?domain=all`).
4. NOT contain any create/edit/delete actions — those live on the Agents page (§4.1).

The label `MANAGER LANES` → rename to `DOMAINS` in the UI.

---

## 5. Orchestrator Card — Fix Sizing and Centering

### 5.1 Root Cause

`WorkspaceEcosystemCanvas` computes a virtual canvas with `MIN_WIDTH = 1180px` and places the
orchestrator card at `x = (virtualWidth / 2) - (NODE.orchestrator.width / 2)`, `y = 80`. On
initial mount `fitViewToContent()` centers the canvas on the content bounds. The regression
happened because:

1. `fitViewToContent` is called before the container has its final size (race condition with
   `ResizeObserver`).
2. When the chat panel opens, `dockedWidth` changes the effective canvas area but
   `userMovedRef.current` is already `true`, so `requestFleetFit` skips the re-fit.
3. `NODE.orchestrator.width = 292` is hardcoded but the rendered card's actual DOM width at
   lower zoom levels can exceed the virtual bounding box due to padding.

### 5.2 Fixes

**A. Re-fit on chat panel state change:**
```typescript
// WorkspaceEcosystemCanvas.tsx — effect that watches chat panel width
useEffect(() => {
  if (!initialCenteredRef.current) return;
  userMovedRef.current = false;               // allow next fit
  requestFleetFit(flowRef.current);
}, [dockedWidth, isFullscreen]);
```

**B. Defer initial fit to after first layout:**
```typescript
// Replace the current inline fitViewToContent call in the entrancePhase='complete' handler
// with a rAF-deferred version that checks containerSize is stable:
const fitOnStableSize = () => {
  if (!containerRef.current) return;
  const measured = containerRef.current.getBoundingClientRect();
  if (Math.abs(measured.width - containerSize.width) > 4) {
    requestAnimationFrame(fitOnStableSize);  // retry once
    return;
  }
  fitViewToContent();
};
requestAnimationFrame(fitOnStableSize);
```

**C. Clamp orchestrator card width to container:**
In the `OrchestratorNode` render function, replace the fixed `width: NODE.orchestrator.width`:
```tsx
// Use min() so the card never exceeds the visible canvas at current zoom:
style={{ width: Math.min(NODE.orchestrator.width, containerSize.width * 0.7) }}
```

**D. Reset centering on meaningful agent changes:**
When the orchestrator agent changes (e.g. a new orchestrator is created), force a re-center:
```typescript
useEffect(() => {
  const orchId = agents.find(a => a.role === 'orchestrator')?.id;
  if (!orchId) return;
  userMovedRef.current = false;
  requestFleetFit(flowRef.current);
}, [agents.find(a => a.role === 'orchestrator')?.id]);  // stable dep
```

---

## 6. Implementation Phases

### Phase 1 — Foundation (no new features, fix regressions)
- [ ] Fix orchestrator card centering + sizing (§5)
- [ ] Remove `Manager Lanes` label → rename to `Domains`
- [ ] Add "Manage domains →" link to the panel (§4.7)
- [ ] Unblock space selector in wizard for workers (§4.3)
- [ ] Sync `spaceTag` write: when `spaceId` is set, write `space.name` to `spaceTag` too (API side, `POST/PATCH /v1/agents`)

### Phase 2 — Inline Domain Management
- [ ] Domain chips bar on Agents page (§4.1)
- [ ] Domain Create Sheet modal (§4.2)
- [ ] `+ Create new domain` option inside all space `<select>` inputs across the platform
- [ ] Domain badge on fleet agent cards (§4.4)
- [ ] Domain field on Identity tab of agent config page (§4.5)

### Phase 3 — Cross-Platform Domain Propagation
- [ ] Domain column + filter on Workflows page (§4.6)
- [ ] Domain badge in Workflow canvas header
- [ ] Worker inherits domain from manager on create (API sets `spaceId` from `reportsTo` agent's `spaceId` if worker's `spaceId` is null)
- [ ] Domain filter in URL param (`/agents?domain=marketing`) so Manager Lanes panel can link directly

### Phase 4 — Polish and Removal of Redundancy
- [ ] Deprecate `agents.spaceTag` — make it read-only, populated by API, no longer user-editable
- [ ] Add `GET /v1/spaces/:id/summary` → `{ name, colorHex, agents: count, workflows: count, activeRuns: count }`
- [ ] Homepage canvas cluster halos: use `spaceId` derived from `spaces` data instead of `spaceTag` string

---

## 7. API Changes Required

### 7.1 `POST/PATCH /v1/agents` — Auto-populate `spaceTag` from FK
```typescript
// When spaceId is provided, look up the space name and write it to spaceTag
if (body.spaceId) {
  const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, body.spaceId)).get();
  if (space) body.spaceTag = space.name;
}
```

### 7.2 Worker inherits `spaceId` from manager
```typescript
// When creating a worker and reportsTo is set and spaceId is not provided:
if (body.role === 'worker' && body.reportsTo && !body.spaceId) {
  const supervisor = db.select({ spaceId: schema.agents.spaceId })
    .from(schema.agents).where(eq(schema.agents.id, body.reportsTo)).get();
  if (supervisor?.spaceId) body.spaceId = supervisor.spaceId;
}
```

### 7.3 `GET /v1/agents` — Include `spaceName` in response
```typescript
// LEFT JOIN spaces to return { ...agent, spaceName: spaces.name ?? null }
```
(This avoids N+1 calls in the UI to resolve space names for every card.)

### 7.4 `GET /v1/spaces/:id/agents` — List agents in a domain
Returns `{ agents: AgentRow[] }` filtered by `spaceId`. Used by the domain chip drill-down.

---

## 8. Interaction Flow — Creating a Manager in a New Domain

This is the primary "happy path" that was broken in the screenshots.

```
1. Operator clicks "+ Add agent" on Agents page
2. Wizard opens — operator selects role = Manager
3. Space field appears below name:
     [Space / Domain ▾]  ← shows existing spaces
     Option: "+ Create new domain"
4. Operator picks "+ Create new domain"
5. Domain Create Sheet slides in (§4.2):
     Name: "Marketing"
     Color: ● #f97316
     Manager: (this agent will be set after creation — skip for now)
6. Operator clicks "Create domain"
7. Sheet closes; wizard's Space field now shows "Marketing" selected
8. Operator completes wizard → creates "Managy" as a manager agent in Marketing domain
9. API: POST /v1/agents { role:'manager', spaceId:'<marketing-id>', ... }
10. API auto-sets spaceTag = 'Marketing' and sets spaces.managerId = agent.id
11. Fleet canvas re-renders with Managy shown under the Marketing cluster halo
12. Homepage Domains panel now lists "Marketing · Managy · 0 flows"
```

---

## 9. Interaction Flow — Viewing and Editing Domains

```
1. Operator visits /agents (fleet view)
2. Domain chips bar shows: ● Marketing  ● Engineering  Unassigned
3. Operator clicks ● Marketing chip
4. Fleet canvas zooms/filters to only Marketing agents
5. Operator clicks [···] on the Marketing chip
6. Context menu: Rename · Change color · Set manager · Delete
7. "Set manager" opens a picker → selects any existing agent as the domain manager
8. PATCH /v1/spaces/:id { managerId }
9. Realtime SPACE_UPDATED event arrives → canvas refreshes
```

---

## 10. What NOT to Change

- **The DB schema** — `spaces` table is correct. No migrations needed for Phases 1-3.
- **The Manager Lanes panel position** — the floating glassmorphism panel looks right; only its
  copy, actions, and link-through need changing.
- **The `AgentHierarchyCanvas` ReactFlow approach** — it works; only the node card rendering and
  domain halo overlay need additions.
- **The `CommissionFlow.tsx` component** — it is used by a different entry point and doesn't need
  the space field at all (it's for simple quick-commissions without hierarchy context). Leave it.

---

## 11. Files Affected

| File | Change |
|---|---|
| `apps/web/src/pages/AgentsPage.tsx` | Domain chips bar, filter-by-domain state, domain chip drill-down |
| `apps/web/src/components/agents/AgentCreateWizard.tsx` | Remove `role==='manager'` gate on space field; add `__new__` option; Domain Create Sheet trigger |
| `apps/web/src/components/agents/AgentHierarchyCanvas.tsx` | Domain halo overlay per spaceId; domain badge on node cards |
| `apps/web/src/components/agents/DomainCreateSheet.tsx` | **NEW** inline modal for creating a domain |
| `apps/web/src/components/home/WorkspaceEcosystemCanvas.tsx` | Fix orchestrator card sizing/centering (§5); rename Manager Lanes → Domains; add Manage link |
| `apps/web/src/pages/AgentDetailPage.tsx` | Add domain field to Identity tab |
| `apps/web/src/pages/WorkflowsPage.tsx` | Domain column + filter |
| `apps/api/src/routes/agents.ts` | Auto-populate `spaceTag`; worker inherits `spaceId`; join space name in GET |
| `apps/api/src/routes/spaces.ts` | Add `GET /:id/agents` endpoint |

---

## 12. Success Criteria

- [ ] An operator can create a new domain inline during agent creation, without navigating away.
- [ ] All agent cards in the fleet canvas show their domain badge (or nothing — never "Unassigned" text).
- [ ] The Agents page shows a domain chips bar with create/edit/delete.
- [ ] The orchestrator card centers correctly on all viewport widths, including when the chat panel is open.
- [ ] Workers created under a manager automatically inherit the manager's domain.
- [ ] The homepage Domains panel shows the correct domain name (not "Manager Lanes") and links to the Agents page.
- [ ] The `spaceTag` free-text field is never written by user actions (only by API auto-sync from `spaceId`).
