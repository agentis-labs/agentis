# UIUX-REPLAN Implementation Audit

> **Date:** May 2026
> **Scope:** Every user complaint from the original feedback mapped to code.
> **Method:** Source file reads, grep verification, cross-referencing against UIUX-REPLAN.md.

---

## Legend

| Symbol | Meaning |
|--------|---------|
| **DONE** | Fully implemented and verified in code |
| **PARTIAL** | Core intent addressed but specific sub-feature missing |
| **NOT DONE** | Not implemented |

---

## /general

| # | Complaint | Status | Evidence |
|---|-----------|--------|----------|
| G1 | Sidebar has global visualization, not organized by spaces | **DONE** | `Sidebar.tsx:219-293` — SPACES section with colored dots, app counts, collapsible group, inline "New space" creation. Each space links to `/apps?space={id}`. |
| G2 | Notifications show UUIDs like "ec8ff114-6db7-4ac5-b027-4ad0a7879066" | **DONE** | `NotificationPanel.tsx:65-66` — Human-readable titles: "Approval needed" + workflow/agent name + timestamp. No UUIDs. |
| G3 | Notification badge opens transparent list | **DONE** | `NotificationPanel.tsx:184-186` — Opaque `bg-surface`, `border border-line`, `shadow-dropdown`. Fully styled. |
| G4 | Notifications have no inline approve/reject actions | **DONE** | `NotificationPanel.tsx:226-240` — Inline Approve/Reject buttons for approvals, Retry/View run for failures. |
| G5 | Theme toggle shows wrong state (bright when actually dark) | **DONE** | `ThemeToggle.tsx:40-76` — Reads from `document.documentElement.classList` + OS `prefers-color-scheme`. Tracks `effective` theme separately from stored preference. Tooltip says "currently {effective}". |
| G6 | No theme option in header (only shows text, no toggle) | **DONE** | `AvatarMenu.tsx:92-97` — Full ThemeToggle (Light/Dark/System) inside avatar dropdown. Also in Settings > Profile. |
| G7 | Sidebar should collapse automatically in strategic moments | **DONE** | `Sidebar.tsx:30,78-83` — Subscribes to `useChatPanelStore`; auto-collapses when `chatState === 'docked'`. |

---

## /chat

| # | Complaint | Status | Evidence |
|---|-----------|--------|----------|
| C1 | Creating a room has no option to add agents | **DONE** | `RoomCreateDialog.tsx:108-170` — Agent multi-select with checkboxes. Agents sent via `agentIds[]` in POST body. |
| C2 | Chat keeps old workspace data when switching workspaces | **DONE** | `ChatPanel.tsx:24-36` — Polls workspace ID every 1000ms, calls `resetForWorkspace()` on change (clears thread + unread). |
| C3 | No option to delete or edit messages | **PARTIAL** | `ThreadView.tsx:240-258` — Per-message hover actions include **Copy** and **Delete** (with confirmation). **No edit** functionality. |
| C4 | Textbox area is extremely small | **DONE** | `ThreadView.tsx:75-78,173-174,187` — Auto-growing textarea via `autosize()`, max height 120px. Grows dynamically as user types. |
| C5 | No connect button when agent has no adapter | **DONE** | `ThreadView.tsx:147-163` — Warning banner with "Connect →" button navigating to `/agents/{id}?tab=connections`. Textarea disabled when no adapter. |
| C6 | Chat context only works for page, not components or inner pages | **NOT DONE** | ChatPanel.tsx/ChatPanelStore.ts show no page-context awareness. Chat is a generic room/agent panel. It does not know which page or component the user is currently viewing. |
| C7 | No full-page chat option | **DONE** | `ChatPage.tsx` exists with routes `/chat` and `/chat/agent/:agentId`. Full-screen two-column layout. ChatPanel suppressed on `/chat` via `onChatPage` check in Shell. |

---

## /home

| # | Complaint | Status | Evidence |
|---|-----------|--------|----------|
| H1 | No environment selector | **DONE** | `TopBarPills.tsx:36-98` — `AmbientSelector` component fetches ambients from workspace, renders dropdown in header. Mounted in Shell at `App.tsx:242`. |
| H2 | Says "everything looks good" when workflows are stuck | **DONE** | `HomePage.tsx:200-218` — Greeting reflects actual state: pending approvals count, running agents count, failures. Uses conditional messages like "things need your attention" or "runs are working". Never lies. |
| H3 | Chat input should follow Perplexity model | **DONE** | `HomePage.tsx:267-349` — Recipient pill selector dropdown + clean auto-grow textarea + send button + suggestion chips computed from live workspace state. Matches Perplexity interaction model. |
| H4 | Scroll transitions are harsh, no smooth divisions | **DONE** | `HomePage.tsx:357` — Gradient fade div with `section-fade-gradient` class between hero section and activity content. Defined in `styles.css` as a bottom-to-transparent gradient. |
| H5 | "Active Platform" section is a nightmare | **DONE** | `HomePage.tsx:352-507` — Old "Active Platform" completely replaced. New sections: "Needs Attention" (approval cards with inline Approve/Reject, failed run cards), "Live Right Now" (active run cards with progress), "Recently Built" (artifact thumbnail grid). |

---

## /agents

| # | Complaint | Status | Evidence |
|---|-----------|--------|----------|
| A1 | No grouping by space | **DONE** | `AgentsPage.tsx:129-135` — Agents grouped by `spaceId` into a Map. Groups rendered with space header (name, colored dot, count). |
| A2 | Constellation component is useless | **DONE** | `AgentsPage.tsx:4` — Comment: "constellation view is killed (per UIUX-REPLAN §7.2)". `AgentConstellation.tsx` deleted. Replaced with Grid/Table toggle (`AgentsPage.tsx:83-92,164-187`). |
| A3 | Agent creation modal is terrible | **DONE** | `AgentCreateWizard.tsx:134-263` — 2-step guided flow. Step 1: image upload + name + description + space selector. Step 2: adapter card grid (4 types) + model input. Progress bar. Clean, minimal, inspired by design references. |
| A4 | Config page is confusing with interpolated info | **DONE** | `AgentDetailPage.tsx:191-196` — 5 purpose-driven tabs: Overview, Instructions, Memory, Connections, History. Each tab has a clear single responsibility. No interpolation. |
| A5 | Instructions page wrong — should show harness files (soul.md, agents.md, etc.) | **DONE** | `AgentDetailPage.tsx:239-356` — Fetches from `/v1/agents/:id/instructions`, renders file list with editable textarea. Falls back to `systemPrompt` if endpoint unavailable. Files come from harness/agent, not hardcoded. |
| A6 | Playground is useless — delete it | **DONE** | `AgentDetailPage.tsx:191-196` — No playground tab. Tabs are: overview, instructions, memory, connections, history. |
| A7 | Avatar glyph and color should be replaced with image | **DONE** | `AgentsPage.tsx:341-359`, `AgentDetailPage.tsx:158-166`, `AgentCreateWizard.tsx:151-165` — Image-first avatars with initials fallback. No glyph picker, no color picker. Image upload in create wizard and detail page. |
| A8 | Memory should show agent-native + platform memories | **DONE** | `AgentDetailPage.tsx:358-427` — Memory tab with source filter ('all' / 'agent' / 'platform'). Fetches from `/v1/agents/:id/memory`. Displays entries with source labels and visual indicators. |
| A9 | "Ledger" naming still appears | **DONE** | All "Ledger" references replaced with "History". Tab label is "History" at `AgentDetailPage.tsx:196`. |

---

## /workflow

| # | Complaint | Status | Evidence |
|---|-----------|--------|----------|
| W1 | Saved to library without confirmation, no undo | **DONE** | `WorkflowCanvasPage.tsx:232-243` — `handlePublish('library'/'reusable')` opens confirmation dialog with clear title and body explaining the action before proceeding. |
| W2 | Should auto-save | **DONE** | `WorkflowCanvasPage.tsx:159-182` — 30-second debounce auto-save via `queueSave()`. Manual save on ⌘S. Save on unmount. `SaveIndicator` shows "Saved ·" / "Saving…" / "Unsaved" (red dot) / "Save failed". |
| W3 | Create workflow flow doesn't make sense — should be prompt or template | **DONE** | `WorkflowCreateDialog.tsx:82-141` — Three-path creation: prompt textarea (AI-first), "Start from scratch" button, "Use a template" tab with template list. |
| W4 | No grouping, no organization | **DONE** | `WorkflowsPage.tsx:114-129` — Workflows grouped by `spaceId` into a Map. Rendered with space headers (name, colored dot, count). "Ungrouped" fallback. |
| W5 | Cards are horrible, no sophistication | **DONE** | `WorkflowsPage.tsx:242-294` — Status is first visual signal (color-coded dot). Cards show: name, trigger type with icon, status badge, last run result inline, single contextual CTA (Open for healthy, Retry for failed). |
| W6 | Can't toggle minimap off | **DONE** | `WorkflowCanvasPage.tsx:90-92,294-305` — Minimap toggle button in toolbar. State persisted to `localStorage` via `agentis.canvas.minimap` key. |
| W7 | Chat breaks the UI when opened | **DONE** | `Sidebar.tsx:78-83` — Sidebar auto-collapses when chat docks, giving canvas more space. Canvas uses `flex min-h-0 flex-1` layout that adapts to available width. |
| W8 | Node config is raw JSON, not editable, placeholder quality | **NOT DONE** | `ContextInspector.tsx:46-57` — Still renders a read-only `<pre>` tag with `JSON.stringify(selection.data)`. **No form-based editing. No editable JSON toggle. No save action.** This is still the V1 placeholder. |
| W9 | Deploy button unclear — deploy where? | **DONE** | `WorkflowCanvasPage.tsx:320-327` — "Publish" dropdown with 4 explained options: "Deploy to schedule" (with description), "Deploy as webhook", "Save to library", "Mark as reusable". Each has icon + title + description. |
| W10 | Run variable prompt is unclear and inflexible | **DONE** | `WorkflowCanvasPage.tsx:416-486` — `RunInputDialog` explains "The trigger expects these inputs:", shows variables with type hints as placeholders, "Or leave empty to use defaults." |
| W11 | Tab order changes chaotically | **DONE** | New design uses `FilterBar` with fixed filter options (`WorkflowsPage.tsx:41-46`). No reorderable tabs. Tab order is static. |
| W12 | Workflow health and run history have terrible UI | **DONE** | Old health/run-history sections removed. Workflow cards now show status + last run inline. Run detail is a separate page (`RunDetailPage`) with Story/Technical modes. |
| W13 | Subflow not working | **PARTIAL** | `WorkflowCanvasPage.tsx:65` — Subflow glyph exists (`subflow: '⊞'`). "Mark as reusable" publish option exists (line 326). But **no actual subflow insertion UI on canvas** — there's no dropdown to select which workflow to embed as a subflow node. |

---

## /apps

| # | Complaint | Status | Evidence |
|---|-----------|--------|----------|
| AP1 | Gigantic cards with terrible UI | **DONE** | `AppsPage.tsx:103,148,160` — Compact 3-column grid with small cards (p-4, h-10 icons). StatusBadge, version, and single primary metric per card. |
| AP2 | Detail page is a logs audit, not an app experience | **DONE** | `AppDetailPage.tsx:102-104` — Default tab is 'performance' (not activity/logs). Performance tab leads with stat bars, approval cards, and clean run list. |
| AP3 | Apps should show results UI (MUST HAVE feature) | **DONE** | `AppDetailPage.tsx:337-413` — Full Results tab driven by `outputLabels` configuration. Renders table with format support (currency, percent, number). Graceful empty state when outputLabels not configured: "Configure output labels to unlock the Results view." |
| AP4 | Apps should feel like apps, not hacker dashboard | **DONE** | `AppDetailPage.tsx:264-330` — Stat bars in grid layout, inline approval cards with Approve/Reject, clean run cards with StatusBadge and duration. Human-readable formatting. |
| AP5 | Space organization | **DONE** | `AppsPage.tsx:49,77,110` — Space filtering via URL param `?space=`. Active space name displayed. Sidebar spaces link to `/apps?space={id}`. |

---

## /packages

| # | Complaint | Status | Evidence |
|---|-----------|--------|----------|
| P1 | Tables/lines are confusing, made for machines | **DONE** | `PackagesPage.tsx:204-214` — Card-based grid layout (3 columns). No tables. Each card shows icon, name, kind, version, description, action menu. |
| P2 | Delete has no warning or undo | **DONE** | `PackagesPage.tsx:125-141` — Confirmation dialog (title, body, danger tone) + 5-second undo toast with restore action. |
| P3 | Shows templates instead of owned packages | **DONE** | `PackagesPage.tsx:48-49` — Default tab is `'library'`. Line 67 filters: `!p.isTemplate` for library view. Templates are a separate tab. |
| P4 | Import and export icons are swapped | **DONE** | `PackagesPage.tsx:11,151,259,268` — Import = `ArrowDownToLine` (down arrow), Export = `ArrowUpFromLine` (up arrow). Correct. |

---

## /history

| # | Complaint | Status | Evidence |
|---|-----------|--------|----------|
| HI1 | No detailed modal, just useless log lines | **DONE** | `HistoryPage.tsx:22,189-258` — `DetailPanel` slides in from the right when a row is clicked. Shows full event context: what happened, who was involved, duration, linked runId with "View run" button. |

---

## /workspaces

| # | Complaint | Status | Evidence |
|---|-----------|--------|----------|
| WS1 | Poor design and organization | **DONE** | `WorkspacesPage.tsx` — Clean card layout with workspace image, name, stats (agents/workflows/apps count), status badge, Switch to / Manage buttons. |
| WS2 | No option to edit workspace image | **DONE** | `WorkspacesPage.tsx:60-74,137-182` — Click-to-upload + drag-and-drop image area on each workspace card. `handleImageUpload` sends PATCH with FormData. |
| WS3 | Workspace image should appear in header | **DONE** | `App.tsx:233-239` — Shell header shows `workspaceImage` as 20x20 rounded image when uploaded, falls back to initial letter badge. |
| WS4 | Create workspace is terrible | **DONE** | `WorkspacesPage.tsx:206-328` — Clean `CreateWorkspaceDialog` modal with image upload + preview, name input with auto-generated slug, optional description, form validation. |

---

## /runs

| # | Complaint | Status | Evidence |
|---|-----------|--------|----------|
| R1 | Made for machines/hackers, not humans | **DONE** | `RunDetailPage.tsx:232-305` — Story mode (default) with natural-language summary, numbered "What happened" timeline, key results metric grid (4 cards), clickable step inspection. |
| R2 | Should have nerd option for technical details | **DONE** | `RunDetailPage.tsx:162-183,307-357` — Story/Technical toggle in header. Technical view shows sortable stats table, timeline with raw output, node inspector with JSON input/output. |

---

## Summary

| Section | Total Complaints | Done | Partial | Not Done |
|---------|-----------------|------|---------|----------|
| /general | 7 | 7 | 0 | 0 |
| /chat | 7 | 5 | 1 | 1 |
| /home | 5 | 5 | 0 | 0 |
| /agents | 9 | 9 | 0 | 0 |
| /workflow | 13 | 10 | 1 | 1 (W8) |
| /apps | 5 | 5 | 0 | 0 |
| /packages | 4 | 4 | 0 | 0 |
| /history | 1 | 1 | 0 | 0 |
| /workspaces | 4 | 4 | 0 | 0 |
| /runs | 2 | 2 | 0 | 0 |
| **TOTAL** | **57** | **52** | **2** | **2** |

**Completion: 52/57 fully done (91%), 54/57 at least partially done (95%)**

---

## Remaining Work

### NOT DONE (must fix)

1. **W8 — Node config is still raw JSON, not form-based** (`ContextInspector.tsx`)
   - Current: read-only `<pre>` tag with `JSON.stringify()`
   - Needed: form-based config editor per node type, with "View as JSON" advanced toggle that IS editable, and a save button
   - Impact: HIGH — this is the node editing experience on the workflow canvas

### PARTIALLY DONE (should fix)

2. **C3 — Chat message editing** (`ThreadView.tsx`)
   - Current: copy + delete hover actions exist
   - Missing: inline edit functionality (click to edit message text, save changes)
   - Impact: MEDIUM — delete covers the most critical destructive case

3. **W13 — Subflow insertion UI** (`WorkflowCanvasPage.tsx`)
   - Current: subflow glyph and "Mark as reusable" publish option exist
   - Missing: a dropdown/dialog on the canvas to insert a subflow node and select which reusable workflow to embed
   - Impact: MEDIUM — the publish side works but the consume side doesn't

### NOT DONE (acknowledged limitation)

4. **C6 — Chat page-context awareness** (`ChatPanel.tsx`)
   - Current: chat is a generic room/agent panel
   - Needed: chat should understand which page/component the user is viewing and pass that as context
   - Impact: LOW-MEDIUM — the original user feedback said "viewing is working but only for the page, not for components selected or inner pages (context)". This is an advanced feature that requires architecture work beyond UI.

---

## Files Changed

### New files created (28)
- `components/shared/Button.tsx`, `Skeleton.tsx`, `ThemeToggle.tsx`, `NotificationPanel.tsx`
- `components/shared/AvatarMenu.tsx`, `SearchInput.tsx`, `FilterBar.tsx`, `DetailPanel.tsx`, `Tabs.tsx`
- `components/chat/ChatPanelStore.ts`, `ChatPanelHeaderButton.tsx`, `ChatPanel.tsx`
- `components/chat/RoomList.tsx`, `ThreadView.tsx`, `RoomCreateDialog.tsx`
- `components/agents/AgentCreateWizard.tsx`
- `components/workflows/WorkflowCreateDialog.tsx`
- `pages/HomePage.tsx`, `ChatPage.tsx`, `AppsPage.tsx`, `AppDetailPage.tsx`
- `pages/PackagesPage.tsx`, `HistoryPage.tsx`, `RunDetailPage.tsx`
- `pages/WorkspacesPage.tsx`, `SettingsPage.tsx`

### Major rewrites (12)
- `App.tsx` — complete route map + Shell redesign
- `Sidebar.tsx` — 5 items + Spaces + auto-collapse
- `tailwind.config.js` — full design token system
- `styles.css` — scrollbar, skeleton, gradient, reduced motion
- `AgentsPage.tsx`, `AgentDetailPage.tsx` — grid/table + tabs
- `WorkflowsPage.tsx`, `WorkflowCanvasPage.tsx` — grouping + auto-save + toolbar
- `Toast.tsx`, `ConfirmDialog.tsx`, `EmptyState.tsx`, `StatusBadge.tsx`, `Drawer.tsx`

### Dead code removed (16 files)
- `components/agents/AgentDetailPanel.tsx`, `AgentFleetTable.tsx`, `TerminalPane.tsx`
- `components/assistant/Assistant.tsx`
- `components/channels/ConnectionForm.tsx`, `ConnectionRow.tsx`
- `components/conversations/ConversationInput.tsx`, `ConversationList.tsx`, `ConversationMessageRow.tsx`, `ConversationThread.tsx`
- `components/gateways/GatewayAgentMap.tsx`, `GatewayConnectionForm.tsx`, `GatewayStatusCard.tsx`
- `components/GatewayDetailPanel.tsx`
- `components/runs/RunHistoryTable.tsx`, `RunInspector.tsx`

### Old pages deleted (previously staged)
- `ActivityPage.tsx`, `AgentFleetPage.tsx`, `ApprovalsPage.tsx`, `ConversationsPage.tsx`
- `FleetOverviewPage.tsx`, `GatewaysPage.tsx`, `RunHistoryPage.tsx`, `SettingsChannelsPage.tsx`, `SkillsPage.tsx`
