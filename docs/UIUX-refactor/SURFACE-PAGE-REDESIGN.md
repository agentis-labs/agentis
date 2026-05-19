# Surface Page Redesign
## App Detail — Surface Tab

> **Status:** Design spec — May 2026
> **Scope:** Complete redesign of `AppDispatchSurface` and the Surface tab in `AppDetailPage`
> **Trigger:** Platform 10x audit — the current Surface is app-agnostic, empty-state broken,
> and makes the workspace Orchestrator the primary interaction instead of the App Brain.

---

## Diagnosis: What's Wrong Now

| Problem | Impact |
|---|---|
| App-agnostic layout — "Morning Work Brief", "Delivered Work" could be any app | Operator cannot orient; no sense of what *this specific app* does or has done |
| Empty = broken — empty state looks identical to a failed or abandoned app | Loss of operator confidence before the first run |
| No live domain status — running agents, active swarms, and scheduled cycles are invisible | Operator must open Canvas to know if the app is working |
| Orchestrator Handoff as primary CTA — composer routes through the workspace agent | Creates a dependency loop; wrong agent owns the conversation |
| Generic signals panel — "Runs: 0, Success: —" carries no business signal | No leads count, no conversion rate, no spend — nothing the operator actually cares about |

---

## Design Principles

1. **App-aware from manifest** — layout adapts from declared `domains` and `dataTables`; a leads-centric app looks different from a migration-centric app
2. **Always alive** — domain status pulses in real time; data records stream in; the feed is never just an empty box
3. **Approval-first** — pending human decisions surface at the top of the page, never buried below the fold
4. **App Brain owns the thread** — the operator talks to the app's internal Brain, not the workspace Orchestrator; "Continue in workspace chat" is a small secondary escape hatch, not the primary CTA
5. **Unified timeline** — thread messages, run progress cards, and data record cards all live in one chronological feed; the operator does not need to reconcile two separate panels

---

## Layout Architecture

```
+-----------------------------------------------------------------------+
|  APP HEADER (slim, always visible)                                    |
|  <- Apps  [Icon] SDR Engine   active  3 running   [Surface][Canvas]  |
|            v2.1 . Signal Det. -> Research -> Response -> Intelligence |
+-----------------------------------------------------------------------+

+-----------------------------------------------------------------------+
|  DOMAIN STATUS STRIP (horizontal, live-updating)                      |
|                                                                        |
|  [*] Signal Detection    [~] Research & Outreach   [o] Response       |
|   RUNNING                 IDLE (12 queued)           IDLE             |
|   47 signals/15min        3 swarm agents last run     2 replies today  |
|                                                                        |
|  [>] Intelligence Loop                                                 |
|   SCHEDULED next: 02:00                                                |
|   Brain absorbed 4 patterns last cycle                                 |
+-----------------------------------------------------------------------+

+-----------------------------------------------------------------------+
|  ACTION INBOX (only when non-empty)                                   |
|  ! NEEDS YOUR INPUT . 2 items                                         |
|  +----------------------------------------------------------+         |
|  | Deploy to production?   Migration passed 100% tests      |         |
|  | [Approve]  [Reject]     Validation & Deploy . 4min ago   |         |
|  +----------------------------------------------------------+         |
+-----------------------------------------------------------------------+

+--------------------------------------------------+--------------------+
|  WORK FEED (70%)                                 |  SIGNALS (30%)     |
|                                                  |                    |
|  [run_a3f1] Signal Detection . 2min ago          |  LEADS THIS WEEK   |
|  Completed . 3 new leads                         |  47                |
|  +----------------------------------------------+|  CONVERSION RATE   |
|  | ACME Corp . hiring_surge . high priority      ||  12.4% /\         |
|  | stage: new . last_contacted_at: never         ||                   |
|  +--------------------------------------[View]--+|  LAST OUTREACH     |
|                                                  |  4min ago          |
|  [run_b7c2] Research & Outreach . 8min ago       |                   |
|  Completed . Message sent to ACME Corp           |  AVG SENTIMENT     |
|  +----------------------------------------------+|  0.74 positive     |
|  | outreach_log . linkedin . Jane Smith / ACME   ||                   |
|  | sentiment: neutral . channel: linkedin        ||  -- BUDGET --      |
|  +--------------------------------------[View]--+|  $0.42 today       |
|                                                  |  $12 / $50         |
|  -- APP BRAIN CONVERSATION --                    |  [====      ] 24%  |
|                                                  |                    |
|  [Brain] Signal detection found 3 new prospects  |                   |
|  from LinkedIn hiring signals. Research swarm    |                   |
|  is running in parallel (~4min).                 |                   |
|                                                  |                    |
|  [You]  Pause outreach to ACME Corp              |                   |
|                                                  |                    |
|  [Brain] Done. ACME Corp added to exclusion      |                   |
|  list. Pending outreach task cancelled.          |                   |
|                                                  |                    |
|  +------------------------------------------+   |                    |
|  | Tell SDR Engine what to do next...  [->] |   |                    |
|  +------------------------------------------+   |                    |
|                                                  |                    |
|  [Continue in workspace chat ->]                 |                    |
|  (small link, 12px, below composer)              |                    |
+--------------------------------------------------+--------------------+
```

---

## Component Specifications

### 1. App Header

```
[Icon]  {App Name}   {status-dot} {STATUS}   {deploy-badge}
         v{version} . {N} workflows . {N} agents . ${cost} this month
```

- Status dot pulses green/amber when any domain is actively running
- `active · 3 running` replaces `Active` when concurrent domains are live
- Deploy badge: `always_on` shows a continuous ring, `api_server` shows a plug icon, `scheduled` shows a clock
- Settings gear opens the Config section inline (no separate tab navigation)

---

### 2. Domain Status Strip

One card per domain declared in the app manifest. Cards are horizontal, scroll
horizontally on narrow viewports.

```
+-----------------------------------+
|  {trigger-icon}  {domain-name}    |
|  {status-dot}  {STATUS}           |  RUNNING / IDLE / SCHEDULED / ERRORED
|  {last-action-summary}            |  "3 leads detected" / "next: 02:00"
+-----------------------------------+
```

**Status rules:**

| Status | Dot | Label | Summary |
|---|---|---|---|
| Running | amber pulse | RUNNING | "{N} tasks active" |
| Idle | grey | IDLE | last action time + count |
| Scheduled | blue | SCHEDULED (next: {time}) | next trigger countdown |
| Errored | red | ERRORED | "failed {N}min ago" |

**Trigger icons derived from manifest:**

| Trigger type | Icon |
|---|---|
| `persistent_listener` | radar/signal |
| `data_event` | loop arrow |
| `cron` | clock |
| `webhook_receiver` | webhook arrow |
| `api` | hexagon/endpoint |

**Interaction:** clicking a chip expands an inline panel showing the last run's
node log. No navigation away from the Surface tab.

---

### 3. Action Inbox

Renders only when `pendingApprovals.length > 0`. This is the highest-urgency
component on the page.

```
+-----------------------------------------------------------------------+
|  ! NEEDS YOUR INPUT . {N} item(s)                                     |
|  +-------------------------------------------------------------------+|
|  | {workflow} . {relative-time}                                       ||
|  | {checkpoint-title}                                                 ||
|  | {checkpoint-summary}                                               ||
|  |                                   [Approve v]   [Reject x]        ||
|  +-------------------------------------------------------------------+|
+-----------------------------------------------------------------------+
```

**Safety rules:**
- Approve: `bg-accent` (green fill, high affordance)
- Reject: `border-danger text-danger` (outline only — conservative default, harder to misclick)
- `aria-label` includes checkpoint title: `aria-label="Approve: Deploy to production?"`
- No auto-dismissal — approvals persist until explicitly resolved
- Min touch target 44×44px on both buttons

---

### 4. Work Feed

The single most important surface change. The feed is a **reverse-chronological
timeline** merging three event types into one scroll:

**a) Run completion card**
```
+-- [{status}] {domain-name} . {relative-time} ----------------------------+
|  {outcome}: {N} records written . ${cost}                               |
|  +-----------------------------------------------------------------------+
|  |  {table-name} record preview — most relevant fields, top 4-5        |
|  |  {field1}: {value}   {field2}: {value}   {field3}: {value}          |
|  +-----------------------------------------------------------[View ->]--+
+--------------------------------------------------------------------------+
```

**b) Data record card** (emitted by every `data_write` node)
```
+-- {table-name} . {relative-time} ----------------------------------------+
|  via {workflow-name}                                                      |
|  {field1}: {value}   {field2}: {value}   {field3}: {value}              |
|  {field4}: {value}   {field5}: {value}                                   |
+----------------------------------------------------------[View in Data ->]+
```

Fields are ordered by schema position, not alphabetically. Long text values
truncate with expand-on-click. Max 5 fields shown inline.

**c) Running swarm card** (for `agent_swarm` nodes in progress)
```
+-- {agent_swarm} running . {domain-name} ----------------------------------+
|  {spinner}  Cartographer scanning /src/components — agent 8/20          |
|  +-- v /api scanned . 234 deps mapped                                    |
|  +-- v /lib scanned . 67 deps mapped                                     |
|  +-- {spinner} /components scanning...                                   |
|  +-- o 17 remaining                                                      |
|                                                         [Cancel run]     |
+--------------------------------------------------------------------------+
```

**d) App Brain conversation messages** (inline in the same feed)

Thread messages from the operator and App Brain appear as chat bubbles
chronologically between run cards. The feed IS the thread. No separate
"conversation" panel.

**Feed ordering:** strictly by `createdAt` descending. New events prepend at the
top with a subtle slide-in animation.

---

### 5. App Brain Composer

```
+----------------------------------------------------------+
|  Tell {App Name} what to do next...              [-> Send]|
+----------------------------------------------------------+
  Ctrl+Enter to send

  [Continue in workspace chat ->]
```

- The placeholder uses the app's name, not a generic "Send a message"
- `[Continue in workspace chat ->]` is a small text link (12px, `text-text-muted`)
  that navigates to `/chat` with the orchestrator's chat pre-loaded and the
  app's context passed as an initial draft (e.g., `"I'm working with {App Name}…"`)
- This replaces the current "Orchestrator Handoff" section entirely
- No separate card, no robot avatar, no "SURFACE" badge — just a small link below the composer

**Navigation target for the link:**
```
/chat?context=app&slug={app.slug}&appName={app.name}
```
The chat page reads these params and pre-populates the orchestrator composer with
an app context preamble so the conversation picks up where the Surface left off.

---

### 6. Signals Panel (right sidebar, sticky)

Auto-generated from the app's declared `dataTables` and live run data. No
manual configuration required.

```
+------------------------------------------+
|  SIGNALS                                 |
|  ----------------------------------------|
|  {derived-label-1}                       |
|  {aggregated-value}    {trend-arrow}     |
|                                          |
|  {derived-label-2}                       |
|  {aggregated-value}    {trend-arrow}     |
|                                          |
|  ----------------------------------------|
|  RUNS TODAY                              |
|  {N}       SUCCESS {pct}%               |
|                                          |
|  ----------------------------------------|
|  BUDGET                                  |
|  ${cost} . {%} of ${cap}                |
|  [============================    ] {%}  |
|                                          |
|  ----------------------------------------|
|  DEPLOY                                  |
|  {deploy-target-badge} . since {date}    |
+------------------------------------------+
```

**Signal derivation rules (from manifest `dataTables`):**

| Table field detected | Derived signal | Aggregation |
|---|---|---|
| `leads` table | "Total Leads" | `count(*)` |
| `outreach_log.sentiment` | "Avg Sentiment" | `avg(sentiment)` |
| `ad_campaigns.spend` + `.budget` | "Spend Today" | `sum(spend)` vs `sum(budget)` |
| `tickets` + `status` field | "Open Tickets" | `count(status='open')` |
| `test_results.pass_count` | "Tests Passing" | latest `pass_count / (pass + fail)` |
| `customers.churn_risk` | "High Churn Risk" | `count(churn_risk > 0.7)` |

Clicking any signal navigates to the Data tab pre-filtered to that table.

---

## State Variations

### Empty State (new app, zero runs)

Replace "No delivered artifacts yet / MORNING WORK BRIEF" with a purposeful
setup checklist:

```
+-----------------------------------------------------------------------+
|  SETUP CHECKLIST                                                      |
|  This app needs a few things before it can run.                       |
|                                                                        |
|  [v] App installed                                                    |
|  [v] Data tables provisioned (leads, outreach_log, objections)        |
|  [x] Entry workflow not connected          [Open Canvas ->]           |
|  [x] No agents connected                  [Connect agent ->]          |
|  [x] Trigger not active                   [Set up trigger ->]         |
+-----------------------------------------------------------------------+

+-----------------------------------------------------------------------+
|  WHAT THIS APP DOES                                                   |
|  {app.description from manifest}                                      |
|                                                                        |
|  DOMAINS:                                                              |
|  Signal Detection -> Research & Outreach -> Response -> Intelligence  |
+-----------------------------------------------------------------------+

+-----------------------------------------------------------------------+
|  SEND FIRST INSTRUCTION                                               |
|  +----------------------------------------------------------+        |
|  | Start with a manual trigger or describe your target...  |        |
|  +-------------------------------------------------- [->] -+        |
|                                                                        |
|  [Continue in workspace chat ->]                                      |
+-----------------------------------------------------------------------+
```

Key improvement: empty state tells the operator *exactly what's missing and
where to fix it*. No "No delivered artifacts yet" dead-end copy.

### Running State

- Domain strip shows animated amber pulse on active domain chips
- Work feed shows live swarm progress cards at the top
- Slim banner inside the feed: "{N} domains running" (not a modal, not a floating bar)
- Composer remains active; operator can interrupt or redirect mid-run

### Error State

- Failed domain chip turns red with "ERRORED" label
- Error card pinned to top of work feed with node failure detail
- Signals panel shows "Last success: {N} hours ago" in amber
- Action inbox may surface a retry prompt if `selfHeal` is exhausted

---

## Orchestrator Handoff → Workspace Chat Link

**Current (remove):**
```
ORCHESTRATOR HANDOFF
Ask the orchestrator to operate Social Listening
[full textarea composer]
[Continue in orchestrator]   <- primary green CTA
```

**New (replace with):**
```
[Continue in workspace chat ->]
```

A single small text link, 12px, `text-text-muted`, placed directly below the
App Brain composer. It navigates to the workspace orchestrator's chat with the
app context pre-loaded as an initial draft message. No card, no composer, no
avatar, no bold header.

The mental model is clean:
- **App Brain** (inside Surface) = how you talk to *this app*
- **Workspace Chat** (link escape hatch) = how you escalate to the *workspace-level orchestrator*

They are separate entities. The Surface never shows both composers side by side.

---

## Accessibility

| Component | Role | Behavior |
|---|---|---|
| Domain chip | `role="status"` `aria-live="polite"` | Status updates announced to screen readers |
| Action inbox | `role="region"` `aria-label="Action required"` | Landmark for quick keyboard navigation |
| Approve button | `aria-label="Approve: {checkpoint title}"` | Context-rich label, not just "Approve" |
| Reject button | `aria-label="Reject: {checkpoint title}"` | Same pattern |
| Running indicator (pulse) | `aria-label="{domain} is running"` | Animated pulse has text equivalent |
| Composer | `aria-label="Send instruction to {app name}"` | App-specific placeholder |

All interactive elements: minimum 44×44px touch target. Focus ring: `ring-2 ring-accent ring-offset-2 ring-offset-canvas`. Approvals never auto-dismiss.

---

## Files to Create / Modify

### New files

| File | Purpose |
|---|---|
| `apps/web/src/components/apps/AppDomainStrip.tsx` | Domain chip row — subscribes to `DATA_RECORD_CHANGED` + `APP_WORKFLOW_COMPLETED` events |
| `apps/web/src/components/apps/AppWorkFeed.tsx` | Unified timeline — thread messages + run completion cards + data record cards |
| `apps/web/src/components/apps/AppSignalsPanel.tsx` | Right sidebar — auto-derives metrics from `dataTables` schema + run stats |
| `apps/web/src/components/apps/AppActionInbox.tsx` | Approval queue — extracted from PerformanceTab, promoted to top-level concern |
| `apps/web/src/components/apps/AppSetupChecklist.tsx` | Empty-state onboarding — shown when `runs === 0 && !trigger.active` |

### Modified files

| File | Change |
|---|---|
| `apps/web/src/components/apps/AppDispatchSurface.tsx` | Full rewrite using new sub-components; new 2-column layout |
| `apps/web/src/pages/AppDetailPage.tsx` | Pass `appManifest.domains` + `appManifest.dataTables` to `AppDispatchSurface` |
| `apps/web/src/components/apps/AppThread.tsx` | `ActivityFeed` right panel retired; message stream feeds into `AppWorkFeed` |

---

## A/B Test Plan

| Metric | Current baseline | Target |
|---|---|---|
| Time to first action on a new app | ~4min (setup unclear) | < 90s (checklist visible) |
| Approval resolve rate from Surface | ~40% | > 80% |
| "Continue in workspace chat" clicks vs App Brain usage | Dominant | < 15% of sessions |
| Operator navigates to Canvas just to check status | High | < 10% |

**Variant A** (recommended): Unified feed — thread messages and data record cards interleaved in one timeline.
**Variant B**: Split layout — conversation column left, data record feed right.

Unified (A) is simpler for apps with 1-2 domains. Split (B) scales better for
power users monitoring 4+ domain apps. Ship A by default; add a per-app toggle
stored in localStorage.

---

## Implementation Log — May 2026 (first integration)

> Status: **Implemented end-to-end.** Variant A (unified feed) shipped.
> The per-app A/B toggle was deferred (see *Deferred* below).

### Summary

The Surface tab was rebuilt from an app-agnostic "Morning Work Brief / Delivered
Work / Orchestrator Handoff" layout into the app-aware, always-alive,
approval-first design specified above. The workspace Orchestrator is no longer
the primary CTA — the app's own Brain thread owns the conversation, and the
Orchestrator is a single 12px escape-hatch link.

### Backend changes

| File | Change |
|---|---|
| `apps/api/src/routes/apps.ts` | `loadAppPackage` now also returns `deployTarget` / `deployStatus`. `appDetailFromPackage` returns `domains`, `dataTables`, `deployTarget`, `deployStatus`, `installedAt`. New helpers `domainsFromManifest` (reads `appGraphTemplate.domains`) and `dataTablesFromManifest` (reads manifest `dataTables`, projects to `{name, description, fields[]}`). `detailPayload` prefers the **live canvas graph's** domains via `deps.canvas.load()`, falling back to the manifest template. |
| `apps/api/src/routes/appDeploy.ts` | New endpoint `GET /v1/apps/:id/data/signals` — auto-derives operator-facing signals from the Data layer (the §6 derivation rules: leads count, avg sentiment, spend vs budget, open tickets, tests passing, churn risk, plus a generic per-table fallback) and returns a `recentRecords` feed for the unified work feed. Registered **before** the `/:id/data/:table` wildcard so `signals` is not parsed as a table name. Window-over-window record-creation `trend` is computed for count signals. |
| `apps/api/src/websocket/rooms.ts` | New `subscribe:app` / `unsubscribe:app` socket handlers with workspace-ownership verification against `app_instances`, so the Surface can join the per-app realtime room (`DATA_RECORD_CHANGED`, `APP_WORKFLOW_COMPLETED/_FAILED`). |

### Frontend changes

| File | Change |
|---|---|
| `apps/web/src/lib/realtime.ts` | `rtSubscribe` now accepts the `'app'` room kind. |
| `apps/web/src/components/apps/appSurfaceShared.ts` | **New.** Shared Surface types (`SurfaceApp`, `SurfaceDomain`, `SurfaceDataTable`, `SurfaceRun`, `SurfaceApproval`, `SurfaceSignal`, `SurfaceRecord`, `SurfaceThreadMessage`) and formatting/status helpers (`relativeTime`, `formatMoney`, `resolveDomainStatus`, `domainTriggerType`, `normalizeRunStatus`, …). |
| `apps/web/src/components/apps/AppDomainStrip.tsx` | **New.** §2 — one live status chip per declared domain. Resolves RUNNING / IDLE / SCHEDULED / ERRORED from workflows + triggers, derives the trigger icon (`persistent_listener`→radar, `data_event`→loop, `cron`→clock, `webhook_receiver`→webhook, `api`→hexagon), `role="status" aria-live="polite"`, and expands the last run's node log inline. |
| `apps/web/src/components/apps/AppActionInbox.tsx` | **New.** §3 — pending approvals promoted to the top. `role="region"`, green-fill Approve / danger-outline Reject, context-rich `aria-label`s, 44px touch targets, no auto-dismiss. |
| `apps/web/src/components/apps/AppWorkFeed.tsx` | **New.** §4 + §5 — unified reverse-chronological timeline merging run completion cards, data record cards (schema-ordered, max 5 fields, expand-on-click), running cards (with Cancel run), and App Brain conversation bubbles. Hosts the App Brain composer (app-named placeholder, Ctrl+Enter, `aria-label`) and the small "Continue in workspace chat →" link. |
| `apps/web/src/components/apps/AppSignalsPanel.tsx` | **New.** §6 — sticky right sidebar. Renders derived signals (click → Data tab pre-filtered to that table), runs-today + success rate, a budget bar, and the deploy-target badge. |
| `apps/web/src/components/apps/AppSetupChecklist.tsx` | **New.** Empty-state — a real setup checklist (installed / data tables / entry workflow / agents / trigger) with inline fix actions, plus a "What this app does" panel showing the domain flow. |
| `apps/web/src/components/apps/AppDispatchSurface.tsx` | **Full rewrite.** Orchestrates all data fetching (`/results`, `/thread`, `/data/signals`), realtime patching (workflow + app + run rooms), the App Brain SSE composer send, approval resolution, run cancellation, and the new 2-column layout. Shows `AppSetupChecklist` when the app has no runs / messages / active trigger. |
| `apps/web/src/pages/AppDetailPage.tsx` | `AppDetail` extended with `domains`, `dataTables`, `deployTarget`, `deployStatus`, `installedAt`. `ResultsTab` builds the full `SurfaceApp` and passes `onOpenCanvas` / `onOpenData` callbacks; a new `dataLayerTable` state lets a signal click deep-link the Data tab to a specific table. |
| `apps/web/src/components/app-detail/DataView.tsx` | Accepts an optional `initialTable` prop so signal clicks open pre-filtered. |
| `apps/web/tests/components/AppDispatchSurface.test.tsx` | Rewritten for the new design (skeleton → App Brain composer). |

### Gaps found & fixed along the way

- **App detail API never exposed `domains` / `dataTables`.** The Surface design depends on the manifest's declared domains and Data tables; both are now surfaced (domains preferring the live, operator-edited canvas graph over the static manifest template).
- **No realtime path for the per-app room.** `DATA_RECORD_CHANGED` was already published to `app:<id>`, but no client could join it — added the `subscribe:app` handler and the `'app'` `rtSubscribe` kind.
- **Route-ordering bug caught pre-merge.** `GET /:id/data/signals` would have been swallowed by the `/:id/data/:table` wildcard; reordered so the literal route wins.
- **Deploy metadata** (`deployTarget`, `installedAt`) was needed for the header/Signals deploy badge and was not in the detail payload — added.

### Verification

- `tsc --noEmit` clean for both `apps/web` and `apps/api`.
- `apps/web` — `AppDispatchSurface` and `AppDetailPage` tests pass.
- `apps/api` — `appsCreation`, `approvals`, and `appDataService` suites pass.
- Pre-existing, unrelated test failures on this WIP branch (AgentFleetTable, ApprovalInbox, OnboardingStrip, PendingApprovalsDock, RunInspector, Sidebar, WorkflowCanvas, AgentsPage, HomePage, SettingsChannelsPage) were present before this work and are untouched by it.

### Deferred / notes

- **`AppThread.tsx`** is now orphaned dead code — nothing imports the `AppThread`
  component. The redesign's intent ("ActivityFeed retired; stream feeds into the
  work feed") is fully met by `AppWorkFeed`. `AppThread.tsx` was left in place
  rather than deleted to keep this change scoped; it can be removed in cleanup.
- **A/B per-app layout toggle** (Variant A vs B in localStorage) was not built —
  Variant A ships as the only layout.
- **Running swarm card** shows live run status + Cancel; the granular
  per-agent "8/20" sub-tree from the spec mock is not yet wired (no per-agent
  swarm progress event exists on the bus today).
