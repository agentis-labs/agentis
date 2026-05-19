# Agents Page — Management Surface Replan
## Focused Cleanup: A Serious Fleet Management Tool

> **Status**: Implemented
> **Date**: May 14, 2026
> **Scope**: `/agents` page, `AgentHierarchyCanvas.tsx`, `AgentsPage.tsx`, `AgentHierarchyDetailPanel.tsx`
> **Predecessor**: `AGENTS-10X-REPLAN.md` (phases 1-3 shipped), `ORCHESTRATION-PAGE-REPLAN.md` (superseded — mission-control vision moved to HOME-WORKSPACE-CANVAS-REPLAN.md)
> **Thesis**: The Agents page is where you **configure and manage** your fleet — not where you watch it work. It is the HR/org-chart of your AI organization. It should be clean, authoritative, and fast to operate.

---

## 0. Mental Model Clarification

This document exists because a prior planning pass (`ORCHESTRATION-PAGE-REPLAN.md`) conflated two surfaces with different jobs:

| Surface | Job | Primary action |
|---------|-----|---------------|
| **Home (`/home`)** | "What is my fleet doing right now?" | Observe, direct, react |
| **Agents (`/agents`)** | "Who are my agents and how are they configured?" | Create, configure, assign, audit |

The immersive mission-control vision (fullscreen, activity popovers, edge animations, monitor window) belongs entirely on the **home canvas**. See `HOME-WORKSPACE-CANVAS-REPLAN.md`.

The agents page gets a focused cleanup: fix the 8 specific critique points (C1–C7) without adding any realtime work-feed complexity. One exception: a simple status dot (active/idle/error) on each card — that is enough realtime for a management surface.

---

## 1. The 7 Cleanup Items

### C1 — Canvas overflow (layout fix)

**Problem**: `AgentHierarchyCanvas` inside `AgentsPage` has no explicit height constraint. The parent chain does not constrain it, causing the canvas to overflow the page and create an unwanted scrollbar.

**Fix**: 
```tsx
// AgentsPage.tsx
<div className="flex h-full flex-col">
  <PageHeader />          {/* fixed ~56px */}
  <AgentHierarchyCanvas className="flex-1 min-h-0" />
</div>
```

Inside `AgentHierarchyCanvas`, the `ReactFlow` wrapper already takes `100%` of its parent when the parent has explicit height — the fix is entirely in the outer container.

### C2 — Filter bar + search bar occupy too much space

**Problem**: `<FilterBar>` (4 pills) + `<SearchInput>` render as two full-width rows above the canvas, consuming ~52px.

**Fix**: Both are removed from `AgentsPage`. They are replaced by a `<FleetToolbar>` component rendered as a React Flow `<Panel position="top-left">` **inside** the canvas.

`FleetToolbar` is a single compact row:
```
[🔍 Search agents…] [● All] [Active] [Idle] [⚠ Setup]  ← 48px tall
```

The search input is 200px; status chips are compact pill buttons. Both are in a single `flex items-center gap-2` row inside a glass-morphism panel.

Search behavior: typing dims non-matching nodes to `opacity: 0.25`; matching nodes get a `ring-1 ring-accent/50`. This preserves topology context instead of removing nodes from view.

### C3 — Metric grid removed from cards

**Problem**: Each node card shows `$0.00 today / 0 runs / 0 approval` — a row of metrics that read "zero" in any fresh workspace and add visual weight without value.

**Fix**: Remove the entire metric grid row from `AgentHierarchyNode`. These metrics belong in the `AgentHierarchyDetailPanel` (slide-in right panel on node click). The panel can show richer context when the user explicitly wants it.

### C4 — Rename view toggle

**Problem**: The view toggle reads "Canvas" — too generic (we have three canvases in the product).

**Fix**: `type View = 'fleet' | 'table'`. Toggle labels: `Fleet` (icon: `Cpu`) and `Table` (icon: `LayoutList`). localStorage key: `agentsView`. Default: `'fleet'`.

### C5 — Duplicate "+ Add agent" button

**Problem**: One button exists in the page header (`AgentsPage`) and another inside the canvas panel.

**Fix**: Remove the canvas `<Panel>` button entirely. The single entry point is the **page header button** `+ New agent`. It is the right place — it is always visible regardless of view mode (Fleet or Table).

### C6 — Left-side tier label Panel

**Problem**: `<Panel position="left">` renders static tier labels (ORCHESTRATOR / MANAGERS / WORKERS / UNASSIGNED). These consume horizontal canvas space and duplicate information the card's `role` field already provides.

**Fix**: Remove the entire left `<Panel>`. Tier is communicated via the card itself (see §2).

### C7 — Topology not enforced or legible

**Problem**: "One orchestrator per workspace, one manager per space" is a rule that exists only in prose. No UI communicates it or enforces it.

**Fix**: Soft enforcement via visual signals — no hard blocking, but clear communication. See §3.

---

## 2. New Node Card Design

### 2.1 Anatomy

```
┌──────────────────────────────────────────┐  ← top border (tier color, 3px solid)
│  [Avatar 32px]  Agent Name        [● ●]  │  ← name + status dot
│                 ORCHESTRATOR             │  ← role badge
│                 OpenClaw · GPT-4o-mini   │  ← adapter · model line
│  ─────────────────────────────────────── │
│  [⚙ CRM App]  [↻ Lead Enrichment]  +2  │  ← resource chips (§4)
└──────────────────────────────────────────┘
```

Width: `240px`. Min-height: `96px` without chips, `120px` with chips.

### 2.2 Tier color system

| Role | Border | Badge color | Badge text |
|------|--------|-------------|------------|
| `orchestrator` | `border-t-violet-500` (3px) + subtle glow | `bg-violet-500/15 text-violet-300` | ORCHESTRATOR |
| `manager` | `border-t-cyan-500` (3px) | `bg-cyan-500/15 text-cyan-300` | MANAGER |
| `worker` | `border-t-blue-400` (2px) | `bg-blue-400/15 text-blue-300` | WORKER |
| `unassigned` | `border-t-zinc-600` (1px, dashed) | `bg-zinc-700/50 text-zinc-400` | UNASSIGNED |

Orchestrator gets an additional `box-shadow: 0 0 14px rgba(139,92,246,0.22)` — a subtle permanent violet aura.

### 2.3 Status dot

| Status | Appearance |
|--------|-----------|
| `active` | `bg-emerald-400 animate-pulse` — pulsing green dot |
| `idle` | `bg-zinc-500` — solid grey |
| `error` / `setup_needed` | `bg-red-500 animate-ping` — urgent ping ring |
| `paused` | `bg-amber-400` — solid amber |

This is the only "live" element on the agents page. It is a simple status read — not a realtime work feed.

### 2.4 Manager cards: space line

Manager agents show which space they manage:

```
│  [Avatar 32px]  Lead Manager      [●]  │
│                 MANAGER                │
│                 Marketing Space  ●     │  ← space name + color dot
│                 OpenClaw · GPT-4o      │
```

The space color dot is `6px × 6px` circle using `space.colorHex`. If the manager is unassigned to any space, show "No space assigned" in `text-zinc-500`.

### 2.5 Remove from card (no longer shown)

- `$X.XX today` — removed
- `N runs` — removed
- `N approval` — removed
- Left-column metric grid — removed entirely
- These all remain available in `AgentHierarchyDetailPanel` when the node is clicked

---

## 3. Topology Enforcement (Soft, Visual)

### 3.1 One orchestrator per workspace

If a workspace has **zero** orchestrators: a dashed ghost node appears in the orchestrator row with the label "Set up orchestrator" and a `+` button. Clicking opens `AgentCreateWizard` with role pre-set to `orchestrator`.

If a workspace has **two or more** orchestrators: each extra orchestrator shows a `⚠ DUPLICATE` badge in amber. The badge tooltip: "This workspace already has an orchestrator. One orchestrator per workspace is recommended." No hard block.

### 3.2 One manager per space

The canvas fetches the list of spaces from `GET /v1/spaces`. For each space that has no manager assigned, a ghost manager node appears:

```
┌──────────────────────────────────────┐  ← border-t-dashed-zinc
│  [?]  No manager for Marketing  [+]  │
└──────────────────────────────────────┘
```

Clicking the `+` opens `AgentCreateWizard` with role pre-set to `manager` and space pre-filled.

For managers that have a space assignment, the space name appears on the card (§2.4).

### 3.3 Unassigned workers

Workers with no `reportsTo` value float to the bottom of the canvas with a dimmed `opacity-60` style. A small banner below them: "N workers are unconnected. Drag to assign." (Drag-to-assign is a future feature — the banner is informational for now.)

---

## 4. Resource Chips (Connected Apps + Workflows)

Each agent card shows the apps and workflows it is connected to as small inline chips.

### 4.1 Chip anatomy

```
[⚙ CRM App]  [↻ Lead Workflow]  +2
```

- App chip: `AppWindow` icon + app name
- Workflow chip: `Workflow` icon + workflow name
- Max 2 chips shown; `+N` overflow chip if more
- Style: `bg-zinc-800 border border-zinc-700 text-zinc-300 text-[11px] rounded-sm px-1.5 py-0.5 flex items-center gap-1`

### 4.2 Hover tooltip

Hovering a chip shows a simple `title`-based tooltip (no popover component needed):
- App: "{app name} — {app description or category}"
- Workflow: "{workflow name} — {last run status} {last run time}"

### 4.3 Click opens navigation

Clicking an app chip navigates to `/apps/:slug`. Clicking a workflow chip navigates to `/workflows/:id`. Simple — no modal needed at this fidelity (the full popovers/modals live in the Home canvas where richer context makes sense).

### 4.4 API change required

`GET /v1/agents` list must include:
```typescript
connectionSummary: {
  apps: { id: string; slug: string; name: string }[];      // top 2
  workflows: { id: string; name: string }[];               // top 2
  totalApps: number;
  totalWorkflows: number;
}
```

This replaces the current `connectionCounts` (just numbers) with actual names. The API join queries `agent_app_connections` and `agent_workflow_connections` (or the equivalent FKs).

---

## 5. FleetToolbar Component

### 5.1 Placement

A React Flow `<Panel position="top-left">` inside the canvas.

### 5.2 Layout

```tsx
<Panel position="top-left">
  <div className="flex items-center gap-2 rounded-xl border border-line/60 bg-surface/90 px-3 py-2 shadow-card backdrop-blur-sm">
    <Search size={13} className="text-text-muted" />
    <input placeholder="Search agents…" className="w-[180px] bg-transparent text-[12px] text-text-primary …" />
    <div className="mx-1 h-4 w-px bg-line" />
    {STATUS_FILTERS.map(filter => <StatusChip key={filter.value} ... />)}
  </div>
</Panel>
```

### 5.3 Search behavior

```typescript
const [search, setSearch] = useState('');
// In node render:
const dimmed = Boolean(search && !node.data.agent.name.toLowerCase().includes(search.toLowerCase()));
// Node gets className: dimmed ? 'opacity-25 pointer-events-none' : ''
```

### 5.4 Status chip behavior

```typescript
const [activeFilter, setActiveFilter] = useState<FilterValue>('all');
// Nodes with non-matching status get dimmed (same opacity: 0.25 treatment)
// Does not remove nodes — topology is preserved
```

---

## 6. Detail Panel Refinements

`AgentHierarchyDetailPanel` (existing) gets minimal changes:

**Remove**: the inline `$X.XX / N runs / N approval` row at the top of the panel — these were added in Phase 3 and are the same noisy metrics we're removing from cards.

**Keep**: agent name, role badge, status, adapter/model summary, space assignment, connection summary, "Open full page" button.

**Add**: a section showing all connected apps and workflows by name (not just the top 2 from the card — the full list).

---

## 7. Component File Plan

| File | Action | Notes |
|------|--------|-------|
| `apps/web/src/pages/AgentsPage.tsx` | Modify | Remove `FilterBar` + `SearchInput`; change `View` type to `'fleet' \| 'table'`; fix height to `h-full flex flex-col`; remove canvas `+ Agent` button (keep header button only) |
| `apps/web/src/components/agents/AgentHierarchyCanvas.tsx` | Modify | Remove left `<Panel>` tier labels; remove canvas `+ Agent` Panel button; add `FleetToolbar` panel; wire status filter + search to dim nodes |
| `apps/web/src/components/agents/AgentHierarchyNode.tsx` | Create | Extract node card from canvas; new anatomy: tier border + role badge + status dot + resource chips; no metric grid |
| `apps/web/src/components/agents/FleetToolbar.tsx` | Create | Search + status filter chips as canvas Panel |
| `apps/web/src/components/agents/AgentHierarchyDetailPanel.tsx` | Modify | Remove metric row from top; add full connection list section |
| `apps/api/src/routes/agents.ts` | Modify | Replace `connectionCounts` with `connectionSummary` (names, not just counts); confirm `spaceName` in list response |

---

## 8. Implementation Phases

### Phase A — Layout and label cleanup (1.5 hours, low risk)

| # | Task |
|---|------|
| A-1 | Fix canvas overflow: `h-full flex flex-col` in `AgentsPage`, `flex-1 min-h-0` on canvas |
| A-2 | Remove `<FilterBar>` and `<SearchInput>` from `AgentsPage` |
| A-3 | Remove left-side `<Panel>` tier labels from `AgentHierarchyCanvas` |
| A-4 | Remove canvas `+ Agent` Panel button (keep page header button) |
| A-5 | Rename view type: `'canvas'` → `'fleet'`; update localStorage key; update toggle labels |

**DoD Phase A**:
- [ ] No vertical scrollbar on `/agents` at 1280×800 viewport
- [ ] No external filter bar or search bar visible
- [ ] Left-side tier labels panel is gone
- [ ] Only one "+ New agent" button exists
- [ ] View toggle reads "Fleet" and "Table"

### Phase B — Card redesign (2 hours)

| # | Task |
|---|------|
| B-1 | Extract `AgentHierarchyNode.tsx` from canvas inline definition |
| B-2 | Implement tier border colors + role badge per `role` value |
| B-3 | Implement status dot with correct animation per status value |
| B-4 | Remove metric grid entirely |
| B-5 | Add space name line to manager cards |
| B-6 | Add orchestrator ghost node + duplicate badge logic |

**DoD Phase B**:
- [ ] Cards show tier-specific border color and role badge
- [ ] Status dot animates correctly for active/idle/error states
- [ ] No cost/runs/approval numbers on any card
- [ ] Manager cards show assigned space name + color dot
- [ ] Duplicate orchestrator gets amber `⚠ DUPLICATE` badge
- [ ] Ghost manager node appears for spaces without a manager

### Phase C — FleetToolbar + search (1 hour)

| # | Task |
|---|------|
| C-1 | Create `FleetToolbar.tsx` |
| C-2 | Wire search to dim non-matching nodes (opacity 0.25) |
| C-3 | Wire status filter chips to dim non-matching status nodes |
| C-4 | Reset-layout button moves into top-right panel next to the existing Controls |

**DoD Phase C**:
- [ ] Toolbar renders inside canvas (top-left panel)
- [ ] Typing in search dims non-matching nodes; topology preserved
- [ ] Status filter chips work
- [ ] Reset layout accessible from canvas controls area

### Phase D — Resource chips + API (1.5 hours)

| # | Task |
|---|------|
| D-1 | Update `GET /v1/agents` list to return `connectionSummary` with names |
| D-2 | Render resource chips in `AgentHierarchyNode` (top 2 apps + workflows) |
| D-3 | `+N` overflow chip logic |
| D-4 | Chip click navigates to `/apps/:slug` or `/workflows/:id` |
| D-5 | Detail panel: add full connection list section; remove metric row |

**DoD Phase D**:
- [ ] Agent nodes with connected apps show app chips by name
- [ ] Agent nodes with connected workflows show workflow chips by name
- [ ] `+N` chip appears when total > 2
- [ ] Clicking chip navigates correctly
- [ ] Detail panel shows full connection list; no metric row at top

### Phase E — Tests (1 hour)

| # | Task |
|---|------|
| E-1 | Update `AgentsPage.test.tsx`: new view label "Fleet", no external filter bar, resource chips |
| E-2 | Update `agents-canvas.spec.ts`: updated selectors for new card anatomy |
| E-3 | Add snapshot test for `AgentHierarchyNode` — orchestrator, manager, worker variants |
| E-4 | Update API test: `connectionSummary` shape instead of `connectionCounts` |

**DoD Phase E**:
- [ ] All `@agentis/web` Vitest tests pass
- [ ] `agents-canvas.spec.ts` Playwright test passes
- [ ] API test validates `connectionSummary` shape

---

## 9. Definition of Done — Full Agents Page Cleanup

The agents page cleanup is complete when ALL of the following are true:

- [ ] No vertical scrollbar on `/agents` at any viewport ≥ 1024px
- [ ] The word "Canvas" is gone from the agents page; view mode is "Fleet"
- [ ] Exactly one entry point to create an agent
- [ ] No cost/runs/approval metrics on any node card
- [ ] Tier communicated via border color + role badge (no left-side label panel)
- [ ] Manager nodes show space name
- [ ] Orchestrator duplication softly warned with amber badge
- [ ] Ghost nodes appear for spaces missing a manager
- [ ] Search and status filter are inside the canvas toolbar
- [ ] Search dims non-matching nodes (topology preserved)
- [ ] Connected apps and workflows appear as named chips on cards
- [ ] Chip click navigates to the correct page
- [ ] Detail panel has full connection list; no metric row
- [ ] All Vitest tests green
- [ ] Playwright e2e passes with updated selectors

---

## 10. Scope Boundary

What is explicitly NOT in this document:
- No realtime activity popovers on agents cards (those live on the Home canvas)
- No edge animations on agents canvas (no running work visualized here)
- No full-screen mode (that's for Home)
- No monitor window (that's for Home)
- No drag-to-reassign `reportsTo` (future sprint)
- No changes to `AgentDetailPage` (separate surface, not this sprint)
- No changes to `AgentCreateWizard` (Phase 2 from AGENTS-10X-REPLAN, already good)
- No changes to the Table view (remains as-is, unaffected by all above)

The distinction from `HOME-WORKSPACE-CANVAS-REPLAN.md` is intentional and load-bearing. Keep them separate.
