# Workflow Page Redesign
## Three-Tab Model: Canvas / Runs / Output

> **Status:** Design spec — May 2026
> **Scope:** `WorkflowCanvasPage.tsx`, new `WorkflowRunsTab.tsx`, new `WorkflowOutputTab.tsx`
> **Mental model:** Workflow = execution primitive. App = accumulation shell.

---

## Mental Model

```
Workflow                           App
────────────────────────           ────────────────────────
Execution primitive                Accumulation shell
Run it → see what it produced      Stores data across runs
Ephemeral output                   Persistent surfaces + Brain + Deploy
Self-contained                     Wraps workflows as domains
```

The workflow page only needs to answer two questions:
1. **What has this workflow run?** (Runs tab)
2. **What did it produce?** (Output tab)

It does NOT need: surface declarations, Brain tab, Deploy tab. Those belong at the App level. If a workflow accumulates enough purpose that it needs all of those, the signal is: **wrap it in an app.**

---

## Diagnosis: What the Current Page Lacks

| Gap | Impact |
|---|---|
| After `POST /run`, user is immediately navigated to `/runs/:runId` | The canvas context is lost; every run is a page hop |
| Run history lives at `/history` — not scoped to this workflow | To see "did this workflow run successfully last time?", the user must leave the page and search |
| Last run output is in `RunDrawer` — a bottom slide-over | Reviewing the result requires expanding a drawer while the canvas is still in view; awkward for anything beyond a 2-node workflow |
| No way to see records a `data_write` node has been accumulating | For standalone research/ETL workflows, the output rows are invisible unless a parent app owns a Data tab |

---

## The Three-Tab Structure

```
/workflows/:id

+------------------------------------------------------------------------+
|  <- Workflows   {Workflow title}   {save-state}         [Run v] [...]  |
+------------------------------------------------------------------------+
|  [Canvas]  [Runs]  [Output]                                            |
+------------------------------------------------------------------------+
|  {tab content}                                                         |
+------------------------------------------------------------------------+
```

Tabs are query-param driven (`?tab=canvas|runs|output`), matching the pattern established in `AppDetailPage` and `AgentDetailPage`. Default tab: `canvas`.

---

## Tab 1 — Canvas

**No change.** The existing `CanvasEngine` + `NodePalette` + `ContextInspector` + `AgentFocusOverlayManager` layout stays exactly as it is.

The only behavioral change: after `runWorkflow()` succeeds, **do not navigate to `/runs/:runId`**. Instead:
1. Open the `RunDrawer` as currently (for live node-by-node progress on the canvas)
2. After run completes, switch to `?tab=output` automatically
3. Keep the canvas URL (`/workflows/:id?tab=output`) — no page hop

This keeps the operator in context. They built the workflow, ran it, and land on the output without leaving the URL.

---

## Tab 2 — Runs

Run history scoped to this workflow. Currently this information is scattered in `/history`.

### Layout

```
+------------------------------------------------------------------------+
|  RUNS                                         [Run now]                |
|  Last 30 days                                                          |
+------------------------------------------------------------------------+
|  {status}  {relative time}         {duration}  {trigger}  [View →]    |
|  ● completed  2min ago              4.3s        manual                 |
|  ● completed  3h ago                6.1s        webhook                |
|  ✕ failed     yesterday             1.2s        cron       [Retry]     |
|  ● completed  2 days ago            5.0s        manual                 |
|  ● completed  3 days ago            4.8s        manual                 |
+------------------------------------------------------------------------+
|  [Load more]                                                           |
+------------------------------------------------------------------------+
```

### Run row anatomy

```
{status-dot}  {status-label}   {relative-time}   {duration}   {trigger-type}   [View]
```

| Field | Source |
|---|---|
| Status dot | `run.status` — green pulse for running, green solid for completed, red for failed |
| Relative time | `run.startedAt` — "2min ago", "3h ago", "yesterday" |
| Duration | `(run.finishedAt - run.startedAt)` in ms → formatted as "4.3s" / "1m 12s" |
| Trigger type | `run.triggeredBy` — "manual" / "cron" / "webhook" / "event" |
| [View] | Navigates to `/runs/:runId` (RunDetailPage) for full ledger/story view |
| [Retry] | Only on failed runs — `POST /v1/workflows/:id/runs/from-node` or re-run with same inputs |

### Data source

`GET /v1/workflows/:id/runs?limit=30` — scoped to this workflow, sorted by `startedAt DESC`.

This endpoint likely needs to be added or confirmed in the API (current workflow routes expose health analytics but not a direct run list by workflow — see codebase map §4). If unavailable, fall back to `GET /v1/runs?workflowId={id}&limit=30`.

### Realtime

Subscribe to workspace room; listen to `RUN_CREATED | RUN_RUNNING | RUN_COMPLETED | RUN_FAILED` and prepend new runs at the top of the list with a slide-in animation.

---

## Tab 3 — Output

Two sections, second is conditional:

### Section A — Last Run Result (always shown)

```
+------------------------------------------------------------------------+
|  LAST RUN  ● completed  2min ago  4.3s                    [View run]   |
+------------------------------------------------------------------------+
|                                                                        |
|  {output-card}                                                         |
|                                                                        |
|  The output of the final node, rendered as a result card.             |
|  If the final node is a response node → show the text content.        |
|  If the final node is a table node → show the records it wrote.       |
|  If the final node is an agent_task → show the agent's final output.  |
+------------------------------------------------------------------------+
```

**Output rendering rules** (based on last completed node's output):

| Final node kind | Rendered as |
|---|---|
| `response` | Plain text card with `whitespace-pre-wrap`, font-mono for code blocks |
| `agent_task` | Agent output card — same `ThreadCard` component used in `AppThread` (kind: result) |
| `table` / `data_write` | Record preview grid — first 5 rows, key columns |
| `scratchpad` | Raw JSON inspector (collapsible tree) |
| `checkpoint` | "Run paused at checkpoint" notice with resume button |
| `router` | "Branched to: {target-node-label}" |
| Any else | Raw JSON in a code block |

If no run has ever completed: an empty state:
```
No output yet. Run this workflow to see what it produces.
[Run now]
```

### Section B — Accumulated Records (conditional)

**Shown only when:** the workflow's graph contains at least one node with `config.kind === 'data_write'`.

```
+------------------------------------------------------------------------+
|  ACCUMULATED RECORDS                                  [Clear] [Export] |
|  Written by data_write nodes across all runs of this workflow.        |
+------------------------------------------------------------------------+

|  {table-name}  {N} records                           [View all →]      |
|  ┌──────────┬───────────┬─────────────┬──────────────────────────┐    |
|  │ field 1  │ field 2   │ field 3     │ createdAt                │    |
|  ├──────────┼───────────┼─────────────┼──────────────────────────┤    |
|  │ value    │ value     │ value       │ 2min ago                 │    |
|  │ value    │ value     │ value       │ 3h ago                   │    |
|  │ value    │ value     │ value       │ yesterday                │    |
|  └──────────┴───────────┴─────────────┴──────────────────────────┘    |
|  Showing 3 of 47 records.  [Load more]                                 |
+------------------------------------------------------------------------+
```

**Multiple `data_write` nodes:** one record browser section per target table, stacked vertically.

**[View all →]:** Navigates to a standalone table record viewer or the parent app's Data tab if this workflow belongs to an app.

**[Export]:** `GET /v1/table-records?workflowId={id}&table={tableName}&format=csv`

**[Clear]:** Confirms then deletes all records written by this workflow to this table. Uses `DELETE /v1/table-records?workflowId={id}&table={tableName}`.

**No duplication concern:** When this workflow lives inside an App, the App's Data tab already shows these records at the app scope. The workflow Output tab shows them at workflow scope (filtered by `workflowId`). Same records, different filter. The App owns accumulation; the workflow shows its contribution.

---

## Run Button Behavior Change

Currently:
```ts
nav(`/runs/${res.runId}`);  // ← page hop, canvas context lost
```

New behavior:
```ts
setActiveRunId(res.runId);
setDrawerOpen(true);     // show live progress overlay on canvas
// when run completes (RUN_COMPLETED event):
setDrawerOpen(false);
setTab('output');        // switch to output tab — no navigation
```

The `RunDrawer` remains as the live progress view during execution. Once the run ends, it closes and Output auto-shows the result. The user never leaves `/workflows/:id`.

---

## What This Page Does NOT Get

Per the mental model, the following are explicitly excluded:

| Feature | Belongs at |
|---|---|
| Surface declarations | App level only |
| Brain tab | App level only |
| Deploy config | App level only |
| Persistent data storage | App level (workflow writes to app's tables) |
| Thread / conversation | App Brain (app-scoped) or workspace Orchestrator |

---

## Promotion Path: Workflow → App

When a standalone workflow has been running for a while and the operator wants persistent surfaces, Brain, and Deploy config, they "promote" it to an App:

```
[...] menu → Wrap in App
```

This creates an App manifest with:
- The workflow as the first domain
- A new `app_brain` agent scoped to the app
- The workflow's accumulated `data_write` tables become the app's Data layer

The workflow itself is unchanged — it becomes one of the app's domains. All its historical runs remain in the Runs tab.

> This promotion flow is out of scope for this spec but should be listed as a future action item.

---

## Files to Create / Modify

### New files

| File | Purpose |
|---|---|
| `apps/web/src/components/workflows/WorkflowRunsTab.tsx` | Runs tab — scoped run history with realtime prepend |
| `apps/web/src/components/workflows/WorkflowOutputTab.tsx` | Output tab — last run result renderer + conditional accumulated records browser |
| `apps/web/src/components/workflows/RunOutputCard.tsx` | Renders a single run's final node output based on node kind |
| `apps/web/src/components/workflows/WorkflowRecordBrowser.tsx` | Mini record browser for `data_write` accumulated rows — one instance per table |

### Modified files

| File | Change |
|---|---|
| `apps/web/src/pages/WorkflowCanvasPage.tsx` | Add tab query-param state; wrap current canvas in tab conditional; add `[Runs]` and `[Output]` tabs; change `runWorkflow()` to not navigate — instead open `RunDrawer`, listen for `RUN_COMPLETED`, switch to output tab |

### API — confirm or add

| Endpoint | Status |
|---|---|
| `GET /v1/workflows/:id/runs?limit=30` | Needs confirmation — workflow health routes exist but scoped run list may not |
| `GET /v1/table-records?workflowId=&table=&limit=` | Likely needs adding — app-scoped table queries probably exist but `workflowId` filter may not |
| `DELETE /v1/table-records?workflowId=&table=` | New endpoint |

---

## Accessibility

| Component | Requirement |
|---|---|
| Tab bar | `role="tablist"` — matches existing pattern from `Tabs` shared component |
| Run row status dot | `aria-label="{status} — {relative time}"` |
| Output section | `role="region"` `aria-label="Last run output"` |
| Record browser | `role="grid"` with `aria-rowcount` |
| [Run now] empty state CTA | Focused automatically when Output tab opens with no data |

---

## Implementation Log — 2026-05-16

> **Status:** Implemented · first integration · all checks green.

This section records the actual implementation, including gaps found in the
spec and how they were resolved.

### What was built

**Frontend (`apps/web`)**

| File | Status | Notes |
|---|---|---|
| `components/workflows/runFormat.ts` | Pre-existing (kept) | `formatDuration`, `relativeTime`, `WorkflowRunSummary` type. |
| `components/workflows/RunOutputCard.tsx` | Pre-existing (kept) | Node-kind-aware output renderer. Already covered `agent_swarm` + `table` beyond the spec table. |
| `components/workflows/WorkflowRecordBrowser.tsx` | Pre-existing (kept) | Per-table record grid with Load more / View all / Export / Clear. |
| `components/workflows/WorkflowRunsTab.tsx` | **New** | Tab 2 — scoped run history, realtime refresh, Retry on failed runs, Load more pagination. |
| `components/workflows/WorkflowOutputTab.tsx` | **New** | Tab 3 — Last Run Result (Section A) + conditional Accumulated Records (Section B). Focuses the empty-state CTA for a11y. |
| `pages/WorkflowCanvasPage.tsx` | **Modified** | Added the three-tab model + the post-run hand-off. |

**Backend (`apps/api`)**

The redesign endpoints were already present in `routes/workflows.ts` (added in
a prior commit) and correctly wired in `bootstrap.ts` with the `appData`
dependency. They were verified, not rewritten:

- `GET /v1/workflows/:id/runs?limit=` — scoped run history.
- `GET /v1/workflows/:id/output` — final-node output of the latest completed run.
- `GET /v1/workflows/:id/records` — accumulated `data_write` tables.
- `GET /v1/workflows/:id/records/:table?limit=&offset=` — paginated browse.
- `GET /v1/workflows/:id/records/export?table=` — CSV export.
- `DELETE /v1/workflows/:id/records?table=` — clear one table.

### Gaps found & how they were closed

1. **Spec endpoint shapes differed from reality.** The spec proposed
   `GET /v1/table-records?workflowId=` and a CSV `format=csv` query. The
   codebase instead nests record access under the workflow resource
   (`/v1/workflows/:id/records...`) and returns CSV as a JSON `{ filename, csv }`
   payload that the client turns into a Blob download. The frontend was built
   to the **actual** API surface, not the spec's hypothetical one.

2. **Pre-existing API type error.** `buildFinalNodeOutput()` in
   `routes/workflows.ts` accessed `pool[0]` without narrowing, failing
   `tsc` with `TS18048: 'winner' is possibly 'undefined'`. Fixed with an
   explicit `if (!winner) return null;` guard.

3. **No `success` color token.** The spec calls for a green "completed" dot.
   The design system has no `success` color — `accent` (#4ade80) *is* the
   green. Status dots use `bg-accent` (completed), `bg-accent animate-pulse-dot`
   (running), `bg-danger` (failed), `bg-warn` (pending), `bg-text-muted`
   (cancelled).

4. **Canvas state preservation across tabs.** Unmounting the canvas on tab
   switch would drop React Flow's internal state and detach the
   `AgentFocusOverlayManager` (its attach effect runs once with `[]` deps).
   Resolved by keeping the canvas **always mounted** and toggling visibility
   with a `hidden` class; only the Runs/Output tabs mount conditionally.

5. **Realtime payload filtering.** The workspace-room `RUN_*` events carry
   `{ runId, status, workflowId }` (`RUN_CREATED` carries `workflowId` too).
   The Runs tab filters by `workflowId`; the canvas post-run hand-off filters
   by `runId === activeRunId`.

6. **`Retry` on failed runs.** The spec floated a `runs/from-node` endpoint
   that does not exist. Retry uses the spec's stated fallback — a fresh
   `POST /v1/workflows/:id/run` — then navigates to the new run.

### Behavioral changes

- **No more page hop on run.** `runWorkflow()` no longer calls
  `nav('/runs/:runId')`. It opens the live `RunDrawer` on the canvas; when the
  `RUN_COMPLETED` / `RUN_FAILED` event for the active run arrives, the drawer
  closes and the page switches to `?tab=output` — all within `/workflows/:id`.
- **Tabs are query-param driven** (`?tab=runs|output`; `canvas` omits the
  param), matching `AgentDetailPage`. Default is `canvas`.

### Verification

- `tsc --noEmit` — clean for both `apps/web` and `apps/api`.
- `vite build` — web bundle builds (`WorkflowCanvasPage` chunk included).
- `apps/api/tests/routes/workflows.test.ts` — **15/15 passing**, including 5
  new tests covering `/runs`, `/output`, and `/records`.
- Web dev server smoke test — app mounts with no console errors.
- Not exercised: the live in-browser workflow page (requires a running API,
  auth, and a seeded workflow) — covered indirectly by the build + API tests.

### Follow-ups (out of scope)

- "Wrap in App" promotion flow (spec §Promotion Path) — still a future action.
- Realtime currently does a debounced refetch rather than an animated
  per-row slide-in prepend; functionally correct, animation deferred.
