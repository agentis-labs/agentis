# INTERFACE OVERHAUL 10X — Masterplan

**Date:** 2026-07-05 · **Status:** PLANNED (execution not started)
**Operator directive:** complete teardown of the agent-generated interface layer. No incremental fixes. Rebuild presentation + logic so the UI mirrors the actual power of the Agentis backend. Reference bar: TailAdmin-class premium dashboards.

---

## 0. The honest diagnosis (evidence, not vibes)

This is the **fifth** interface pass (Renaissance 06-25 → Premium 06-27 → Rebuild E0-E3 06-30 → App-Interface-10X 07-03 → now). Each prior pass shipped real substrate and the operator still rejected the result. A fifth round of prompt-doctrine + token polish will fail the same way. The plan below is structural, and it is grounded in what is actually in the tree today.

### 0.1 What the live DB proves (dumped 2026-07-05 from `apps/api/.agentis/data.db`)

The Fashion Store Factory `home` surface (the rejected screenshot):

| Fact | Value |
|---|---|
| Node kinds authored | Stack:3 · Hero:1 · KPIStrip:1 · Split:1 · **Table:4** · Callout:1 · ActivityStream:1 · AgentRegion:1 |
| Interactive elements | **Buttons: 0 · rowActions: 0 · Forms: 0 · Hero actions: 0** |
| Declared actions | `run_factory (workflow→0759b370…)`, `update_lead (data)`, `insert_lead (data)` |

**The agent declared a workflow action and wired *nothing* to it.** `run_factory` exists in the actions array; no pixel on the surface can fire it. The other production apps are worse: `AI News Email Digest` declares zero actions; `24/7 AI News Site Monitor` contains an `AgentConsole` node — a kind that is no longer registered, so it renders as an UnknownBlock marker in production today.

Meanwhile the transport is fully real: `POST /:id/surfaces/:name/actions/:action` ([apps.ts:1251](../apps/api/src/routes/apps.ts)) resolves `data` CRUD, **starts real workflows** (`runPublishedWorkflow`, 2.5s inline budget then live run streaming), executes `tool` actions, and the client handles `navigate`/`setState`. **The backend power exists. The generated UI simply never touches it.**

### 0.2 The four root causes

1. **Operability is optional.** Nothing rejects a dead surface. `repairSurface` ([genuiAudit.ts](../packages/core/src/genuiAudit.ts)) fixes *layout* anti-patterns only. The generator prompt teaches mission-control composition ([surfaceGenerator.ts:162-241](../apps/api/src/services/surfaceGenerator.ts)) — all soft doctrine, all ignorable, all ignored. The platform already learned this exact lesson for workflows: **COMPLETED ≠ ACCOMPLISHED** became a verdict engine, not a nicer prompt. The UI equivalent — **RENDERED ≠ OPERABLE** — was never built.
2. **No value-presentation layer.** `formatCell` ([ViewRenderer.tsx:2070](../apps/web/src/components/apps/ViewRenderer.tsx)) is 6 lines. Raw `SUCCESS_DEPLOYED_STORE_AND_CRM` in pills, un-linked URLs overflowing cells, no locale numbers/dates, no truncation. `Metric` ([ViewRenderer.tsx:1163](../apps/web/src/components/apps/ViewRenderer.tsx)) has zero overflow defense — binding the word "ACCOMPLISHED" to a 38px numeral produces the screenshot's mid-word wrap.
3. **LLMs are asked to do pixel design.** Free ViewNode composition + 50 kinds + styleIntent enums = every app is a fresh design project executed by a model that cannot see. TailAdmin looks premium because humans fixed every layout decision once; the LLM should supply *semantics* (bindings, copy, actions), never *composition mechanics*.
4. **One hardcoded look, and it's the banned one.** `MONOCHROME_BASE_VARS` ([designLanguage.ts:188](../apps/web/src/components/apps/designLanguage.ts)) forces near-black + ghost-white — literally the frontend-design skill's named "Dark Minimalism generic AI default." The five design languages are dark-hardcoded (white-alpha card gradients); the platform's light theme exists (`styles.css` `data-theme='light'`) but app surfaces were never designed for it.

### 0.3 Teardown vs. keep (what "complete teardown" means precisely)

**RAZED — deleted or fully replaced:**
- The five design languages + monochrome override (`designLanguage.ts` contents) → one flagship design system, two appearances.
- The visual implementation of every block in `ViewRenderer.tsx` / `opsBlocks.tsx` / `archetypeBlocks.tsx` (~50 kinds) → the new kit, same registry seam.
- Free-form tree authoring as the *agent* contract (ui.render prompt doctrine, styleIntent-as-API) → typed InterfaceSpec compiled deterministically.
- `formatCell` and all ad-hoc cell/value rendering → the formatter layer.
- Legacy kinds that no longer exist (`AgentConsole`, `WorkflowControl` alias…) → migration map at the render seam.

**KEPT — this *is* the backend power the UI must mirror; rebuilding it would be rebuilding Agentis, not the UI:**
- Block registry seam ([blocks/registry.ts](../apps/web/src/components/apps/blocks/registry.ts)) — the open dispatch stays; new kit registers through it.
- SurfaceAction grammar + dispatch route (6 kinds: workflow/tool/data/capability/navigate/setState — already implemented server-side).
- Data plane (`appsApi.query`, datastore, DATA_CHANGED realtime) and the run/approval realtime bus.
- Surface persistence + the repair seam ([appSurfaceStore.ts:208/233/267](../packages/app/src/appSurfaceStore.ts)) — this becomes the enforcement point.
- App Shell *concept* (AppRuntime chrome: sidebar/topbar/ops drawer) — restyled, plus real routing.
- The zero-dep SVG chart kit ([charts/index.tsx](../apps/web/src/components/apps/charts/index.tsx)) — restyled to ApexCharts-grade anatomy; no 500KB chart dependency.

---

## 1. Architecture & Stack Selection

### 1.1 Stack decision

| Layer | Decision | Why |
|---|---|---|
| Framework | **Stay React 18.3 + Tailwind 3.4 + Radix + lucide** | TailAdmin free is React 19 + Tailwind v4 — vendoring the repo verbatim means a version migration *plus* a rewrite to our data/action plane. We take its **anatomy and design system**, not its package.json. MIT allows copying specific component patterns where they accelerate (sidebar, table anatomy, chart styling) with attribution in the file header. |
| Charts | **Keep zero-dep SVG kit, restyle to ApexCharts anatomy** | Gradient area fills, rounded bar caps, soft dashed grid, legend chips, hover tooltip, period switcher. The kit already does line/area/bar/stacked/donut/spark with tooltips; what's missing is *styling*, not capability. No new heavy dependency (Radical Efficiency). |
| Design system | **One flagship system: `agentis`** — light + dark appearances, density + accent + radius knobs | The five-language zoo is entropy the LLM misuses and five surfaces to keep premium. TailAdmin is ONE coherent system; that's why every page of it looks good. Legacy `design` ids (`aurora`/`soft`/`operations`/`editorial`/`console`) remain schema-valid and map to flagship variants (compat, zero migration). |
| Appearance | **Designed light-first (the TailAdmin reference), dark fully tuned. App surfaces follow the platform theme by default; per-app pin available** | The operator's reference screenshots are light; the platform chrome is dark. Both must hit the bar — judged against TailAdmin in both modes. Kills the "Dark Minimalism default" permanently: light canvas `gray-50`, white cards, real shadows, blue-family accent, color on data. |
| Typography | Real scale per frontend-design skill: 11px tracked labels / 14px body / 15-16px titles / 24-28px page titles / 32-40px KPI numerals, tabular-nums for data. Evaluate Outfit (TailAdmin's display face, OFL) for display; Inter/system for body | The scale must JUMP. Uniform 12px was rejected twice. |

### 1.2 The architecture inversion — "semantics from the agent, pixels from the system"

```
TODAY   agent → free ViewNode tree (+ soft prompt advice) → repairSurface (layout only) → renderer
TARGET  agent → InterfaceSpec (typed intent) → Interface Compiler (deterministic) → ViewNode tree
                                                    ↓
                              Operability Gate (hard: reject/auto-wire) at the SAME seam
                                                    ↓
                              Kit renderer (registry) — every block premium by construction
```

- **InterfaceSpec** (new, `packages/core`): small, validatable intent — `pages: [{ purpose: 'mission-control'|'board'|'records'|'analytics'|'inbox'|'report', collection(s), kpis[], primaryActions[], drill config, copy }]`. The LLM authors THIS (or nothing — the spec is fully derivable from data + workflows, like `classifyArchetype` already does).
- **Interface Compiler** (extends [genui.ts](../packages/core/src/genui.ts) — it already *is* the shape→tree compiler; per "never duplicate, extend"): lowers spec → tree using fixed, professionally designed page templates. Every layout decision (grid, spans, rails, header anatomy, form placement) is made ONCE, here, by us — never per-app by a model.
- **ViewNode stays the IR** — persistence, patches, SurfaceBuilder, ui.render all keep working. Advanced agents/operators may still hand-author trees; they just pass the same hard gate.
- Runtime path is unchanged and abstraction-free: tree → registry → React. No new runtime layer.

---

## 2. Logic & Routing Overhaul (killing the dead UI)

### 2.1 The Operability Contract — RENDERED ≠ OPERABLE, enforced

New `auditOperability` beside `repairSurface` in `packages/core` — pure, deterministic, idempotent — wired at the seams every author already passes through ([appSurfaceStore.ts:208/233/267](../packages/app/src/appSurfaceStore.ts) + `surfaceGenerator` output). Two tiers:

**AUTO-WIRE (repair, the default):**
| Violation | Repair |
|---|---|
| Declared `workflow` action reachable from no element | Synthesize the page action bar: PageHeader gets a primary "Run" button bound to it (args from `inputSchema`) |
| Declared `data` update/delete with a Table on that collection and no rowActions | Synthesize rowActions (+ confirm for delete) |
| Table rows with no drill-down | Attach the default RecordDrawer (auto detail view + record actions) |
| App owns workflows, home has no OrchestrationPanel | Insert it under the header |
| Bare URL/email values | Formatter renders them as links automatically (no tree change needed) |
| `Metric` bound to a non-numeric | Renders as the status-pill Metric variant (no more 38px word-wrap) |

**REJECT (compile error back to the author, exactly like workflow readiness):** unknown node kind, bind to a nonexistent collection/field, action referencing an undeclared name, form submit without a matching `insert` action. The error names the fix — navigation-in-results, the Paved Road pattern that already works for workflows.

New agent tool **`agentis.ui.lint`** (mirrors the build-loop: author → lint → render → verify) so agents get the gate's findings *before* rendering, and the gate's auto-wires are visible in tool results (`compass.next` style).

### 2.2 One action grammar, every pixel wired

No new abstractions: the existing 6-kind `SurfaceAction` contract is the single wire. The overhaul is coverage + feedback:

- **Buttons/Hero/PageHeader/Toolbar** → any action kind; workflow buttons show busy → toast → inline run chip.
- **Run feedback loop:** dispatching a `workflow` action highlights the new run in RunMonitor and surfaces a "view run" chip (run room subscription already exists — make it the default UX, not a drawer secret).
- **Forms** → schema-driven from the action's `inputSchema` (workflow inputs) or collection schema (data inserts) — never hand-listed fields drifting from reality.
- **Rows** → drill (RecordDrawer) + rowActions; **Kanban drag** → declared update (already shipped, kept).
- **Optimistic data actions** with rollback (Kanban already does this; generalize in the kit).

### 2.3 Real routing (URLs are product behavior)

Today `navigate` only swaps component state ([AppRuntime.tsx:115](../apps/web/src/components/apps/AppRuntime.tsx)) — no deep links, no back button, no sharing. Add router sync (react-router already present):

- `/apps/:appId/:page` — surface pages; `?record=<id>` — RecordDrawer; `?run=<id>` — ops drawer on that run; `?approval=<id>` — approval focus.
- Browser back/forward, refresh-safe, shareable. The shell sidebar becomes real navigation, and every notification/approval/run chip can deep-link into the exact app state.

### 2.4 Data-plane efficiency (Radical Efficiency requirement)

- Replace per-block `useBoundRows` (re-queries on ANY `uiState` change via a `JSON.stringify` key — [ViewRenderer.tsx:168-195](../apps/web/src/components/apps/ViewRenderer.tsx)) with a per-app **query store**: dedupe identical (collection, filter, sort, limit) subscriptions across blocks, patch rows in place on `DATA_CHANGED`, stable row identity by id.
- One workspace realtime subscription owned by the shell, multiplexed to blocks (fixes the "blocks must hold `rtSubscribe`" gotcha centrally).
- Table windowing only if measured necessary (keep zero-dep bias).

---

## 3. Component Strategy — the Agentis Interface Kit

All kit blocks register on the existing registry seam. **Definition of done per block:** light + dark, comfortable + compact density, loading skeleton, designed empty state, error state, overflow/truncation rules, container-query responsive, keyboard accessible — *a block is done when it cannot look broken*, regardless of what data an agent binds to it.

### 3.1 Foundations
| Component | Anatomy (TailAdmin bar) |
|---|---|
| **AppShell** | Collapsible icon+label sidebar, topbar (app identity, page title, live cluster: run pulse / approvals badge / appearance toggle), ops drawer. Restyled, route-aware. |
| **PageHeader** | Breadcrumb · page title (24-28px) · subtitle · **the action bar** (primary workflow actions live here — the operability gate's synthesis target). |
| **Formatter layer** (`format.tsx`) | THE value brain, used by every block: status → humanized tone pill (`SUCCESS_DEPLOYED_STORE_AND_CRM` → `Deployed · store + CRM`), url → favicon + domain link (external-safe), email/phone → actionable, date → relative + tooltip absolute, number/money → locale + compact (`12.4k`), boolean → check/dash, id-reference → entity chip, long text → truncate + tooltip. Type inferred from collection schema first, then key/value heuristics. |

### 3.2 Data & analytics
| Component | Notes |
|---|---|
| **StatCard / KPIGrid** | Icon tile, 32-40px tabular numeral with **auto-fit** (char-count clamp — kills "ACCOMPLISHE D"), delta arrow ± tone, optional sparkline. Status-variant when value is a word. |
| **ChartPanel** | Restyled zero-dep charts: soft dashed grid, gradient area fills, rounded bars, legend chips, hover crosshair+tooltip (exists), period switcher, header w/ metric summary. |
| **SmartTable** | The workhorse. Formatter-driven cells, sticky header, sort/filter/pagination (exist — restyled), row drill → RecordDrawer, rowActions, multi-select + bulk action bar, column width policy (identity grows, urls/statuses fixed, numerics right-aligned tabular), CSV export. |
| **RecordDrawer / RecordPage** | Auto-generated detail: field groups by schema, related child collections, record actions, activity trail. The default row drill everywhere. |
| **Kanban · PipelineFlow · Roadmap · Funnel · Calendar · GaugeRing** | Keep behavior (drag-to-update etc.), rebuild pixels on the kit. |

### 3.3 Agentic control (the differentiator — controls no static template has)
| Component | Notes |
|---|---|
| **OrchestrationPanel** | The app's control plane (workflows, schedules, chains, run/pause) — restyled, always present on mission-control pages (gate-enforced). |
| **RunMonitor** | Live runs: status pulse, node progress, elapsed, cancel/pause/resume, expand → activity. The post-action feedback target. |
| **AgentFeed / ActivityTimeline** | The "watch the agent think" stream; signature live-pulse element. |
| **ApprovalsInbox** | One-click approve/reject/revise, deep-linkable. |
| **FormPanel** | Schema-driven (workflow `inputSchema` / collection schema), validation, submit → run feedback. |
| **AgentRegion** | Kept as-is conceptually; restyled placeholder. |

### 3.4 Design-system spec (Phase 1 deliverable, per frontend-design skill process)
Token plan before code: 4-6 named colors (canvas/surface/line/accent-blue-family/success/warn/danger), the type scale above, spacing (cards 24px pad, 16px gaps, 12-16px radius), shadow scale (subtle ambient, not glow-everything), **signature element = the live agentic pulse** (run activity breathing through the interface — the one place boldness is spent). Self-critique pass against the three named generic defaults before any component ships.

---

## 4. Phased Implementation

Ground rules for every phase: verified in the REAL app (Fashion Store Factory is the benchmark), screenshots judged against the TailAdmin reference (both appearances), typecheck + tests green before proceeding ([[feedback_clean_no_loose_ends]]), impl log appended here.

| Phase | Scope | Key seams touched | Exit criterion |
|---|---|---|---|
| **P0 — Reference bar + freeze** (S) | Pin reference screenshots; inventory the 11 live apps' trees (done: dump script); pick migration mapping for dead kinds; no new features on the old layer from now on | — | Reference doc + mapping table in repo |
| **P1 — Design system foundation** (M) | `agentis` flagship tokens light+dark; rewrite `--s-*` contract; delete 5-language bodies (ids remain as variant aliases); type scale; AppShell restyle + route sync (§2.3) | `designLanguage.ts`, `styles.css`, `theme.ts`, `AppRuntime.tsx` | Shell + an existing surface render premium in BOTH appearances; deep links work |
| **P2 — Kit core** (L) | Formatter layer; SmartTable; StatCard/KPIGrid (auto-fit); ChartPanel restyle; PageHeader; StatusPill/EntityCell/LinkCell; EmptyState/skeletons | `ViewRenderer.tsx` block bodies via registry, `charts/index.tsx`, new `format.tsx` | Fashion Store home re-rendered with kit blocks passes side-by-side vs TailAdmin; zero raw snake_case/overflow anywhere |
| **P3 — Logic layer** (M) | `auditOperability` (auto-wire + reject) at appSurfaceStore seams; RecordDrawer default drill; run-feedback UX; `agentis.ui.lint` tool; query store dedupe | `genuiAudit.ts`→grow, `appSurfaceStore.ts`, `opsBlocks.tsx`, new query store | The DB evidence case is impossible: a surface with `run_factory` declared CANNOT persist without a reachable control; dispatching it shows live feedback |
| **P4 — Generation retarget** (M) | InterfaceSpec + compiler in `genui.ts`; rewrite `surfaceGenerator` prompts to spec-first; retarget `chatToolCatalog` ui.render guidance + orchestratorPrompt; scaffolds emit kit compositions | `genui.ts`, `surfaceGenerator.ts`, `chatToolCatalog.ts`, `orchestratorPrompt` | A fresh agent-built app is premium + operable with NO operator intervention, measured by the gate reporting zero auto-wires needed |
| **P5 — Migration + teardown** (M) | Auto-upgrade legacy trees at render seam (kind map, design-id map); re-scaffold the 3 production apps; DELETE dead code (old language bodies, dead block impls, stale showcase content); rebuild `/genui-showcase` as the kit gallery | render seam, showcase | Old apps render on the kit with zero markers; `git grep` finds no orphaned old-layer code |
| **P6 — Verification** (S) | Full e2e: build a new app via chat → gate → premium operable UI; run actions from every element class; both appearances; perf sanity (query dedupe, no re-render storms); screenshot set vs reference | — | Operator sign-off on pixels; all suites green |

**Sequencing rationale:** pixels first (P1-P2) so every later verification is judged on the real look; logic gate (P3) before generation retarget (P4) so the compiler is *born* under the contract; teardown last (P5) so nothing breaks mid-flight — but P0's freeze means no new investment in the condemned layer from day one.

### Decisions locked (override explicitly if disagreed)
1. One flagship design system with variants — not five parallel languages.
2. TailAdmin = anatomy + quality bar adopted on our tokens/stack; not a repo vendored wholesale (React 19/TW4 mismatch; our data/action plane is the hard part it doesn't have).
3. ViewNode remains the IR; agents move up to InterfaceSpec; the hard gate applies to ALL authors.
4. Zero-dep charts restyled, no ApexCharts dependency.
5. Light-first design, dark fully tuned, default follows platform theme, per-app pin.

### Open knobs (defaults chosen, cheap to change)
- Display typeface (Outfit vs Inter-only) — decided in P1 with screenshots.
- Per-app brand accent exposure (recommend: yes, one accent knob).
- Table virtualization (only if P6 perf measurement demands it).

---

## Impl log

*(append per phase — keep reconciled with real code)*

- 2026-07-05 — Masterplan authored. Evidence dump of live surfaces (script in session scratchpad; findings in §0.1). No code changed yet.
- 2026-07-05 — **P1–P6 EXECUTED e2e (same day).** What shipped, per phase:
  - **P1 Design system:** `.s-surface` scoped palette in `styles.css` — token re-point (`--color-*`) for the whole app subtree, dark base + TailAdmin-grade light bundle (`#465fff` accent, gray-25/white cards, gray-200 lines) + per-app `data-appearance` pins (dark-pin block declared last wins ties); appearance-dependent paint in `--app-*` tokens; kit primitives as CSS (`.s-btn[-primary|secondary|ghost|danger]`, `.s-icon-btn`, `.s-input`, `.s-chip`). `designLanguage.ts` rewritten: ONE flagship `agentis` (structure-only vars) + legacy ids as structural variants (zero migration); `MONOCHROME_BASE_VARS` deleted. Core schema: `agentis` design id + root `appearance` (additive). `theme.ts` presets → flagship; `CHART_PALETTE[0]` → `accent`. ViewRenderer root applies `s-surface` + appearance + per-app accent re-branding (`color-mix` soft ramps). AppShell: `s-surface` scope, solid sidebar w/ soft-accent active nav, h-14 blurred topbar, modal-shadow drawer. **Routing:** `?page=` synced (back/forward/share), `?ops=runs|activity|approvals|rules` deep-links the drawer.
  - **P2 Kit core:** `format.tsx` — the value brain (`classifyValue`/`formatDisplay`/`StatusPill`/`humanizeToken`/`numeralScale`/`isWordyMetric`): URLs→truncated external links, emails→mailto, SCREAMING_SNAKE→humanized tone pills (acronym-aware), ISO dates→relative+tooltip, numbers→locale-grouped (compact ≥10k), uuids→short code, long text→truncate+title. Table: formatter cells, numeric right-align (sampled classification), humanized pills, zebra fix for light. Metric/KPIStrip: wordy values render as pills (kills the 32px "ACCOMPLISHE D" wrap), numerals auto-fit by length. Hero → clean page-header anatomy (title+eyebrow+subtitle+ACTION BAR; gradient banner panel removed). Buttons/forms on kit classes. Charts: dashed grid, rounded bar caps, surface tooltip, pill legend.
  - **P3 Approvals (operator mandate):** `ApprovalReviewModal.tsx` rebuilt as a decision document — header (tone icon tile + "Needs your decision" label + meta chips + Open-run chip), body (summary panel → human-input → action definition-grid → assets gallery → records → diff with `{from,to}`/`{before,after}` rendered as struck-through→success change pairs → **raw JSON collapsed behind a disclosure**), footer decision bar (Approve primary / Reject danger / Instruct-differently revise composer). `ApprovalPreviewCard` redesigned (icon tile, source chip, clamp summary, kit buttons; workflow name deduped vs title). `HumanInputApprovalForm` on kit inputs/buttons. Same endpoints/logic/redaction.
  - **P4 Operability gate:** `genuiAudit.ts` — `repairSurface(view, {collections, actions})` now runs `auditOperability`: strips interactives bound to undeclared actions (would 404), wires orphan `workflow` actions into the Hero action bar (or synthesizes a Toolbar; wraps child-less roots), wires declared `<col>.delete` as rowActions (`{id:{$row:'id'}}`), inserts OrchestrationPanel when the app drives workflows; legacy kind healing (`AgentConsole`→`ActivityStream`) + web registry read-path alias. Wired at `appSurfaceStore.render/patch` (stored actions) and **`setActions` re-audits + persists + emits** (the render-then-declare flow — an unreachable declared workflow action cannot persist). Web: `RecordDrawer` (default row drill-in: formatter fields, inline editing when `<col>.update` declared, row actions, Esc/overlay close) + run-feedback loop (`useActionInvoker` announces `runId` → shell chip → "View run" opens ops drawer).
  - **P5 Generation retarget + teardown:** genui.ts scaffolds stamp `design:'agentis'`; surfaceGenerator SYSTEM_PROMPT (flagship + appearance/accent knobs + THE OPERABILITY CONTRACT block), chatToolCatalog `ui.render`/`ui.action_schema`/`app.scaffold` descriptions, orchestratorPrompt PICK-THE-LOOK → contract. Old five-language bodies deleted.
  - **P6 Verification:** core 61/61 (incl. 8 new gate tests — the Fashion-Store case, toolbar synthesis, orchestration insert, dead-button strip, builtin keep, row-delete wire, legacy migrate, idempotency), api 42/42 (surfaceGenerator/appChatTools/apps routes), web ViewRenderer 15 + archetypeOps + ChatApprovalStrip + AppEditorPage 12 — all green; core/app/web typechecks clean (api typecheck fails ONLY in pre-existing in-flight `assetStore.ts`/`artifacts.ts` — untouched); web production build green. Showcase verified live (real ViewRenderer): dark `#597aff` accent + layered ink panels, light `#465fff`/white/gray-200 — computed-style proven both ways. **Live-data migration executed** (backup `data.db.bak-2026-07-05T17-38-00-995Z`): Fashion Store home rev 2→3 — `run_factory` wired into the header + OrchestrationPanel added; News Monitor rev 3→4 — legacy AgentConsole healed. The §0.1 defect is no longer present in production data.
  - **Deferred (explicitly):** per-app query-store dedupe (perf pillar §2.4 — current per-block fetch kept; measure first), `agentis.ui.lint` as a standalone tool (gate fixes already visible via revision bumps), InterfaceSpec typed layer (compiler = genui.ts as shipped; spec type when the LLM authoring path moves off free trees), `?record=` deep link into RecordDrawer. Needs API restart to load new prompts/gate.
- 2026-07-05 — **Deferred items EXECUTED (operator directive), all three:**
  - **§2.4 Query-dedupe data plane:** `useBoundRows` rewritten on a per-client `BindStore` (WeakMap-keyed). Identity = collection + RESOLVED filter + sort + limit — `$state` refs participate only through their current value, so unrelated uiState changes refetch NOTHING (the old hook keyed on the whole uiState: every keystroke refetched every bound view). One fetch per (key, dataRevision) no matter how many blocks share the bind (`fetchingRevision` guard); revision refetches keep prior rows on screen (live update, no skeleton flicker); empty entries GC after 30s. Hook signature unchanged → Table/List/Chart/Board/Kanban/RecordMaster/Roadmap all ride it.
  - **`agentis.ui.lint`:** new tool in `agentisToolHandlers/appData.ts` (+ chatToolCatalog projection, mcpExposed). The UI dry-run: lints a PROPOSED view+actions (or the stored surface) through `repairSurface` (layout floor + operability gate) WITHOUT persisting; returns `operable` + the exact fixes the gate would apply, and surfaces zod schema errors as first-class findings. Flow: author → lint → render.
  - **InterfaceSpec:** `interfaceSpecSchema` (app-wide `appearance`/`accent` + pages: `name`/`purpose` mission-control|board|records|roadmap|analytics|operations/`collection`/`title`/`subtitle`) + `compileInterfaceSpec` in `genui.ts` (extends the SAME archetype builders — single taste engine), lowering spec → named, gate-clean `CompiledPage[]` with page copy applied to the Hero and look knobs stamped on the root. Exported from core index.
  - **Verified:** core 65/65 (4 new interfaceSpec tests incl. a gate-clean assertion), web renderer/editor suites 32/32 on the new data plane, core+web typecheck clean, showcase live-verified (tables + Kanban render through the shared store; zero unknown/unbound/console errors). API typecheck still fails only in pre-existing `assetStore.ts`/`artifacts.ts`; also flagged a stale Abilities test (`agentisChatTools.test.ts` "creates and queues a reusable ability") left over from the 07-04 Abilities deletion — spawned as a follow-up task, unrelated to this work.
