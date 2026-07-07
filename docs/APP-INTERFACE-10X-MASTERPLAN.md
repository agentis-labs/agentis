# APP INTERFACE 10X — from "stacked blocks" to an agentic product shell

**Date:** 2026-07-02 · **Status:** BUILDING
**Prior art:** GENUI-RENAISSANCE (grammar), GENUI-PREMIUM-10X (design languages), DECISIONS D39 E0–E3 (workflow control plane, open block registry). All three shipped, and the operator is still right: a rendered App reads as *one scrolling column of anonymous panels*. This plan attacks what none of them touched — the shell, the live-operations plane, real multi-workflow orchestration, and interactive archetype composites.

## 1 · Diagnosis (grounded in code, 2026-07-02)

The complaint is "first project of a noob developer — separate blocks, no UI/UX, no control, no realtime." Mapped to root causes:

| Complaint | Root cause in code |
|---|---|
| "All these separate blocks" | `AppRuntime.tsx` renders `<tab bar> + <padded div>`. No shell: no sidebar nav, no topbar, no identity, no status rail. Surfaces = anonymous tabs. Every archetype composes ONE page as a vertical `Stack`. |
| "Where's the control of multiple workflows by rule?" | `appBinding {order, purpose, enabled, dependsOn}` (E0) is stored and *returned* but **never enforced** — grep confirms `dependsOn` appears only in `routes/apps.ts` (read/write). No chain executor, no run-all, no concurrency policy, no schedule surface. `WorkflowControl` block = flat list + play button. |
| "Realtime monitoring, agent thinking" | The substrate is COMPLETE and unused by apps: per-run rooms + `GET /v1/runs/:id/activity` backfill + `useRunActivity` hook (reasoning/tool steps), `RUN_*`/`NODE_*`/`APPROVAL_*`/`AGENT_WORK_STEP` events, approvals API. **No app block consumes any of it.** |
| "Kanban / CRM / pipeline / roadmap / DevOps / ERP" | `DataBoard` is read-only title cards (no drag, no detail). No master-detail record view, no timeline lanes, no funnel math. Grammar tops out at sortable `Table`. |
| "Bad creation optionality" | `genui.ts` scaffolds ONE surface (Hero + WorkflowControl + chart + tabs). Generator prompt teaches nodes, not *products*. |

**Thesis:** the grammar/tokens layers are fine. The loss is (a) the missing **App Shell** (chrome is runtime-owned, not agent-authored — so every existing app upgrades instantly), (b) the missing **live-ops plane** (blocks that consume the run/approval bus), (c) **orchestration that does something** (dependsOn → real chains; schedule visibility; run-all; concurrency), (d) **interactive archetypes** (kanban that writes back, CRM master-detail, roadmap lanes).

## 2 · Architecture

### 2.1 App Shell (runtime chrome — W1)
`AppRuntime` becomes a product shell, derived (never authored):
- **Sidebar** — the app's surfaces as *pages* with icons (derived from surface kind + name heuristics), app identity block (icon, name, version), collapse-to-rail. Hidden when the app has one surface and no ops data.
- **Topbar** — current page title, global search (filters bound collections client-side… v1: page switcher ⌘K), **live status cluster**: active-runs pulse (RUN_* room), pending-approvals badge (APPROVAL_*), agent presence.
- **Ops drawer** — right-side slide-over available on every page: Live activity / Runs / Approvals tabs. The agentic heartbeat is one click away from anywhere without the agent authoring anything.
- Content region: full-width, design-language driven, `@container` for responsiveness.
- Root style knob: `style.shell: 'full' | 'minimal' | 'none'` (root-only StyleIntent) — default `full` when >1 surface or any workflow bound, else `minimal`.

### 2.2 Live operations plane (new blocks — W2)
- **`RunMonitor`** — the app's runs, live. Sources: `appsApi.listWorkflows` (bindings) + `GET /v1/runs?workflowId=` + RUN_*/NODE_* realtime. Rows: workflow, status pulse, progress (completed/total nodes), elapsed, cost when present; controls cancel/pause/resume; expandable → per-node timeline + live `useRunActivity` feed. Filterable by workflow/status.
- **`AgentFeed`** — "watch the agent think": reasoning + tool steps + node transitions from run rooms (reuses `describeRealtimeActivity`), console-grade rendering (role icons, tone colors, monospace details, auto-follow). Scope: app (all its workflows' runs) or a specific run.
- **`ApprovalsInbox`** — pending approvals for the app's workflows: `GET /v1/approvals` + APPROVAL_REQUESTED/RESOLVED; approve/deny inline with optimistic update.
- These register on the E2 block seam like everything else; the Ops drawer composes the same components (one implementation, two mounts).

### 2.3 Orchestration by rule (backend + block — W3)
- **`appWorkflowBindingSchema` grows** (additive): `schedule?: { cron: string; enabled: boolean }`, `concurrency?: 'parallel' | 'exclusive'` (exclusive = skip start if a sibling run of the same workflow is active), `chainOn?: 'success' | 'always'` (when do dependents fire; default success).
- **`appOrchestrator.ts` (NEW service)** — the missing executor:
  - Subscribes to the bus; on RUN_COMPLETED (and RUN_FAILED for `chainOn:'always'`) of workflow W in app A → finds enabled siblings whose `dependsOn` ⊇ W → queues them via the scheduler's `queueWorkflowRun` (same execution path as everything else — NOT a fork), with chain-depth cap + per-app cycle guard.
  - Binding `schedule.cron` → registers on the existing `SchedulerService` sweep seam (`registerSweep`), computing next-fire from the cron expr; fires through `queueWorkflowRun`. (The workflow-level trigger system stays authoritative for graph-authored triggers; binding schedules are the App-level layer on the same runner.)
  - `runAll(appId)` — start all enabled roots (no dependsOn) in `order`; chains cascade.
- **Routes:** `POST /v1/apps/:id/workflows/run-all`, binding PATCH accepts the new fields; `GET /:id/workflows` returns `activeRun` (live) + `nextRunAt` (from binding schedule or trigger scheduleRuns).
- **`OrchestrationPanel` block** (supersedes `WorkflowControl`, which stays as an alias): mission-control table — status pulse, purpose, trigger/schedule chip (editable cron presets), dependsOn chain chips, enable/pause toggle, run + run-all, last/next run. This is "control of multiple workflows by rule," visible.

### 2.4 Interactive archetype composites (W4)
- **`Kanban`** — real board over a collection: `groupBy` columns (explicit `columns[]` or discovered), drag card → `data.update` writes the groupBy field (optimistic + rollback), WIP counts, card template fields (`titleField`, `subtitleField`, `badgeField`, `assigneeField`), click → record drawer (all fields + row actions).
- **`RecordMaster`** — CRM/ERP master-detail: left searchable list (title/subtitle/status), right record page — field grid, related child collection (`related: {collection, foreignKey}`) as list/table, per-record actions. The workhorse for CRM/ERP/inventory/HR.
- **`Roadmap`** — time lanes from a collection (`startField`, `endField`, `laneField`, `labelField`); month/quarter header; bars colored by lane/status tone. Roadmaps, release plans, campaigns, hiring pipelines.
- **`PipelineFlow`** — staged funnel with per-stage counts/values + conversion % between stages (bound; `stageField`, optional `valueField`, explicit `stages[]` for empty-stage rendering).
- All are registered blocks; `collectionsInView` learns their binds (authz allowlist stays correct).

### 2.5 Design system v2 (W8-lite, folded into W1/W2/W4)
Blocks stop looking like "separate boxes" via the shell (chrome owns hierarchy) + tightened `s-panel` treatment: header rows become quieter, gaps come from `--s-gap`, KPI/heros keep language-driven scale. New `--s-*` additions only where blocks need them. No new dependency; charts stay the zero-dep SVG kit.

### 2.6 Generator + doctrine (W5)
- `genui.ts`: archetypes now build **multi-surface products**: `home` (KPIs + OrchestrationPanel + RunMonitor/AgentFeed rail) + a working surface per shape (kanban/records/roadmap) + forms behind tabs. `classifyArchetype` learns `kanban` (status+few numerics), `crm` (many string fields + email/phone-ish), `roadmap` (two date fields).
- `surfaceGenerator` SYSTEM_PROMPT + PATCH prompt: teach Shell knob, live-ops blocks, new composites, and the "product, not page" doctrine.
- `chatToolCatalog` `agentis.ui.render` description: same vocabulary.
- `repairSurface` floor: unchanged semantics + accepts new kinds.

## 3 · Explicit non-goals (this pass)
- No arbitrary React bundles (owned-declarative stays the thesis; CodeSurface remains the escape hatch).
- No second scheduling engine for graph-authored triggers — binding schedules ride the existing SchedulerService seam; graph triggers stay authoritative where authored.
- No stable node-ids refactor (deferred since E2; index paths still fine).
- No marketplace/theming UI beyond the existing pickers.

## 4 · Definition of done
1. core/web/api typecheck + existing tests green; new tests for orchestrator (chain fire, cycle guard, concurrency skip, run-all) + new blocks render.
2. A real app (Fashion Store Factory) renders in the new shell with live RunMonitor/AgentFeed and the OrchestrationPanel controlling its workflows.
3. An agent-scaffolded app comes out as a multi-page product (shell + home + working surface) with zero operator styling.

---

## Impl log

- 2026-07-02 · Plan written; W1 (shell) → W2 (live-ops) → W3 (orchestration) → W4 (archetypes) → W5 (generator) → verify.
- 2026-07-03 · **ALL WAVES SHIPPED + VERIFIED LIVE.**
  - **Grammar** (`packages/core/src/types/view.ts`): +`OrchestrationPanel`/`RunMonitor`/`AgentFeed`/`ApprovalsInbox` (app-scoped, no bind) + `Kanban`/`RecordMaster`/`Roadmap`/`PipelineFlow` (bound composites) + root-only `style.shell: full|minimal|none`; `collectionsInView` covers the new binds (RecordMaster includes `related[]`). `genuiAudit`: new kinds added to `DATA_PANEL`/`REQUIRES_BIND` + `inferTheme`.
  - **Orchestration backend**: `appWorkflowBindingSchema` +`schedule{cron,enabled}|null` +`concurrency: parallel|exclusive` +`chainOn: success|always`. NEW `services/appOrchestrator.ts` — the missing executor: bus-subscribed dependsOn **chains** (fire dependents on settle through the exported `queueWorkflowRun` seam — never a forked path; lineage-depth cap 16 kills cycles), binding **cron schedules** on the `SchedulerService.registerSweep` seam (15s), `runAll` (enabled roots in order), exclusive-concurrency skip. NEW `services/cronNextFire.ts` (5-field cron parser + next-fire + describeCron; node-cron can't answer "when next"). Routes: `GET /:id/workflows` returns `activeRun/schedule/nextRunAt/concurrency/chainOn`; `POST /:id/workflows/run-all`; binding PATCH re-arms. Wired in bootstrap (start/shutdown/sweep). Tests: `appOrchestrator.test.ts` 10/10 (chain fire, chainOn semantics, exclusive skip, cycle cap, run-all order, schedule arm/fire/disable, cron math).
  - **App Shell** (`AppRuntime.tsx` rebuilt): derived product chrome — sidebar (app identity + pages w/ icon heuristics, collapsible), topbar (page title + LIVE cluster: active-runs pulse, approvals badge, ops toggle), **ops drawer** (Runs / Thinking / Approvals / Rules) available on every page; mobile page select; `style.shell` override; default full when >1 surface or any workflow. Chrome is runtime-owned → every existing app upgraded with zero migration.
  - **Live-ops blocks** (`blocks/opsBlocks.tsx`, on the E2 seam): `OrchestrationPanelView` (status pulse + rule chips + inline RulesEditor: schedule presets/custom cron, dependsOn checkboxes, chainOn, concurrency + run/run-pipeline/pause), `RunMonitorView` (live runs, node progress bar, ticking elapsed, cancel/pause/resume, expand → `useRunActivity` feed), `AgentFeedView` (follows newest active run; reasoning/tool stream), `ApprovalsInboxView` (approve/reject inline). Same components mount as blocks AND in the shell drawer. `WorkflowControl` re-registered as an alias of OrchestrationPanel (old surfaces upgrade in place — its ViewRenderer built-in was deleted). Shared hooks hold a workspace realtime-room subscription (run events fan out to run+workspace rooms). NEW `lib/opsApi.ts` (runs list/cancel/pause/resume + approvals list/resolve).
  - **Archetype composites** (`blocks/archetypeBlocks.tsx`): `Kanban` (HTML5 drag across columns → declared `update` data action `{id, patch:{groupBy}}` optimistic w/ rollback; card drawer w/ full record + actions), `RecordMaster` (searchable master list + record page: header, sections, related child collections via `client.data.query({[fk]: id})`, record actions), `Roadmap` (month-ticked time lanes, today marker, tone/lane coloring), `PipelineFlow` (stage cards + conversion % + value sums). Tests `archetypeOpsBlocks.test.tsx` 6/6 incl. drag-writes-back.
  - **Generator**: `genui.ts` archetypes rebuilt → mission-control compositions (Hero + OrchestrationPanel + working composite + RunMonitor/AgentFeed rail + records/add Tabs); `classifyArchetype` learns `crm` (contact-ish strings) + `roadmap` (date+label); crud actions now insert **+ update** (Kanban drag). Prompts taught everywhere: surfaceGenerator SYSTEM+PATCH, chatToolCatalog `agentis.ui.render`, orchestratorPrompt §2 (incl. reworked CRM worked-example). Builder palette: +Kanban/Records/Roadmap/Pipeline + "Live operations" group.
  - **Verified**: core+api+web typecheck 0; core 54, api (orchestrator 10, apps routes 28 incl. scheduler, referenceTemplates/surfaceGenerator/appChatTools 57, appSurfaceStore+appAgentTools 9), web (ViewRenderer+AppEditorPage 26, new blocks 6) all green; web production build green (ViewRenderer↔opsBlocks cycle safe — helpers dereferenced at render only). **Live proof on Fashion Store Factory**: topbar showed real "1 running" pulse + "2" approvals; Runs drawer listed real runs w/ failure reasons + 23/33 progress + pause/cancel; Rules tab → set "Daily 09:00" → PATCH 200 → chip + re-arm confirmed → reverted (schedule:null verified via API).
  - ⚠️ Gotchas: (1) side-effect block modules must OWN any kind they override — imports hoist, so ViewRenderer's own later registration would win (deleted the old WorkflowControl built-in instead). (2) Run status events publish to run+workspace rooms — blocks need `rtSubscribe('workspace',{})` held while mounted or nothing arrives. (3) `AppWorkflowSummary` grew required fields — server + web types move together (same package, fine).
- 2026-07-03 · **VISUAL REDESIGN V2 (operator rejected the first pixels — "terrible").** Applied Anthropic's frontend-design skill: the first pass was the skill's named generic default (near-black + hairline rules + uniform 10-13px type). Redo:
  - **Type scale that JUMPS** (the core fix): `.s-label` 11px tracked-uppercase → 13.5-14px body → `.s-title` 14.5-15px panel titles → 26-28px hero → `.s-num` 32-42px numerals (`--s-title-size`/`--s-body-size` joined the `--s-*` contract; all five languages rescaled — radius 16-20, pad 20-28, real jumps per language).
  - **Layered elevation**: `LAYERED_CARD` top light-edge gradient + `DEEP_SHADOW` on `.s-panel`; `.s-panel-hover` lift; borders soften to rgba-white 7-9% (no more hairline-on-black).
  - **Color belongs to DATA**: `MONOCHROME_BASE_VARS` success restored to real green `#34d399` (was ghost-white — flattened every status); chrome stays monochrome. **Signature element = the live pulse**: `.s-pulse` breathing keyframe (reduced-motion honored) on running dots/chips; run progress bars green.
  - Reworked renderers: Hero (radial wash, tracked eyebrow, 26px+ title), Metric/KPIStrip (`.s-num` numerals, delta pills), PanelShell (quiet muted icon + `.s-title` + `--s-pad` body), Table (13px body, 11px tracked headers, taller rows), StatusBoard/Callout/EmptyState/ActivityStream/DataBoard/Tabs/Toolbar — plus the same scale pass over opsBlocks, archetypeBlocks, and the shell (taller topbar, 15px page title, green running chip, 224px sidebar).
  - Verified: web typecheck 0, 32 component tests green, production build green; live screenshots on Fashion Store Factory (layered hero + readable pipeline rows + green-pulse runs drawer) — judged against the operator's reference, not just tests.
