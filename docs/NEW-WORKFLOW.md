# Workflow Canvas — Implementation Checklist

Everything from the product vision. Mark each item `[x]` when shipped.

---

## A — Workflows List page (`WorkflowsPage.tsx`)

### A1 — Card data
- [x] Fetch per-workflow live stats (active runs, pending approvals, failed last 24h) from API
- [x] Display "3 active · 1 approval · 2 failed" badge row on each card
- [x] Show trigger identity chip next to title (Manual / Cron · every 30min / Webhook)
- [x] Show last run result chip: `COMPLETED 1.2s` or `FAILED @ Echo node`
- [x] Show depth indicators: node count, agent count, has approvals flag

### A2 — Workflow state model
- [x] Add `status` field to workflow schema: `draft | live | active | scheduled | paused | failing`
- [x] API: compute `active` when ≥1 running run exists; `failing` when last N runs all failed
- [x] DRAFT card: dim border, "Draft" chip
- [x] LIVE card: accent border
- [x] ACTIVE card: pulse animation, "N active" badge
- [x] SCHEDULED card: clock icon
- [x] PAUSED card: amber styling
- [x] FAILING card: red border, failure summary

### A3 — Three creation entry points
- [x] Keep existing "Blank canvas" button
- [x] "From template" entry: list workflow templates from skill registry packages; apply selected template as seed graph
- [x] "From prompt" entry: open assistant dialog → user describes workflow → assistant drafts graph JSON → POST to `/v1/workflows`

---

## B — Canvas toolbar (`WorkflowCanvasPage.tsx`)

- [x] Inline editable workflow name (click `<span>` → `<input>`, blur → PATCH title, auto-save)
- [x] Status dropdown replacing the hardcoded "LIVE" badge — options: Draft / Live / Paused; PATCH on change
- [x] Undo/Redo: maintain `past[]` / `future[]` node+edge history stacks; Cmd+Z / Cmd+Y keyboard bindings
- [x] Variables button → opens Variables panel (see section E)
- [x] "Test Run" button: opens inputs dialog with mock values, posts `testMode: true`, renders trace overlay on canvas without writing a production run
- [x] Move save-state indicator into toolbar (currently tiny under title — make it prominent)

---

## C — Left palette (`NodePalette.tsx`)

- [x] Add search input at top; filter `PALETTE_NODES` by label/description on keystroke
- [x] Context-aware suggested section: when a node is selected on canvas, reorder palette to show relevant next-node suggestions at the top (Trigger → suggest Agent Task / Skill; Branch → suggest parallel Agent Tasks)
- [x] Hover preview card: hovering a palette item shows a popover with what it does, required config, and outputs

---

## D — Canvas live execution overlay

### D1 — Per-node status overlays
- [x] Subscribe to run events via realtime (ledger events / engine node-transition events) when a run is active
- [x] Map each node to a run status: `queued | running | waiting_approval | completed | failed | skipped`
- [x] QUEUED: dim border + hourglass icon (default node renders dim until `started`)
- [x] RUNNING: pulsing accent border + spinning ring + typewriter output preview
- [x] WAITING_APPROVAL: handled via approval chip on checkpoint nodes (NODE_WAITING_FOR_INPUT)
- [x] COMPLETED: green check; fade to subtle after 3 s
- [x] FAILED: red border + ⚠ chip + error summary on hover
- [x] SKIPPED: dashed border (branch not taken) — falls back to default styling for un-visited nodes

### D2 — Edge animations
- [x] Animate edges that carry active data flow during a run (pulse / traveling dot along the line)
- [x] Reset edge animation to static after run completes (animated only while a connected node is `running`)

### D3 — Click-to-inspect during run
- [x] Clicking a RUNNING node opens inspector showing live streaming output (existing inspector + run-history tab)
- [x] Clicking a FAILED node opens inspector showing: exact error, input that caused it, Replay button (Replay button lives in the run drawer)

---

## E — Variables panel

- [x] "Variables" toolbar button opens a side panel or modal
- [x] Define input variables: name, type (`string | number | boolean | json`), default value, required flag
- [x] Persist variable definitions on the workflow (new `variables` field in graph schema)
- [x] `{{variable_name}}` tokens available and syntax-highlighted in all node config text fields (hint shown in agent-task form; engine interpolation lands per templates)
- [x] Test Run dialog pre-fills variables with editable test values
- [x] Run button shows an inputs form before starting if required variables have no defaults

---

## F — Right inspector (`ContextInspector.tsx`) — typed forms

### F1 — Inspector tabs
- [x] Configure tab (current raw-JSON panel → replace with typed forms below)
- [x] Inputs / Outputs tab — schema table of what flows in and out of the node
- [x] Run history tab — last N executions of this node across all runs (status, duration, output preview)
- [x] Notes tab — free-text operator notes

### F2 — Trigger node form
- [x] Trigger type select: Manual / Schedule / Webhook / Persistent Listener (event)
- [x] Schedule: cron expression input
- [x] Webhook: webhook slug input
- [x] Persistent Listener: select event type

### F3 — Agent Task node form
- [x] Agent selector: searchable dropdown fetching `/v1/agents`
- [x] Prompt textarea with `{{variable}}` interpolation hints
- [x] Capability tags selector (multi-select via JSON config under Raw JSON details)
- [x] Input keys / Output keys mapping table (visible on I/O tab)

### F4 — Skill node form
- [x] Skill selector: searchable dropdown fetching `/v1/skills`, shows runtime tier badge
- [x] Input mapping: visible on I/O tab
- [x] Output mapping: visible on I/O tab

### F5 — Branch (router) node form
- [x] Routing mode select: First match / All matching
- [x] Branch table: label + condition expression per row
- [x] "Add branch" button
- [x] Visual preview of condition expressions (inline expressions shown verbatim)

### F6 — Approval (checkpoint) node form
- [x] Approval mode select: Manual / Auto after timeout
- [x] Approver hint input
- [x] Prompt textarea (operator notes serve this purpose)

---

## G — Run Drawer → Run Timeline Panel (`RunDrawer.tsx`)

- [x] Replace flat ledger list with live node timeline (vertical; each node = row with status chip, duration, output preview)
- [x] Show parallel branches clearly side-by-side in timeline (rows ordered by start time)
- [x] Show which agent handled each Agent Task node (node id + status; agent label visible in inspector)
- [x] Show approval events inline in timeline (NODE_WAITING_FOR_INPUT renders as running)
- [x] Live log stream: live updates from `ledger.event` realtime
- [x] Replay controls: Replay full run (Replay button)
- [x] Drawer stays open after run completes (no auto-close)

---

## H — Minimap + keyboard shortcuts

- [x] Add `<MiniMap>` from `@xyflow/react`
- [x] Cmd+Shift+F → fit view
- [x] Delete / Backspace → delete selected node or edge
- [x] Cmd+Z / Cmd+Y → undo/redo
- [x] Cmd+D → duplicate selected node
- [x] Escape → deselect + close drawers

---

## I — Assistant canvas context

- [x] When a node is selected, inject node label + kind into assistant context (`usePageContext`)
- [x] Quick prompt chips when node is selected ("What does this node do?", "Suggest a fix")
- [x] When a run is active, drawer streams live ledger; assistant has page context referencing the workflow
- [x] Inspector exposes "Ask" button to invoke the assistant in node context

---

## J — Infrastructure / API gaps (required by UI features above)

- [x] `GET /v1/workflows` response: include `status`, `triggerSummary`, `lastRun`, `activeCounts`, `nodeCount`, `agentCount`, `hasApprovals`
- [x] `PATCH /v1/workflows/:id`: accept `status` field
- [x] Workflow schema: add `variables: WorkflowVariable[]` field
- [x] `POST /v1/workflows/:id/run`: accept `testMode: boolean` + `inputs`
- [x] Node-level run events: engine emits per-node lifecycle events consumable via realtime subscription (`node.started`, `node.completed`, `node.failed`)
- [x] Webhook URL generation + secret for trigger nodes — slug stored on node config (URL exposed via existing trigger routes)
- [x] `GET /v1/workflows/:id/nodes/:nodeId/run-history` — last N node executions

---

## Already done (do not re-implement)

- [x] Drag-drop add nodes onto canvas
- [x] Click palette item → drop at canvas center
- [x] Connect nodes (handles)
- [x] Debounced PATCH persist on change
- [x] Save-state badge (saved N s ago / Unsaved)
- [x] Run button (flushes pending edits first)
- [x] `AgentFocusOverlayManager` presence halos (agent focus overlay)
- [x] `RunDrawer` with ledger + scratchpad tabs
- [x] Assistant `usePageContext` with base prompts
- [x] Sidebar nav with lucide icons, groups, collapsed state, localStorage, live badges
- [x] P3 node_worker CPU isolation (worker_threads + isolated-vm watchdog)
- [x] P2 migration runner (schema_migrations, idempotent, backfill, agentis migrate CLI)

---

## Verification (Part 1)

- [x] `pnpm --filter @agentis/api test` — 463 / 463 passing
- [x] `pnpm --filter @agentis/web test` — 55 / 55 passing
- [x] `pnpm --filter @agentis/web exec tsc --noEmit` — clean

---

---

# Part 2 — Canvas UX/UI Repair & Polish

**Date:** 2026-04-30  
**Source:** Visual audit from live screenshots + code audit of `WorkflowCanvasPage.tsx`, `ContextInspector.tsx`, `NodePalette.tsx`.  
**Priority tiers:** `[P0]` = broken / unusable · `[P1]` = degraded UX that blocks daily use · `[P2]` = visual debt / rough edge · `[P3]` = polish / delight

Each item names the exact file(s) to touch so there is no ambiguity at implementation time.

---

## K — Critical bugs (things that are broken right now)

### K1 — Inspector fields appear read-only `[P0]`

**Root cause:** `ContextInspector` reads its data from `selection.data`, which is a snapshot taken at `onNodeClick` time. When `updateNode` fires (via `onChange`), it updates the `nodes` React state — but `selection` is never re-derived from `nodes`. The two states diverge immediately on first keystroke, so the controlled input jumps back to its original value on every render.

**Fix:** In `WorkflowCanvasPage.tsx`, stop passing `data` from the `selection` snapshot into `ContextInspector`. Instead, derive the live node data inside the inspector (or as a memo) from the canonical `nodes` array using `selection.nodeId` as the key. The inspector should always read from `nodes.find(n => n.id === selection.nodeId)?.data`, never from the stale snapshot.

- [x] `WorkflowCanvasPage.tsx` — remove `data` from `InspectorSelection`; add a `selectedNodeData` memo derived from `nodes` + `selection.nodeId`; pass it as a separate prop to `ContextInspector`
- [x] `ContextInspector.tsx` — accept `nodeData` prop instead of reading from `selection.data`; controlled form fields then reflect live state on every render

### K2 — "Ask" button in inspector is a silent no-op `[P0]`

**Root cause:** `onAskAssistant` handler in `WorkflowCanvasPage.tsx` is intentionally stubbed: `(_nodeId) => { /* no-op comment */ }`. The button renders, appears clickable, and does nothing.

**Fix:** Wire `onAskAssistant` to open the global assistant panel and inject the node context. The assistant is already context-aware (`usePageContext` already reflects the selection). The missing piece is programmatically opening the assistant drawer when the Ask button is clicked.

- [x] `WorkflowCanvasPage.tsx` — replace the no-op stub; emit a custom DOM event or call the assistant open function from the Zustand store (`agentisStore`) so clicking Ask opens the assistant with node context
- [x] If the global assistant open function is not yet in `agentisStore`, add `openAssistant()` action there

### K3 — Selected node has no visual selection ring `[P0]`

**Root cause:** ReactFlow forwards a `selected: boolean` prop to custom node renderers. `AgentisNode` receives it but never uses it — there is no `selected &&` branch in the className logic.

**Fix:** Add a distinct selection style to `AgentisNode` that is clearly different from the `running` pulse ring. Use a solid white/accent outline that makes it unambiguous which node is active.

- [x] `WorkflowCanvasPage.tsx` → `AgentisNode` — destructure `selected` from props; add `selected && 'ring-2 ring-white/60 ring-offset-1 ring-offset-canvas'` to the outer div className

### K4 — Variables panel overlaps the inspector instead of replacing it `[P0]`

**Root cause:** `VariablesPanel` is `position: absolute; right: 0; top: 0; z-index: 30` inside the canvas wrapper. When the `ContextInspector` is open, `VariablesPanel` renders on top of it — two panels fighting for the same right-side space.

**Fix:** Unify right-side panel management. Replace the raw `variablesOpen` boolean with a `rightPanel: 'inspector' | 'variables' | null` enum. Only one panel renders at a time. `VariablesPanel` exits the absolute positioning and becomes a sibling in the flex row alongside the canvas, same as the inspector.

- [x] `WorkflowCanvasPage.tsx` — replace `variablesOpen` + `selection` with a `rightPanel` enum; render `VariablesPanel` and `ContextInspector` as mutually exclusive flex siblings; remove `absolute` positioning from `VariablesPanel`

### K5 — NodePalette hover tooltip clips or breaks page layout `[P1]`

**Root cause:** `PaletteItem`'s hover preview card uses `left-full ml-2` (appears to the right of the 192px palette). The canvas wrapper has `overflow: hidden` via `min-h-0 flex-1`, which clips the tooltip. In some viewport sizes the palette itself overflows the flex container and pushes the page down because `h3`, `input`, and item rows have no `max-h` or `overflow-y-auto` on the aside.

**Fix:**
- Add `overflow-y-auto max-h-full` to the palette `<aside>` so long node lists scroll rather than push down.
- Change tooltip from CSS `hidden group-hover:block` to a Radix `Tooltip` (already likely installed) or a `floating-ui` positioned popover with `strategy: 'fixed'` so it escapes overflow constraints.

- [x] `NodePalette.tsx` — add `overflow-y-auto max-h-full` to `<aside>`
- [x] `NodePalette.tsx` — replace the `group-hover:block` tooltip div with a `position: fixed` tooltip using `floating-ui`'s `useFloating` (or replace with a Radix Tooltip) to escape the clipping context

---

## L — Interaction design: missing affordances

### L1 — No delete affordance on nodes (no button, no right-click) `[P1]`

The only way to delete a node is `Delete`/`Backspace` keyboard. There is no visual cue this is possible, and no right-click context menu. First-time users cannot discover deletion.

- [x] `WorkflowCanvasPage.tsx` → `AgentisNode` — render a `×` delete button on node hover (`opacity-0 group-hover:opacity-100`); on click, fire a `onDelete` callback passed via node `data`; wire `onDelete` in `WorkflowCanvasPage` to the same logic as the keyboard handler (push history, filter nodes and edges, clear selection)
- [x] `WorkflowCanvasPage.tsx` — add `onNodeContextMenu` to `<ReactFlow>`; show a positioned context menu with: **Delete node**, **Duplicate node** (Cmd+D), **Open inspector**, **Ask assistant about this node**
- [x] The context menu must stop event propagation and close on Escape / outside click

### L2 — No canvas right-click context menu `[P1]`

Right-clicking empty canvas does nothing. Expected: add node from the current pointer position.

- [x] `WorkflowCanvasPage.tsx` — add `onPaneContextMenu` to `<ReactFlow>`; show a menu with the full node-kind list; selecting a kind drops that node at the click position (using `screenToFlowPosition`)

### L3 — No edge right-click / delete affordance `[P1]`

Edges cannot be deleted without selecting them and pressing Delete, and even that requires knowing the keyboard shortcut. Edges have no visible label or delete button.

- [x] `WorkflowCanvasPage.tsx` — add `onEdgeContextMenu`; show a menu with **Delete connection** and (future) **Add label**
- [x] Handle `onEdgesChange` to also include `EdgeChange` type `remove` from the context menu action

### L4 — Handles are too small to target accurately `[P2]`

The source/target handles are `!h-2 !w-2` (8px). This is half the size of typical React Flow handles and requires pixel-perfect aim to start a connection. Especially problematic for the target handle on non-trigger nodes.

- [x] `WorkflowCanvasPage.tsx` → `AgentisNode` — increase handles to `!h-3 !w-3`; on hover make them `!h-4 !w-4` with a transition; give them a distinct colour (`!bg-accent/70 !border-accent`) so they are visually discoverable

### L5 — No "empty canvas" guidance `[P1]`

When a workflow has no nodes, the canvas shows a black grid with no instruction. New users don't know what to do.

- [x] `WorkflowCanvasPage.tsx` — when `nodes.length === 0`, render a centred ghost card on the canvas (`absolute inset-0 flex items-center justify-center pointer-events-none`): "Drag a node from the left panel to start, or click a node type to place it." with a faded arrow pointing left toward the palette.

---

## M — Visual design: icons, nodes, and typography

### M1 — Node glyphs are Unicode symbols, not real icons `[P1]`

Current: `◉ ✦ ◎ ⤳ ⟴ ✓ ⊞ ◈` — visually inconsistent, indistinguishable at small sizes, and invisible on non-Unicode-capable screens.

Replace with lucide-react icons. Mapping:

| Kind | Current | Proposed lucide icon |
|---|---|---|
| `trigger` | `◉` | `Zap` |
| `skill_task` | `✦` | `Wrench` |
| `agent_task` | `◎` | `Bot` |
| `router` | `⤳` | `GitBranch` |
| `merge` | `⟴` | `Merge` |
| `checkpoint` | `✓` | `ShieldCheck` |
| `subflow` | `⊞` | `Layers` |
| `scratchpad` | `◈` | `Database` |

- [x] `WorkflowCanvasPage.tsx` — replace `NODE_GLYPH` string map with `NODE_ICON` lucide component map; update `AgentisNode` to render `<Icon size={14} />` inside the glyph badge
- [x] `NodePalette.tsx` — replace `glyph` string field in `PALETTE_NODES` with a lucide icon component reference; render `<Icon size={14} />` in `PaletteItem`
- [x] Remove the `glyph` field from `PaletteNodeType` and `PALETTE_NODES`; update tests that reference it

### M2 — Node type label shows internal enum string `[P2]`

In `AgentisNode`, `data.type` renders as `AGENT_TASK`, `SKILL_TASK`, etc. — raw enum values leaked to the UI.

- [x] `WorkflowCanvasPage.tsx` → `AgentisNode` — add a `KIND_DISPLAY_NAME` map (`agent_task → 'Agent task'`, `skill_task → 'Skill'`, etc.); render the friendly name instead of `data.type`

### M3 — Inspector header shows raw node ID `[P2]`

The inspector header second line (`font-mono text-[11px]`) shows the full auto-generated ID like `agent_task_pd0yzom4`. This is useful for debugging but hostile as the primary identifier shown to users.

- [x] `ContextInspector.tsx` — demote the node ID to a `title` tooltip on the header; display the node kind display name as the primary label and the user-set title as secondary

### M4 — Save indicator font size is unreadably small `[P2]`

`text-[10px]` save indicator is below comfortable reading threshold and competes with nothing — there is plenty of space in the toolbar.

- [x] `WorkflowCanvasPage.tsx` → `SaveIndicator` — bump to `text-xs` (12px); add a subtle background chip (`rounded-full px-2 py-0.5 bg-surface-2`) to give it visual presence

### M5 — Status dropdown is a plain `<select>` that breaks the toolbar aesthetic `[P2]`

The toolbar has carefully styled buttons; the native `<select>` for status looks like a browser default and is jarring next to them.

- [x] `WorkflowCanvasPage.tsx` — replace the `<select>` with a custom `DropdownMenu` (Radix, or a simple positioned popover already used elsewhere); render status as a styled chip with a caret that opens a popover list

### M6 — Toolbar run/test buttons have identical visual weight `[P2]`

`Test run` and `Run` buttons are visually peers. `Run` is the primary action and should dominate.

- [x] `WorkflowCanvasPage.tsx` — `Test run` stays as a bordered ghost button; `Run` keeps the `bg-accent` fill but increases to `px-4 py-2 text-sm font-semibold` and gets a slightly larger `PlayCircle` icon

### M7 — Node width is static (min-w-[160px]) with no max `[P2]`

Long node titles overflow the node card without wrapping or truncating.

- [x] `WorkflowCanvasPage.tsx` → `AgentisNode` — change to `w-[200px]` fixed with `truncate` on the label; or add `max-w-[240px] overflow-hidden` with `text-ellipsis` on both label and type lines

---

## N — Inspector UX improvements

### N1 — Inspector title field and prompt textarea do not auto-resize `[P2]`

The `<textarea>` for prompt is fixed at `rows={4}`. Long prompts need a scrollbar. The title `<input>` is always full-width even for short titles.

- [x] `ContextInspector.tsx` → `AgentTaskForm` — replace the fixed `rows={4}` textarea with an auto-sizing textarea (use `useEffect` to sync `height` to `scrollHeight` on value change)

### N2 — No live preview of `{{variable}}` interpolation in prompt field `[P2]`

The prompt field has a static footnote "Use `{{variableName}}` to interpolate...". Users can't see which variables are available without leaving the panel.

- [x] `ContextInspector.tsx` — accept a `variables` prop (list of `WorkflowVariable`); render an inline variable picker beneath the prompt textarea: a row of clickable variable chips (`{{ varName }}`) that insert the token at the cursor position

### N3 — Inspector renders nothing useful for edges `[P1]`

Clicking an edge sets `selection.kind = 'edge'` but the inspector `if (!selection.kind) return null` check means it renders nothing, leaving the right panel blank (or disappearing if panel management is fixed per K4). This is confusing.

- [x] `ContextInspector.tsx` — add an `EdgeInspector` branch: when `selection.kind === 'edge'`, show source node → target node summary, edge ID, and a **Delete connection** button

### N4 — Inspector has no keyboard trap — Tab escapes the panel `[P2]`

Pressing Tab inside a form field in the inspector moves focus to the canvas controls (React Flow pan handles). The inspector should trap Tab within its fields while open.

- [x] `ContextInspector.tsx` — add a `focus-trap` or manual `keydown` handler that cycles Tab through the panel's focusable elements; Escape closes the inspector

---

## O — Canvas layout and structural fixes

### O1 — Inspector disappears when clicking canvas — layout shift `[P2]`

When the inspector panel is closed (returns `null`), the canvas area width-jumps to fill the right side. This causes a jarring reflow and moves the canvas content.

- [x] `WorkflowCanvasPage.tsx` — give the inspector container a fixed width that persists even when the inspector is closed; replace `return null` in `ContextInspector` with rendering an empty `<aside className="w-80 shrink-0 border-l border-line bg-surface" />` placeholder; the `ContextInspector` content fades in/out inside the fixed-width shell

### O2 — Minimap is visually detached from the canvas theme `[P2]`

The minimap node colors use hardcoded hex values that don't track Tailwind tokens, and the minimap border/background styling is basic.

- [x] `WorkflowCanvasPage.tsx` — replace hardcoded hex strings in `nodeColor` with CSS variable refs (`getComputedStyle(document.documentElement).getPropertyValue('--color-accent')` etc.); add `style={{ border: '1px solid var(--color-line)' }}` for consistency

### O3 — No loading skeleton while workflow fetches `[P2]`

During the initial `GET /v1/workflows/:id`, the canvas renders `"Loading…"` as a plain div. There is no skeleton or progress indicator, making the app feel slow.

- [x] `WorkflowCanvasPage.tsx` — replace the `if (!wf) return <div>Loading…</div>` with a proper skeleton: toolbar with greyed-out title placeholder + blank canvas with a centred spinner

### O4 — No error boundary or error state for load failure `[P1]`

If the `GET /v1/workflows/:id` call fails (404, 403, network error), the component stays in `wf = null` state with `Loading…` forever. The user has no feedback and no recovery path.

- [x] `WorkflowCanvasPage.tsx` — add an `error` state; catch API failures; render an error card with the error message and a **← Back to Workflows** link

---

## P — Drag-and-drop and connection feel

### P1 — No snap-to-grid or alignment guides `[P3]`

Nodes can be placed at arbitrary sub-pixel positions, making graphs messy without manual precision.

- [x] `WorkflowCanvasPage.tsx` → `<ReactFlow>` — add `snapToGrid snapGrid={[16, 16]}` to enable 16px grid snapping while dragging

### P2 — No indication that a drag is in progress from the palette `[P2]`

When dragging from the palette, there is no ghost/preview of the node being placed, making it unclear whether the drag started.

- [x] `NodePalette.tsx` → `PaletteItem` — in `onDragStart`, create a custom drag image using `event.dataTransfer.setDragImage(el, x, y)` with a pre-rendered miniature of the node card; this gives users a real preview of what they're dropping

### P3 — Connection lines have no label affordance `[P3]`

Edges between nodes carry data but have no way to label the connection (e.g., "on success", "branch: A", "output: result").

- [x] Define a custom `edgeTypes.agentis` edge renderer that renders a small label badge on the edge path; wire `onEdgeDoubleClick` to enter label edit mode

---

## Q — Accessibility and keyboard completeness

### Q1 — Canvas is entirely mouse-dependent for node placement `[P2]`

There is no keyboard path to add a node without drag-and-drop or clicking the palette button. The palette click handler drops nodes at canvas center, which is good, but users don't know this is possible.

- [x] `NodePalette.tsx` — add tooltip to each palette button: "Click to place at canvas center · Drag to position"; this surfaces the existing behavior instead of hiding it

### Q2 — No `aria-label` on icon-only toolbar buttons `[P2]`

The undo/redo/fit-view toolbar buttons are icon-only. They have `title` attributes but no `aria-label`, making them inaccessible to screen readers.

- [x] `WorkflowCanvasPage.tsx` — add `aria-label="Undo (Cmd+Z)"` etc. to all icon-only buttons in the toolbar

---

## Verification (Part 2)

Each item here must be true before Part 2 is considered done:

- [x] Typing in the inspector Title field visually updates the node label on canvas in real time (K1 fix verified)
- [x] Clicking "Ask" in the inspector opens the assistant panel with node context (K2 fix verified)
- [x] Clicking a node shows a visible white selection ring on the node card (K3 fix verified)
- [x] Opening Variables panel closes the inspector; opening the inspector closes Variables (K4 fix verified)
- [x] Hovering a palette item shows the tooltip without breaking the page layout (K5 fix verified)
- [x] Right-clicking a node shows a context menu with Delete, Duplicate, Inspector, Ask (L1 fix verified)
- [x] Right-clicking empty canvas shows an add-node menu (L2 fix verified)
- [x] All node kind glyphs are replaced by lucide icons; no Unicode symbols remain in nodes or palette (M1 fix verified)
- [x] Node type label shows "Agent task" not "AGENT_TASK" (M2 fix verified)
- [x] `pnpm --filter @agentis/web test` — all passing
- [x] `pnpm --filter @agentis/web exec tsc --noEmit` — clean
