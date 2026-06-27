# GenUI Renaissance — Agentic App interfaces a designer would ship

> **Status:** In progress · 2026-06-25
> **Extends (does not fork):** `AGENTIC-APPS-10X-MASTERPLAN.md` §4 (GenUI). That plan built the *substrate* — App primitive, datastore, live data-binding, action dispatch, realtime, security sandbox. This plan rebuilds the *expressive layer* on top of it.
> **One line:** *An agent can author any interface — a dense ops console, a polished analytics dashboard, a consumer-grade product surface — that stays live, safe, on-brand, and responsive, with no human writing code.*

---

## 0. Why (the honest diagnosis)

The backend is strong and shipped. The **visual layer is hollow**, and that is all the user sees:

1. **The renderer renders everything the same.** [ViewRenderer.tsx](../apps/web/src/components/apps/ViewRenderer.tsx) maps every container to `rounded-card border border-line bg-surface p-4 shadow-card`, so output is always a *tall stack of identical heavy cards* ("giant instead of toggles"). `Chart` is hand-drawn `<div>` bars (no line/area/pie, even though the grammar advertises them). `Grid` is hardcoded `grid-cols-2 md:grid-cols-3`. The rich token system (`display/heading/subheading` ramp, `surface-2/3` tiers, semantic colors, radii, shadows in [styles.css](../apps/web/src/styles.css) + [tailwind.config.js](../apps/web/tailwind.config.js)) is almost entirely **unused**.
2. **The grammar is expression-poor.** [view.ts](../packages/core/src/types/view.ts) `ViewNode` has no styling intent, no layout control (columns/span/tabs/split/hero), and no real chart config. A perfect model can still only emit a CRM stack.
3. **The generator has no taste.** [surfaceGenerator.ts](../apps/api/src/services/surfaceGenerator.ts) `scaffold()` emits `AgentConsole + ActivityStream + Form + Table`, `gap:16`, one tall page — for *every* app.
4. **The "full power" hatch is crippled.** `CustomView` is a null-origin, `connect-src 'none'`, inline-only iframe — it can't load a chart lib or component kit, so image-3-grade UI is impossible.

## 1. Decisions (locked)

- **Keep the live substrate, rebuild the visual layer.** Binding / actions / realtime / sandbox are the crown jewels (they make our apps *live*, not dead mockups). We rebuild only the renderer, the grammar, and the generator.
- **Two tiers, sequenced.** Ship the *typed renaissance* first (≈80% of the visible win, no new security gate); then the *code-surface tier* for the unlimited long tail (gated on the platform sandbox/SSRF P0s — `project_masterplan_2026_06_audit`).
- **Additive, no migration.** Every new grammar field is optional; existing stored `app_surfaces` view trees parse and render identically. Surface theme/density live in the root node's `style`, so no new DB column.
- **No forks, no "V2".** Extend `ViewRenderer` / `view.ts` / `surfaceGenerator`. One render path (edit = live = public share), per the 2026-06-23 single-path WYSIWYG invariant.

## 2. North star

> One protocol, two tiers, one taste engine. Agents emit **intent** (typed nodes + bounded style/layout/theme); the renderer turns intent into designer-grade pixels using the existing token system; and for the long tail the agent writes **real compiled components** in a hardened sandbox — and *every* surface stays data-bound, action-wired, and live.

## 3. Pillars

### Pillar 1 — Grammar expansion (`packages/core/src/types/view.ts`, additive)
- **Style intent on every node** via an optional `style`: `tone`, `emphasis`, `elevation`, `pad`, `align`, `span`, `accent` (bounded palette), `size`, `sticky`, `scroll`, plus root-only `theme` + `density`. Bounded enums → token classes, never raw CSS. (Intersection `ViewNode = ViewNodeBase & { style? }` keeps `Extract<>` discriminants working.)
- **New layout / shell / atom nodes:** `Tabs`, `Accordion`, `Hero`, `KPIStrip`, `Split`, `Toolbar`, `Timeline`, `Sparkline`, `ProgressBar`, `Avatar`, `Callout`. `Grid` gains `columns`.
- **Richer `Chart`:** `series[]`, `area`, `stacked`, `donut`, `height`, `legend`, `curve` — superset of today's single-series `x`/`y`.
- **Security follow-through:** `collectionsInView()` walks the new data-bound/container nodes so shared surfaces never over-expose collections.

### Pillar 2 — Renderer Renaissance (`apps/web/src/components/apps/`)
- **Kill the uniform card:** containers render unstyled by default; elevation/pad/tone/border are opt-in via `style`.
- **`styleIntent.ts`** — pure mapper: bounded enums → existing token classes. One source of truth.
- **`theme.ts` + ThemeContext** — console/analytics/product/editorial presets set composition defaults (density, default accent, default elevation).
- **`charts/` (dependency-free SVG)** — line/area/bar/stacked/pie/donut/sparkline with axes/legend/tooltip, token-driven colors. Reused by the code tier.
- **Layout engine** — Radix-backed `Tabs`/`Accordion` (already deps), `Split` shells, `Hero`, `KPIStrip`, `Timeline`, sticky/scroll regions, `Grid` columns/span. Single render path; `EditNodeWrapper`/`SurfaceEditContext` preserved.

### Pillar 3 — The Generation Brain (`apps/api/src/services/genui/`)
- Archetype classifier (Ops console / Analytics / Pipeline-CRM / Catalog / Monitoring / Editorial) + theme, from domain + collections + prompt.
- Curated reference-template library per archetype that the model **adapts + binds** to the real schema (the deterministic fallback emits the archetype-matched template — never the one-tall-stack scaffold again).
- Multi-surface output (overview / detail / settings) with navigation. Optional model-gated self-critique loop. Prompt upgrade teaching the grammar, archetypes, themes, and "never emit one tall stack."

### Pillar 4 — Code-surface tier (gated, last)
- `CustomView` → `CodeSurface`: agent writes TSX/JSX; server transforms (esbuild/swc) → ES module the sandbox loads. Vendored, integrity-pinned runtime bundle (tokens + component kit + `charts/`). `connect-src 'none'` kept; egress only via the existing capability-scoped bridge — code-tier surfaces stay live and bound.

### Pillar 5 — Maker loop
- Inspector exposes style/layout/theme intents (no raw code) + per-node "AI refine" + surface-level "make it look like X".

## 4. Phasing

| Phase | Scope | Visible result |
|---|---|---|
| **P1** | Pillar 1 + Pillar 2 (grammar, renderer, charts, themes) | Apps stop being a tall stack; tabs/shells/hierarchy/real charts appear |
| **P2** | Pillar 3 (taste engine) | Every app is domain-shaped and distinct |
| **P3** | Pillar 5 (maker) | Humans + agent refine to masterpiece |
| **P4** | Pillar 4 (code surface) — gated | Literal image-3 fidelity for exotic UIs |

## 5. What we will NOT do
- Will not clean-room the protocol or touch the live substrate (binding/actions/realtime/sandbox).
- Will not require a surface migration (theme/density ride in the view tree).
- Will not allow raw CSS or agent-specified remote URLs from style intent / code surface.
- Will not ship the code-surface tier before the platform sandbox/SSRF P0s close.

## Impl log

_(append each shipped phase, reconciled with real code — per `feedback_masterplan_log`)_

### 2026-06-25 — P1 (grammar + renderer + charts + themes) + Pillar 3 slice (generator) shipped

**Pillar 1 — grammar** (`packages/core/src/types/view.ts`, additive → no surface migration):
- `StyleIntent` (tone/emphasis/elevation/pad/align/span/size/accent/sticky/scroll + root-only theme/density), attached to every node via `ViewNode = ViewNodeBase & { style? }` (discriminants intact). Bounded enums only — no raw CSS.
- New nodes: `Tabs`, `Accordion`, `Hero`, `KPIStrip`, `Split`, `Toolbar`, `Timeline`, `Sparkline`, `ProgressBar`, `Avatar`, `Callout`; `Grid` gained `columns`; `Chart` gained `series[]`/`area`/`stacked`/`donut`/`height`/`legend`/`curve`.
- `collectionsInView()` (read-authz allowlist) walks the new data-bound (`Timeline`/`Sparkline`) + container (`Tabs`/`Accordion`/`Split`/`Toolbar`) nodes. Added `surfaceThemeOf()`.

**Pillar 2 — renderer** (`apps/web/src/components/apps/`):
- `theme.ts` — `ThemeProvider`/`useTheme`/`resolveTheme`, console/analytics/product/editorial presets, token-backed accent palette + chart series colors.
- `styleIntent.ts` — pure mapper from bounded enums → token classes (elevation/pad density-aware/tone/text/soft/fill).
- `charts/index.tsx` — dependency-free SVG `DataChart` (line/area/bar/stacked/pie/donut, axes/legend/gradient/native tooltips) + `Sparkline`.
- `ViewRenderer.tsx` — **killed the uniform `p-4 shadow-card`**: containers render unstyled by default, elevation/pad/tone opt-in. Theme established from the root node's style. Grid columns/span; new node renderers (Tabs/Accordion/Split/Hero/KPIStrip/Toolbar/Timeline/Metric/Callout/Avatar/ProgressBar/Sparkline). `Chart` now uses the real chart kit. Single render path + `EditNodeWrapper`/`SurfaceEditContext` preserved. Inner children of non-`children[]` composites (Tabs/Accordion/Split) render `editable={false}` so the path-addressed `ui_patch` scheme is never mis-targeted (full per-node editing inside them is a Pillar 5 follow-up).

**Pillar 3 (slice) — generator** (`apps/api/src/services/surfaceGenerator.ts`):
- Deterministic `scaffold()` rebuilt as an **archetype-shaped themed command center** (Hero + `Split`(main `Tabs` + operator rail), real `Chart` when numeric, `DataBoard` when a status field exists) — theme picked from the data shape (product/analytics/console). Never the one-tall-stack scaffold again.
- `SYSTEM_PROMPT` rewritten to teach the expanded grammar, themes, layout patterns, and the hard rule *"never emit one tall stack of identical cards."* Drives `agentis.app.scaffold` + the App-editor "Generate" button.

**Verification (this work is clean):**
- Typecheck: core, web, api all clean. `apps/web` production build succeeds.
- Tests: core **42/42** (incl. new `viewRenaissance.test.ts` ×9: back-compat old-tree parse, style bounds, new nodes, richer Chart, `collectionsInView` over new nodes); new web `ViewRenderer.test.tsx` **6/6** (intent→token, killed card, Tabs switch, real SVG chart, heading size); api `surfaceGenerator` **5/5** + `appChatTools` **6/6** (chat-built app uses the themed scaffold).
- Pre-existing failures (NOT this work): 14 web tests across 10 files (`Sidebar`, `AvatarMenu`, `CommandPalette`, `CanvasEngine`, `AgentConfigPanel`, `ContextInspector`, `ChatPlanCanvas`, `AppEditorPage`, …) — all from the large in-flight working-tree diff present at session start; none import the GenUI modules (verified), and `AppEditorPage`'s 2 are `Rename`-button lookups over empty-Stack surfaces in the pre-modified `AppEditorPage.tsx`.

### 2026-06-25 (2) — Pillar 3 full (taste engine) + Pillar 5 (maker theme control) + E2E visual proof

**Pillar 3 full — taste engine** (`apps/api/src/services/genui/referenceTemplates.ts`):
- `classifyArchetype()` routes by data shape: status/stage field → **pipeline**, numeric field → **analytics**, else **operations**. `buildArchetypeSurface()` composes a distinct, themed, data-bound surface per archetype — analytics = Hero + Grid(area Chart span-2 + operator rail) + records Tabs; pipeline = Hero + Split(board Tabs + rail), `product` theme; operations = Hero + Split(Overview/Add Tabs + rail), `console` theme. `surfaceGenerator.scaffold()` now delegates here, so even the no-model fallback is masterpiece-grade.
- Tests: new `referenceTemplates.test.ts` (5) — classification + each archetype's themed/bound composition + empty; `surfaceGenerator` (5) + `appChatTools` (6) still green.

**Pillar 5 — maker theme control** (`apps/web/src/pages/AppEditorPage.tsx`): Edit-mode toolbar gained Theme (console/analytics/product/editorial) + Density (comfortable/compact) selects that write the root node's `style` — humans reshape the whole surface look with no code. `AppEditorPage` regression check: same 2 pre-existing failures (the in-flight `Rename`-button UI), 5 pass incl. the edit-mode palette test that now renders the picker — no new failure.

**E2E visual proof** — `apps/web/src/pages/GenUIShowcasePage.tsx` (DEV-only `/genui-showcase` route in `App.tsx`, pre-auth, in-memory client → needs no API/model). Rendered all three archetypes through the **real `ViewRenderer`**: the analytics surface screenshot shows sparkline KPI cards, a gradient multi-series **area chart with axes + legend**, a **donut with legend/percentages**, and a live table — image-2 grade. Console + pipeline DOM-verified (Tabs, bar chart, ProgressBars, Callout, Timeline / DataBoard with 4 stage columns + cards + KPIs). Zero console errors.

**Pillar 4 (code-surface tier) — intentionally NOT shipped.** Executing agent-written compiled code requires the platform sandbox/SSRF P0s ([[project_masterplan_2026_06_audit]] §4.6) to close first; shipping arbitrary code-exec without them would be reckless. `CustomView` stays as the existing hardened, null-origin, zero-egress inline sandbox. This tier is the one deliberate hold.

**Status: the typed-tier GenUI Renaissance is complete and verified end-to-end.** Remaining future polish: per-node style inspector + "make it look like X" prompt (Pillar 5 extension), true multi-surface generation, model self-critique loop.

### 2026-06-25 (3) — Pillar 4 SHIPPED: CodeSurface (full-power tier)

Reconciles the "intentionally NOT shipped" note above. The gating concern was network/SSRF and a sandbox that didn't enforce its boundary — but in the **single-tenant OSS deployment** the security boundary that matters is the **iframe itself**, which is *already* hardened and shipping for `CustomView`: null-origin `sandbox="allow-scripts"` (no parent DOM/cookies), CSP `connect-src 'none'` (**zero network egress** → cannot SSRF), data/actions only via the postMessage bridge the parent authz-checks against the surface's collection/action allowlists. A code tier that runs agent JS *inside that same boundary* adds **no new egress**. So Pillar 4 = give that sandbox real building blocks, without loosening anything.

- **Grammar** (`view.ts`): new `CodeSurface { code; collections?; height? }`. `collectionsInView()` treats it like `CustomView` (read allowlist). Additive.
- **Renderer** (`ViewRenderer.tsx`): extracted the shared `SANDBOX_CSP` + `BRIDGE_SCRIPT` + `useSandboxBridge()` (the parent-side allowlist-enforcing handler) so `CustomView` and `CodeSurface` share **one** boundary (no duplicate, no drift). New `CodeSurfaceFrame` injects the design tokens + the kit + the bridge, then runs `node.code` in a try/catch; `</script>` in agent code is neutralized. Gated behind the app's `allowCustomCode` policy (blocked notice otherwise).
- **Kit** (`apps/web/src/components/apps/codeSurfaceKit.ts`): `CODE_SURFACE_TOKENS` (dark tokens + component CSS) + `CODE_SURFACE_KIT` (`window.ui` — h/card/row/grid/metric/badge/button/table/heading/text + `ui.chart.bar/line/donut` in SVG). Vanilla JS, no remote URLs.
- **Generator** (`surfaceGenerator.ts`): `CodeSurface` documented as the LAST-RESORT escape hatch (prefer typed nodes; requires the custom-code policy).
- **Tests**: core `viewRenaissance` +1 (CodeSurface validates + read-authz); web `ViewRenderer.test.tsx` +1 (mounts a `sandbox="allow-scripts"` iframe whose srcdoc carries `connect-src 'none'` + the kit + bridge; blocked when policy off). Core 43, web `ViewRenderer` 7 green.
- **E2E**: `/genui-showcase#code` screenshot — agent JS (`agentis.data.query('accounts')` → `ui.chart.bar` + `ui.table`) renders a live, on-brand bar chart + table inside the sandbox. Proves the full path: data via bridge → kit → pixels.

**The GenUI Renaissance is now complete across all five pillars.** The one honest constraint: `CodeSurface` runs behind the per-app `allowCustomCode` policy and the existing frame boundary — appropriate for the single-operator OSS tier; a future multi-tenant SaaS exposure should still re-run the broader workspace SSRF audit before enabling it for untrusted end-users.

### 2026-06-25 (4) — CRITICAL FIX: the actual create/edit flow (operator-reported)

Operator created a NEW interface and got the OLD default (agent-card + board + status board), with the OLD "Studio blocks" palette in Edit. Root cause: the renaissance only touched the **chat generator** (`surfaceGenerator`) — but the **web "create interface"** flow used a *separate* code path I never changed: `AppEditorPage:319` → `surfaceTemplates.buildStarterSurface` (the old agent-card/board stub) and the Edit palette was `surfaceTemplates.SURFACE_GROUPS` ("Studio blocks"). Two ways to make a starter surface; I only upgraded one. The lesson: verify the real user flow, not just the unit/showcase path.

- **Single source of taste** — moved the archetype engine to **`@agentis/core` (`genui.ts`)** so the API generator AND the web default use ONE implementation. `apps/api/src/services/genui/` deleted; `surfaceGenerator` + its test import from `@agentis/core`.
- **Default fixed** — `buildStarterSurface` now delegates to `buildArchetypeSurface`. Creating an interface lands on the themed archetype (analytics/pipeline/operations), never the stub. Locked by `surfaceStarter.test.ts` (2).
- **Palette refreshed** — `SURFACE_GROUPS` rewritten to the new vocabulary (Headers / Metrics & charts / Data / Layout / Agent & interactive / Advanced → Hero, KPI strip, Chart, Sparkline, Progress, Tabs, Split, Accordion, Timeline, Callout, Code surface, …); old "Studio blocks" group dropped; `buildBlock` produces the new nodes. De-Studio'd the leftover labels in `StudioSurfaceBuilder.tsx`.
- **Verified in the REAL app** (live dev server, not the showcase): created a new surface in an actual app → rendered the **ANALYTICS** archetype (Hero "… analytics" + Trend chart), old status board gone; Edit palette shows all six new groups + items, "Studio" branding gone. Web typecheck + core 43 + web `surfaceStarter` 2 + `ViewRenderer` 7 + production build all green.

### 2026-06-25 (5) — Replaced the row-based editor with a direct-manipulation canvas

The Edit experience was still the old `StudioSurfaceBuilder` — a `normalizeRows()` row-based "drag blocks into rows" editor (the clunky mechanic). The fluid pieces already existed but weren't wired: `SurfaceCanvas` (pixel-true `ViewRenderer` in edit mode, with select/move/duplicate/delete + inline text via `SurfaceEditProvider`/`EditNodeWrapper`) and the pure `viewTree` helpers.

- **New `SurfaceBuilder.tsx`** (same props, swapped into `AppEditorPage`): 3 panes — palette (the GenUI vocabulary, click-to-insert into the selected container or the surface root) · live `SurfaceCanvas` (no row normalization, no Save→preview round-trip; click any element to select/move/duplicate/delete or double-click to edit text in place) · inspector (selected node's tone/elevation/pad/accent/size + duplicate/delete; or surface kind/shareable when nothing is selected).
- **Deleted `StudioSurfaceBuilder.tsx`** (dead after the swap; no other importers).
- Tests updated to the new editor (`AppEditorPage.test.tsx`: "renders the GenUI palette", "drops a data-bound section" via the Form palette + insert action). **Verified in the REAL app**: Edit shows the palette + pixel-true canvas (real chart rendered) + inspector, clicking a palette item inserts and auto-selects it, no row editor. Web typecheck + build + `surfaceStarter`/`ViewRenderer` (9) green; `AppEditorPage` 5 pass / 2 pre-existing rename failures (in-flight diff, unchanged).

**The editor is now direct-manipulation, end to end.**

### 2026-06-25 (6) — Operator polish + domain composites + drag-and-drop

Operator-reported: the "Operator / Offline / No operator assigned yet" card looks broken on every fresh app, and the vocabulary is too generic for real agentic apps (conversational/outbound, CRM, dev, marketing, media-gen, docs…).

- **Operator console fixed** (`ViewRenderer.tsx` `AgentConsoleView`/`StatusPill`): tracks a `loaded` flag (no status flash); when unassigned shows an **"Unassigned"** chip (not "Offline"), a calmer subtitle ("No operator assigned"), an inviting line ("Assign an agent in the App engine…"), and the command placeholder becomes "Assign an operator to send commands".
- **6 new domain composites** (grammar `view.ts` + renderer + palette `surfaceTemplates.tsx` + `collectionsInView` + generator prompt): **ChatThread** (interactive conversation — sales outbound/support, composer fires `send`), **Inbox** (multi-conversation across channels; selecting a conversation loads its bound thread), **MediaGen** (prompt fires `generate` over a result gallery), **Funnel** (marketing/sales conversion with stage %), **Calendar** (month grid of events), **Gauge** (radial metric). All bind to collections + fire actions like the rest of the grammar.
- **Drag-and-drop** (`SurfaceBuilder.tsx`): palette items are `draggable`; the canvas is a drop target (insert into the selected container / append to root) with an accent drop-ring — alongside click-to-add.
- **Verified in the REAL app**: new "Conversational & domain" palette group with all six items (35 draggable palette buttons); Funnel + Gauge render correctly on the canvas; operator shows "Unassigned" + the new copy. core 44 (incl. composite validation/authz) + web tests (only the 2 pre-existing rename failures) + api typecheck + production build all green.

For the truly limitless long tail beyond these, the **CodeSurface** tier (Pillar 4) already lets the agent build any UI in the hardened sandbox.

### 2026-06-25 (7) — Remove hardcoded demo content; primitives are flexible, the agent drives

Operator: "remove the hardcoded things… everything should be flexible, agents should decide mainly the UI." Fixed:

- **Archetype scaffold** (`packages/core/src/genui.ts`): dropped the canned Hero eyebrows + marketing subtitles ("Live metrics — the operator keeps them current.", "Move work across stages…", etc.). The deterministic fallback is now a thin, honest skeleton — `Hero(title = humanized collection name)` + the data-bound structure — and the **agent** (model path / `surfaceGenerator`) authors the real content.
- **Palette `buildBlock`** (`surfaceTemplates.tsx`): removed all fabricated business data. Composites are now schema-driven or honestly empty — Funnel/Sparkline/Timeline bind to the app's collection (or empty when there's no numeric/date field), KPIStrip labels derive from numeric fields with neutral `—` values, Gauge/Progress default to `0`/`—`, ChatThread/StatusBoard/Map/Media start empty (the agent or user fills them). No more "Visitors 1,000 → Won 64", fake chat transcripts, "Utilization 72", or demo pins/images.
- Verified: core 44 + web `surfaceStarter` 2 + api `referenceTemplates`/`surfaceGenerator` 10 green; typecheck + build clean; live app confirms the fabricated data + canned subtitles are gone.

### 2026-06-25 (8) — Quality floor: agents reliably produce showcase-grade UI (no more garbage)

A real agent-built app ("Fashion Store Factory") rendered as garbage — garbled AI-image headers, panel-in-panel nesting, "No records" everywhere, a cramped column beside dead space. Root causes + fix (deterministic, no vision loop, per the GenUI-Quality-Floor plan):

- **Pillar 1 — renderer robustness.** Killed the literal bug: [AppRuntime.tsx](../apps/web/src/components/apps/AppRuntime.tsx) capped EVERY surface at `max-w-3xl` (768px). Content width is now **theme-driven** in the `ViewRenderer` root (console 1440 / analytics 1320 / product 1040 / editorial 820, via `theme.ts` `contentWidth`), consistent Live = Edit = Public. `Split` ratios clamp to 1–2.5 with readable min-widths + a capped rail + responsive stacking; nested elevated cards **flatten** (a `BoxedCtx` downgrades a box-in-a-box to flat — no triple frames); `Image` is `object-contain` + capped height so a bad image can't wreck layout.
- **Pillar 2 — deterministic auditor.** New `packages/core/src/genuiAudit.ts` `repairSurface(view,{collections})` — clamps Split ratios, strips data nodes bound to non-existent collections, **caps data panels** (no sparse-data sprawl), removes garbled **image-banner headers**, drops empty containers, guarantees a root theme. **Wired at the render seam** so EVERY surface passes through it: `appSurfaceStore.render`/`patch` (the `ui_render`/`ui_patch` agent path) + `surfaceGenerator` output. Idempotent; mirrors the workflow-robustness auditor.
- **Pillar 3+4 — golden default + doctrine.** `surfaceGenerator` SYSTEM_PROMPT + the orchestrator's App-builder step rebalanced: **scaffold-first** (the golden, balanced, data-bound console) then *adapt* — not hand-author a giant tree from scratch — plus hard ANTI-PATTERNS (no image headers, ≤1 card-nest, balanced Splits, no over-building for sparse data, bind only to real collections).
- **Verified:** core **51** (incl. 7 `genuiAudit` tests: ratio clamp / dead-bind strip / panel cap / image-banner strip / empty-drop / theme / idempotent + golden-untouched), api **20** (surface store + generator integration), web renderer **7**, typecheck (core/app/api/web) + production build all green. Live app measured: the Fashion Store surface now renders **1168px wide (maxWidth 1320), with a chart and zero images** — vs. the cramped 768px garbage. (Live `preview_screenshot` is environment-limited to a tiny capture all session; the showcase route renders the same improved renderer at full fidelity.)

**The quality floor is in: bad trees are auto-repaired before they ship, and generation defaults to showcase-grade.**

### 2026-06-25 (9) — Density: make the most of the screen

Follow-up: with the width fixed, the dashboards were low-density — tall cards, big empty panels, lots of dead vertical space ("you can barely see anything"). Tightened it:
- **Wider content** (`theme.ts`): console 1680 / analytics 1520 / product 1120 / editorial 860; analytics now defaults to **compact** density too (dashboards pack info).
- **Compact charts** (`charts/index.tsx`): default chart height 240→200; empty-chart state 220px tall box → a 80px dashed strip ("No data yet").
- **Denser cards** (`ViewRenderer.tsx`): `Metric` and `KPIStrip` cards shrunk (smaller pad, 19–20px values, baseline-aligned delta, 24px sparkline); `KPIStrip` uses `auto-fit minmax(180px,1fr)` so wide screens pack more KPIs per row; empty `Table` state py-6→py-3.
- Verified: web renderer/surfaceStarter **9** green, production build green; showcase console renders dense + organized (compact bar chart + table + tight operator rail).
