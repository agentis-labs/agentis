# CanvasCommandCenter — Implementation Plan

One unified mission-control card at `top-4 left-4` that absorbs `AgentLiveFeed`,
`CanvasTriagePanel`, and the HUD Triage button into a single, always-present surface.

---

## Files affected

| File | Action |
|---|---|
| `apps/web/src/components/home/AgentLiveFeed.tsx` | **Delete** |
| `apps/web/src/components/home/CanvasCommandCenter.tsx` | **Create** (new) |
| `apps/web/src/components/home/WorkspaceEcosystemCanvas.tsx` | **Modify** — swap imports, remove `CanvasTriagePanel` function, wire new card |
| `apps/web/src/components/home/CanvasHudBar.tsx` | **Modify** — add `triageOpen` prop, hide Triage button when `true` |
| `apps/web/src/components/home/useAgentLiveFeed.ts` | **Keep untouched** — reused directly by `CanvasCommandCenter` |

---

## 1. New file: `CanvasCommandCenter.tsx`

### Props interface

```tsx
interface CanvasCommandCenterProps {
  agents: WorkspaceAgent[];
  activeRuns: WorkspaceActiveRun[];
  approvals: WorkspaceApproval[];
  failedRuns: WorkspaceFailedRun[];
  artifacts: WorkspaceArtifact[];
  now: number;                              // passed from parent 1-s clock
  triageOpen: boolean;                      // controlled by parent
  onTriageOpen: () => void;
  onTriageClose: () => void;
  onRefresh: () => void;
  onSelectNode: (nodeId: string) => void;
  onNavigate: (route: string) => void;
}
```

### Internal state

```tsx
type CardMode = 'ambient' | 'live' | 'triage';

// mode derives from props — never manually set:
//   triageOpen=true          → 'triage'
//   triageOpen=false + runs  → 'live'
//   triageOpen=false + empty → 'ambient'
//
// Exception: if approvals.length goes 0→N while mode==='live', auto-escalate
// to 'triage' and call onTriageOpen() so HUD button syncs.

const [collapsed, setCollapsed] = useState(false);
const [resolving, setResolving] = useState<Record<string, boolean>>({});
const [doneSince, setDoneSince] = useState<Record<string, number>>({});
```

### Visual states

**Ambient** (no runs, no approvals, no failed)
```
◉  Ready · N agents idle                             [collapse]
```
Height: 44px. Dot = static grey. Shows only when `agents.length > 0`.
This state is present even if card is "empty" — it's the resting state of the card.

**Live** (active runs present, no attention items)
```
◉  Live · N running                                  [collapse ▲]
──────────────────────────────────────────────────────
  [●] Analyst        ⚡ Step 4/7  ·  2m 14s       [→]
      "Analyze Q3 metrics and write a report…"
      [████████░░░░░░░░]  Writing summary…
──────────────────────────────────────────────────────
  [●] Worker B       ⚡ Step 1/3  ·  18s           [→]
      "Write the blog post intro…"
      [███░░░░░░░░░░░░░]  Planning…
──────────────────────────────────────────────────────
  ✓  Done today · 2 outputs                        [▾]
```
Max card height: `calc(100vh - 200px)` with `overflow-y-auto` on the body.

**Triage** (attention items present OR triggered by HUD button)
```
⚠  1 needs review · 1 running                       [×]
──────────────────────────────────────────────────────
  NEEDS REVIEW
──────────────────────────────────────────────────────
  [⚠] Worker B — Needs approval                   [→]
      "Should I post this to Slack?"
      [✓ Approve]         [✗ Reject]
──────────────────────────────────────────────────────
  [✗] Analyst — Failed: search_web               [↺] [→]
──────────────────────────────────────────────────────
  RUNNING
──────────────────────────────────────────────────────
  [●] Manager        ⚡ Step 3/7  ·  5m 02s       [→]
      "Research competitor landscape…"
      [██████░░░░░░░░░░]  Extracting insights…
──────────────────────────────────────────────────────
  ✓  Done today · 2 outputs                        [▾]
```

### Request card row — anatomy (80px per card)

```
Row 1:  [status dot]  Agent name     [status pill]  elapsed  [→ nav]
Row 2:  "Prompt excerpt up to 60 chars…"            (text-muted, truncated)
Row 3:  [progress bar ████░░░░]  Current step label           (11px)
```

Status dot colors: accent-pulse (running) · amber (waiting) · green (done) · red (failed)

### Status pill values

| Condition | Pill text | Color class |
|---|---|---|
| `run.stepIndex == null` | Queued | `text-text-muted bg-surface-2` |
| `stepIndex === 0` | Planning | `text-indigo-300 bg-indigo-900/30` |
| `stepIndex > 0 && stepIndex < totalSteps` | `Step N/M` | `text-accent bg-accent/10 animate-pulse` |
| `approval` linked to run | Needs review | `text-warn bg-warn/10` |
| run in `failedRuns` | Failed | `text-danger bg-danger/10` |
| run recently completed | `Done · Xm` | `text-success bg-success/10` |

### Prompt text — sessionStorage bridge

`CanvasCommandCenter` reads prompts from sessionStorage. The HomeLauncher writes them.

Key format: `agentis.req.{runId}` → prompt string (max 200 chars).

Fallback chain:
1. `sessionStorage.getItem('agentis.req.' + run.id)`
2. `run.workflowName`

The HomeLauncher write happens in its `send()` function — after the API call returns
the `runId`, write to sessionStorage. If the API returns no runId (e.g. general chat),
skip. Details in **Step 5** below.

### Progress bar

Uses `run.stepIndex` and `run.totalSteps` from `WorkspaceActiveRun`.
Width = `Math.max(4, (stepIndex / Math.max(totalSteps, 1)) * 100)` percent.
Transitions with `transition-all duration-700 ease-out`.

When `stepIndex == null`, render an indeterminate shimmer bar.

### Done-card retention

When a run completes (`RUN_COMPLETED` realtime event), record
`doneSince[run.id] = Date.now()`.
Cards in `done` state are visible for **3 minutes** then removed from render.
This gives the operator satisfying visual feedback without indefinite clutter.

The `now` prop (1-second tick from parent) drives this expiry check:
```tsx
const visibleDone = completedRuns.filter(
  (r) => !doneSince[r.id] || (now - doneSince[r.id]) < 3 * 60_000
);
```

### Sorting order (within each section)

1. Approval-blocked runs (triage)
2. Failed runs (triage)
3. Active runs sorted by `startedAt` ascending (oldest first)
4. Done runs sorted by completion time descending

### Collapse behaviour

- Header is always rendered (never hidden) so the card anchor is stable
- `collapsed` hides only the body (`max-h-0 overflow-hidden` grid trick)
- Collapsing does NOT clear `triageOpen` — the HUD button stays hidden
  until the user clicks `×` in the header which calls `onTriageClose()`

---

## 2. Modify: `CanvasHudBar.tsx`

Add `triageOpen: boolean` prop. Hide the Triage button when `true`:

```tsx
// Current signature:
export function CanvasHudBar({
  counts, connected, isFullscreen,
  onOpenTriage, onToggleFullscreen, onResetView,
}: { ... onOpenTriage: () => void; ... })

// New signature — add one prop:
export function CanvasHudBar({
  counts, connected, isFullscreen,
  triageOpen,                          // ← ADD
  onOpenTriage, onToggleFullscreen, onResetView,
}: { ... triageOpen: boolean; onOpenTriage: () => void; ... })

// In the render, change the Triage button to:
{!triageOpen && (
  <HudButton label="Triage" onClick={onOpenTriage} icon={<span className="font-mono text-[11px]">T</span>} />
)}
```

---

## 3. Modify: `WorkspaceEcosystemCanvas.tsx`

### 3a. Imports — swap

Remove:
```tsx
import { AgentLiveFeed } from './AgentLiveFeed';
```

Add:
```tsx
import { CanvasCommandCenter } from './CanvasCommandCenter';
```

`CanvasTriagePanel` is defined locally inside the same file (line 1260).
Remove the entire `CanvasTriagePanel` function (lines 1260–end of function).

### 3b. State — `triageOpen` is already present at line 208

No new state needed. `triageOpen` / `setTriageOpen` are reused as-is.

### 3c. JSX — replace render blocks

**Remove** the `<AgentLiveFeed>` block (lines 813–820):
```tsx
// DELETE:
<AgentLiveFeed
  agents={agents}
  activeRuns={activeRuns}
  approvals={approvals}
  onRefresh={refresh}
  onSelectNode={setSelectedNodeId}
/>
```

**Remove** the `<CanvasTriagePanel>` block (lines 843–856):
```tsx
// DELETE:
<CanvasTriagePanel
  open={triageOpen}
  activeRuns={activeRuns.filter(isActiveRun)}
  approvals={approvals}
  onClose={() => setTriageOpen(false)}
  onNavigate={(route) => { setTriageOpen(false); nav(route); }}
  onRefresh={refresh}
/>
```

**Add** `<CanvasCommandCenter>` where `<AgentLiveFeed>` was:
```tsx
<CanvasCommandCenter
  agents={agents}
  activeRuns={activeRuns}
  approvals={approvals}
  failedRuns={failedRuns}
  artifacts={artifacts}
  now={now}
  triageOpen={triageOpen}
  onTriageOpen={() => setTriageOpen(true)}
  onTriageClose={() => setTriageOpen(false)}
  onRefresh={refresh}
  onSelectNode={setSelectedNodeId}
  onNavigate={nav}
/>
```

**Update** `<CanvasHudBar>` — add `triageOpen`:
```tsx
<CanvasHudBar
  counts={fleetCounts}
  connected={fleet?.gateways.connected ? fleet.gateways.connected > 0 : true}
  isFullscreen={isFullscreen}
  triageOpen={triageOpen}             // ← ADD
  onOpenTriage={() => setTriageOpen(true)}
  onToggleFullscreen={() => void toggleFullscreen()}
  onResetView={resetViewport}
/>
```

### 3d. Remove `CanvasTriagePanel` local function

Delete the entire `CanvasTriagePanel` function that lives at the bottom of
`WorkspaceEcosystemCanvas.tsx` (currently lines ~1260–1370).

---

## 4. Delete: `AgentLiveFeed.tsx`

After `CanvasCommandCenter` is working and all tests pass, delete:
```
apps/web/src/components/home/AgentLiveFeed.tsx
```

`useAgentLiveFeed.ts` is NOT deleted — it's the data engine for `CanvasCommandCenter`.

---

## 5. HomeLauncher — sessionStorage prompt write

In `apps/web/src/components/home/HomeLauncher.tsx`, in the `send()` function,
after the agent conversation API call, capture the runId and write the prompt:

```tsx
// In send(), after:
void api(`/v1/conversations/${target.id}/send`, { method: 'POST', body: JSON.stringify({ body }) });

// Add — the API may return a runId in the response, capture it:
api<{ runId?: string }>(`/v1/conversations/${target.id}/send`, {
  method: 'POST',
  body: JSON.stringify({ body }),
}).then((res) => {
  if (res.runId) {
    try {
      sessionStorage.setItem(`agentis.req.${res.runId}`, body.slice(0, 200));
    } catch { /* storage full or unavailable */ }
  }
}).catch(() => undefined);
```

If the conversations API does not currently return `runId`, this write is a no-op
and the card falls back to `workflowName`. No backend change is required for the
card to be functional — the prompt text is a progressive enhancement.

---

## 6. Implementation order

1. **Create `CanvasCommandCenter.tsx`** — build with static mock data first,
   confirm layout and states render correctly in the browser.

2. **Modify `CanvasHudBar.tsx`** — add `triageOpen` prop, conditional Triage button.

3. **Modify `WorkspaceEcosystemCanvas.tsx`** — swap imports, remove blocks,
   add `<CanvasCommandCenter>`, update `<CanvasHudBar>` call. At this point both
   old and new render simultaneously — comment out `<AgentLiveFeed>` temporarily.

4. **Smoke test** — run the app, verify all three card states (ambient/live/triage)
   and that HUD Triage button disappears/reappears correctly.

5. **Delete `AgentLiveFeed.tsx`** — remove the import from the canvas and delete the file.

6. **Remove `CanvasTriagePanel` local function** from `WorkspaceEcosystemCanvas.tsx`.

7. **HomeLauncher sessionStorage write** — add prompt capture.

8. **Run tests**: `pnpm --filter @agentis/web exec vitest run tests/pages/HomePage.test.tsx`

---

## 7. Positioning & z-index

```
position: absolute
top: 80px          /* clears top nav bar */
left: 16px
z-index: 40        /* same as AgentLiveFeed today */
width: 320px       /* w-80 */
max-height: calc(100vh - 200px)
data-canvas-control  /* prevents canvas pan on pointer events inside card */
```

The card is hidden on screens narrower than `lg` (1024px) — same rule as
the current `AgentLiveFeed` (`hidden lg:block`). On mobile, the HUD Triage
button remains the only triage entry point.

---

## 8. Auto-escalation to triage

When `approvals.length` transitions from 0 to > 0 while `triageOpen === false`,
the component calls `onTriageOpen()` immediately. This ensures the operator
is never silently blocked — the card forces itself open when an approval arrives.

```tsx
const prevApprovalsRef = useRef(approvals.length);
useEffect(() => {
  if (prevApprovalsRef.current === 0 && approvals.length > 0 && !triageOpen) {
    onTriageOpen();
  }
  prevApprovalsRef.current = approvals.length;
}, [approvals.length, triageOpen, onTriageOpen]);
```

---

## 9. Realtime subscriptions inside `CanvasCommandCenter`

Subscribe to `RUN_COMPLETED` and `RUN_FAILED` to drive `doneSince` state:

```tsx
useRealtime([REALTIME_EVENTS.RUN_COMPLETED, REALTIME_EVENTS.RUN_FAILED], (env) => {
  const runId = (env.payload as Record<string, unknown>)?.runId;
  if (typeof runId === 'string') {
    setDoneSince((prev) => ({ ...prev, [runId]: Date.now() }));
  }
});
```

The live step label comes from `useAgentLiveFeed` which already handles
`AGENT_WORK_STEP` events — no duplicated subscriptions.

---

## Summary of deletions vs additions

```
DELETE  apps/web/src/components/home/AgentLiveFeed.tsx
DELETE  CanvasTriagePanel function (inside WorkspaceEcosystemCanvas.tsx)

ADD     apps/web/src/components/home/CanvasCommandCenter.tsx

MODIFY  WorkspaceEcosystemCanvas.tsx   (swap imports + render blocks)
MODIFY  CanvasHudBar.tsx               (1 prop + 3 lines)
MODIFY  HomeLauncher.tsx               (sessionStorage write in send())
KEEP    useAgentLiveFeed.ts            (unchanged data engine)
```
