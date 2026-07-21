# 02 · Agentic Applications

An **App** is a durable entity that bundles typed data, agent-authored interfaces, and
attached automation into a product an agent both builds and operates. Apps are the top-level
unit users create; a standalone workflow is auto-wrapped into an "App-of-one" (`build_workflow`
returns an `appId`).

## Data model

Tables (`packages/db/src/sqlite/schema.ts`):
- `apps` — slug, name, version, icon, owning domain/agent, status (`draft | published | archived`),
  policy (audience, custom-view gating, unsupervised-outbound safety).
- `app_collections` — typed collections: fields of `string | number | boolean | date | json`,
  optional strict-schema mode.
- `app_records` — rows in a collection.
- `app_surfaces` — named pages: a `ViewNode` tree + `SurfaceAction[]` + entry point.
- `app_contacts` — people the app tracks and reaches (ties into Subjects).

## Datastore

`services/app/` exposes a query DSL over collections: filter / sort / limit / cursor, with
optional strict schema validation. The web app renders collections in an editable
`AppDataGrid`; mutations emit `DATA_CHANGED` on the `workspace` realtime room so open surfaces
refresh live. The **data loop closes**: terminal run outcomes feed back into records and
subjects.

- Tools: `agentis.data.{define_collection,insert,update,upsert,delete,query,promote_memory}`.

## Interfaces — the AG-UI View Tree (GenUI)

Surfaces are authored as a typed **ViewNode** tree (`packages/core/src/types/view.ts`), not
raw HTML/CSS. ~40 node kinds across categories:

- **Layout** — Stack, Grid, Split, Tabs, Accordion, Card, Section.
- **Content** — Text, Heading, Metric, KPIStrip, Image, Avatar, ProgressBar, Sparkline.
- **Data-bound** — Table, List, Chart (line/bar/pie/area/donut), Timeline, DataBoard.
- **Interactive** — Form (typed fields), Button, Badge.
- **Agent-native** — ActivityStream, RunMonitor, AgentFeed, ApprovalGate, Orchestration,
  AgentRegion, CodeViewer, MediaGallery, DocumentViewer, MapView.

Styling is design-system-bounded (`packages/core/src/genui.ts`): semantic tones, named
palettes, per-surface design languages/themes, and shell modes (`full | minimal | none` for
embeds) — no raw CSS escape hatch by default.

- Tools: `agentis.ui.{render,patch,compose,perform_region,action_schema,lint}`.

## Surface generation — the taste engine

`packages/core/src/genui.ts` + `services/surfaceGenerator.ts` classify a collection's shape
into an **archetype** (`analytics | pipeline | crm | roadmap | operations`) and scaffold a
**mission-control product** — the fitting composite (Kanban / RecordMaster / Roadmap / Chart)
beside a live operations rail (RunMonitor + AgentFeed) under the App's OrchestrationPanel,
wrapped by the App Shell. The same module backs both the API generator and the web
"create interface" default, so starter surfaces look consistent everywhere. Agents can also
generate/patch a surface from natural language; the web editor is a WYSIWYG canvas with live
binding preview.

## App Shell & live-ops

The runtime chrome (`apps/web/src/components/apps/`) wraps every surface: a sidebar (surface
list), a topbar (live status, approvals, refresh), and an ops drawer (Runs / Activity /
Approvals / Rules). URL routing is `?page=<surface>` in search params. Public surfaces are
token-gated, read-only, CSP-safe, and embeddable (`PublicAppSurfacePage`).

## Orchestration & proactivity

- **App orchestration** (`services/app/appOrchestrator.ts`) — multi-workflow rules:
  chain-on-completion, cron scheduling, concurrency (exclusive), run-all; cycle-safe via a
  per-lineage depth cap.
- **Subjects** (`services/subjectRuntime.ts`) — per-contact actors with a declarative
  lifecycle (`send → agent → wait → done`) that survive restarts and resume out of order.
- **Conversation scripts** — declarative per-contact state machines that advance on each
  inbound message (`agentis.conversation.{define,enroll,flag_needs_attention}`).
- **Proactive followups** (`services/proactiveFollowups.ts`) — a sweep over due
  `nextTouchAt` clocks dispatches turns so apps reach out first (subject to outbound policy).

## App Goals & the Evolution Loop

An App can hold a durable **Goal** (the reserved north-star tier — distinct from a run-scoped
**Objective**; a Goal decomposes into the objectives runs chase) and get measurably better at
it over time. The loop closes three arcs that previously existed but never touched:

- **Goal** (`services/app/appGoal.ts`, `AppIdentity.goal` in the manifest) — a statement +
  optional north-star metric, set via `agentis.app.goal`. Portable (rides the manifest) and
  mirrored into the App's Brain scope as a governing atom, so every run recalls it.
- **Strategy** (`strategies` table, `services/app/strategyService.ts`) — a competing approach
  mapped to an experiment arm. Confidence is the **outcome-weighted** Laplace win rate
  `(wins+1)/(trials+2)`, *not* recurrence; proven strategies mirror into the App Brain as
  recallable atoms. Tools: `agentis.strategy.{propose,list}`.
- **Measure → learn bridge** — `ExperimentService.record` fires an `onOutcome` hook →
  `StrategyService.recordExperimentOutcome`, so an A/B outcome updates the arm's strategy.
  `RollingBaselineStore` (now wired into `AppLearningService.onRunSettled`) captures 7/30/90d
  performance baselines.
- **Evolution controller** (`services/app/strategyEvolution.ts`) — winner selection gated by a
  min-sample floor + a two-proportion z-test (no promotion on noise); promotes the winner,
  retires significant losers, recommends the next generation. A 6h scheduler sweep runs it;
  **ACT** (auto promote/retire) is operator-gated (`AGENTIS_EVOLUTION_AUTONOMY`, off by
  default — otherwise SURFACE-only). Tool: `agentis.evolution.review`.
- **Mission Control** — `GET /v1/apps/:id/mission-control` (goal + strategies + decisions +
  experiments + baselines, computed live) → the App engine's **Goal** tab
  (`MissionControlPanel`).

The decision core is deterministic and tested; next-generation variant *authoring* is left to
the owner agent (via `strategy.propose`), keeping the LLM out of the promote/retire logic.

## API surface

- HTTP: `/v1/apps`, `/v1/artifacts`, `/v1/rooms`, `/v1/interactions`,
  `/v1/workspace-context`, `/v1/apps/:id/mission-control`.
- Tools: `agentis.app.{create,list,archive,delete,adopt_workflow,scaffold,plan,goal}`,
  `agentis.strategy.{propose,list}`, `agentis.evolution.review`, plus the `data.*` and `ui.*`
  families above.
- Web pages: `AppsPage`, `AppEditorPage` (Interface / Workflow / Data / Brain facets),
  `PublicAppSurfacePage`, `GenUIShowcasePage`. App engine modal → **Goal** tab (Mission Control).

---

**Next:** [03 · Self-Healing Orchestration →](./03-orchestration.md)
