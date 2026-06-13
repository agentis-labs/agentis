# Brain Page Redesign — UX/Architecture Plan

**Status**: Planning  
**Author**: Design + Engineering  
**Supersedes**: `UIUX-refactor/BRAIN-PAGE-REDESIGN.md` (older partial notes)

---

## 1. Current State Audit

### 1.1 What exists today

`UnifiedBrainPage.tsx` renders:

```
[Page Header]
  Brain icon · "The Brain" · subtitle

[Tab bar — 8 tabs]
  Graph | Health | Config | Disputes | Documents(2) | Knowledge Bases(1) | Memory | Episodes

[Content area]
  Graph tab → BrainView
    └─ [Row 1] Stats sentence + Search box + Map/Flow/Ledger mode switcher
    └─ [Row 2] "Filters:" ALL | KNOWLEDGE | MEMORY | JUDGMENT | ⚠ Warnings | ○ Gaps
    └─ [Canvas] BrainStage (d3-force) or BrainFlowMode or BrainLedgerMode
       └─ [Canvas overlay] "83 ATOMS · 222 LINKS" pill
    └─ [Canvas bottom legend] ● Knowledge  ● Memory  ● Judgment  ● Core
       Size = connections · Glow = confidence · Drag to arrange
    └─ [Right rail] BrainDetailRail (280 px, selection-aware)

  Health tab → BrainHealthDashboard
    Degraded warning banner + 5 metric cards + Atom lists + Compression card + Activity feed + Dream Pass button

  Config tab → BrainConfigWizard
    Embedding model setup (OpenAI) · 2-step wizard · verify connection

  Disputes tab → DisputeResolutionPanel
    List of contradiction pairs + resolve actions (keep A/B, merge, split, snooze)

  Documents tab    → WorkspaceDocDropZone + DocumentList
  Knowledge Bases  → KnowledgeBaseList
  Memory tab       → WorkspaceMemoryTab
  Episodes tab     → EpisodesTab
```

### 1.2 Pain points identified

| # | Problem | Impact |
|---|---------|--------|
| P1 | **Duplicate filter system**: The filter bar (ALL/KNOWLEDGE/MEMORY/JUDGMENT) above the canvas repeats the same categories shown in the legend below the canvas. User is forced to cross-reference two separate controls for the same action. | High — cognitive dissonance |
| P2 | **Three-row overhead above the canvas**: Stats sentence + search + mode switcher (Row 1) + Filter bar (Row 2) + Legend below = three full rows of chrome that eat vertical space from the canvas. | High — canvas feels cramped |
| P3 | **Flow and Ledger modes add almost no unique value**: Flow is a static Sankey-column view of the same data. Ledger is a card grid with its own internal filter row — a simpler reading of atoms that doesn't justify a full mode. Neither is featured in usage patterns. | Medium |
| P4 | **8-tab navigation is overwhelming**: Config and Disputes are rarely accessed; Memory and Episodes belong together conceptually; Documents and Knowledge Bases are two halves of the same concern. | High |
| P5 | **Config as a primary tab** implies it should be visited often. In reality it is a one-time setup that degrades into a status check. Surfacing it as a major tab pollutes the navigation rail. | Medium |
| P6 | **Health, Disputes, Memory, Episodes are four separate surfaces** for what is really one conceptual domain: *"What does the Brain know and how healthy is it?"* Splitting them makes the user hunt across tabs to get a full picture. | High |
| P7 | **The right side of the page header** is currently empty in the screenshot, but the codebase is starting to accumulate ad-hoc items there. It must remain clear for an upcoming toggle feature. | Low (future safety) |
| P8 | **Stats sentence ("83 knowledge - 0 memories - 222 links")** is a verbose text block occupying prime toolbar real estate. The same information is visible on the canvas itself. | Low |

---

## 2. Design Principles for the Redesign

1. **One row of chrome, maximum.** Every pixel above the canvas is a pixel stolen from understanding. Aim for a single slim tab strip below the page header; nothing else between the header and the content.

2. **Controls that exist only once.** If a concept (e.g. layer filtering) already has visual representation on the canvas (node color), adding a separate filter bar above is redundant. The visual representation *is* the filter — clicking a color chip on the legend toggles visibility.

3. **Tabs reflect user intents, not data types.** Users don't think "I want to see the Documents tab." They think "I want to add knowledge" or "I want to understand what the Brain knows." Navigation labels should map to those intents.

4. **Rare actions live in drawers or icons, not tabs.** Config is a one-time wizard. Disputes are low-frequency admin. These don't deserve permanent tabs that occupy attention every time the page loads.

5. **The canvas owns its own state.** Search, zoom, and filtering belong to the canvas layer — overlaid softly inside or at the edge of the viewport, not stacked above it as separate rows.

6. **Progressive disclosure.** Show the healthy, happy default. Reveal config options, dispute counters, and degraded-mode warnings only when relevant — via badges, inline banners, or a slide-over — not always-visible tabs.

---

## 3. Information Architecture — New Structure

### 3.1 Tab count: 8 → 3

| Old tabs | Merges into | Rationale |
|----------|-------------|-----------|
| Graph | **Map** | Renamed for clarity; same canvas |
| Flow | (removed) | No user-facing value; data already browseable via Ledger; kill mode entirely |
| Ledger | (merged into Insights) | The card-grid atom browser becomes a section inside the Insights tab |
| Health | **Insights** | Part of "what does the Brain know and how healthy is it?" |
| Config | (moved to gear icon) | One-time setup; not a navigation destination |
| Disputes | **Insights** | Rare admin action; surfaced as amber section inside Insights |
| Documents | **Knowledge** | Two halves of the same topic |
| Knowledge Bases | **Knowledge** | Two halves of the same topic |
| Memory | **Insights** | Belongs with health/episodes in the brain state picture |
| Episodes | **Insights** | Same domain as memory |

**Result: Map · Knowledge · Insights** — three tabs with clear, obvious intent.

### 3.2 Config gear icon

`BrainConfigWizard` is triggered by a small gear/settings icon placed **inline, immediately to the right of "The Brain" title**, inside the page header. It opens as a full-height right-side drawer (or full-page overlay on narrow screens). This removes Config from the tab strip entirely.

Visual placement:

```
[●] The Brain  ⚙                          [        reserved        ]
    Workspace intelligence map
```

The `⚙` icon gets a small amber dot badge when `intelligence.degraded === true`, surfacing the setup need passively without taking over the page.

---

## 4. Page Layout Blueprint

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ HEADER (48 px)                                                              │
│  [●] The Brain  ⚙(badge?)                                                  │
│      Workspace intelligence map · knowledge graph · shared memory          │
│                                                                             │
│                                          [reserved for upcoming toggle]    │
├─────────────────────────────────────────────────────────────────────────────┤
│ TAB STRIP (36 px)                                                           │
│  Map   Knowledge   Insights                                                 │
│  ────                                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   CONTENT AREA  (flex-1, overflow-hidden)                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

The header right side is intentionally left empty — no search, no actions, no stat counters. The upcoming feature will place its toggle there.

---

## 5. Map Tab — Redesigned Canvas View

### 5.1 What is removed

| Element | Reason |
|---------|--------|
| Stats sentence row ("83 knowledge - 0 memories - 222 links" + "Open knowledge") | Duplicates information visible on the canvas; "Open knowledge" link is redundant with the Knowledge tab |
| Mode switcher (Map / Flow / Ledger) | Flow and Ledger modes are removed; Map is the only mode |
| Separate filter bar row (ALL / KNOWLEDGE / MEMORY / JUDGMENT + Warnings + Gaps) | Replaced by interactive legend inside canvas |
| Separate legend row below canvas (● Knowledge ● Memory ● Judgment ● Core + hint text) | Replaced by interactive legend *inside* canvas |
| `BrainFlowMode.tsx` | Deleted |
| `BrainLedgerMode.tsx` | Deleted |

### 5.2 What replaces them: Floating Layer Controls

A single **floating chip strip** lives inside the canvas viewport, anchored to the **bottom-left corner** with `position: absolute; bottom: 12px; left: 12px`. It replaces both the filter bar and the legend in one component.

```
Bottom-left overlay (inside canvas):
  [● Knowledge]  [● Memory]  [● Judgment]
```

- Each chip shows its **actual node color** as a filled dot (not a swatch legend separate from the filter)
- Clicking a chip **toggles that layer's visibility** (selected = opaque; deselected = dimmer dot + strikethrough text)
- All chips active by default = "ALL" view — no separate "ALL" button needed
- Warnings and Gaps are represented as chip variants:
  - `[⚠ Warnings]` appears only when `warnings.length > 0`  
  - `[○ Gaps]` appears only when `gaps.length > 0`
- Hint text ("Size = connections · Glow = confidence · Drag to arrange") moves into a tiny `?` help icon that shows a tooltip on hover — removing it from permanent screen real estate

**Design rationale:** The color dot on each chip IS the legend dot. There is no separate legend. There is no separate filter bar. One widget does both jobs. The canvas gets 72 px back (two removed rows).

### 5.3 Search

The search box moves **inside the canvas** as a small floating element in the **top-right corner** of the canvas area (not the page header). It is visually lighter — an icon-only button that expands to a text field on click/focus, similar to how design tools handle in-canvas search.

```
Top-right canvas overlay:
  [🔍]  →  [🔍 Search the brain ________]  (on focus)
```

### 5.4 BrainDetailRail

The right rail stays unchanged in function. It slides in when a node is selected, pushing (or overlaying) the canvas. No changes to its API or content.

### 5.5 Config inline setup banner

When `intelligence.degraded === true` AND the user has not completed setup, the existing inline `BrainConfigWizard` banner (currently conditional in `BrainView`) is **replaced by a slim amber top-banner** inside the Map canvas area:

```
⚠  Brain is running in keyword mode — semantic search is disabled.   [Set up embedding →]
```

Clicking the action opens the Config drawer. The old full-panel inline wizard render is removed.

### 5.6 Resulting Map layout

```
┌───────────────────────────────────────────────────┬──────────────────┐
│                                                   │                  │
│              CANVAS (d3-force, full)              │  BrainDetailRail │
│                                                   │  (280 px,        │
│  [🔍]                              top-right ↗   │   slides in on   │
│                                                   │   selection)     │
│                                                   │                  │
│  [● Knowledge] [● Memory] [● Judgment]  bot-left ↙│                  │
└───────────────────────────────────────────────────┴──────────────────┘
```

---

## 6. Knowledge Tab — Merged Documents + Bases

### 6.1 Layout

```
┌─────────────────────────────────────────────────────────────┐
│  [Drop zone banner — drag files here]                       │
├────────────┬────────────────────────────────────────────────┤
│  KB LIST   │  DOCUMENT LIST                                 │
│  (sidebar) │  (main panel)                                  │
│            │  Search + filter chips inside                  │
│  + New KB  │                                                │
└────────────┴────────────────────────────────────────────────┘
```

- Left sidebar: Knowledge Bases list (`KnowledgeBaseList`) — compact, ~220 px
- Main panel: Documents for the selected KB (`DocumentList`)
- Drop zone is a persistent top banner (not a full-page empty state unless there are 0 documents AND 0 bases)
- Selecting a KB in the sidebar updates the document list — no separate page navigation
- "Add to" dropdown (currently "Workspace knowledge" / specific KB) becomes a context-aware default based on what is selected in the sidebar

### 6.2 What is removed

- No separate "Documents" and "Knowledge Bases" tabs — they are now panes in a single split layout
- The separate load for each tab (currently two separate API calls on different mount cycles) collapses into one coordinated load

---

## 7. Insights Tab — Unified Brain State

### 7.1 Intent

This tab answers: *"What does the Brain know, how confident is it, and what needs attention?"*

It unifies: Health metrics · Memory entries · Episodes · Disputes

### 7.2 Layout (top → bottom scroll)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  [DEGRADED BANNER — only if degraded]                                   │
│  ⚠ Brain is running in keyword mode.                  [Set up →]       │
├─────────────────────────────────────────────────────────────────────────┤
│  HEALTH METRICS ROW  (4 cards)                                          │
│  [Brain Health: 28]  [Context Coverage: 0%]  [Quality: Flat]  [Disputes]│
├─────────────────────────────────────────────────────────────────────────┤
│  DISPUTES SECTION  (only if disputes.length > 0, else hidden)           │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │  ⚠ 3 contradictions need resolution        [Resolve all →]       │ │
│  │  [DisputeCard] [DisputeCard] ...                                  │ │
│  └───────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────┤
│  MEMORY SECTION                                                         │
│  [Fact] [Rule] [Preference] [Pattern] [Lesson]  filter chips            │
│  memory entry list / empty state                                        │
├─────────────────────────────────────────────────────────────────────────┤
│  EPISODES SECTION                                                       │
│  [Decision] [Failure] [Recovery] ...  filter chips                     │
│  episodes list / "No promoted memories yet" empty state                │
├─────────────────────────────────────────────────────────────────────────┤
│  MAINTENANCE ROW                                                        │
│  Last dream pass: ...   [N] archived   [M] evaluator signals this week │
│  [Dream Pass ▶]  [Refresh ↺]                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.3 Key design decisions

**Disputes are shown only when they exist.** When `disputes.length === 0` the entire disputes section collapses — no empty state card, no mention of the concept. This keeps the surface clean 95% of the time. When disputes exist, an amber card draws attention at the top of the content (below health metrics), making them impossible to miss.

**Memory and Episodes share the same page flow** but are visually distinct sections with their own section headers and filter chips. The user can scroll past memory to reach episodes — they no longer need to click a separate tab.

**The Health score card is kept** — it is the single most useful health number and earns its space. The four supporting metric cards (Context Coverage, Evaluator Signal, Quality Trend, Open Disputes) collapse the current 5-card grid to 4 more relevant metrics with cleaner labels.

**"Highest Confidence Atoms" and "Stale Review Queue"** from `BrainHealthDashboard` are removed from the main view. They are expert-level information. They can be surfaced inside `BrainDetailRail` when a node is selected, or as a collapsible "Advanced" section at the very bottom. They should not compete for first-screen attention with the simpler memory/episodes content that most users will interact with.

**Dream Pass action** moves to the Maintenance row at the bottom of the page — it's an infrequent power-user operation, not a primary CTA. It does not need a prominent button above the fold.

---

## 8. Config Drawer — Extracted from Tabs

### 8.1 Trigger

Small `<Settings2 size={15} />` icon button placed immediately after "The Brain" heading in the page `<header>`. When `intelligence.degraded` the icon gets a small amber pulsing dot overlay.

### 8.2 Content

The existing `BrainConfigWizard` component renders inside a right-side slide-over drawer (`position: fixed; inset: 0 0 0 auto; width: 480px; z-index: 50`). The drawer has its own close button. No route change is needed — it is a local UI state (`configDrawerOpen: boolean`).

### 8.3 Removal

`BrainConfigWizard` is no longer rendered as a `tab === 'config'` branch in `UnifiedBrainPage`. The tab is fully deleted from the tab array.

---

## 9. Component Inventory — Changes Required

### Files to delete
| File | Reason |
|------|--------|
| `apps/web/src/components/brain/BrainFlowMode.tsx` | Flow mode removed |
| `apps/web/src/components/brain/BrainLedgerMode.tsx` | Ledger mode removed |

### Files with major changes
| File | Changes |
|------|---------|
| `apps/web/src/pages/UnifiedBrainPage.tsx` | Reduce tabs from 8 → 3; add config gear icon; add `configDrawerOpen` state; remove `config` / `disputes` / `documents` / `bases` / `memory` / `episodes` tab branches |
| `apps/web/src/components/brain/BrainView.tsx` | Remove stats row; remove filter bar row; remove mode switcher; remove inline `BrainConfigWizard` embed; add floating `LayerFilterChips` component; add floating `CanvasSearch` component; add slim degraded-mode top banner |
| `apps/web/src/components/brain/BrainStage.tsx` | Accept `layerFilter` as before; the canvas legend is now owned by `BrainView`'s overlay instead of being rendered inside BrainStage itself |

### New components to create
| Component | Location | Purpose |
|-----------|----------|---------|
| `LayerFilterChips` | `components/brain/LayerFilterChips.tsx` | Floating bottom-left chip strip: colored dots that ARE the legend AND the filter toggle |
| `CanvasSearch` | `components/brain/CanvasSearch.tsx` | Floating top-right expandable search box inside the canvas viewport |
| `InsightsTab` | `components/brain/InsightsTab.tsx` | Unified tab: degraded banner + health metrics + disputes section + memory section + episodes section + maintenance row |
| `ConfigDrawer` | `components/brain/ConfigDrawer.tsx` | Slide-over wrapper around `BrainConfigWizard` |
| `KnowledgeTab` | `components/knowledge/KnowledgeTab.tsx` | Split-pane: KBs sidebar + document list main panel |

### Files with minor changes
| File | Changes |
|------|---------|
| `apps/web/src/components/knowledge/WorkspaceKnowledgePanels.tsx` | API extracted into `KnowledgeTab`; component may be deleted or reduced to a thin adapter |
| `apps/web/src/components/brain/BrainHealthDashboard.tsx` | Broken into sections consumed by `InsightsTab`; the monolithic component is retired |
| `apps/web/src/components/brain/DisputeResolutionPanel.tsx` | Becomes a collapsible section inside `InsightsTab`; existing dispute card components are reused |

---

## 10. Route Changes

Current routes mapped to Brain:
- `/brain` → Graph tab
- `/brain/health` → Health tab
- `/brain/config` → Config tab
- `/brain/disputes` → Disputes tab
- `/brain?tab=documents` → Documents tab
- `/brain?tab=bases` → KB tab
- `/brain?tab=memory` → Memory tab
- `/brain?tab=episodes` → Episodes tab

New routes:
- `/brain` → Map tab (default)
- `/brain?tab=knowledge` → Knowledge tab
- `/brain?tab=insights` → Insights tab
- `/brain/health`, `/brain/config`, `/brain/disputes` → redirect to `/brain?tab=insights`
- `/brain?tab=documents`, `/brain?tab=bases`, `/brain?tab=memory`, `/brain?tab=episodes` → redirect to their new consolidated tabs

The `readTab()` function in `UnifiedBrainPage` is updated to handle legacy paths with redirects so no external links break silently.

---

## 11. Tab Count Summary

| Before | After |
|--------|-------|
| Graph | Map |
| Health | → (merged into Insights) |
| Config | → (gear icon in page header) |
| Disputes | → (section inside Insights) |
| Documents | → (split pane inside Knowledge) |
| Knowledge Bases | → (split pane inside Knowledge) |
| Memory | → (section inside Insights) |
| Episodes | → (section inside Insights) |
| **8 tabs** | **3 tabs** |

---

## 12. Implementation Phases

### Phase 1 — Remove clutter from Graph/Map view
- Delete `BrainFlowMode.tsx` and `BrainLedgerMode.tsx`
- Remove the mode switcher from `BrainView`
- Remove the stats sentence row from `BrainView`
- Remove the separate filter bar row from `BrainView`
- Remove the bottom legend row from `BrainView`
- Create `LayerFilterChips` overlay (bottom-left of canvas)
- Create `CanvasSearch` overlay (top-right of canvas)
- Add slim degraded-mode banner inside canvas (top of canvas content area)

### Phase 2 — Consolidate tabs
- Reduce `UnifiedBrainPage` tabs from 8 to 3: Map · Knowledge · Insights
- Add gear icon + `ConfigDrawer` slide-over for BrainConfigWizard
- Add legacy route redirects
- Create `KnowledgeTab` split-pane component
- Create `InsightsTab` unified component (health + disputes + memory + episodes)

### Phase 3 — Polish Insights tab
- Disputes section hidden when count = 0 (animated reveal when disputes arrive via realtime)
- Health score card redesign: larger number, cleaner supporting metrics
- Memory filter chips (Fact / Rule / Preference / Pattern / Lesson) inline
- Episodes filter chips (Decision / Failure / Recovery / Correction / Pattern / Distilled Lesson) inline
- Maintenance row at bottom with Dream Pass action

### Phase 4 — Test and redirect cleanup
- Update `BrainView.test.tsx` for new component structure
- Verify legacy `/brain/health`, `/brain/config`, `/brain/disputes` redirects
- Confirm `BrainDetailRail` still functions correctly with new overlay structure

---

## 13. What Deliberately Stays the Same

- `BrainStage.tsx` (d3-force canvas renderer) — no changes to core rendering logic
- `BrainDetailRail.tsx` — no changes; the right-side inspector remains
- `BrainConfigWizard.tsx` — content unchanged, just moved to a drawer
- `DisputeResolutionPanel` card components — reused inside `InsightsTab`
- All API endpoints — no backend changes required
- All realtime subscriptions — no changes required

---

## 14. Visual "Before / After" Summary

**Before (Graph tab):**
```
┌────────────────────────────────────────────────────────────┐
│ 83 knowledge - 0 memories - 222 links  Open knowledge ↗   │  ← row 1 (36px)
│                             [Search ___]  [Map|Flow|Ledger]│
├────────────────────────────────────────────────────────────┤
│ Filters: ALL  KNOWLEDGE  MEMORY  JUDGMENT  ⚠Warnings ○Gaps│  ← row 2 (32px)
├────────────────────────────────────────────────────────────┤
│                                                            │
│   CANVAS (force graph)                                     │  ← main content
│   • 83 ATOMS · 222 LINKS                                   │
│                                                            │
├────────────────────────────────────────────────────────────┤
│ ●Knowledge ●Memory ●Judgment ●Core  Size=connections...   │  ← row 3 (28px)
└────────────────────────────────────────────────────────────┘
```

**After (Map tab):**
```
┌───────────────────────────────────────────────┬───────────┐
│                                          [🔍] │           │
│   CANVAS (force graph)                        │  Detail   │
│   Full height, no overhead rows               │  Rail     │
│                                               │  (on      │
│   ⚠ Keyword mode active  [Set up →]           │  select)  │
│                                               │           │
│   [●Knowledge] [●Memory] [●Judgment]          │           │
└───────────────────────────────────────────────┴───────────┘
```

**Net gain: ~96 px of vertical canvas space. Zero redundancy. Single interaction point for filtering.**

---

## 15. Open Questions / Decisions Needed

| # | Question | Suggested default |
|---|----------|------------------|
| Q1 | Should "Insights" or "Pulse" be the tab label? | **Insights** — more descriptive to new users |
| Q2 | Should the Disputes section inside Insights always be rendered (with empty state) or truly hidden? | **Hidden when count = 0** — keeps the surface clean |
| Q3 | Should the Knowledge tab default-select the first KB automatically? | **Yes** — avoids empty right panel on load |
| Q4 | Should Layer filter chips "Warnings" and "Gaps" always be visible or only appear when there are relevant nodes? | **Only when relevant** — reduces noise |
| Q5 | Should the gear icon open a drawer or navigate to a dedicated `/brain/config` page? | **Drawer** — keeps context, no navigation needed |
| Q6 | Where do "Highest Confidence Atoms" and "Stale Review Queue" live in the new layout? | **Inside BrainDetailRail as advanced sections**, accessible only when inspecting atoms |
