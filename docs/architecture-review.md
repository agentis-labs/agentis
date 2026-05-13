# Agentis Architecture and Performance Review

Date: 2026-05-11
Scope: whole monorepo audit across `apps/api`, `apps/web`, `packages/core`, `packages/db`, `packages/integrations`, runtime wiring, database access patterns, frontend render cost, realtime behavior, technical debt, and deletion candidates.

This review is intentionally direct. The dominant performance problem is not one hot loop. It is architectural drift: several product eras coexist in the same build, the canonical schema and event contracts no longer match large parts of the codebase, and many runtime surfaces compensate by refetching or scanning far more data than they need.

## Executive Summary

Agentis currently looks like a promising local-first prototype with a production-shaped surface area, but it is not yet a production-scalable multi-tenant system. The codebase contains an embedded SQLite-only runtime, in-process workflow execution, in-process realtime fan-out, synchronous data access, eager service construction, duplicated UI implementations, stale routes/services/pages, and broad type contract drift.

The biggest finding is build health: both the web and API typechecks fail. The failures are not cosmetic. They show missing schema tables, missing realtime event constants, missing store fields, missing exports, stale feature services, and code that still assumes older contracts. This is a critical maintainability and delivery problem because dead or half-integrated layers remain compiled with active code.

The second biggest finding is database inefficiency. Multiple hot endpoints load entire workspace tables and filter, sort, rank, count, or paginate in JavaScript. This appears in runs, dashboard aggregates, command search, ledger events, scheduler queue logic, knowledge retrieval, and app memory recall. That pattern is acceptable for seed data, but it becomes a CPU/RAM/latency wall with real workspaces.

The third biggest finding is realtime/network amplification. Global frontend widgets independently fetch overlapping data on mount, timers, and realtime events. A single run/approval/conversation event can trigger Home, LiveStrip, Sidebar, NotificationPanel, and chat refreshes. This multiplies API load and battery usage while still being less accurate than a single normalized cache or summary stream.

The fourth biggest finding is overbuilt feature scaffolding. There are services, pages, route builders, schema references, and UI trees for teams, scheduler, spaces, budget, MCP, issues, routines, workflow graph revisions, telemetry spans, and a richer uppercase ChatPanel. Many are unmounted, partially wired, or incompatible with the current canonical schema/events. These layers should be deleted, moved behind a separate experimental boundary, or finished with real schema and route integration. Leaving them in the main compile path is expensive and confusing.

Priority order:

1. Restore green typecheck/build by deleting or isolating stale feature trees and reconciling schema/event contracts.
2. Decide the product boundary: embedded single-user/local-first vs hosted multi-tenant. The current runtime cannot be both.
3. Push filtering, sorting, counting, pagination, and search into the database with indexes and projections.
4. Replace frontend refetch fan-out with one query/cache/realtime invalidation layer.
5. Split route bundles and lazy-load heavy pages such as canvas, brain, packages, and chat.
6. Simplify duplicated chat/package/app/scheduler abstractions before adding new performance features.

## Critical Problems

### C1. The main application does not typecheck

- What it is: `pnpm --filter @agentis/web exec tsc --noEmit --pretty false` fails with missing store fields, missing realtime constants, missing API exports, and stale component imports. `pnpm --filter @agentis/api exec tsc --noEmit --pretty false` fails with missing schema tables, missing event constants, missing OpenTelemetry dependency, stale service APIs, and invalid error codes.
- Evidence: web failures include `components/ChatPanel/ChatPanel.tsx` referencing `chatPanelOpen`, `chatPanelThreadId`, `setChatPanelOpen`, `openChatThread`, and `toggleChatPanel` that are not in `apps/web/src/store/agentisStore.ts`; `components/ChatPanel/ThreadView.tsx` imports non-existent `streamSse`; multiple files reference missing `REALTIME_EVENTS.*` members. API failures include services referencing absent SQLite schema tables such as `teams`, `routines`, `issues`, `budgetEvents`, `workflowRunQueue`, `workflowNodes`, `workflowGraphRevisions`, `mcpServers`, `evalSuites`, and `dataIngestionJobs`.
- Why it exists: feature work appears to have advanced ahead of the canonical schema/core contracts, while old feature slices stayed inside `src/**/*` instead of being removed or isolated.
- Real-world impact: no trustworthy release pipeline, no safe refactor loop, no accurate bundle/build measurement, and no way to distinguish product code from abandoned scaffolding.
- Affects: DX, Maintainability, Scalability, CPU indirectly through stale compiled/analyzed code.
- Severity: Critical.
- Recommendation: make typecheck the release gate. Either finish the missing contracts or delete/move stale services/components out of the compiled app. Start with uppercase `components/ChatPanel`, workspace switcher legacy components, scheduler/teams/issues/routines/budget/MCP/evals/data ingestion services that reference absent schema.
- Simpler architecture: one compiled product surface per package. Experimental code lives under a separate package, feature flag build, or docs/prototypes folder that is not included by `tsconfig`.
- Estimated gain: restores deployability; reduces engineering cycle time dramatically; avoids chasing runtime bugs caused by stale contracts.
- Action: remove, simplify, isolate, then enforce CI typecheck.
- Classification: legacy code, overengineering, contract drift, feature scaffolding leakage.

### C2. Hosted/standard mode is scaffolded but not implemented

- What it is: the API database factory only supports embedded SQLite. Standard/Postgres mode throws at runtime with a message that the engine wiring is incomplete in V1.
- Evidence: `apps/api/src/db.ts` selects embedded SQLite and throws for standard/Postgres mode; `packages/db/src/pg` exists but is not wired through the active engine/services.
- Why it exists: the codebase carries a dual architecture story, but operational code was finished only for the embedded path.
- Real-world impact: multi-tenant hosted scale, horizontal API replicas, cross-process workflow execution, and durable realtime fan-out are blocked. Any deployment that expects Postgres/Supabase semantics is misleading until the engine and services use the async database path.
- Affects: Scalability, RAM, CPU, Network, Maintainability, DX.
- Severity: Critical.
- Recommendation: choose one near-term architecture. If V1 is local-first, delete or clearly mark standard mode as future work and stop carrying false production assumptions. If hosted is required, create a real Postgres/Supabase adapter and port services away from sync SQLite and in-memory process state.
- Simpler architecture: local-first V1 uses embedded SQLite, one API process, and explicit limits. Hosted V2 uses Postgres, a queue, external pub/sub, and stateless API workers.
- Estimated gain: avoids months of ambiguous optimization; sets correct performance targets and tenant isolation model.
- Action: defer or rewrite, depending on product decision.
- Classification: overengineering, premature architecture, incomplete abstraction.

### C3. Core runtime is single-process and stateful

- What it is: workflow execution, active run tracking, realtime events, and socket rooms are process-local.
- Evidence: `apps/api/src/engine/WorkflowEngine.ts` keeps active runs in memory; `apps/api/src/event-bus.ts` is an EventEmitter; `apps/api/src/websocket/rooms.ts` bridges that in-process bus to Socket.IO rooms.
- Why it exists: the system optimized for a compact prototype loop and avoided operational dependencies.
- Real-world impact: multiple API instances cannot safely share work. A process crash can lose active in-memory state. Realtime events do not cross instances. Queue ownership, scheduling, and long-running workflow safety cannot be guaranteed.
- Affects: Scalability, RAM, CPU, Network, Maintainability.
- Severity: Critical for hosted multi-tenant; acceptable only for local single-node V1.
- Recommendation: either codify single-node local limits or introduce durable queue ownership, distributed locks, external pub/sub, and idempotent workflow step execution before marketing hosted concurrency.
- Simpler architecture: API workers are stateless; workflow workers pull from a queue; Postgres stores run state and ledger deltas; Redis/NATS/Postgres NOTIFY broadcasts realtime summaries.
- Estimated gain: unlocks horizontal scale and crash recovery; prevents duplicate/missing workflow execution under load.
- Action: rewrite for hosted mode, or defer and document local-only constraints.
- Classification: framework misuse for production, prototype architecture, scalability debt.

### C4. Hot API paths load full tables and compute in JavaScript

- What it is: many backend routes/services call `.all()` or equivalent broad list functions, then filter, sort, count, rank, or paginate in Node.
- Evidence: `apps/api/src/routes/runs.ts` selects all workflow runs for a workspace and sorts/slices in JS while ignoring the `status` query; `apps/api/src/routes/dashboard.ts` loads agents, gateways, runs, workflows, approvals and computes fleet counts in memory; `apps/api/src/services/commandIndex.ts` reads workflows, agents, gateways, runs, approvals, and skills every search; `apps/api/src/services/ledger.ts` filters/sorts ledger rows in JS; scheduler/knowledge/memory services contain similar patterns.
- Why it exists: early datasets were small and service methods favored convenience over query shape.
- Real-world impact: latency grows linearly with workspace history, memory spikes per request, SQLite sync calls block the event loop, and frontend polling/realtime fan-out multiplies the damage.
- Affects: CPU, RAM, Network, Battery, Scalability, DX.
- Severity: High to Critical depending on tenant size.
- Recommendation: push `where`, `orderBy`, `limit`, `offset/cursor`, aggregates, and projections into SQL. Add indexes for workspace/status/createdAt/runId/sequenceNumber. Return only fields the UI needs.
- Simpler architecture: repository methods expose explicit query use cases such as `listRuns({ workspaceId, status, limit, cursor })`, `countRunsByStatus(workspaceId)`, `listLedgerEventsAfter(runId, sequence, limit)`, not generic all-row loaders.
- Estimated gain: 10x to 100x less row materialization on large workspaces; lower event-loop blocking and tail latency.
- Action: server-side, cache, rewrite query layer.
- Classification: prototype shortcut, framework misuse, scalability debt.

### C5. Realtime triggers cause request storms instead of state deltas

- What it is: frontend components independently refetch broad endpoint sets on the same realtime events.
- Evidence: `apps/web/src/pages/HomePage.tsx` fetches six endpoints on mount and on run/approval/artifact events; `LiveStrip.tsx` fetches dashboard and activity; `Sidebar.tsx` fetches agents and runs and polls every 30s; `NotificationPanel.tsx` fetches approvals and failed runs; active chat refreshes entire message threads on message events.
- Why it exists: realtime is used as an invalidation bell, but there is no shared query cache, no event-specific reducer, and no central dashboard summary store.
- Real-world impact: one event can fan out into a dozen HTTP requests. On mobile or slow networks, the UI burns battery and bandwidth while also racing old/new responses.
- Affects: Network, CPU, RAM, Battery, Scalability, DX.
- Severity: High.
- Recommendation: introduce a single data cache/invalidation layer. Normalize event payloads so simple counters/lists update locally. Throttle/coalesce dashboard invalidations. Use one `/v1/dashboard/snapshot` or websocket summary for shell-wide status.
- Simpler architecture: shell owns one workspace summary subscription; feature pages subscribe to cached queries; events carry minimal deltas and invalidate by key.
- Estimated gain: 60% to 90% fewer shell requests during active runs; less backend CPU and lower mobile battery drain.
- Action: cache, merge, simplify.
- Classification: copy-paste fetch logic, over-fetching, cache misuse.

### C6. Realtime room lifecycle and auth lifecycle are incomplete

- What it is: the web uses a singleton Socket.IO client; subscriptions join rooms but do not leave them; token/workspace changes do not reset the socket; several subscription calls omit required workspace arguments.
- Evidence: `apps/web/src/lib/realtime.ts` keeps `sharedSocket`, registers component handlers, and exposes `rtSubscribe` with no unsubscribe/leave path. Uppercase chat code calls `rtSubscribe('conversation', { agentId })`, while backend room subscriptions expect workspace context. Socket auth is set only when the singleton is created.
- Why it exists: listener cleanup was implemented at the component event-handler level, but server room membership and auth state were treated as session-global.
- Real-world impact: stale workspace rooms can remain joined until disconnect, logout/login in the same tab can reuse old socket auth, and some resource subscriptions silently fail. This produces missed messages, extra events, and possible cross-session confusion.
- Affects: Network, CPU, RAM, Battery, Scalability, Maintainability.
- Severity: High.
- Recommendation: make `useRealtimeSubscription(kind, args)` return a server-side leave on cleanup; key sockets by auth token/workspace; disconnect on logout; update auth before reconnect; require typed subscription args.
- Simpler architecture: one workspace socket context owns connection lifecycle; feature hooks subscribe by typed room descriptors and always clean up.
- Estimated gain: prevents leaked rooms/listeners; reduces duplicate event delivery; improves realtime correctness.
- Action: rewrite subscription API, simplify lifecycle.
- Classification: framework misuse, lifecycle leak, contract drift.

### C7. Workflow engine serializes too much state and payload

- What it is: workflow execution persists and emits broad run state/output payloads while also keeping active run state in memory and scanning graph arrays for transitions.
- Evidence: `apps/api/src/engine/WorkflowEngine.ts` stores active runs in `#runs`, persists full run state, appends ledger/output payloads, and computes next steps from node/edge arrays.
- Why it exists: full-state snapshots make the prototype easier to debug and replay.
- Real-world impact: long runs or verbose nodes increase JSON serialization cost, database write volume, websocket payload size, RAM pressure, and event-loop blocking. Graph traversal becomes increasingly inefficient as workflows grow.
- Affects: CPU, RAM, Network, Scalability, Battery.
- Severity: High.
- Recommendation: persist compact state deltas and indexed per-node status. Precompute adjacency maps per workflow revision. Emit summarized realtime events and let details be fetched by cursor.
- Simpler architecture: immutable workflow revision, adjacency map, durable step queue, append-only small ledger events, and paged detail retrieval.
- Estimated gain: 3x to 20x less serialization/write traffic for long workflow runs; lower websocket overhead.
- Action: rewrite, server-side, cache.
- Classification: prototype observability shortcut, serialization overhead, scalability debt.

## Performance Bottlenecks

### P1. Command palette performs multi-table backend scans per keystroke

- What it is: the web command palette hits `/v1/command/search` after an 80 ms debounce, including empty or tiny queries, and the backend searches six collections in memory.
- Evidence: `apps/web/src/components/CommandPalette.tsx` debounces query changes and calls the API; `apps/api/src/services/commandIndex.ts` loads workflows, agents, gateways, runs, approvals, and skills and applies JS substring scoring.
- Why it exists: the command palette is implemented as remote global search without an index or minimum query threshold.
- Real-world impact: fast typing can create a backend scan stream. Empty query becomes a broad discovery query. On larger tenants, this becomes one of the easiest ways to induce CPU and RAM spikes.
- Affects: CPU, RAM, Network, Battery, Scalability.
- Severity: High.
- Recommendation: do not query the server for empty/short input; cache static command targets client-side; build a lightweight SQL FTS/search index or precomputed command index; return capped projections only.
- Simpler architecture: local command registry for navigation/actions plus server search only for `query.length >= 2` or `>= 3`, with indexed SQL.
- Estimated gain: 80% to 99% fewer command-search requests during normal palette use; 10x+ lower backend CPU for search.
- Action: cache, server-side index, simplify.
- Classification: framework misuse, over-fetching, premature remote search.

### P2. Runs API ignores status filtering and paginates after loading

- What it is: frontend callers use `?status=running` and `?status=failed`, but the backend list path loads runs and filters/sorts/slices in memory. The status query is not honored as a database predicate.
- Evidence: `apps/web/src/pages/HomePage.tsx` and `Sidebar.tsx` call `/v1/runs?status=...`; `apps/api/src/routes/runs.ts` loads all workspace runs and performs JS sorting/slicing.
- Why it exists: route parameters and service query capabilities drifted apart.
- Real-world impact: running/failed widgets become more expensive as completed run history grows. Counts can be wrong if status is ignored. This also pollutes dashboard and sidebar refreshes.
- Affects: CPU, RAM, Network, Scalability, Maintainability.
- Severity: High.
- Recommendation: add a typed query schema and enforce `status`, `limit`, and cursor at the SQL layer. Add indexes on `(workspaceId, status, createdAt)`.
- Simpler architecture: `runRepository.list({ workspaceId, status, limit, cursor })` is the only path used by routes/widgets.
- Estimated gain: 10x to 100x less data loaded for historical workspaces.
- Action: server-side, rewrite query.
- Classification: API contract drift, copy-paste query logic.

### P3. Dashboard aggregate endpoint materializes whole tables

- What it is: fleet overview computes counts and recent activity by loading multiple full lists.
- Evidence: `apps/api/src/routes/dashboard.ts` loads agents, gateways, runs, workflows, and approvals, then computes aggregate counts in JS.
- Why it exists: a single route was used as a convenient composition layer.
- Real-world impact: every shell or LiveStrip refresh can force unnecessary row materialization. As workspaces grow, dashboard becomes a recurring CPU/RAM tax.
- Affects: CPU, RAM, Network, Scalability.
- Severity: High.
- Recommendation: replace with SQL aggregate queries and narrow projections. Cache the resulting workspace summary for a short TTL or update it from run/approval events.
- Simpler architecture: `workspace_summary` read model or `SELECT COUNT(*) ... GROUP BY status` queries, not full object hydration.
- Estimated gain: 5x to 50x less backend work per dashboard refresh.
- Action: server-side, cache.
- Classification: prototype shortcut, over-fetching.

### P4. Ledger and long-run history use memory pagination

- What it is: ledger reads all events for a run, filters by sequence, sorts, and slices in memory despite comments implying cursor pagination.
- Evidence: `apps/api/src/services/ledger.ts` `listForRun()` logic.
- Why it exists: append-only event history began small and pagination was added at API shape level before storage query optimization.
- Real-world impact: long-running workflows become progressively slower to inspect. Replay, timeline, and polling endpoints can consume large memory bursts.
- Affects: CPU, RAM, Network, Scalability.
- Severity: High.
- Recommendation: query `WHERE run_id = ? AND sequence_number > ? ORDER BY sequence_number ASC LIMIT ?` with an index on `(runId, sequenceNumber)`.
- Simpler architecture: ledger is a real cursor stream, not an array slice.
- Estimated gain: near-constant memory per request; 10x+ faster for long histories.
- Action: server-side query rewrite.
- Classification: incomplete pagination, scalability debt.

### P5. Knowledge and memory retrieval score all rows in Node

- What it is: app knowledge and app memory recall load broad candidate sets and perform lexical/vector/hybrid scoring in JavaScript.
- Evidence: `apps/api/src/services/knowledgeStore.ts` and `apps/api/src/services/appMemoryStore.ts` load rows and score them process-side.
- Why it exists: retrieval logic was implemented without committing to a proper FTS/vector index.
- Real-world impact: retrieval latency and memory grow with every imported document/memory. At 10k+ chunks per app, this competes directly with workflow execution in the same event loop.
- Affects: CPU, RAM, Scalability, Battery indirectly through slower UI.
- Severity: Medium to High.
- Recommendation: use SQLite FTS5 for embedded mode, Postgres `tsvector`/pgvector or Supabase vector search for hosted mode, and always prefilter by workspace/app/source/time.
- Simpler architecture: retrieval service asks storage for top-N candidates and only reranks a bounded set in Node.
- Estimated gain: 10x to 100x less CPU for large knowledge bases.
- Action: server-side, cache, rewrite retrieval index.
- Classification: premature custom search, framework misuse.

### P6. Frontend shell duplicates data ownership

- What it is: Home, LiveStrip, Sidebar, NotificationPanel, chat header, and command palette each own their own fetch/refresh logic for overlapping workspace state.
- Evidence: `HomePage.tsx`, `LiveStrip.tsx`, `Sidebar.tsx`, `NotificationPanel.tsx`, lowercase `components/chat/ChatPanel.tsx`, and uppercase `components/ChatPanel/ChatPanel.tsx` all fetch related conversation/run/approval/agent state independently.
- Why it exists: components were built independently without a shared workspace data boundary.
- Real-world impact: duplicate requests, duplicate state, inconsistent counts, repeated JSON parsing, and avoidable rerenders.
- Affects: CPU, RAM, Network, Battery, Maintainability.
- Severity: High.
- Recommendation: introduce one workspace data layer for shell summaries and feature caches. Use stable query keys and event-specific invalidation.
- Simpler architecture: `WorkspaceDataProvider` or a small query client owns agents/runs/approvals/conversations summaries; UI widgets render selectors.
- Estimated gain: 50% to 80% fewer duplicate shell requests; less UI jitter.
- Action: merge, cache, simplify.
- Classification: copy-paste logic, cache misuse.

### P7. Chat threads refetch full lists on every message event

- What it is: active chat refreshes entire thread/room message lists on realtime message events and after send/edit/delete.
- Evidence: `apps/web/src/components/chat/ThreadView.tsx` maps the full returned message list into local state on refresh; `useRealtime` calls `refresh()` for conversation and room message events.
- Why it exists: list refresh is simpler than optimistic append/reconcile.
- Real-world impact: large conversations pay full network, parse, diff, and render cost for every new message. Smooth scrolling and mobile battery suffer.
- Affects: CPU, RAM, Network, Battery, DOM rendering.
- Severity: Medium to High.
- Recommendation: paginate messages, append realtime deltas by message id, invalidate only on edit/delete, and virtualize old messages.
- Simpler architecture: message store keyed by thread, cursor-paged fetch, realtime append/update/delete reducers.
- Estimated gain: 70%+ less chat network and render work on active conversations.
- Action: cache, virtualize, simplify reducer.
- Classification: over-fetching, prototype shortcut.

### P8. Heavy UI routes are eagerly imported into the first bundle

- What it is: `App.tsx` statically imports all major pages and global widgets, including canvas, packages, brain, chat, dashboard, workflow, and app surfaces.
- Evidence: `apps/web/src/App.tsx` imports all page modules directly before route selection.
- Why it exists: simple route table implementation without route-level code splitting.
- Real-world impact: first load pays parse/evaluate cost for rarely used screens. `@xyflow/react`, canvas logic, package views, and rich shell widgets are likely in the initial JS path.
- Affects: CPU, RAM, Network, Battery, frontend rendering, PWA startup.
- Severity: Medium to High.
- Recommendation: use `React.lazy`/dynamic imports per route and lazy-load heavyweight panels. Split canvas/brain/packages/chat into separate chunks.
- Simpler architecture: small authenticated shell bundle plus lazy route modules.
- Estimated gain: likely 30% to 60% smaller initial JS, depending on Vite chunk output.
- Action: simplify, defer, bundle split.
- Classification: framework misuse, premature monolith.

### P9. Workflow canvas autosaves full graph payloads and mutates compatibility data on the client

- What it is: canvas state, graph editing, runtime compatibility mutation, and persistence live in one large page. Save operations send broad workflow graph payloads and use `setTimeout(syncAndSave, 0)` style scheduling.
- Evidence: `apps/web/src/pages/WorkflowCanvasPage.tsx` owns graph state, `queueSave`, `syncAndSave`, `saveNow`, and auto-binding/runtime patch behavior.
- Why it exists: canvas UX evolved rapidly and absorbed persistence/orchestration concerns.
- Real-world impact: every graph change can produce large JSON serialization and PATCH cost. Client-side compatibility mutation creates stale closure/race risk and makes server state less authoritative.
- Affects: CPU, RAM, Network, Battery, Maintainability.
- Severity: Medium to High.
- Recommendation: move graph normalization/compatibility to the server, save diffs or debounced revisions, and isolate canvas editor state from persistence commands.
- Simpler architecture: client edits local graph; server accepts validated graph diff/revision; compatibility migration runs once on read/write server-side.
- Estimated gain: 50% to 90% less network payload for large workflows; fewer save races.
- Action: server-side, simplify, rewrite persistence boundary.
- Classification: overengineering, framework misuse, serialization overhead.

### P10. High-frequency store updates replace whole maps

- What it is: presence and active run updates copy entire maps with object spread on every event.
- Evidence: `apps/web/src/store/agentisStore.ts` `upsertPresence` and `upsertActiveRun` spread the full object.
- Why it exists: immutable updates are idiomatic, but high-frequency maps need narrower selectors and bounded update frequency.
- Real-world impact: each event changes the map identity and can rerender broad subscribers. With many agents/runs, GC pressure increases.
- Affects: CPU, RAM, Battery, frontend rendering.
- Severity: Medium.
- Recommendation: use keyed selectors, store slices, shallow subscriptions, or event batching. Consider `Map` plus version counters only if compatible with existing React patterns.
- Simpler architecture: event reducers update a normalized store; widgets select only the ids/counters they display.
- Estimated gain: modest at current scale, meaningful with many live agents/events.
- Action: simplify, cache, batch.
- Classification: framework misuse under high frequency.

## Unnecessary Complexity

### U1. Two chat panel implementations compete

- What it is: active app shell imports lowercase `components/chat/ChatPanel`, while uppercase `components/ChatPanel` contains a richer but stale implementation.
- Evidence: `apps/web/src/App.tsx` imports lowercase chat. `apps/web/src/components/ChatPanel/index.ts` exports uppercase chat. Uppercase chat references missing store fields and imports missing APIs/components.
- Why it exists: a previous UI phase was superseded but not deleted.
- Real-world impact: typecheck failures, duplicated UX concepts, duplicated fetch/realtime logic, and developer uncertainty about which panel is canonical.
- Affects: DX, Maintainability, CPU/Network indirectly through duplicate code paths if revived.
- Severity: High because it currently breaks typecheck.
- Recommendation: delete uppercase `components/ChatPanel` or merge only the desired features into lowercase chat after restoring contracts.
- Simpler architecture: one chat dock, one chat store, one message data layer.
- Estimated gain: immediate build-health improvement; lower bundle/analyzer noise; simpler future chat work.
- Action: remove or merge.
- Classification: legacy code, duplicate logic, copy-paste.

### U2. Package persistence has two models

- What it is: package library/import/install code carries both new `libraryPackages` and legacy `agentPackages` behavior. `install-local` writes legacy state while get/delete fall back across models.
- Evidence: `apps/api/src/routes/packages.ts` and `apps/api/src/services/packager.ts`.
- Why it exists: migration from agent-scoped packages to library packages was left in compatibility mode.
- Real-world impact: extra branches, duplicated semantics, confusing API behavior, extra JSON cloning/stable stringify overhead, and higher bug risk around delete/install consistency.
- Affects: CPU, RAM, Maintainability, DX.
- Severity: Medium.
- Recommendation: pick the canonical package model and write a one-way migration. Remove fallback behavior after migration.
- Simpler architecture: library package is the source of truth; installs are references with explicit version/pin fields.
- Estimated gain: lower maintenance cost; less serialization and fewer fallback queries.
- Action: remove, merge, simplify.
- Classification: legacy code, migration debt.

### U3. App endpoints return permissive stubs for missing packages

- What it is: app/package loading can produce placeholder/default data instead of failing when a package id is missing.
- Evidence: `apps/api/src/routes/apps.ts` `loadAppPackage()` behavior and endpoints returning empty arrays/defaults.
- Why it exists: UI scaffolding needed non-crashing responses while app-canvas features were incomplete.
- Real-world impact: data integrity bugs hide behind successful responses. Operators can see ghost apps or empty capability surfaces instead of actionable errors.
- Affects: Maintainability, DX, Network indirectly through retries/confusion.
- Severity: Medium.
- Recommendation: fail fast with typed 404/409 errors for missing package references. Seed demo data explicitly instead of returning generic stubs.
- Simpler architecture: package id either resolves to a real package or the API returns a clear error.
- Estimated gain: fewer hidden state bugs and easier debugging.
- Action: simplify, remove stubs.
- Classification: cargo-cult resilience, scaffolding leakage.

### U4. Bootstrap eagerly constructs nearly every service

- What it is: the API composition root creates many optional services and route dependencies on startup even when feature routes are unmounted or broken.
- Evidence: `apps/api/src/bootstrap.ts` constructs memory, intelligence, brain, channel, package, tool, workflow, and other layers; scheduler/event chain classes exist but are not instantiated.
- Why it exists: centralized composition made feature wiring convenient.
- Real-world impact: startup cost, RAM footprint, dependency coupling, and test complexity grow with every feature. Broken services can poison the whole app even when the product does not expose them.
- Affects: RAM, CPU, DX, Maintainability.
- Severity: Medium.
- Recommendation: split composition by product slice and only instantiate mounted, healthy routes. Optional features should register through explicit modules with health checks.
- Simpler architecture: core API module plus feature modules with `register(app, deps)` and separate test/build gates.
- Estimated gain: lower startup memory and fewer cross-feature failures.
- Action: simplify, defer, isolate.
- Classification: overengineering, dependency bloat.

### U5. Magic realtime strings and constants coexist

- What it is: some frontend components use raw event strings while others import `REALTIME_EVENTS` from core. Several code paths reference event constants that no longer exist.
- Evidence: `HomePage.tsx`, `LiveStrip.tsx`, `Sidebar.tsx`, `NotificationPanel.tsx` use magic strings in several subscriptions; compiler failures show missing `REALTIME_EVENTS.CANVAS_*`, `SPACE_*`, `TEAM_*`, and other constants.
- Why it exists: event taxonomy changed while call sites were updated unevenly.
- Real-world impact: silent missed events, unnecessary refetches from broad subscriptions, type errors, and difficult debugging.
- Affects: Network, CPU, Maintainability, DX.
- Severity: High because it contributes to build failure and realtime unreliability.
- Recommendation: define one event catalog with payload schemas and generated TypeScript subscription types. Remove raw event strings from app code.
- Simpler architecture: `subscribe(REALTIME_EVENTS.RUN_UPDATED, payload => ...)` with typed payload and route-owned invalidation keys.
- Estimated gain: correctness more than raw speed; also reduces accidental refetch fan-out.
- Action: merge, simplify, rewrite types.
- Classification: contract drift, copy-paste, framework misuse.

## Dead Code & Legacy Remnants

### D1. Unmounted frontend pages and stale workspace components remain compiled

- What it is: pages/components exist without active routes or compatible store contracts.
- Evidence: pages such as `TeamsPage`, `ArtifactsPage`, `LedgerPage`, and `ChatDeploymentPage` were found without active routes in `App.tsx`; workspace switcher/card/context components reference missing store exports/fields.
- Why it exists: product experiments were left in the source tree.
- Real-world impact: TypeScript failures, larger source analysis surface, potential accidental imports, and unclear product navigation.
- Affects: DX, Maintainability, bundle risk.
- Severity: High where they fail typecheck; Medium otherwise.
- Recommendation: delete unmounted pages or move them to an experimental package excluded from app build. If a page is intended to ship, mount it and make its API/schema contracts real.
- Simpler architecture: only routed, tested pages live in `apps/web/src/pages`.
- Estimated gain: immediate compile cleanup and lower cognitive load.
- Action: remove or finish.
- Classification: legacy remnants, overengineering.

### D2. Unmounted or broken API services reference absent schema

- What it is: services for teams, scheduler, issues, routines, budget, data ingestion, evals, MCP, policies, file storage, workflow graph revisions, and workflow deployments reference schema tables that are absent from the active SQLite schema.
- Evidence: API typecheck output lists many `Property ... does not exist on type schema` errors across these services.
- Why it exists: future platform capabilities were added before migrations/schema exports were made canonical.
- Real-world impact: no green build, no accurate backend dependency graph, and high risk that route mounting later will expose broken code.
- Affects: DX, Maintainability, Scalability.
- Severity: Critical for build health.
- Recommendation: delete or quarantine unshipped services. For capabilities that matter, add the schema/migration/tests first, then service, then route.
- Simpler architecture: schema-first feature development with one migration and one mounted route at a time.
- Estimated gain: restores backend compile; reduces future integration failures.
- Action: remove, defer, rewrite.
- Classification: scaffolding leakage, overengineering.

### D3. Scheduler and event-chain architecture is present but runtime-absent

- What it is: scheduler/event-chain services exist, but bootstrap does not instantiate them, and their code references missing schema and engine methods.
- Evidence: `apps/api/src/services/scheduler.ts` defines queue/schedule logic; searches found no active bootstrap instantiation; compiler output shows missing `scheduleRuns`, `workflowRunQueue`, `workflowEventSubscriptions`, `drainWorkflowQueue`, and event constants.
- Why it exists: planned workflow automation layer was started before the durable queue/storage model.
- Real-world impact: product docs/UI may imply scheduling, but runtime cannot deliver it. If enabled naively, it would scan/filter/sort in process and would not be distributed-safe.
- Affects: CPU, RAM, Scalability, Maintainability.
- Severity: High.
- Recommendation: remove until queue architecture is ready, or implement a minimal durable schedule table with indexed due-time polling and ownership locks.
- Simpler architecture: one `scheduled_jobs` table with `next_run_at`, `locked_by`, `locked_until`, and a worker loop; no event-chain abstraction until use cases demand it.
- Estimated gain: avoids carrying dead automation code and prevents a future inefficient scheduler launch.
- Action: defer or rewrite.
- Classification: premature optimization, overengineering.

### D4. Migration compatibility code has become debt

- What it is: migration code manually stamps implied migrations and telemetry DB code renames old trace tables.
- Evidence: `packages/db/src/migrate.ts` `stampImpliedMigrations`; `packages/db/src/sqlite/telemetryDb.ts` legacy `llm_trace_spans` rename behavior.
- Why it exists: schema evolved during prototype phases and migration history was patched to keep old databases usable.
- Real-world impact: migrations become hard to reason about, tests must cover historical states, and future schema drift is easier to hide.
- Affects: Maintainability, DX, Reliability.
- Severity: Medium.
- Recommendation: define a clean V1 baseline migration and keep compatibility migrations explicit and bounded. Remove legacy telemetry renames after a documented cutoff.
- Simpler architecture: one baseline migration for new installs, one documented upgrade path for old installs.
- Estimated gain: lower migration risk and faster onboarding.
- Action: simplify, remove legacy.
- Classification: migration debt, legacy code.

### D5. `.claude` worktrees pollute repository tooling

- What it is: `.claude/` is untracked, not cleanly ignored at the top level, and contains nested worktrees/node_modules that trigger long path warnings and duplicate search results.
- Evidence: `git status --short --ignored .claude` shows `.claude/` untracked and ignored nested worktree content; search results included `.claude/worktrees/...` duplicates; Git emitted Windows filename-too-long warnings under `.claude/worktrees/.../node_modules`.
- Why it exists: local agent worktrees were created inside the repo root.
- Real-world impact: slower searches, noisy grep results, Windows path warnings, and accidental tool traversal of duplicate checkout content.
- Affects: DX, CPU, Maintainability.
- Severity: Medium.
- Recommendation: add `.claude/` to `.gitignore` or move agent worktrees outside the repository. Exclude it from editor/search tooling.
- Simpler architecture: generated/agent worktrees live outside the project checkout.
- Estimated gain: faster local tooling and cleaner search results.
- Action: remove/ignore.
- Classification: tooling hygiene debt.

## CPU/RAM/Network Analysis

CPU hotspots:

- Backend full-table materialization and JS computation: runs, dashboard, command search, ledger, scheduler, knowledge, and app memory. This is the primary CPU risk because it scales with historical workspace size.
- Synchronous SQLite calls in the Node API process. Even efficient SQL will block the event loop while running; inefficient SQL or `.all()` magnifies that.
- Workflow engine JSON serialization and graph traversal. Full run-state persistence and full output events cost CPU on every step.
- Frontend repeated JSON parsing from duplicate shell fetches and chat full-list refreshes.
- React render churn from high-frequency store map replacement and unvirtualized lists.

RAM hotspots:

- `.all()` list materialization before filtering/sorting/pagination.
- Full run state stored both in memory and persisted.
- Full message arrays in chat, full graph arrays in canvas, and SVG/foreignObject graph rendering in BrainStage.
- Eager bootstrap of optional services and eager frontend route imports.

Network hotspots:

- Home/LiveStrip/Sidebar/NotificationPanel duplicate requests on realtime events and timers.
- Command palette remote searches during typing.
- Chat full-thread refresh on every message event.
- Workflow canvas full graph PATCHes rather than diffs/revisions.
- Realtime payloads that carry too much detail instead of summaries and cursor references.

Battery/mobile risks:

- Timers and polling (`Sidebar` 30s, chat workspace localStorage polling, placeholder intervals) continue to cost CPU even when little changes.
- Socket rooms without leave semantics can increase event traffic over a long session.
- Heavy initial JS from eager route imports slows startup and burns battery on low-power devices.
- SVG/foreignObject graph and React Flow surfaces need strict virtualization/throttling for mobile.

Cache misuse/absence:

- There is no apparent shared query cache for shell data. Realtime events trigger direct refetches in each component.
- Backend aggregates are recomputed on demand instead of cached/read-modeled.
- Command search has no indexed cache and no minimum-query guard.
- Knowledge/memory retrieval lacks bounded candidate caches/indexes.

Estimated system-level impact after the first refactor wave:

- Shell network requests during active runs: 60% to 90% reduction.
- Backend rows materialized for dashboard/runs/ledger/search: 10x to 100x reduction on non-trivial workspaces.
- Initial web JS: likely 30% to 60% reduction with route splitting and deletion of stale code.
- Workflow run serialization/write overhead: 3x to 20x reduction with delta state and summary events.

## Frontend Rendering Analysis

Rendering risk is currently dominated by data ownership and bundle shape, not pixel-level CSS.

1. Initial bundle cost is too high.
   - `App.tsx` statically imports all pages and shell widgets. Canvas, packages, brain, chat, and dashboard code should not be parsed before the user navigates there.
   - Recommendation: lazy route modules and lazy heavy panels.

2. Shell components refetch and rerender independently.
   - Home, LiveStrip, Sidebar, NotificationPanel, and chat own overlapping state. Counts and lists can rerender after each duplicate fetch.
   - Recommendation: central workspace summary cache and narrow selectors.

3. Chat rendering is unbounded.
   - Active lowercase chat maps all messages into React state and renders the full list. Uppercase chat has an even richer stale path with streaming/full-array update risks.
   - Recommendation: cursor pagination, delta reducers, virtualization for older messages.

4. Canvas save/edit state is too broad.
   - WorkflowCanvasPage owns graph editing, runtime binding compatibility, save queue, PATCH behavior, and UI state together.
   - Recommendation: separate editor state, graph validation, and persistence commands; save diffs/revisions.

5. BrainStage is acceptable for small graphs but risky at scale.
   - `BrainStage.tsx` memoizes graph transforms, which is good, but pan/mouse movement updates React state and SVG/foreignObject content can become costly.
   - Recommendation: rAF throttle pan/zoom updates and switch to canvas/WebGL or virtualized SVG if graph sizes grow.

6. Event listeners and polling need cleanup.
   - `components/chat/ChatPanelStore.ts` registers a module-level keydown listener; this can accumulate under HMR/tests. Lowercase chat polls localStorage for workspace context.
   - Recommendation: register global shortcuts inside a mounted provider with cleanup; publish workspace changes through the store rather than localStorage polling.

7. DOM/animation/mobile/PWA concerns.
   - Heavy shell, full-list rendering, timers, and websocket fan-out are the primary mobile battery risks. There is no evidence that expensive animations are the current problem; data/render churn is.
   - Recommendation: reduce work first, then profile paint/layout on target devices.

## Backend & Database Analysis

The backend needs a query-shape refactor before micro-optimizing Node code.

Key problems:

- Embedded SQLite is the only working runtime path. This is fine for a local-first product but not for hosted multi-tenant scale.
- Synchronous database calls share the event loop with HTTP, websocket, and workflow execution.
- Several routes/services treat the database as an object store: load rows, then filter/sort/count/rank in JS.
- API contracts drift from route behavior: frontend passes run `status`, backend does not use it as an indexed predicate.
- Cursor pagination is declared in API shape but not implemented in storage for ledger-like data.
- Schema references in many services do not match the exported SQLite schema.
- Migration compatibility code hides baseline uncertainty.

Required database refactors:

- Add repository methods for every hot query with explicit predicates, projections, ordering, and limits.
- Add indexes for common access paths:
  - `workflow_runs(workspace_id, status, created_at)`
  - `run_ledger(run_id, sequence_number)`
  - `approvals(workspace_id, status, created_at)`
  - `conversation_messages(conversation_id, created_at)`
  - `room_messages(room_id, created_at)`
  - knowledge/memory source tables by `workspace_id`, `app_id`, and search index columns
- Add aggregate/read-model queries for dashboard and shell summaries.
- Stop returning full JSON blobs when list cards need only ids, names, status, timestamps, and counters.
- Make query schemas typed and tested so frontend query params cannot silently drift.

Supabase/Postgres note:

- I found no active Supabase client path in the runtime. The relevant risk is architectural: if these `.all()` and JS-filter patterns are ported to Supabase/Postgres without pushdown, hosted mode will inherit the same inefficiencies with higher network latency. Hosted mode should use SQL/RPC/views/materialized summaries/vector search, not client-side or Node-side table scans.

## Multi-Tenant Scalability Risks

Current multi-tenant risk profile is high.

- Tenant isolation is mostly application-level. Every hot query must include `workspaceId` and use indexes. Broad list methods make accidental cross-tenant or overbroad scans easier.
- In-process EventEmitter realtime does not cross API instances. Multi-instance deployments will miss events unless all sockets and workflow execution happen in one process.
- WorkflowEngine active state is process-local. No durable worker ownership means horizontal scaling risks duplicate or lost work.
- SQLite embedded mode creates write contention and operational limits for concurrent tenants.
- Dashboard and command search cost grow with tenant history, not current viewport needs.
- Socket room lifecycle lacks unsubscribe/reset semantics, which matters more when operators switch workspaces/accounts.
- Scheduler/event-chain code is not distributed-safe and is not actually wired.

Minimum hosted architecture:

- Postgres or Supabase as canonical database.
- Durable queue for workflow steps and scheduled jobs.
- External pub/sub for realtime events.
- Stateless HTTP workers.
- Separate workflow workers.
- Read models for shell/dashboard summaries.
- Per-tenant query guards and indexes.
- Typed event and API contracts enforced in CI.

Until that exists, Agentis should be described as single-node/local-first, not horizontally scalable multi-tenant infrastructure.

## Dependency & Bundle Audit

Dependencies are not wildly excessive, but the current import structure makes them more expensive than necessary.

Frontend:

- `@xyflow/react` is appropriate for workflow canvas, but it should be isolated in a lazy canvas chunk.
- `lucide-react` is reasonable, but many static icon imports across eagerly imported pages add parse work to the first bundle. Lazy routes reduce this automatically.
- `socket.io-client` is appropriate if room lifecycle is fixed. Otherwise it becomes persistent network overhead.
- Zustand is reasonable, but current state is fragmented between `agentisStore` and chat-specific stores with localStorage polling.
- No route-level split means Vite cannot protect initial load from heavy optional surfaces.

Backend:

- Hono, Drizzle, jose, zod, bcryptjs, Socket.IO are reasonable for the product shape.
- `@hono/zod-openapi` and `@scalar/hono-api-reference` are useful only if OpenAPI is maintained and served intentionally; otherwise they add dependency surface.
- `better-sqlite3` is correct for embedded local mode but incompatible with high-concurrency hosted expectations.
- `postgres` dependency exists via `@agentis/db`, but the app runtime does not actually use a working Postgres path.
- API typecheck fails because `@opentelemetry/api` is imported but not present in `apps/api` dependencies.

Tooling:

- `lint` scripts currently echo `ok` in app packages. That removes an important early warning system for hooks, dependency arrays, unused code, and import drift.
- `.claude` worktrees inside the repo create duplicate search results and Windows long-path warnings.

Recommended bundle/dependency actions:

- Add route-level code splitting and inspect `vite build --mode production` output after typecheck is green.
- Remove stale components/pages before optimizing chunks.
- Replace fake lint scripts with real ESLint rules for React hooks, unused imports, and no raw realtime strings.
- Keep SQLite/Postgres dependencies aligned with the selected runtime story.

## Refactoring Opportunities

Highest leverage refactors, in order:

1. Contract cleanup refactor.
   - Delete or isolate stale frontend and backend feature slices until `pnpm -r typecheck` passes.
   - Replace raw realtime strings with typed constants/payloads.
   - Make schema exports the source of truth.

2. Query layer refactor.
   - Convert hot `.all()` plus JS filtering into explicit repository methods with SQL predicates, limits, projections, and indexes.
   - Start with runs, dashboard, ledger, command search, conversations/rooms, knowledge, and memory.

3. Frontend data layer refactor.
   - Add a shared workspace summary/cache layer.
   - Coalesce realtime invalidation.
   - Remove independent polling/fetch ownership from shell widgets.

4. Realtime lifecycle refactor.
   - Typed subscribe/unsubscribe.
   - Socket reset on logout/token/workspace changes.
   - Server room leave handling and metrics for room counts/listeners.

5. Workflow runtime refactor.
   - Precompute graph adjacency.
   - Store deltas and step-level state.
   - Emit summary realtime payloads.
   - Separate HTTP API from worker execution for hosted mode.

6. Frontend code-splitting refactor.
   - Lazy load heavy routes.
   - Delete stale ChatPanel/workspace components first so chunks are meaningful.

## Deletion Candidates

Delete or quarantine these before doing deeper optimization:

- `apps/web/src/components/ChatPanel/*` uppercase tree, unless it becomes the single canonical chat implementation immediately.
- Unmounted pages without active product routes: `TeamsPage`, `ArtifactsPage`, `LedgerPage`, `ChatDeploymentPage`, if not shipping in V1.
- Legacy workspace components that reference missing `agentisStore` fields/exports.
- API services referencing absent schema and event constants: teams, scheduler/event-chain, issues, routines, budget, data ingestion, evals, MCP, policies, file storage, workflow graph revisions, workflow deployments, unless each is completed schema-first.
- Legacy package fallback paths after a migration plan is chosen.
- App package stub fallbacks that return fake success for missing data.
- Old telemetry migration rename code after a cutoff/baseline migration.
- `.claude/` from the repo root, or at minimum ignore it fully.

Deletion is not cosmetic here. It is a performance and architecture improvement because it restores typecheck, reduces bundle/build/search noise, removes false contracts, and lets profiling focus on code that actually ships.

## Simplification Opportunities

1. One product mode for V1.
   - Local-first embedded mode or hosted multi-tenant mode, not both in active code unless both are implemented.

2. One chat implementation.
   - One chat store, one thread view, one realtime subscription path, one message pagination model.

3. One workspace summary source.
   - Replace Home/LiveStrip/Sidebar/Notification duplicate fetches with a single summary cache.

4. One package model.
   - Remove legacy `agentPackages` fallback once `libraryPackages` is canonical.

5. One event taxonomy.
   - Generated typed events and payloads; no raw strings in UI components.

6. Repository methods over generic stores.
   - Avoid broad `listAll` helpers in performance-critical routes.

7. Feature modules over eager bootstrap.
   - Mounted, healthy features register their services. Experimental features do not affect app boot/typecheck.

8. Server-owned compatibility migrations.
   - Canvas/workflow compatibility should be server-side and versioned, not patched ad hoc in the editor.

## Quick Wins

These are small, high-return steps:

1. Add `.claude/` to `.gitignore` and editor search excludes.
2. Remove or exclude uppercase `components/ChatPanel` to eliminate several web type errors.
3. Guard command search: do not call the API for empty or one-character queries.
4. Honor `status` and `limit` in `/v1/runs` at the SQL layer.
5. Implement ledger cursor query with `(runId, sequenceNumber)` index.
6. Replace `Sidebar` polling and duplicate LiveStrip/Home refreshes with a short-term shared `refreshWorkspaceSummary()` throttle.
7. Disconnect/reset Socket.IO on logout and workspace/auth token change.
8. Add route-level lazy imports for canvas, brain, packages, and app pages.
9. Move module-level chat shortcut listener into a mounted provider with cleanup.
10. Replace fake lint scripts with at least React hooks and unused import checks.

Expected quick-win impact:

- Typecheck becomes closer to green quickly.
- Command palette stops being a trivial CPU amplifier.
- Runs/ledger endpoints stop scaling with full history.
- Shell request storms are reduced even before a full query-cache migration.
- Local tooling becomes less noisy and faster.

## High Impact Refactors

### H1. Green build and contract freeze

- Goal: `pnpm -r typecheck` passes and CI blocks regressions.
- Work: delete/quarantine stale code, reconcile event constants, reconcile schema exports, add missing dependency declarations or remove imports.
- Impact: unlocks safe performance work and accurate builds.
- Risk: product owners must accept deleting unfinished surfaces.

### H2. Database pushdown pass

- Goal: no hot endpoint uses full-table list plus JS filter/sort/paginate.
- Work: repository methods, indexes, query tests, route contract tests.
- Impact: biggest direct CPU/RAM/latency improvement.
- Risk: requires touching route/service tests and possibly API response shapes.

### H3. Workspace data cache and realtime invalidation

- Goal: shell widgets share state and events update deltas instead of triggering independent broad refetches.
- Work: central summary store/query client, typed invalidation keys, event coalescing.
- Impact: biggest frontend network/battery improvement.
- Risk: must avoid stale counts and race conditions.

### H4. Workflow runtime split

- Goal: hosted-ready workflow execution with durable state and external workers.
- Work: durable queue, step state, adjacency cache, delta ledger, external pub/sub.
- Impact: unlocks multi-instance scale and safer long-running runs.
- Risk: significant architecture change; should follow product-mode decision.

### H5. Route-level code splitting and stale UI deletion

- Goal: small initial web bundle and clean route ownership.
- Work: delete stale pages/components, lazy import heavy routes, measure Vite output.
- Impact: faster startup and lower mobile CPU/RAM.
- Risk: low after typecheck is green.

## Long-Term Architectural Recommendations

1. Decide and document the platform tier.
   - Local-first tier: SQLite, one process, no distributed claims, explicit workspace/run limits.
   - Hosted tier: Postgres/Supabase, queue, pub/sub, stateless API, worker pool, read models.

2. Make contracts generated or centrally typed.
   - API request/response schemas, event names, event payloads, and database schema should not drift independently.

3. Introduce read models for operator surfaces.
   - Dashboard, sidebar badges, notification counts, and live strips should read compact summaries instead of recomputing from base tables.

4. Treat workflow execution as a distributed system if hosted.
   - Idempotent steps, durable leases, retry policy, backpressure, and cursor-based logs are required.

5. Establish a deletion discipline.
   - Experimental features must not remain in the main compile path after being superseded.

6. Add performance budgets.
   - Initial JS budget, shell request budget per realtime event, max rows per endpoint, max websocket payload size, max run-state serialized bytes.

7. Add observability after the architecture is coherent.
   - Metrics for query time, rows returned, websocket room counts, event fan-out, workflow step duration, run-state payload size, and frontend route chunk sizes.

8. Use real search/retrieval engines for search problems.
   - Command search can be indexed SQL/FTS. Knowledge/memory retrieval needs FTS/vector indexes and bounded reranking.

## Proposed Simplified Architecture

### V1 Local-First Architecture

Use this if the immediate product is a local/operator workspace:

- One API process.
- Embedded SQLite with WAL and explicit size/concurrency limits.
- Synchronous DB accepted but all hot queries use indexes, limits, and projections.
- In-process EventEmitter accepted, with typed events and proper socket unsubscribe.
- WorkflowEngine stays in process but stores compact deltas and can resume safely after restart.
- No standard/Postgres mode in active product UI/docs.
- No unshipped services in compile path.
- Frontend uses lazy routes and one workspace summary cache.

This architecture is honest, simpler, and can be fast for small to medium local workspaces.

### Hosted Multi-Tenant Architecture

Use this only if Agentis must serve multiple tenants concurrently:

- Postgres/Supabase is canonical storage.
- API workers are stateless Hono services.
- Workflow workers consume a durable queue.
- Redis/NATS/Postgres NOTIFY handles realtime fan-out.
- Socket.IO runs with a shared adapter if multiple socket servers exist.
- Read models/materialized summaries power dashboard/sidebar/live strip.
- Workflow runs store step-level state and ledger deltas.
- Knowledge/memory uses FTS/vector indexes.
- Tenant query guards and indexes are mandatory.
- Scheduler uses durable leases, not in-process timers.

This architecture is more complex, but the complexity maps to real distributed-system requirements instead of half-present scaffolding.

## Final Verdict

Agentis should not be optimized by adding small memoization patches or sprinkling caches around the current shape. The codebase first needs subtraction and contract repair.

The system is carrying too many unfinished eras at once: embedded runtime plus hosted scaffolding, lowercase chat plus uppercase chat, canonical events plus magic/missing events, active schema plus services for absent tables, dashboard shell widgets plus duplicated local fetch loops. This creates real performance cost through broad scans, duplicated requests, eager imports, serialization overhead, and broken build feedback.

The path to a faster system is straightforward:

1. Delete or quarantine stale code until typecheck is green.
2. Pick local-first or hosted as the honest V1 runtime boundary.
3. Push hot data access into indexed SQL queries.
4. Collapse shell data fetching into one cache/realtime invalidation layer.
5. Fix socket room/auth lifecycle.
6. Split frontend route bundles.
7. Rebuild workflow execution around compact deltas and, for hosted mode, a durable queue.

If those steps are taken, Agentis can become dramatically simpler and faster. If they are skipped, the current architecture will continue to produce slow endpoints, noisy realtime behavior, fragile builds, and feature work that fights the platform rather than extending it.