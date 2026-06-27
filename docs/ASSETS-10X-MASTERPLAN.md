# Assets 10x — Unified, Agent-First Output Library

**Status:** Plan (2026-06-24) · **Owner:** operator · **Next migration:** v90

## Problem

Two surfaces grew up separately and neither is first-class:

1. **Global Artifacts** — `artifacts` table + `/v1/artifacts` + `ArtifactsPage` + `ArtifactPanel`.
   It is the path agents and channel delivery write through (`ArtifactService.persist`), but it
   is **not in the sidebar** — only reachable via a chat link. A user asked an agent for a
   screenshot and got a bare link to `/artifacts` (no inline experience).
2. **App "Data"** — a *different* subsystem: `app_collections` + `app_records` (typed datastore),
   surfaced only as the **Data facet inside the App editor** (`AppEditorPage`).

These are genuinely different concepts: App Data = *structured records an app reads/writes*;
Artifacts = *produced outputs* (screenshots, docs, exports, generated data). They should
**converge in experience** without being forced into one table.

### Concrete gaps

- `artifacts` has **no `appId`** and **no `origin`** field → cannot group "by what generated it."
- No sidebar entry → undiscoverable.
- `ArtifactPanel` fullscreen has **no opaque backdrop** and sits under the Shell chrome → the
  page bleeds through (the "goes completely transparent on maximize" bug).
- Cards are large (`aspect-video`, max 4 cols); no defined minimized footprint.
- Agents can *write* artifacts but cannot **list/search/read** them → no reuse across runs/agents.

## Decisions

- **Name:** the surface is **Assets** (sidebar + global page). Distinct from App "Data" (datastore).
- **Convergence:** **link, don't merge tables.** Keep `app_records` and `artifacts` separate;
  unify the *UI* and add `appId` to artifacts so an app shows both its records and its assets.

## Phases

### Phase 0 — Bug fixes (no schema)

- **Fullscreen transparency.** `ArtifactPanel` renders fullscreen as a bare `inset-4` div at
  `z-40` with no backdrop. Fix: portal + opaque backdrop (`fixed inset-0 bg-canvas/95`), raise
  z-index above Shell top bar, ensure the panel body uses a solid surface token.
- **Smaller cards + minimized footprint.** Denser grid (`sm:grid-cols-3 lg:grid-cols-5
  xl:grid-cols-6`), smaller thumbnails, compact meta; explicit minimized/floating card size that
  does not rely on `aspect-video` stretching.

### Phase 1 — First-class & navigable

- **Sidebar entry** "Assets" in `Sidebar.tsx` (between Apps and Agents) with a new-asset badge.
- **Origin + app association.** Migration **v90**: add `app_id` (FK→apps, set null) and `origin`
  (`agent|app|workflow|channel|manual`) to `artifacts`; backfill origin from existing
  `agent_id`/`workflow_id`. Thread through `ArtifactService.persist`, route filters, types.
- **Two-axis browse:** group-by **Source** (Agent / App / Workflow) × filter-by **Type**, plus
  search and pinned-first.

### Phase 2 — Converge Data ↔ Assets

- App editor "Data" facet → **"Data & Assets"**: keep typed collections; add an Assets sub-view
  scoped by `appId`, reusing the global card grid + panel.
- Promote `DataView` (table renderer) to a shared component so app records and `type:data`
  artifacts render identically.

### Phase 3 — Agent-first

- Add `agentis.assets.list` / `search` / `read` registry tools (confirm `save`) so agents can
  discover and reuse outputs — the lever that makes "agents use it more than humans" real.
- Rich previews wherever assets are referenced (chat already resolves `artifact:` refs in
  `ThreadView`); extend to app surfaces and the home canvas.

## Touch points

- API: `apps/api/src/routes/artifacts.ts`, `apps/api/src/services/artifactService.ts`,
  registry tool handlers under `apps/api/src/services/agentisToolHandlers/`.
- DB: `packages/db/src/sqlite/{schema,migrations}.ts` (v90), `packages/db/src/pg/schema.ts`.
- Web: `apps/web/src/pages/ArtifactsPage.tsx`, `apps/web/src/components/ArtifactPanel/*`,
  `apps/web/src/components/Sidebar.tsx`, `apps/web/src/App.tsx`, `apps/web/src/pages/AppEditorPage.tsx`.

## Impl log

### 2026-06-24 — Phases 0–3 shipped

- **Root cause of "transparent on maximize":** `bg-surface-1` is **not a defined
  Tailwind token** (only `surface`/`surface-2`/`surface-3` exist) → it rendered
  transparent. Fixed all usages in `ArtifactPanel`/`ArtifactsPage` → `bg-surface`.
  `ArtifactPanel` fullscreen now renders through a `createPortal` to `document.body`
  with an opaque backdrop (`bg-canvas/90 backdrop-blur-sm`, z-80) and the panel at
  z-81 — above the Shell chrome, no bleed-through.
- **Smaller cards:** denser grid (`grid-cols-2 … xl:grid-cols-6`), `aspect-[4/3]`
  thumbnails, compact meta.
- **Schema (migration v90 `artifacts_app_and_origin`):** `artifacts.app_id`
  (FK→apps, set null) + `artifacts.origin` (default `manual`), backfilled, two
  indexes. Mirrored in `schema.ts` + the `index.ts` drift path. WorkflowEngine's two
  direct inserts set `origin: 'workflow'`; `ArtifactService` derives origin
  (`deriveArtifactOrigin`) and accepts `appId`; `browser.screenshot` tags `appId`
  from app viewport. Route gained `appId`/`workflowId`/`origin` filters + create fields.
- **Assets page + sidebar:** renamed to **Assets**, added to `Sidebar` (Library icon),
  new `/assets` route (legacy `/artifacts` alias kept for chat/share links). Two-axis
  browse: Source (origin) × Type + search; grouped into per-source sections when no
  source filter is active.
- **App editor:** "Data" facet → **"Data & Assets"** — Collections section +
  new app-scoped `AppAssets` grid (`?appId=`) opening the shared `ArtifactPanel`.
- **Agent tools (`assets.ts`):** `agentis.assets.list` / `search` / `read`
  (metadata-only list/search; capped content read), registered in the handler index.
- **Tests:** `migrate.test.ts` de-brittled (app block asserted by version range, not
  `slice(-7)`) + new v90 column coverage. db 12/12, api artifact suites 7/7, all three
  packages typecheck clean. Browser click-through not done — fresh preview hits the
  login wall (no creds; user's authed session is on a separate origin).

Deferred: resolve specific producer **names** (agent/app/workflow) in the Assets
section headers (needs name lookups); set `app_id` on workflow-run artifacts by
resolving the App that owns the running workflow.

### 2026-06-24 — UX revision + type expansion (post-review)

Feedback: dual-axis filter on one row was confusing; cards resized to fit the
asset; type set looked impoverished.

- **Layout:** Source is now a **left vertical rail** (with per-source counts);
  Type is a **top tab row**. Two axes, two places — no more inline confusion.
- **Cards:** fixed-height window (`h-40`) with `object-cover object-top` so tall
  assets show their **top edge** at uniform size, plus a bottom fade hinting "more
  inside". Grid is `auto-fill minmax(180px,1fr)`. Same treatment in the App
  "Data & Assets" grid.
- **First-class types (no migration — `artifacts.type` is plain TEXT):** canonical
  list moved to `@agentis/core` (`packages/core/src/types/artifact.ts`:
  `ARTIFACT_TYPES`, `ArtifactType`, `artifactTypeSchema`, `isArtifactType`,
  `artifactTypeFromMime`, `ARTIFACT_TYPE_LABELS`). Expanded 5→**10**:
  image, document, pdf, spreadsheet, data, code, html, audio, video, archive.
  API (`artifactService`, `routes/artifacts`, `assets` tool) and web
  (`ArtifactPanel/types`) all import the one source of truth. ArtifactPanel gained
  viewers: pdf (iframe), audio/video (`<audio>/<video>`), spreadsheet (CSV→table,
  binary→download), archive→download; binary downloads now link the `data:` URL
  directly (decodes bytes) instead of wrapping the URL string in a text Blob.
  Workflow *node* configs (artifact_save/collect `acceptTypes`) intentionally left
  at the original 5 — the engine only emits those today.

Verified: core/api/web typecheck clean; db 12/12; api artifact suites 4/4.

### 2026-06-24 — Image zoom/pan viewer

- `ArtifactPanel` image case → new `ZoomableImage`: scroll-to-zoom toward the
  cursor, drag-to-pan when zoomed, double-click toggle, bottom-left toolbar
  (+/−/reset) mirroring the Brain canvas controls, live % readout. Fixes
  "screenshot unreadable when fit-to-window" — zoom reveals native pixels.
- Open follow-up (not done): capture screenshots at `deviceScaleFactor: 2` for
  sharper text. Deferred because it needs `browserPool.#withPage` to create a
  `newContext({ deviceScaleFactor })` and manage context teardown (the pool
  currently uses `browser.newPage()` and already leaks the implicit context) —
  too much risk to bundle with a UI change.

### 2026-06-24 — Download fix + branded share

- **Download bug (root cause):** binary assets are stored as `data:` URLs and the
  prior code set `a.href = dataURL` — Chrome truncates large `data:` hrefs, so the
  saved file was corrupt/unopenable. Now `dataUrlToBlob` decodes (base64→bytes) into
  a typed Blob and downloads via an object URL; extension derived from the real MIME
  (`MIME_EXT`). `artifactToFile` materializes a `File` reused by download + share.
- **Share → branded menu:** the Share icon opens a dropdown ("Made with Agentis ✨"
  header) with **Share asset…** (Web Share API — sends the actual file with the
  branded caption; desktop fallback = download + copy link), **Download**, and
  **Copy link** (caption + link). Replaces the bare copy-link button.

### 2026-06-24 — Share simplified + Iterate wired

- **Share is one action again** (dropdown removed per feedback): clicking Share
  invokes the branded Web Share directly (file + "made with Agentis ✨" caption),
  falling back to copy-branded-link on browsers without Web Share.
- **Iterate now does something real:** opens the chat docked with a **semi-ready,
  type-aware draft** (`autoSendInitialDraft: false`, via `ChatPanelStore.openChat`)
  that references the asset by `artifact:<id>` so the agent can pull it with
  `agentis.assets.read`, then closes the panel so chat is visible. Per-type prompts
  (image→recreate as HTML, code→refactor/extend, data→analyze, doc/pdf→rewrite, …).
