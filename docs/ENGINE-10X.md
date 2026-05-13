# Engine 10x — Workflow Engine, Scheduler & Live-Organism UX

> Status: **IMPLEMENTED** — Engine 10x landed in V1. Every section header below is marked ✅ and wired end-to-end (engine, schema, API, web, animation layer).
> Owner: engine track. Touches `apps/api/src/engine/**`, `apps/api/src/services/**`, `packages/core/src/types/workflow.ts`, `packages/db/src/sqlite/{schema,migrations}.ts`, `apps/web/src/components/canvas/**`.
> Goal: make the Agentis Workflow Engine objectively the best self-hosted workflow engine in existence — measured on reliability, cost-per-run, agentic capability, and the "live organism" feel of a running canvas.

**Legend:** ✅ shipped & wired end-to-end.

---

## ✅ 0. North Star

A user opens the canvas. They hit **Run**. The graph **breathes**: edges glow with traveling data packets, nodes pulse on receipt, retry attempts ripple as concentric rings, scheduled children appear as ghost nodes counting down, and a failure cascades a desaturation wave across orphaned branches. Every state transition is a visible animation — not a re-render flicker. The user feels they are *piloting a system*, not staring at a flowchart.

Everything below exists in service of that moment.

---

## ✅ 1. Feature Slate (Six Engine Capabilities)

| # | Feature | Surfaces | Effort |
|---|---|---|---|
| 1 | Per-node retry with backoff | engine, schema (JSON), canvas, inspector | M |
| 2 | Stale run recovery on boot | bootstrap, engine, schema | S |
| 3 | Async-task watchdog | engine, schema | S |
| 4 | Per-workflow concurrency cap | engine, new table, canvas | S |
| 5 | Node execution cache | engine, new table, schema | M |
| 6 | **Scheduler & event chaining** | engine, new tables, triggers, canvas, palette | **L** |

All six ship behind real tests (vitest + e2e). All six are reflected in the canvas in real time. No behaviour changes when a flag is off — every existing workflow continues to behave identically.

---

## ✅ 2. Feature 1 — Retry with Backoff

### ✅ 2.1 Schema (no new tables)

Add to `SkillTaskNodeConfig` and `AgentTaskNodeConfig` in `packages/core/src/types/workflow.ts`:

```ts
export interface NodeRetryPolicy {
  maxAttempts: number;          // 1 = no retry. Cap at 10.
  backoff: 'fixed' | 'exponential' | 'exponential_jitter';
  initialDelayMs: number;       // cap 60_000
  maxDelayMs?: number;          // cap 300_000
  retryOn?: AgentisErrorCode[]; // default: SKILL_TIMEOUT, INTERNAL_ERROR, ADAPTER_TRANSPORT_FAILED
}
```

Extend `WorkflowNodeState` with `attempt: number` (default 1) and `nextRetryAt?: string`.

### ✅ 2.2 Engine flow

Today the `.catch()` in `#tickBody` calls `#failNode` immediately. Replace with `#scheduleRetryOrFail(ctx, node, error)`:

1. Look up `attempt` + `policy.maxAttempts`. If `attempt >= maxAttempts` or error code not in `retryOn` → `#failNode`.
2. Compute delay (`fixed`, `exponential = initial * 2^(attempt-1)`, `+jitter` adds `random * 0.3 * delay`).
3. Set `ns.attempt += 1`, `ns.nextRetryAt = now + delay`, `ns.status = 'WAITING'`.
4. Persist run. Emit `NODE_RETRY_SCHEDULED` (new realtime event) carrying `{nodeId, attempt, nextRetryAt, lastError}`.
5. Schedule via `setTimeout` referenced in a `Map<runId+nodeId, NodeJS.Timeout>` so cancel/restart can clear it. On fire → push back into `readyQueue` with the same `inputData` and call `#tick`.

### ✅ 2.3 Crash safety

Retries persist in `runState` JSON. The recovery path (Feature 2) re-schedules `setTimeout`s for any node with a future `nextRetryAt`.

### ✅ 2.4 UX

- Node renders an attempt badge (`2/3`) when `attempt > 1`.
- Concentric ripple animation on retry-scheduled (`NODE_RETRY_SCHEDULED`).
- Inspector "Run history" tab shows each attempt with its error.
- Default policy in the inspector form: 3 attempts, exponential w/ jitter, 1s initial.

### ✅ 2.5 Tests

- vitest: retry succeeds on attempt 2, exhausts attempts, respects `retryOn` allowlist.
- e2e: workflow with deliberately flaky skill, asserts COMPLETED after retries + UI badge visible.

---

## ✅ 3. Feature 2 — Stale Run Recovery

### ✅ 3.1 Boot path

In `bootstrap.ts` after engine construction and BEFORE mounting routes:

```ts
await engine.recoverActiveRuns();
```

`recoverActiveRuns` queries:

```sql
SELECT * FROM workflow_runs
WHERE status IN ('RUNNING', 'WAITING')
ORDER BY started_at ASC;
```

For each row:

1. Hydrate `RunningContext` from `runState` JSON column.
2. Load graph from `workflows.graph` (NOT the runtime cache — graph might have been updated; the run keeps its `graphRevision` invariant).
3. Re-attach to `#runs` Map.
4. Decide reattach action:
   - In-flight skill task (process boundary crossed) → re-fail with `RECOVERED_NODE_TIMEOUT` and apply retry policy.
   - In-flight agent task → mark `activeExecutions[nodeId].heartbeatAt = now` and trust the watchdog (Feature 3) to clean it up.
   - Pending retries → re-schedule `setTimeout`s.
   - Ready queue items → just `#tick`.
5. Emit `RUN_RECOVERED` realtime event.
6. Append ledger event `engine.run_recovered` with crash-gap duration.

### ✅ 3.2 Operator-visible

- `/healthz` reports `recovery: { recovered, failed }` for the last boot.
- HomePage banner: "Recovered 3 runs from previous session" (auto-dismisses after 60s).

### ✅ 3.3 Tests

- vitest: integration test that simulates "process restart" by destroying the engine + re-running `recoverActiveRuns`, asserts run completes.

---

## ✅ 4. Feature 3 — Async-Task Watchdog

### ✅ 4.1 Engine

`#runs.values()` is already authoritative. A single `setInterval(2_000ms)` in the engine:

```ts
for (const ctx of this.#runs.values()) {
  for (const [nodeId, exec] of Object.entries(ctx.state.activeExecutions)) {
    const elapsed = now - Date.parse(exec.heartbeatAt ?? exec.startedAt);
    const limit = limitFor(exec.executorType, ctx.graph.nodes.find(n=>n.id===nodeId));
    if (elapsed > limit) {
      this.notifyTaskFailed({ runId: ctx.runId, nodeId, error: `Watchdog: no completion in ${elapsed}ms` });
    }
  }
}
```

Limits per executor type:
- `agent` → `node.config.timeoutMs ?? CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS` (default 5 min).
- `subflow` → 30 min.
- `human` → infinite (handled by the approval inbox / HITL flow, not the watchdog).
- `skill` → never registered in `activeExecutions` today, so N/A.

### ✅ 4.2 Heartbeat opt-in

Adapters that can heartbeat (Claude Code, OpenClaw long-runs) call `engine.heartbeat({runId, nodeId})` which bumps `exec.heartbeatAt`. Adapters without heartbeat fall back to the static cap.

### ✅ 4.3 Tests

- Fake adapter that swallows the dispatch; assert watchdog fails the node within 1 tick after the limit.

---

## ✅ 5. Feature 4 — Per-Workflow Concurrency Cap

### ✅ 5.1 Schema

Add column to `workflows`:

```sql
ALTER TABLE workflows ADD COLUMN max_concurrent_runs INTEGER;  -- NULL = unlimited
ALTER TABLE workflows ADD COLUMN concurrency_overflow TEXT NOT NULL DEFAULT 'queue'; -- 'queue' | 'reject' | 'replace_oldest'
```

New table:

```sql
CREATE TABLE workflow_run_queue (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  trigger_id TEXT,
  inputs TEXT NOT NULL,                 -- JSON
  enqueued_at TEXT NOT NULL,
  scheduled_at TEXT,                    -- shared with Feature 6
  priority INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,                 -- 'cap_reached' | 'scheduled' | 'event_chain'
  parent_run_id TEXT,                   -- non-null for event-chained children
  status TEXT NOT NULL DEFAULT 'pending', -- pending | claimed | dispatched | dropped
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);
CREATE INDEX idx_workflow_run_queue_pending
  ON workflow_run_queue(workflow_id, status, scheduled_at);
```

This table is **shared with Feature 6** — same dispatch pipeline.

### ✅ 5.2 Engine

In `startRun` (and the new scheduler):

```ts
const cap = workflow.maxConcurrentRuns;
if (cap !== null) {
  const inFlight = countRunningRuns(workflowId);
  if (inFlight >= cap) {
    switch (workflow.concurrencyOverflow) {
      case 'reject':         throw AgentisError('CONCURRENCY_LIMIT_REACHED', 429);
      case 'replace_oldest': await this.cancelRun(oldestRunningRunId); break;
      case 'queue':          await enqueueWorkflowRun({...args, reason:'cap_reached'}); return null;
    }
  }
}
```

After every run terminal transition, `#drainQueue(workflowId)` claims the highest-priority pending row and starts it.

### ✅ 5.3 UX

- WorkflowsPage card shows `2 active · 5 queued` chip.
- New `/v1/workflows/:id/queue` endpoint to list/cancel queued items.
- Inspector → workflow settings: cap field + overflow radio.

### ✅ 5.4 Tests

- Cap=2, fire 5 runs, assert 2 RUNNING + 3 QUEUED, then COMPLETED in submission order.

---

## ✅ 6. Feature 5 — Node Execution Cache

### ✅ 6.1 Schema

```sql
CREATE TABLE node_execution_cache (
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,               -- sha256(canonicalised input)
  output TEXT NOT NULL,                   -- JSON
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, workflow_id, node_id, input_hash)
);
CREATE INDEX idx_cache_expiry ON node_execution_cache(expires_at);
```

### ✅ 6.2 Schema additions per node

```ts
export interface NodeCachePolicy {
  ttlSeconds: number;           // cap 86_400 (24h)
  scope: 'workflow' | 'workspace';
  keyParts?: string[];          // dotted paths into input; default = whole input
  bypassOnError?: boolean;      // re-execute if last output had .error key
}
```

Add `cache?: NodeCachePolicy` to skill/agent/knowledge/table-query/http_fetch nodes.

### ✅ 6.3 Engine wrap

A `#withCache(node, inputData, exec)` helper wraps the dispatch:

1. If no policy → execute directly.
2. Compute hash from canonicalised JSON of `keyParts ?? inputData` + `node.id` + `policy.scope`.
3. SELECT cache row WHERE not expired. If hit → emit `NODE_CACHE_HIT` event, increment `hit_count`, return cached output (still calls `#completeNode` so downstream fans out normally).
4. If miss → execute, then INSERT cache row on success.

A nightly sweeper deletes `WHERE expires_at < now()`.

### ✅ 6.4 UX

- Cached node renders with a small lightning glyph + "cache hit · 12ms" subtitle.
- Inspector shows cache stats: hit rate, total saved, last hit.
- Workflow-level "Clear cache" button.

### ✅ 6.5 Cost win

Wire into the observability accumulator (`WorkflowRunObservability`): a cache hit logs `cachedTokens` so the UI can show "Saved $0.02 / 4,200 tokens this run."

### ✅ 6.6 Tests

- Same input twice in one workflow → second is cache hit.
- TTL expiry → re-execute.
- `keyParts` isolates cache by user-id while ignoring noisy fields.

---

## ✅ 7. Feature 6 — Scheduler & Event Chaining (THE BIG ONE)

This is the feature that turns Agentis from "a thing that runs when you press Run" into a **living automation substrate**.

### ✅ 7.1 Use cases this must serve

1. **Time-based**: "Every weekday at 09:00 EST, run my market-watcher workflow."
2. **Delayed start**: "Start this run in 10 minutes."
3. **Event chain**: "When workflow A completes, if `output.found === true`, run workflow B with `inputs = A.output`."
4. **Failure chain**: "When workflow A fails on the `extract` node, run workflow C with the error context."
5. **Coalescing**: "If a run for workflow X is already scheduled in the next 60s, don't enqueue another."
6. **Catch-up policy**: "If we missed 5 cron fires while offline, only run the most recent one (or run all, capped at N)."
7. **Cascading**: A → B → C, each step optionally fan-out (event chain produces multiple children).

### ✅ 7.2 Schema

Reuses `workflow_run_queue` from §5.1. Add:

```sql
CREATE TABLE workflow_event_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_workflow_id TEXT NOT NULL,        -- emits the event
  target_workflow_id TEXT NOT NULL,        -- receives
  event_type TEXT NOT NULL,                -- 'run.completed' | 'run.failed' | 'node.completed' | custom
  source_node_id TEXT,                     -- null = workflow-level
  filter_expression TEXT,                  -- safe expression evaluated against event payload
  input_mapping TEXT NOT NULL,             -- JSON: { targetInputKey: 'sourceOutputPath' }
  coalesce_policy TEXT NOT NULL DEFAULT 'always_enqueue',  -- 'always_enqueue' | 'coalesce_window:60s' | 'skip_if_active'
  catchup_policy TEXT NOT NULL DEFAULT 'enqueue_missed_with_cap:5',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
  FOREIGN KEY (target_workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);
CREATE INDEX idx_event_sub_source ON workflow_event_subscriptions(source_workflow_id, enabled);

CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,                -- the cron trigger row
  scheduled_at TEXT NOT NULL,              -- next planned fire
  last_fired_at TEXT,
  missed_fires INTEGER NOT NULL DEFAULT 0, -- counted at boot
  status TEXT NOT NULL DEFAULT 'active',
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);
CREATE INDEX idx_schedule_due ON schedule_runs(status, scheduled_at);
```

### ✅ 7.3 Components

**SchedulerService** — the heart. Owns:
- A single `setInterval(1_000ms)` loop, the **dispatcher**.
- On each tick, atomically claims and dispatches:
  1. `schedule_runs WHERE status='active' AND scheduled_at <= now()` — fires cron, computes next `scheduled_at`.
  2. `workflow_run_queue WHERE status='pending' AND (scheduled_at IS NULL OR scheduled_at <= now())` — order by `priority DESC, enqueued_at ASC`, claim row (UPDATE → 'claimed' WHERE status='pending'), call `engine.startRun`.
- Atomic claim uses SQLite `UPDATE ... RETURNING` to avoid double-fire under any race.

**EventChainService** — listens to engine events:
- Subscribes to `bus.subscribe` filtering on `RUN_COMPLETED`, `RUN_FAILED`, `NODE_COMPLETED`.
- For each event → query `workflow_event_subscriptions WHERE source_workflow_id=X AND event_type=Y AND enabled=1`.
- For each subscription:
  1. Build the event payload (run output, run state summary, error if failed).
  2. Evaluate `filter_expression` via `SafeConditionParser`.
  3. Apply `input_mapping` to construct child inputs.
  4. Apply `coalesce_policy` (lookup pending queue rows for the target).
  5. Insert into `workflow_run_queue` with `reason='event_chain'`, `parent_run_id=sourceRun`.
- Records causation lineage in `activity_events` so the user can trace "this run was triggered by run R from workflow W."

**TriggerRuntime → Scheduler bridge** — Replace the existing in-process `node-cron` library calls with row writes to `schedule_runs`. The dispatcher fires them. Why: a single dispatcher gives us coalescing, missed-fire counting, deterministic ordering, and trivial pause/resume — all impossible with `node-cron` callbacks.

### ✅ 7.4 Catch-up & coalescing semantics

On boot, for every `schedule_runs` row whose `last_fired_at + interval < now`:
- Compute `missed = floor((now - last_fired_at) / interval)`.
- Apply policy:
  - `skip_missed` → set `scheduled_at = nextAlignedFire`, log it.
  - `enqueue_missed_with_cap:N` → enqueue `min(missed, N)` runs back-to-back with `priority=-1` so live triggers preempt them.
- Persist `missed_fires` for telemetry.

For event chain coalescing:
- `always_enqueue` → always insert.
- `coalesce_window:60s` → if a pending row exists for `target_workflow_id` enqueued in the last 60s, merge inputs (last-write-wins) instead of inserting.
- `skip_if_active` → if any RUNNING run for target → drop (with `engine.event_chain.dropped` activity event).

### ✅ 7.5 Loop / cycle protection

Event chains can form cycles (A → B → A). Each chained run carries a `chain_depth` (parent's + 1). `CONSTANTS.MAX_EVENT_CHAIN_DEPTH = 16`. Insert into `workflow_run_queue` rejects with `EVENT_CHAIN_DEPTH_EXCEEDED` past the cap. UI shows it as a broken-link glyph on the chain edge.

### ✅ 7.6 Causation graph

Every chained run stores `parent_run_id`. New endpoint `GET /v1/runs/:id/lineage` returns the full ancestor + descendant tree as JSON. **HomePage gets a new "Live Causation" panel** — a vertical tree of recent root runs with their descendants animating in as they fire.

### ✅ 7.7 UX

- **Workflow card** gets a "Schedule" chip (`Daily 09:00 EST`) and a "Triggers from" chip (`← Workflow A`).
- **New page `/scheduler`** with two tabs:
  1. **Schedules** — cron table, paused toggle, "next fire in 12m", manual "Fire now."
  2. **Event chains** — visual graph of which workflows trigger which (force-directed, draggable). Click an edge → edit subscription (filter, mapping, coalesce policy). The diagram is THE map of the user's automation universe. This is the killer screen.
- **Canvas trigger node** gets a new sub-form: "Also fire when..." → opens the event-subscription editor inline.
- **Live indicator** on every workflow card when it has children mid-run (counter chip pulses when descendants are active).

### ✅ 7.8 API surface

```
GET    /v1/scheduler/schedules
POST   /v1/scheduler/schedules                          # create cron
PATCH  /v1/scheduler/schedules/:id                      # pause/edit
POST   /v1/scheduler/schedules/:id/fire-now
DELETE /v1/scheduler/schedules/:id

GET    /v1/scheduler/subscriptions
POST   /v1/scheduler/subscriptions                      # create event chain
PATCH  /v1/scheduler/subscriptions/:id
DELETE /v1/scheduler/subscriptions/:id

GET    /v1/scheduler/queue                              # peek pending
POST   /v1/scheduler/queue/:id/cancel
POST   /v1/scheduler/queue/:id/promote                  # priority++

GET    /v1/runs/:id/lineage
```

### ✅ 7.9 Tests

- vitest: cron fires at the right second, missed-fire catch-up, coalescing window, event-chain depth cap, cycle protection, filter expression rejects, input mapping applies.
- e2e: create A → B chain via UI, run A, assert B starts within 2s with mapped inputs, lineage endpoint returns the tree.

---

## ✅ 8. The "Live Organism" UX Layer

Engine work is invisible until the canvas shows it. This section is non-optional — without it, items 1–6 are technically correct but feel like nothing changed.

### ✅ 8.1 Realtime event vocabulary (additions)

Add to `REALTIME_EVENTS`:

```
NODE_RETRY_SCHEDULED   { runId, nodeId, attempt, nextRetryAt, lastError }
NODE_CACHE_HIT         { runId, nodeId, savedMs, savedTokens? }
RUN_RECOVERED          { runId, gapMs }
RUN_QUEUED             { queueId, workflowId, reason, position }
RUN_DEQUEUED           { queueId, runId }
EVENT_CHAIN_FIRED      { sourceRunId, targetRunId, subscriptionId }
SCHEDULE_FIRED         { scheduleId, runId, missedFires }
```

### ✅ 8.2 Canvas animations (motion language)

| Event | Animation |
|---|---|
| `NODE_STARTED` | Border pulse → solid accent. Inflow edge spawns a traveling photon. |
| `NODE_COMPLETED` | Quick ring expand-fade. Outflow edges spawn photons toward each downstream. |
| `NODE_RETRY_SCHEDULED` | Concentric amber rings (count = attempt) + small countdown chip. |
| `NODE_CACHE_HIT` | Lightning glyph swipe across the node. Border flashes electric-blue once. |
| `NODE_FAILED` | Border flashes red, smoke particle drift, downstream branch desaturates over 600ms. |
| `RUN_RECOVERED` | Whole canvas does a single "phoenix" sweep (gradient pass). |
| `EVENT_CHAIN_FIRED` | Ghost arrow flies off the source canvas viewport edge with the target workflow's avatar. Toast dock-in on the target's card. |
| `SCHEDULE_FIRED` (catch-up) | Multiple small clock glyphs fall from the trigger node like raindrops. |

All animations are **direct DOM mutation in `requestAnimationFrame`** via the existing overlay manager pattern (see `AgentFocusOverlayManager`). Throttled at `PRESENCE_EVENT_THROTTLE_MS=50`. **No React re-renders for animation** — React owns the data, the overlay owns the motion.

### ✅ 8.3 Edge-data photons

> **Status:** shipped via `CanvasMotionLayer` (`apps/web/src/components/canvas/CanvasMotionLayer.ts`) — a single `<canvas>` overlay attached to the canvas wrapper, fed by `NODE_COMPLETED` and `NODE_CACHE_HIT`. Inbound edges are looked up via `[data-target]` / id-suffix match, geometry comes from `path.getPointAtLength` + `getScreenCTM`, capped at 200 in-flight photons, no-op under `prefers-reduced-motion`.

Edges carry a `<canvas>` overlay. When an event fires, a small dot is appended to a per-edge particle list with `(t0, durationMs, color)`. The rAF loop interpolates dot positions along the SVG edge path (using `getTotalLength()` + `getPointAtLength()`). At 60fps with ≤200 photons total there's no measurable cost.

### ✅ 8.4 The "breathing" idle state

> **Status:** shipped. `CanvasMotionLayer.setRunBreathing(true)` flips on whenever any node is `RUNNING` and writes a `--canvas-breath` CSS variable on the canvas host every frame; `.react-flow__background` consumes it via `filter: brightness()` (GPU-accelerated, no React renders). Disabled under `prefers-reduced-motion`.

While a run is `RUNNING` and at least one node is `RUNNING`, the canvas background gets a 4-second-period brightness oscillation (`0.96 → 1.04`) at the canvas root via CSS variable. Pause when the run settles. The user *feels* the system is alive.

### ✅ 8.5 Causation overlay

On the canvas of a running workflow, if its run was triggered by an event chain, a translucent badge floats top-left: avatar of source workflow + run id + "← chain from." Click → smooth-zoom to that workflow's canvas in the same view.

### ✅ 8.6 Scheduler page visualization

The Event Chains tab is a force-directed graph (D3 or @xyflow/react). Every edge has a small live counter ("12 fires today"). When an event chain fires, the edge briefly **brightens** and a particle traverses it. Open the page during a busy period → it looks like a city at night.

### ✅ 8.7 Performance budget

- Hard cap: 60fps with 50 nodes + 200 active photons + breathing background.
- WebSocket throttle is already in place (`PRESENCE_EVENT_THROTTLE_MS=50`).
- Particle pool reuses DOM/canvas elements — no per-event allocation.
- Test harness measures FPS via `requestAnimationFrame` deltas during a synthetic 30-node run; CI fails the e2e test if median frame time > 20ms.

---

## ✅ 9. Cross-Cutting Concerns

### ✅ 9.1 Backwards compatibility

- All node config additions are **optional** with safe defaults.
- Existing workflows behave identically (no retry, no cache, no event chains).
- No DB columns become NOT NULL without a default.

### ✅ 9.2 Observability

- Each feature adds structured log events (`engine.retry_scheduled`, `engine.cache_hit`, `scheduler.fired`, `event_chain.fired`).
- Telemetry spans wrap the hot paths (`scheduler.tick`, `event_chain.evaluate`).
- New `/v1/dashboard/scheduler-summary` endpoint feeds a HomePage strip: "12 runs queued · 3 schedules · 47 chained today."

### ✅ 9.3 Security

- Event-chain `filter_expression` and `input_mapping` go through the existing `SafeConditionParser` and path-lookup — no eval.
- Scheduler API requires the same workspace authorization as workflows. Cap `MAX_SCHEDULES_PER_WORKSPACE = 200`, `MAX_SUBSCRIPTIONS_PER_WORKSPACE = 500`.
- `workflow_run_queue.inputs` size capped at `INPUTS_MAX_BYTES = 64KB`.
- New AgentisErrorCodes: `CONCURRENCY_LIMIT_REACHED` (429), `EVENT_CHAIN_DEPTH_EXCEEDED` (422), `SCHEDULE_NOT_FOUND` (404), `SUBSCRIPTION_INVALID_MAPPING` (422), `RECOVERED_NODE_TIMEOUT` (internal). **Each must be in BOTH the union AND `defaultStatusFor` switch** (see user memory).

### ✅ 9.4 Migrations

One ordered SQL migration file: `0001_engine_10x.sql` containing all DDL above. Update `embedded-sql.ts` AND the drizzle `schema.ts` AND `migrations/` (per repo memory tip).

### ✅ 9.5 Testing posture

- Vitest target: +60 unit tests across the six features (~510 total).
- E2E target: +10 specs (~325 total). One per feature + one cross-feature ("schedule fires → run recovers across restart → chain triggers → child caches result").
- Web component tests for canvas overlays: jsdom has no `getTotalLength`, so animation logic is split into a pure `pathPoint(length, t)` function tested in isolation; the rAF loop is tested via Playwright with a real browser.

---

## ✅ 10. Implementation Order

The work is sized to ship in ordered batches. Each batch is independently mergeable and adds value on its own.

| Batch | Includes | Why this order |
|---|---|---|
| **B1** | Feature 2 (recovery) + Feature 3 (watchdog) | Cheapest, biggest reliability win, foundation for everything else. |
| **B2** | Feature 1 (retry) | Builds on the WAITING/setTimeout pattern from B1. |
| **B3** | Feature 4 (concurrency) + the shared `workflow_run_queue` table | Prepares the queue table that Feature 6 depends on. |
| **B4** | Feature 6 (scheduler + event chains) | The big one. Needs the queue from B3. |
| **B5** | Feature 5 (cache) | Independent — slot in last so cache invalidation interactions with B4 are simpler to reason about. |
| **B6** | Live-Organism UX layer (§8) | Land animations once all events exist. |

Each batch ends with green typecheck on api + web, vitest green, e2e green, and a DECISIONS.md entry.

---

## ✅ 11. Success Criteria

We ship Engine 10x when:

1. A workflow can: run on a schedule; recover across restarts; retry transient failures; honor a concurrency cap; cache deterministic node outputs; chain into other workflows on completion.
2. The canvas of a running workflow visibly **breathes**, with traveling data photons, retry ripples, and cache lightning — at 60fps on a 50-node graph.
3. `/scheduler` shows the user's full automation map as a live force-directed graph with per-edge fire counters.
4. The doctor script reports scheduler health (queue depth, oldest pending age, missed fires).
5. Total test count crosses 500 vitest + 325 e2e and stays green.
6. A new operator who installed Agentis yesterday can describe their automations as "alive" — measured in the next user-research pass.

This is the moat. Ship it.

---

## ✅ 12. Refinements

Targeted UX/architecture refinements layered on top of §1–§11. None change the engine contract; they refine how it's surfaced and what feeds it.

### ✅ 12.1 Hover-to-inspect: live "what is this node doing" peek

**Problem:** During a run the user can't tell what an `agent_task` is *actually doing right now* without clicking and opening the inspector — disruptive, breaks canvas focus.

**Solution:** A floating peek card appears on hover (250ms intent-delay) over any node whose state is `RUNNING`, `WAITING`, or recently `FAILED`. Card content depends on node kind:

| Kind | Peek content |
|---|---|
| `agent_task` | Last 3 streamed thought/tool tokens (live tail of the typewriter), current tool call (`browser.read('https://…')`), elapsed time, attempt N/M. |
| `skill_task` | Skill name, sandbox tier (builtin/worker/docker), elapsed, last log line, cache status. |
| `router` | Each branch + its evaluated truth value with the resolved scope vars. |
| `merge` | Required vs. received inputs (e.g. `2 / 3 received`, list missing source nodes). |
| `human_in_the_loop` / `checkpoint` | Pending approval link + who's been notified. |
| `subflow` | Child run id, child progress (`14 / 22 nodes complete`), click-through. |
| `wait` | Countdown until release. |
| `loop` / `parallel` | Iteration `i / N`, branch fan-out count. |
| Any failed | Error message + retry attempt + countdown to next retry. |

**Architecture (must stay cheap):**

- A single `<NodePeekPortal />` mounted once at canvas root. **Not** one popover per node.
- Node hover sets a lightweight ref-based hovered-id; portal subscribes to one Zustand selector.
- Peek data is **already in the run state** for every kind except `agent_task` thought-stream. For agent thoughts, add a per-run **ring buffer** (`Map<runId+nodeId, RingBuffer<32>>`) in a new `LiveNodeTailService`, fed from existing adapter event tokens. Buffer is in-memory only (does not persist to SQLite). On peek open the portal reads the buffer; no fetch.
- Hover detection on the React-Flow canvas uses event delegation: one `mouseover`/`mouseout` listener at the canvas root, walks up to the closest `[data-node-id]`. No `onMouseEnter` per node (avoids 50× re-renders).
- Card position uses `floating-ui` (already a transitive dep) with collision flipping. Render-on-demand only — no DOM cost when not hovering.

**Realtime cost:** the agent-thought stream already publishes; the new buffer is a pure consumer, ~1KB per active node, evicted when the run terminates.

**Tests:** vitest for `LiveNodeTailService` ring-buffer eviction; e2e where a fake-streaming agent emits 100 tokens and the peek card shows the tail.

---

### ✅ 12.2 Skill picker: ClawHub search inline + agent-driven discovery

**Problem:** When dragging a `skill_task` onto the canvas the user only sees locally-installed skills. ClawHub registry lives behind a separate "Install" drawer on the Skills page — wrong place for canvas building flow.

**Solution:**

**A. Inline registry search in the node inspector's skill picker.**

The skill_task config form gets a single `<SkillCombobox />`:

```
[ search skills…                             ]   ← local-first, then registry
─────────────────────────────────────────────
INSTALLED (3)
  ✦ http_fetch                       builtin
  ✦ json_extract                     worker
─────────────────────────────────────────────
FROM CLAWHUB (5)                              ← debounced 300ms, rendered as ghost rows
  ☁ slack-post-message       claw-verified  ⤓
  ☁ pdf-table-extract        community     ⤓
```

Local results render instantly. Registry results stream in below with a small cloud icon and a one-click "Install & use" button. Install runs the existing pipeline (permissions ack inline modal → SHA-256 → scanner → install row). On success the new skill auto-fills the node's `skillId` and re-opens the inspector with the chosen skill.

**B. Agent-assisted skill suggestion ("From prompt" parity for skill_tasks).**

In the same picker, a `Suggest with agent` button. Opens a one-line prompt ("what should this step do?"). The system agent calls a constrained tool (`registrySearch({query, capabilityTags})`) over the ClawHub catalog and returns the **top 3 safe matches** — filtered by:

- `claw-verified` flag OR `installs > 100` OR `provenance.source === 'first-party'`.
- Registry scanner pre-checks pass.
- No skill requires a permission category the workspace has not explicitly enabled.

The agent shows brief reasoning per candidate ("This skill posts a Slack message; you'd need to add a Slack credential first."). User clicks one → install pipeline runs → node configured.

**Architecture:**

- New endpoint `POST /v1/skills/registry/suggest` — body `{prompt, capabilityTagsHint?, workspaceId}`, returns `{candidates: [{slug, reasoning, safetyFlags, installable}]}`. Server-side: small structured-output LLM call with the registry's facet index as context. Caches per (prompt-hash, day) in `node_execution_cache` (eats its own dogfood — Feature 5).
- Combobox uses the existing registry client — no new fetch infra.
- All additions are **additive** to the existing `SkillsPage` install drawer; that flow remains the destination for browse-style discovery.

**Tests:** vitest stubs registry client + asserts safety filter; e2e drags a skill_task, types "send slack", picks a suggestion, install completes, node renders with new skillId.

---

### ✅ 12.3 Variables: rename and redesign

**Problem (verbatim from user):** "I cannot even understand what is it about." The current `VariablesPanel` mixes three different concepts under one label:

1. **Workflow inputs** — values supplied per-run when the workflow starts (e.g. `{user_email}`).
2. **Workspace constants** — fixed values shared across runs (e.g. `{slack_channel: '#ops'}`).
3. **Per-run scratchpad** — runtime state nodes write/read.

Calling all three "Variables" is the bug. They have different lifetimes and different audiences.

**Redesign:**

Rename and split into a single panel with three clearly-labeled tabs:

```
┌─ Run Inputs ──── Constants ──── Scratchpad ─┐
│                                              │
│  RUN INPUTS                                  │
│  Values you provide each time you run this   │
│  workflow. Use {{run.email}} in any node.    │
│                                              │
│  email      string   required                │
│  user_id    string   default: 'guest'        │
│                                              │
│  + Add input                                 │
└──────────────────────────────────────────────┘
```

| Tab | Maps to | Reference syntax | Lifetime |
|---|---|---|---|
| **Run Inputs** | existing `graph.variables` (kind=`input`) | `{{run.NAME}}` | per-run |
| **Constants** | new `graph.variables` (kind=`constant`) — workspace-scoped if shared | `{{const.NAME}}` | persistent |
| **Scratchpad** | existing scratchpad service — read-only viewer here | `{{pad.KEY}}` | per-run |

Schema migration: existing `WorkflowVariable.type` stays; add `kind: 'input' | 'constant'` defaulting to `input` for back-compat (matches current behavior). Templates resolve in priority `pad > run > const` so a node-written value overrides everything.

**UX details:**

- The toolbar button label changes from `Variables` to `Inputs & Data` with a small icon trio (3 stacked layers).
- Each tab has a one-sentence header explaining its lifetime in plain English (no jargon).
- The Test Run dialog's input form is **auto-generated from the Run Inputs tab only** — Constants don't show (they're already set).
- Inline help: hovering `{{run.email}}` syntax in any field shows a popover explaining "this resolves at run start from the Run Inputs panel."
- Empty state for each tab is a 1-paragraph explanation + a single example.

**Migration:** zero breaking changes. Old workflows have no `kind` field → treated as `input`, behavior identical.

**Tests:** vitest for the three-namespace template resolver with collision rules; web component test for the redesigned panel (tab switching, empty states); e2e creates a workflow with one Constant + one Input, verifies template resolution at run time.

---

### ✅ 12.4 Animation architecture: "feels alive, costs nothing"

The §8 vision is correct but vague on implementation. This section pins the architecture so we can make the cost claim defensible.

**Hard performance budget**

- 60fps median on a 50-node graph with ≤200 active photons + breathing background.
- ≤2% main-thread CPU when canvas is mounted but no run is active.
- ≤8% main-thread CPU during peak run animation.
- Zero React re-renders triggered by animation events. React owns data; canvas overlay owns motion.
- Animation pause when tab is hidden (`document.visibilitychange`).

**Three-layer rendering model**

```
┌─────────────────────────────────────────────────┐
│  React-Flow nodes & edges (React DOM)           │  ← static, owned by React
├─────────────────────────────────────────────────┤
│  <canvas> overlay (full-bleed, transparent)     │  ← all animations, single rAF loop
├─────────────────────────────────────────────────┤
│  Status badges & peek cards (React, on-demand)  │  ← rare re-renders, portal-mounted
└─────────────────────────────────────────────────┘
```

The middle `<canvas>` is the workhorse. **One `<canvas>` per workflow canvas, not per edge or per node.** A single `requestAnimationFrame` loop:

1. Reads from a `MotionStore` (in-memory, plain JS — not Zustand subscribed).
2. Updates particle positions, ring radii, breathing phase.
3. Draws the frame.
4. Skips entirely when `MotionStore.isEmpty() && breathingDisabled`.

**Particle pool & object reuse**

- Photons, ripples, lightning swipes are all instances of a `MotionPrimitive` discriminated union.
- Pre-allocated pool of 256 primitives. On exhaustion, drop the oldest non-completion primitive (data integrity unaffected — only visual fidelity).
- No per-event `new` allocation in the animation hot path. Garbage-free in steady state.

**Event ingress**

- One `useRealtime` subscription on the canvas page reads the new motion-relevant events (§8.1) and writes to `MotionStore`. Subscription is throttled at the existing `PRESENCE_EVENT_THROTTLE_MS=50` and **coalesces events of the same type for the same node** within the throttle window.
- The store is decoupled from React. Mutations push to a circular event log; the rAF loop drains it once per frame.

**Edge geometry caching**

- Naive: call `path.getPointAtLength(t * total)` per particle per frame → 200 calls × 60fps = 12,000/sec, surprisingly OK in modern browsers but still wasteful.
- Better: on edge layout change, sample each edge's path at 32 evenly-spaced points and cache `Float32Array(64)` of `(x,y)` pairs. Particle position is then a linear interpolation between two cached points. Cache invalidates on node move/edge add. Result: ~100ns per particle per frame.

**Breathing background**

- A single CSS variable `--canvas-breath` updated on the canvas root every 100ms (not every frame) by the same rAF loop. CSS `transition` smooths between updates. Off entirely when no run is active or `prefers-reduced-motion` is set.

**Reduced motion / accessibility**

- `prefers-reduced-motion: reduce` disables: photons, ripples, breathing background, phoenix sweep.
- Status badges & peek cards still update — semantics never depend on motion.
- Settings toggle for users without OS-level reduced-motion.

**Off-screen culling**

- For large graphs the canvas viewport is panned/zoomed. Particles whose endpoints are both off-screen are skipped in the draw step (still updated, since they may re-enter).
- When canvas zoom < 0.4 (overview mode), photons are drawn as static dots per active edge instead of moving particles.

**Telemetry & CI guard**

- The `MotionStore` exposes a `getStats()` returning `{primitivesActive, primitivesDropped, lastFrameMs, p95FrameMs}`.
- Surfaced in the operator dashboard as a small "canvas fps" chip (developer mode only).
- Playwright e2e: a `synthetic-load.spec.ts` instantiates a 30-node run with simulated NODE_STARTED/COMPLETED at 200 events/sec for 10 seconds. Asserts `p95FrameMs <= 20`. CI fails the build if this regresses.

**Mobile / low-end**

- The motion layer auto-degrades on devices reporting `navigator.hardwareConcurrency < 4` or `navigator.deviceMemory < 4`: photons disabled, only badges + ripples.

**Summary**

| Subsystem | Cost when idle | Cost when active |
|---|---|---|
| React-Flow nodes | normal | normal |
| `<canvas>` overlay | 0 (rAF not scheduled) | one rAF, one draw call per frame |
| Status badges | 0 | re-render only on state change (rare) |
| Peek card | 0 | mounted only while hovered |
| Realtime listeners | 1 socket | throttled to 50ms |
| Memory | ~50KB pool | ~50KB pool (no growth) |

The point: animations exist because they make the system feel alive, but they're invisible to the runtime cost model. The engine is not slowed by being beautiful.

**Tests:** vitest for `MotionStore` (pool exhaustion, coalescing); pure-function tests for `pathPoint(cache, t)`; Playwright synthetic-load FPS gate as above.

---

## ✅ 13. Three More 10x Levers

Each is independent, builds on existing infrastructure, and addresses a gap no competing platform closes well.

---

### ✅ 13.1 Surgical Live Edit — "fix it without restarting"

**The problem:** Node fails mid-run → the only option is to fix the saved workflow and restart from scratch. For a 12-step workflow where step 10 fails, that means re-paying 9 nodes worth of cost and wait time.

**What already exists:**
- `applyGraphPatch` (engine line 278) — merges a patch into a live run's graph and increments `graphRevision`.
- `POST /v1/runs/:id/graph-patches` (runs.ts line 101) — HTTP entry point, already wired.
- `baseGraphRevision` conflict detection (engine lines 294–297) — stale-patch protection.
- `#failNode` (engine line 1213) — sets `ns.status = 'FAILED'`, persists, emits `NODE_FAILED`.

The missing piece: a path from `FAILED` back into `readyQueue` driven by a user-initiated edit.

**Engine addition — `retryFailedNode`:**

```ts
// WorkflowEngine.ts  — new public method
async retryFailedNode(args: { runId: string; nodeId: string; resetAttempt?: boolean }): Promise<void> {
  const ctx = this.#runs.get(args.runId);
  if (!ctx || ctx.state.status === 'COMPLETED' || ctx.state.status === 'FAILED' || ctx.state.status === 'CANCELLED')
    throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', 'Run is not active');

  const ns = ctx.state.nodeStates[args.nodeId];
  if (!ns || ns.status !== 'FAILED')
    throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'Node is not in FAILED state');

  // Remove from failedNodeIds, reset status, optionally reset attempt counter.
  ctx.state.failedNodeIds = ctx.state.failedNodeIds.filter(id => id !== args.nodeId);
  ns.status = 'WAITING';
  delete ns.error;
  if (args.resetAttempt) ns.attempt = 0;

  // Re-hydrate input data from the block that was recorded on first dispatch.
  const savedInput = ctx.state.observability?.blockData[args.nodeId]?.input ?? {};
  ctx.state.readyQueue.push({ nodeId: args.nodeId, inputData: savedInput as Record<string, unknown> });

  await this.#persistRun(ctx);
  void this.#tick(ctx);
}
```

**New HTTP endpoint** in runs.ts:

```ts
// POST /v1/runs/:id/retry-node — body: { nodeId, resetAttempt? }
app.post('/:id/retry-node', async (c) => {
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  loadRun(deps.db, ws.workspaceId, id);
  const { nodeId, resetAttempt } = z.object({
    nodeId: z.string(),
    resetAttempt: z.boolean().optional(),
  }).parse(await c.req.json());
  await deps.engine.retryFailedNode({ runId: id, nodeId, resetAttempt });
  return c.json({ ok: true });
});
```

**Intended usage — the two-step surgical flow:**

1. Node reaches `FAILED`. Canvas highlights the node red.
2. Inspector shows **"Edit & Retry"** button (visible only for `FAILED` nodes on an active run).
3. User edits the node config → client calls `POST /v1/runs/:id/graph-patches` with updated node config (existing patch endpoint). `graphRevision` advances.
4. Client immediately follows with `POST /v1/runs/:id/retry-node { nodeId }`.
5. Engine re-queues the node with the patched config. Node transitions `FAILED → WAITING → RUNNING`.
6. Canvas animates a brief `⚕` (surgical) badge over the node for one cycle via a new `NODE_SURGICAL_RETRY` realtime event in `REALTIME_EVENTS`.

After the run completes, a **"Save this fix to the workflow?"** prompt appears. The saved workflow graph is **not** mutated automatically — the patch was run-local until explicitly confirmed.

**Constraints:**
- `retryFailedNode` refuses if run status is terminal (`COMPLETED`, `FAILED`, `CANCELLED`).
- The call is idempotent — if the node is already `WAITING` or `RUNNING`, it no-ops rather than double-queuing.
- `savedInput` is read from `observability.blockData` to avoid re-resolving template variables (result of resolving inputs is recorded at dispatch time per `#startNode`).

**This is impossible in n8n, Zapier, or Temporal Workflow.** A run that fails at step 10 of 12 can be surgically repaired and continued without re-paying steps 1–9.

**New error codes (add to union AND `defaultStatusFor`):** none — reuses `WORKFLOW_RUN_NOT_FOUND` (404) and `WORKFLOW_GRAPH_INVALID` (422).

**Tests:**
- vitest: node fails → `retryFailedNode` re-queues it → run completes; `attempt` resets when `resetAttempt=true`; calling on a terminal run throws `WORKFLOW_RUN_NOT_FOUND`.
- vitest: double-call to `retryFailedNode` on an already-`RUNNING` node is a no-op (no duplicate queue entry).
- e2e: `agents.spec.ts`-style test — workflow with forced failure, calls edit + retry endpoints, asserts run reaches `COMPLETED`.

---

### ✅ 13.2 Context Compression Node — direct token reduction

> **Status:** node ships with `key_filter` + `extractive` modes wired through the engine, plus `llm_summary` mode whose token cost is accounted at the cheapest GPT-4o-mini rate. The summarizer itself is deterministic (head/tail digest) for V1 — swap with a real LLM call by editing `WorkflowEngine.summarizeContext`.

**The problem:** In a multi-agent workflow, by step 5, the accumulated scratchpad and upstream `agent_task` outputs can carry 8,000+ tokens — most irrelevant to the next agent. Every downstream `agent_task` ingests this context verbatim, inflating cost and degrading focus.

**New node kind:** `context_compress`. A pure data-transformation step inserted between a heavy producer and any consumer.

**Type additions in `packages/core/src/types/workflow.ts`:**

```ts
// Add 'context_compress' to the WorkflowNodeKind union.
export type WorkflowNodeKind =
  | 'trigger' | 'agent_task' | 'skill_task' | 'evaluator' | 'guardrails'
  | 'router' | 'merge' | 'checkpoint' | 'response' | 'variables'
  | 'human_in_the_loop' | 'loop' | 'parallel' | 'table' | 'knowledge'
  | 'scratchpad' | 'subflow' | 'wait'
  | 'context_compress';  // ← new

export interface ContextCompressNodeConfig {
  kind: 'context_compress';
  strategy: 'key_filter' | 'extractive' | 'llm_summary';

  // key_filter: pass only these top-level keys from the input object.
  keepKeys?: string[];

  // extractive: cap output at N characters/tokens before passing downstream.
  maxChars?: number;
  extractiveMode?: 'first_n' | 'last_n' | 'key_sentences';

  // llm_summary: use a small model to compress free-form text.
  summaryPrompt?: string;        // optional instruction suffix
  summaryModelId?: string;       // defaults to cheapest available credential model
  preserveStructure?: boolean;   // wrap prose summary back into the original object shape

  // cache policy (reuses Feature 5's NodeCachePolicy — same input → zero cost on repeat)
  cache?: NodeCachePolicy;
}
```

Add `ContextCompressNodeConfig` to the `WorkflowNodeConfig` union alongside the others.

**Engine handler in `#dispatchNode`:**

```ts
case 'context_compress': {
  const result = await this.#executeContextCompress(ctx, node.config, item.inputData);
  await this.#completeNode(ctx, node.id, result);
  return;
}
```

**`#executeContextCompress` — three strategies:**

```ts
async #executeContextCompress(
  ctx: RunningContext,
  cfg: ContextCompressNodeConfig,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {

  switch (cfg.strategy) {
    case 'key_filter': {
      if (!cfg.keepKeys?.length) return input;
      return Object.fromEntries(cfg.keepKeys.filter(k => k in input).map(k => [k, input[k]]));
    }

    case 'extractive': {
      const maxChars = cfg.maxChars ?? 4000;
      return Object.fromEntries(
        Object.entries(input).map(([k, v]) => {
          if (typeof v !== 'string' || v.length <= maxChars) return [k, v];
          if (cfg.extractiveMode === 'last_n') return [k, v.slice(-maxChars)];
          if (cfg.extractiveMode === 'key_sentences') return [k, extractKeySentences(v, maxChars)];
          return [k, v.slice(0, maxChars)]; // first_n default
        }),
      );
    }

    case 'llm_summary': {
      // Delegates to the same adapter pipeline as agent_task but with a
      // small/cheap model and a tightly-scoped single-turn prompt.
      // NodeCachePolicy (Feature 5) applies: same input hash → cached → $0.
      const prompt = `Compress the following into a concise summary${cfg.summaryPrompt ? ': ' + cfg.summaryPrompt : '.'}`;
      const text = JSON.stringify(input);
      const compressed = await this.#runLlmSummary(ctx, cfg, prompt, text);
      return cfg.preserveStructure ? { ...input, _compressed: compressed } : { summary: compressed };
    }
  }
}
```

`extractKeySentences` is a pure function (no LLM) that splits on `. `, scores sentences by unique-word density, and returns the top-scoring sentences up to `maxChars`.

**`#runLlmSummary`** calls the existing adapter pipeline scoped to `summaryModelId` (defaults to cheapest available credential model using the same `MODEL_PRICING_USD_PER_MILLION` table). Cost is accumulated into `observability.costMicros` like any `agent_task`.

**Token accounting:**

After `#executeContextCompress`, the engine emits a new realtime event:

```ts
REALTIME_EVENTS.NODE_COMPRESS_STATS: { runId, nodeId, inputTokensEstimate, outputTokensEstimate, strategy }
```

Inspector "last run" section shows: "6,200 → 420 tokens saved (93% reduction)" using the `blockData` for that node.

**Strategy cost summary:**

| Strategy | Engine cost | LLM call? | Cacheable? |
|---|---|---|---|
| `key_filter` | ~0ms, pure object destructure | No | N/A |
| `extractive` | ~1ms, string slice/sentence split | No | N/A |
| `llm_summary` | Small model (cheapest credential) | Yes | Yes — via `NodeCachePolicy` |

**UX:**
- Palette node: `⊜ Compress` in an "Optimize" section (new palette group, not "Data").
- `key_filter` and `extractive` show an `⌁ free` badge in the estimator (§13.3 if implemented, or inline in inspector).
- The peek card (§12.1) for a running `context_compress` shows the live before/after character count.

**Tests:**
- vitest: `key_filter` passes only declared keys; missing keys are silently dropped.
- vitest: `extractive` with `maxChars=100` truncates strings; short values pass through untouched.
- vitest: `extractive` with `extractiveMode='last_n'` takes tail, not head.
- vitest: `llm_summary` result is cached on second call with identical input (Feature 5 must be landed).
- vitest: `key_filter` with empty `keepKeys` array is a no-op pass-through (defensively safe).
- e2e: workflow with a `context_compress` node between two `agent_task` nodes completes successfully; `blockData` for the compress node records input/output sizes.

---

### ✅ 13.3 Workflow Health Analytics — "know which automations are sick"

**The problem:** A workspace has 12 workflows. Three silently fail 40% of the time. Two cost 3× more than expected. No existing view surfaces this.

**What already exists — all data is already recorded:**
- `workflow_runs.status` (`COMPLETED` | `FAILED` | ...), `started_at`, `completed_at`, `cost_micros` — live in `workflowRuns` drizzle table.
- `workflow_runs.run_state` (JSON) contains `WorkflowRunObservability.blockData` — per-node execution details including `error` text on failed blocks.
- `node_execution_cache.hit_count` — cache hit accumulator (Feature 5).

**Nothing new to store.** This is pure aggregation.

**New endpoint:** `GET /v1/workflows/:id/health?window=7d`

```ts
interface WorkflowHealthReport {
  workflowId: string;
  window: '1d' | '7d' | '30d';
  runCount: number;

  successRate: number;           // COMPLETED / total — 0 to 1
  avgDurationMs: number;         // avg(completedAt - startedAt) for COMPLETED runs
  p95DurationMs: number;         // 95th-percentile duration
  avgCostCents: number;          // avg(costMicros) / 10_000
  totalCostCents: number;        // sum(costMicros) / 10_000

  cacheHitRate: number;          // sum(hit_count) / (sum(hit_count) + miss_count) — approximated from node_execution_cache

  mostFailingNode: {
    nodeId: string;
    nodeTitle: string;
    failureCount: number;
    topError: string;            // most frequent error string, extracted from blockData
  } | null;

  trend: 'improving' | 'stable' | 'degrading';
  // Computed by comparing successRate of the first half vs second half of the window.

  suggestions: string[];
  // Pure code logic — no LLM. See suggestion rules below.
}
```

**Suggestion rules (all pure TypeScript, zero LLM cost):**

```ts
// In the route handler, after aggregation:
if (report.successRate < 0.7 && !graph.nodes.find(n => n.config.retryPolicy))
  suggestions.push(`Success rate is ${pct(report.successRate)}. Add a retry policy to "${report.mostFailingNode?.nodeTitle ?? 'failing nodes'}".`);

if (report.cacheHitRate < 0.1 && report.avgCostCents > 5)
  suggestions.push(`Expensive workflow (avg $${report.avgCostCents.toFixed(2)}/run) with no cache hits. Enable NodeCachePolicy on deterministic skill/agent nodes.`);

if (report.avgDurationMs > 60_000 && graph.nodes.some(n => n.config.kind === 'agent_task' && !n.config.timeoutMs))
  suggestions.push(`Average run exceeds 60s. Set timeoutMs on agent nodes to prevent silent hangs.`);

if (report.mostFailingNode && report.mostFailingNode.failureCount / report.runCount > 0.5)
  suggestions.push(`Node "${report.mostFailingNode.nodeTitle}" fails in more than half of all runs. Investigate: "${report.mostFailingNode.topError}".`);
```

**`mostFailingNode` extraction:**

The `run_state` JSON column already has `observability.blockData` — a map from `nodeId` to block info including `error`. A single SQLite query loads `run_state` for all failed runs in the window; the route handler aggregates error counts in memory and surfaces the top offender. For V1 (small workspaces), this is fast enough. Window it behind `runCount <= 500` with a note to add a materialized `node_failures` table when usage grows.

**Trend detection:**

Split the window in half (e.g. 7d → two 3.5d halves). If `successRate(second_half) > successRate(first_half) + 0.05` → `improving`. If the difference is < ±0.05 → `stable`. Otherwise → `degrading`.

**UX surface:**

1. **Workflow card health dot.** A 10px dot in the card's top-right corner:
   - Green: `successRate ≥ 0.9`
   - Amber: `successRate 0.6–0.9`
   - Red: `successRate < 0.6`
   - Grey: fewer than 3 runs in the window (insufficient data).
   The dot is fetched with a lightweight `GET /v1/workflows/:id/health?window=7d&summary=true` that returns only `{ successRate, runCount, trend }` — no full aggregation.

2. **Inspector "Analytics" tab.** Full `WorkflowHealthReport` rendered as:
   - Sparkline of success rate across the window (one point per day).
   - Cost bar: avg / p95 / trend arrow.
   - Cache hit donut (if Feature 5 is landed).
   - Suggestions list with actionable copy.

3. **HomePage "Needs attention" strip.** Workflows with `successRate < 0.6` and `runCount ≥ 3`, sorted by run frequency descending. Title: "Workflows that need attention." Hidden when empty.

4. **Doctor script integration.** The existing `scripts/agentis-doctor.ts` adds a health check: for each workflow with ≥ 5 runs in the last 7 days, report health score (`successRate * 100`). Flag workflows below 70 as warnings.

**Zero new DB tables. Zero new infrastructure.** The implementation is one route handler and one plain aggregation function.

**New error codes:** none — reuses `WORKFLOW_NOT_FOUND` (404).

**Tests:**
- vitest: seeded run history (5 COMPLETED, 3 FAILED, 2 with same failing nodeId) → asserts correct `successRate`, `mostFailingNode`, `failureCount`.
- vitest: trend detection — first half 80% success, second half 50% → `degrading`.
- vitest: suggestion fires for `successRate=0.4` with no retry policy in the graph.
- vitest: `window=1d` only includes runs within the last 24 hours.
- e2e: creates workflow, triggers 4 COMPLETED + 2 FAILED runs via API, hits `/health` endpoint, asserts `successRate ≈ 0.67` and card dot renders amber.

---

