# Agentis — Agentic Systems Architecture

> **Status:** Complete architecture spec · build-ready · 2026-06-22
> **Companion to:** `AGENTIC-APPS-10X-MASTERPLAN.md` (the build/reshape of the App primitive — largely shipped).
> **This doc answers the "how":** the canonical model (§0–§1A), the IR + concrete `AppManifest` schema (§2), the capability contract (§3), the owned UI framework (§3A), packages (§4–§5), runtime/harness (§6–§8), lifecycle/install/upgrade/migrate (§9), OSS-first/Hub-ready (§10), the unified IA (§11), security (§14), known gaps (§15), the bridge API (§16), the data model (§17), the de-monolith map (§18), non-goals (§19), glossary (§20), acceptance criteria (§21), and the open-decisions log (§22).
> **One line:** *Agentis is the runtime where you build an Agentic App — UI, logic, memory, data, and agents as one portable unit — in code or by asking an agent, and run it inside Agentis.*
> **Build sequence:** freeze the IR (§2.1, §21·1) → capability contract (§3.1) → unify the IA (§11) → extract `@agentis/runtime` (§18) → SDK + CLI (§5·5) → Agentis UI + `app-client` (§3A, §16) → lifecycle (§9) → security pass (§14) → Hub-ready seams (§10). Don't reorder; each unblocks the next (§13, §21).

---

## 0. The single most important decision: one primitive, many facets

**There is exactly one buildable thing in Agentis: the Agentic App.** Not "workflows" and "apps" as separate concepts. A workflow is not a sibling of an app — it is the *logic facet* of an app.

```
                          AGENTIC APP  (the only primitive)
   ┌──────────────────────────────────────────────────────────────────────┐
   │  facets — present only when the builder adds them (progressive)        │
   │                                                                        │
   │   ▢ Logic     (workflow graph + agent sessions)   ← "a workflow"       │
   │   ▢ Interface (AG-UI ViewNode surfaces)           ← "a UI"            │
   │   ▢ Data      (typed datastore collections)       ← "a database"      │
   │   ▢ Memory    (brain scope)                        ← "it remembers"    │
   │   ▢ Team      (operator + worker agents)           ← "who runs it"     │
   │                                                                        │
   │   + identity · policy · capabilities (the app-as-tool surface)         │
   └──────────────────────────────────────────────────────────────────────┘
```

- A cron automation = an App with **only the Logic facet**. It looks and feels exactly like today's workflow.
- A CRM = an App with Logic + Interface + Data + Team.
- A monitoring dashboard = an App with Interface + Data + Memory, no discrete "run."

This is **progressive disclosure**: you start with one facet and *add* the others when you need them ("Add a UI", "Add a database"). The user is never forced to think about five tabs to schedule a job, and never has to "convert a workflow into an app" — it already is one; it just hasn't grown the other facets yet.

**Strategic verdict (the "grave" point):** unifying Workflows and Apps into one primitive is correct, and it is the *more* coherent model — it matches the IR (§2), where every facet is already one field of one manifest. The earlier split (a separate `/apps` destination + removing the surface tab from the workflow canvas) created two mental models for one thing. We converge them. §11 is the concrete IA/migration.

> Keep the **word** "workflow." Devs search for it; it's the on-ramp. "Workflow" is the name of the Logic facet/tab. The top-level entity is the **App**.

---

## 1. What a (complete) Agentic App is

> A **versioned, portable product unit that runs inside Agentis** — combining UI, logic, agents, structured data, memory, and **callable capabilities**, with enough **policy, observability, and lifecycle** to be safely used, shared, upgraded, and operated in the real world.

| Facet | Artifact | Status in code |
|---|---|---|
| Identity | slug, name, version, icon, entry surface, manifest | ✅ `apps` table + `AppStore` (`services/app/`) |
| Logic | workflow graph(s) + agent sessions | ✅ engine (`apps/api/src/engine`) |
| Interface | AG-UI `ViewNode` surfaces | ✅ `app_surfaces` + `ViewRenderer` / `AppRuntime` |
| Data | typed collections | ✅ `app_collections` / `app_records` + `AppDatastore` |
| Memory | brain scope bound to the app | ✅ brain + one-way datastore→memory bridge |
| Team | operator + worker agents | ✅ `app_members` |
| Policy | audience, auth, who-can-do-what | ◑ partial (policy_json, approvals) — harden |
| **Capabilities** | the app exposed as a tool to other agents | ✗ **not built — §3** |
| **Lifecycle** | version/install/upgrade/migrate/fork | ◑ `.agentisapp` export/import exists; upgrade/migrate semantics ✗ |
| **Observability** | runs, ledger, audit, cost, recovery | ✅ engine ledger/runs (bind to App scope) |

The two genuine gaps to "complete" are **capabilities (app-as-tool)** and **lifecycle semantics**. Everything else exists.

---

## 1A. Audience & distribution model (operator-owned, package-distributed)

The canonical model — and it shapes auth, security, and the Hub. Hold it explicitly so we don't accidentally design a multi-tenant SaaS we didn't want.

- **An app is owned and operated by an *operator setup*** — one person *or* a company (multiple seats in one instance). The operator is the user.
- **Distribution = install the package into your own instance.** A creator exports a `.agentisapp`; a consumer **inserts it into their own machine/instance** and runs it there, under their own operator auth. This is the WordPress-plugin / n8n-workflow / Docker-image model — **not** "many strangers log into one hosted app."
- **The app runs inside the consumer's Agentis** (§6: runtime = Agentis itself). It does not become a separate hosted product with its own customer logins.
- **Sharing surfaces today = anonymous, read-mostly public links** (`shareable` + opaque token). That's the only "external viewer" path in V1, and it needs no accounts.

**What this means concretely:**
- **V1 (now), self-host first:** operator/seat auth (exists) + app scoping + a mostly-dormant `app.policy` (`private | workspace | public_link`). No end-customer accounts.
- **Company setup:** multiple operator **seats** in one workspace — team-tier auth, already modeled (`users` + `workspaces`). Not "customer auth."
- **Future (V2+), optional/paid:** if Agentis later *hosts* apps (cloud, component-gated, customer-facing), an **end-customer identity model** plugs into `app.policy` as a new audience tier. **Deliberately deferred** — designing it now would over-build for a model we aren't launching.

This is why "end-user/customer auth" is a **future seam, not a V1 requirement** (corrected in §14.3 / §15 #6).

---

## 2. The IR — the canonical App manifest (own this)

The strategic core. Agentis is **one canonical app format with multiple ways to produce and run it.** That format is the IR.

```
  AUTHORING (frontends)            IR                    EXECUTION              DISTRIBUTION
  ┌────────────────────┐
  │ @agentis/sdk (code)│ ─┐
  ├────────────────────┤  │   ┌────────────────┐    ┌──────────────────┐   ┌──────────────┐
  │ agent builder (NL) │ ─┼─► │ App Manifest   │──► │ Agentis runtime  │ ─►│  AgentisHub  │
  ├────────────────────┤  │   │ typed·versioned│    │ (= Agentis itself)│   │ (later)      │
  │ visual builder     │ ─┘   │ ·serializable  │    └──────────────────┘   └──────────────┘
  └────────────────────┘      └────────────────┘
```

**Three representations of the same thing — they must stay isomorphic:**
1. **Runtime representation** — the `apps` / `app_surfaces` / `app_collections` DB rows used while editing and running inside Agentis.
2. **Portable representation** — the **manifest** in `@agentis/core` (the IR). A typed, versioned object.
3. **Serialized distribution form** — `.agentisapp` (the on-disk/Hub bundle). Already implemented by `AppPackager`.

You already have all three in embryo. The work is to **promote the `.agentisapp`/packager schema into `@agentis/core` as the canonical, versioned manifest**, and make every producer/consumer target *it*:
- the SDK **emits** it,
- the agent builder + visual builder **emit** it,
- the runtime **consumes** only it,
- the Hub **distributes** it.

**Non-negotiable constraint — round-trip.** Code-authoring and agent-authoring must produce the *same* manifest, and `code → manifest → agent-edit → code` must hold. If the two paths fork into different artifacts, Agentis splits into two systems at the worst possible layer. Round-trip is the killer feature and the hardest invariant; design for it now (single manifest schema, no parallel "code-only" fields).

### 2.1 The `AppManifest` schema (the concrete IR — implementation target)

Lives in `@agentis/core` as a versioned zod schema. Every facet is a field; absence of a facet = that facet isn't used (a logic-only app has empty `surfaces`/`collections`). This is the artifact the SDK emits, the agent builder emits, the runtime projects to/from DB rows, and `.agentisapp` serializes.

```ts
interface AppManifest {
  manifestVersion: 1;                         // schema version; migrates forward
  // ── identity ──────────────────────────────────────────────
  slug: string;                               // lowercase, unique-in-workspace
  name: string;
  version: string;                            // app semver (NOT manifestVersion)
  description?: string;
  icon?: string;
  entrySurface?: string;                      // surface name opened first
  agentisVersion: string;                     // min runtime version required

  // ── facets (each present only when used) ──────────────────
  agents?: AppAgentRef[];                     // operator + workers (ref or embedded)
  workflows?: WorkflowSpec[];                 // logic graphs (the "workflow" facet)
  surfaces?: AppSurface[];                    // §3A — the UI facet (ViewNode trees)
  collections?: CollectionSpec[];             // §5 — typed datastore (SCHEMA only)
  memory?: { brainScope: boolean };           // bind a brain scope (no data shipped)

  // ── contracts & safety (declared, server-enforced — §14) ──
  capabilities?: CapabilityDecl[];            // what this app EXPOSES (app-as-tool, §3)
  requiredPlugins?: PluginRequirement[];      // external Agent Services it CALLS
  requiredCredentials?: CredentialSlot[];     // vault handles, NEVER values
  policy: AppPolicy;                          // audience + auth + grants (§1A/§14)

  // ── lifecycle / provenance (§9) ───────────────────────────
  dependencies?: AppDependency[];             // other apps/components by id+version
  migrations?: CollectionMigration[];         // ordered schema migrations (§9.2)
  source?: { kind: 'local' | 'hub'; id: string; author?: AuthorRef } | null;
  checksum?: string;                          // sha256 over canonical contents
}

type AppPolicy = {
  audience: 'private' | 'workspace' | 'public_link';   // V1 tiers (§1A)
  shareableSurfaces?: string[];                         // surfaces allowed public
  customCode: 'disabled' | 'allowed';                  // CustomView gate (§3A.9/§14)
  grants?: CapabilityGrant[];                           // cross-app/plugin allow-list
};
```

**Rules:**
- **Components may be referenced or embedded.** `AppAgentRef`/`WorkflowSpec`/etc. either embed the full definition or reference a shared component by `{ id, version }` (§5 content artifacts). The runtime resolves refs at install; the bundle can inline them for offline portability.
- **No facet carries runtime data.** `collections` ship *schema*; rows never travel except as explicit, scrubbed seed (§14.4). `memory` binds a scope; brain contents never travel.
- **`policy` is mandatory; everything else is optional.** A bare workflow = `{ identity, workflows:[one], policy:{audience:'private'} }`.
- **Canonical serialization is stable** (sorted keys) so `checksum` is deterministic and diffs (for upgrade, §9) are meaningful.

> The existing `AppPackager` `.agentisapp` envelope is the embryo of this. **Step 1 of implementation is to promote it into this `AppManifest` schema in `@agentis/core` and make `AppStore`/`AppDatastore`/`AppSurfaceStore` project to/from it.**

---

## 3. The capability contract — app-as-tool (the compounding layer)

The reframe that makes the ecosystem compound: **"Agentic Apps are tools for the agents inside Agentis."** An App is not only a product humans use through a UI — it **exposes callable capabilities** that *other* agents and apps invoke.

Define **one Capability contract** and make three things implement it:

```ts
interface Capability {
  name: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  invoke(input, ctx): Promise<output>;
  auth?: 'none' | 'api-key' | 'oauth2';
  latency?: 'realtime' | 'fast' | 'batch';
}
```

- **Native tools** (today's `data_*`, `ui_*`, `web_search`, …) — in-process.
- **Apps** — an App's declared `actions` + datastore queries become capabilities other agents call (App-as-tool).
- **Plugins / Agent Services** (AgentMail-style) — external services, same contract over the wire.

Then "agent tool use," "app composition," and "the Plugin marketplace" are the **same dispatch path** with different backends (in-process / in-workspace / external). This unification is what makes the Hub valuable: everything in it is callable by every agent — and it prevents a third "two-systems" rot.

### 3.1 Registration, discovery, dispatch (concrete)

```ts
type CapabilitySource =
  | { kind: 'native' }                              // in-process tool
  | { kind: 'app';    appId: string }               // App-as-tool (in-workspace)
  | { kind: 'plugin'; service: string };            // external Agent Service

interface RegisteredCapability extends Capability {
  id: string;                                       // "<source>.<name>"
  source: CapabilitySource;
  scopes: string[];                                 // collections/actions it touches
}

interface CapabilityRegistry {
  register(cap: RegisteredCapability): void;
  list(filter?: { source?; tag? }): RegisteredCapability[];
  resolve(intent: string): RegisteredCapability[];  // semantic discovery (Hub-era)
  invoke(id: string, input: unknown, ctx: InvokeCtx): Promise<unknown>;
}

interface InvokeCtx {
  workspaceId: string;
  callerAgentId?: string;
  actingSeatId: string;          // the human seat on whose behalf we act (§14.3)
  appId?: string;                // calling app, for scope checks
  signal?: AbortSignal;
}
```

- **One registry, three backends.** Your existing `AgentisToolRegistry` is the seed — generalize it so `app` and `plugin` capabilities register alongside native tools and share `invoke`.
- **`invoke` is the single authz chokepoint** (§14): validates input schema, checks the caller's `grants`/`policy`, authz's against `actingSeatId`, ledgers the call, enforces budget/rate limits.
- **App-as-tool projection:** an App's `capabilities[]` (manifest) + its declared `actions` become `RegisteredCapability` rows on install. Other agents call them like any tool.
- **Discovery (`resolve`)** is the Hub-era semantic search; in V1 it's an exact/tag lookup. Keep the method on the interface now so the Hub doesn't force an API change.

---

## 3A. The Interface facet — Agentis UI (own the representation)

> **The decision:** Agentis ships its **own declarative, render-anywhere UI framework** as *the* way apps have interfaces. We do **not** support arbitrary compiled frontend bundles (React/Tailwind/MUI/…) as a first-class mode. A narrow, sandboxed `CustomView` leaf exists for the genuine long tail — clearly marked as leaving the safe/portable zone. One framework + one escape valve, **not** two co-equal modes.

### 3A.1 Why owned-declarative, not arbitrary frontends

Every property that makes an Agentic App valuable depends on the UI being an **owned, declarative representation** — not an opaque bundle:

| Property (from §2) | Declarative Agentis UI | Compiled frontend bundle |
|---|---|---|
| Agent can read & edit the UI | ✅ | ❌ opaque blob |
| Round-trips visual ↔ agent ↔ code | ✅ | ❌ eject is one-way |
| Inspectable / diffable / reviewable | ✅ | ❌ |
| Safe by construction (no arbitrary JS) | ✅ | ❌ sandbox + supply chain |
| Consistent, themed, accessible for free | ✅ | ❌ every app diverges |
| Portable in `.agentisapp`, zero build infra | ✅ | ❌ bundler + asset hosting |
| **Render-anywhere from one tree** (web→mobile, email, Slack/Discord blocks, voice) | ✅ | ❌ welded to the DOM |

An arbitrary-frontend mode breaks all seven. The owned framework keeps them. The cost we accept in return: an **expressiveness ceiling** (covered by the escape hatch, §3A.9) and the **cost of building a real UI framework** (de-risked by sequencing, §3A.11).

### 3A.2 The model: `ViewNode` tree (today) → `AgentisUI` (10x)

Today: `app_surfaces.view_json` holds a `ViewNode` tree (Stack/Card/Table/Form/Button/List/Chart/Metric/Badge/Divider/Image/CustomView), rendered by `apps/web/src/components/apps/ViewRenderer.tsx`. That is the seed. The 10x framework extends the *same* declarative tree with seven subsystems below. **No new representation** — we grow the node vocabulary and the renderer, so existing surfaces keep working.

A surface is:
```ts
interface AppSurface {
  id: string;
  name: string;
  kind: 'page' | 'dashboard' | 'thread' | 'embed' | 'public';
  view: ViewNode;                 // the declarative tree (the ONLY UI representation)
  state?: StateSchema;            // declarative local UI state (§3A.5)
  actions: SurfaceAction[];       // declared, backend-enforced (§3 capability contract)
  params?: Record<string, ParamSpec>; // route params for navigation (§3A.8)
}
```

### 3A.3 Component kit (the catalog)

A *real* app kit, not 14 dashboard blocks. Grouped, named, and themed by the Agentis Design System. API + aesthetics deliberately mirror shadcn so it is instantly legible to React devs.

- **Layout:** `Stack`, `Row`, `Grid`, `Split`, `Spacer`, `Section`, `Card`, `Tabs`, `Accordion`, `ScrollArea`.
- **Content:** `Heading`, `Text`, `Markdown`, `Image`, `Media`, `Icon`, `Badge`, `Avatar`, `Code`, `Divider`, `Empty`, `Stat`/`Metric`.
- **Data display:** `Table` (sort/filter/paginate/select/export), `List`, `DataGrid`, `KanbanBoard`, `Calendar`, `Timeline`, `Tree`, `DescriptionList`.
- **Charts:** `LineChart`, `BarChart`, `PieChart`, `AreaChart`, `Sparkline`, `Gauge` (declarative `bind`+`x`/`y`/`series`).
- **Inputs:** `Form`, `Input`, `Textarea`, `NumberInput`, `Select`, `MultiSelect`, `Combobox`, `Checkbox`, `Radio`, `Switch`, `Slider`, `DatePicker`, `FileUpload` (→ artifacts, §15), `RichText`.
- **Navigation:** `NavBar`, `SideNav`, `Breadcrumbs`, `Link`, `Pagination`, `Stepper`.
- **Feedback / overlay:** `Alert`, `Toast`, `Banner`, `Progress`, `Skeleton`, `Spinner`, `Modal`, `Drawer`, `Popover`, `Tooltip`, `ConfirmDialog`.
- **Composites (the ported "blocks"):** `MessageFeed`, `MetricsGrid`, `ApprovalGate`, `StatusBoard`, `AgentCard`, `ConversationThread`, `DocumentViewer`, `MediaGallery`, `Map`.
- **Escape hatch:** `CustomView` (§3A.9).

Growth rule: the component *contract* (props shape, theming, binding) freezes early; the component *set* grows forever, driven by real apps. A missing component is never a hard wall because the escape hatch exists.

### 3A.4 Binding & expression model (reuse `safeExpression`)

Declarative reactivity with **no arbitrary JS**. We already own the safe half: `apps/api/src/engine/safeExpression.ts` + `SafeConditionParser`. Extend it into the renderer.

- **Bindable values:** `"literal"` or `{ $bind: "record.field" }` or `{ $expr: "lead.score * 0.7" }` (safe expression, sandboxed, no I/O).
- **Data binding:** `Table/List/Chart` take `bind: { collection, query?, sort?, limit?, live? }` → `data.query` + `DATA_CHANGED` refetch (already built).
- **Conditional rendering:** `{ $if: "row.status == 'open'" }` on any node (show/hide).
- **Repetition:** `List.item` is a template rendered per row with a row scope (already built); generalize to `{ $each: bind, as: "item", node }`.
- **Computed/formatters:** `{ $expr, format: 'currency'|'date'|'percent'|... }`.

### 3A.5 Local UI state (declarative, no JS)

Real apps need client state (open tab, selected row, filter text, form draft, wizard step) without an arbitrary JS runtime.

```ts
state: { activeTab: 'open', selectedId: null, filter: '' }
```
- Components read state via `{ $state: 'filter' }` and write it via the `setState` action (§3A.6).
- State is per-surface, ephemeral, client-side. It never touches the datastore unless an action persists it. This keeps the tree pure and the renderer deterministic.

### 3A.6 Actions & events (the click→backend loop)

Every interactive node names an **action** declared in `SurfaceAction[]` and enforced server-side against `app.policy` (§3 + §14). Action kinds:
- `data` → datastore op (`collection.insert|update|upsert|delete`)
- `workflow` → run a workflow (synchronous via `runPublishedWorkflow`) — **built**
- `tool` → invoke an agent tool in app context — **built**
- `capability` → call another App/Plugin via the Capability contract (§3)
- `navigate` → go to another surface (`{ surface, params }`) — client-side
- `setState` → mutate local UI state (§3A.5) — client-side

Args resolve from bindings/state/row scope (`$bind`/`$state`/`$row`). `data/workflow/tool/capability` are authz'd on the server with the **end-user's** identity, not the agent's (§14).

### 3A.7 Layout, theming, composition

- **Layout:** responsive `Grid`/`Row`/`Stack` with breakpoints (`sm/md/lg`), flex weights, gaps — declarative, no CSS required.
- **Theming:** design tokens (`color`, `space`, `radius`, `font`) resolved by the renderer; dark mode for free; an app may set a token override but cannot ship raw CSS in the safe path.
- **Composition:** named **`Component` templates** (reusable sub-trees with `props`/`slots`) so an app is a graph of small components, not one giant tree. This is what lets large apps stay maintainable and agent-editable.

### 3A.8 Navigation & multi-surface apps

An app has many surfaces; navigation is declarative: `navigate({ surface, params })`, route `params` declared per surface (`/orders/:id`), a `SideNav`/`NavBar` bound to the app's surface list. One app = one navigable product, not a pile of disconnected pages.

### 3A.9 The escape hatch — `CustomView` (narrow, sandboxed, leaf-only)

For the genuine long tail (a bespoke chart, a third-party embed). **Already built** (`ViewRenderer.tsx` `CustomViewFrame`): agent/dev HTML in a **null-origin** `sandbox="allow-scripts"` iframe, **CSP `connect-src 'none'`** (zero network egress), data/actions only through the postMessage bridge, which is **server-authz'd and per-collection allow-listed**.

Rules that keep it a leaf, not a mode:
- It is a **node**, not a surface type — a `CustomView` lives *inside* a declarative tree, scoped to a region.
- It is **explicitly marked non-portable/non-inspectable** in the builder ("this region leaves the safe zone").
- It is **policy-gated**: a workspace can disable custom code entirely; on the Hub, apps containing `CustomView` are flagged and scanned (§14).
- It gets the **same bridge** (`@agentis/app-client`, §3A.10) as everything else — no privileged escape.

### 3A.10 Authoring: one tree, three frontends, one DSL feel

- **Visual (anyone):** drag components → `ViewNode`. WYSIWYG.
- **Agent (vibecode):** NL → `ui_render`/`ui_patch` emit/patch the *same* tree. Visual + agent co-edit one artifact (round-trip is free because it's one JSON).
- **Code (devs):** the SDK exposes a **JSX-like / `ui.*` DSL** that *compiles to the tree* — devs write familiar-feeling code (`ui.table({ bind, columns })`), not raw JSON. The shared component kit (`@agentis/ui`) renders the tree **and** is importable by devs, so "open in code" scaffolds real, working code on the same kit (forward eject; see §15 on round-trip honesty).
- **The bridge** every path shares: **`@agentis/app-client`** — a tiny, **versioned, forever-stable** client:
  ```ts
  agentis.data.query/insert/update/delete(...)
  agentis.action.invoke(name, args)
  agentis.capability.call(name, args)
  agentis.auth.currentUser()
  agentis.theme.tokens()
  agentis.realtime.subscribe(...)
  ```
  No raw DB. No raw secrets. No backend escape. This client is a **public API contract** — design it minimal; semver it; never break it.

### 3A.11 Sequencing (don't try to build SwiftUI in a quarter)

1. ✅ Structured tree + renderer (`ViewNode` / `ViewRenderer`) — exists.
2. ✅ `CustomView` sandbox + bridge — exists.
3. **Freeze `@agentis/app-client`** (the bridge) — before growing anything.
4. **Extract `@agentis/ui`** (renderer + dev kit, shadcn-like) — the unifying component library.
5. **Add binding/state/composition/navigation** (§3A.4–3A.8) on `safeExpression`.
6. **Grow the component set** forever, driven by real apps.
7. **Render-anywhere targets** (email/Slack/mobile) — later, from the same tree.

---

## 4. The package graph (`@agentis/*`)

> **Current reality:** packages are `core`, `db`, `integrations`, `sdk` (stub), `cli`. The runtime still lives in `apps/api` (Part B reorganized `services/` into domain folders like `services/app/`, but did **not** yet extract packages). The graph below is the **target**; the extraction is the bridge from "monolith" to "framework."

```
                         @agentis/core
        (IR: App manifest spec · types · zod schemas · events · Capability contract)
                                 ▲   imports nothing
        ┌──────────┬─────────────┼─────────────┬──────────────┐
   @agentis/    @agentis/     @agentis/     @agentis/      @agentis/
    agents      workflows     datastore       ag-ui          brain
        └──────────┴─────┬─────┴──────────────┴──────────────┘
                         ▼
                   @agentis/app           ← composition: manifest → runnable App
                    ▲          ▲
            @agentis/sdk   @agentis/runtime ← THE Agentis engine (not an external target)
                    ▲          ▲
                    └ @agentis/cli ─────────► create / dev / build / export / import

   SEPARATE TRACK (different audience, shared Capability contract):
              @agentis/plugin-sdk   ── build agent-native services (AgentMail-style)
```

**Dependency rules:**
1. `@agentis/core` depends on nothing. It is the IR. Everyone imports it.
2. Each **capability package** (`agents`, `workflows`, `datastore`, `ag-ui`, `brain`) is independently installable and has **no knowledge of "App."**
3. `@agentis/app` is the **only** composition point — the place "App = sum of facets" becomes true.
4. `@agentis/runtime` is **Agentis itself** (see §6). `apps/api` becomes a thin host that imports it. The CLI boots the same runtime for self-host.

---

## 5. Two meanings of "shareable" — and you want both (answers the open question)

The claim *"`npm i @agentis/workflows` is independently installable → multiple on-ramps"* is correct **but it is a different layer** from what you were picturing ("share agents, knowledge, workflows to compose apps"). Don't conflate them:

| | **Code packages** (`@agentis/workflows`) | **Content artifacts** (a specific agent / workflow / KB / app) |
|---|---|---|
| What | The engine/libraries devs build *with* | The things people build and then *share* |
| Audience | Developers (`npm install`) | Builders + the Hub |
| Form | npm package | a portable bundle (you already have `PackageKind = agent \| workflow \| extension \| integration \| agentis`) |
| On-ramp | "I just want the workflow engine in my own app" | "Install this agent / this workflow / this whole app and compose it" |

- **§4 (code packages)** = *multiple developer on-ramps* to adoption. A dev who only wants the engine takes `@agentis/workflows`. Good for OSS mindshare.
- **What you want** = *component-level content sharing*: ship an agent, a workflow, a knowledge base, or a whole app as a reusable unit that another app **references or embeds**. This already exists in embryo as `PackageKind` and `.agentisapp`. The IR completes it: **an App manifest can reference shared components** (an agent from the Hub, a workflow template) **or embed them**.

Both are real and both matter. The doc's package graph is the *engine* layer; the Hub + package-kinds is the *content* layer. They meet at the IR: a shared component is just a sub-tree of the manifest with its own identity/version.

---

## 6. Runtime = Agentis itself (not an external target)

The runtime is **not** "a place apps go to run elsewhere." **Apps run inside Agentis.** The runtime is the internal execution engine: workflows, AG-UI surfaces, datastore, brain, tool dispatch, realtime, channels, public surfaces.

- Want cloud? You deploy **your Agentis instance** to your own infra. The app does not escape Agentis.
- "Import an app" = install a `.agentisapp` into an Agentis instance (like installing a plugin into WordPress or a workflow into n8n), which recreates its definition and Agentis runs it internally. **Not** generating a separate standalone deployment.
- Packaging it as `@agentis/runtime` is an **architecture boundary**, not a new product: it lets `apps/api` (hosted) and `agentis` (self-host CLI) and tests all boot the *same* engine, and ends the welded monolith.

---

## 7. The agent-execution backend (the "harness" layer) — corrected

An agent needs something to actually run its tool-loop. Agentis abstracts that behind **adapters** (`AdapterManager` + ACP client):

- **Today:** external provider harnesses — **OpenClaw, Hermes Agent, Claude Code, Codex, Cursor**, plus HTTP. (`services/harness*` is about *importing* agents from those, per `UNIVERSAL-HARNESS-ARCHITECTURE.md` — not a harness of our own.)
- **Future:** **Agentis's own harness** — a first-party native agent runtime, a later launch — plugs into the *same* adapter seam.

The harness is an **internal runtime concern (a pluggable execution backend), not a user-facing framework and not an authoring frontend.** There is no `@agentis/harness-sdk`. The authoring frontends are only: SDK (code), agent builder (NL), visual builder.

---

## 8. Apps vs Plugins (keep them separate)

| | **App** | **Plugin / Agent Service** |
|---|---|---|
| Built by | operators, devs, agents — *inside* Agentis | SaaS builders — *external* |
| Runs | inside Agentis | as an external service (e.g., AgentMail) |
| Shape | manifest of facets | a server exposing capabilities (+ optional embedded UI) |
| Authoring | `@agentis/sdk` / agent builder / visual builder | `@agentis/plugin-sdk` |

Both expose **capabilities** (§3) — that's the shared contract. But they are **different packaging/deploy/trust models** and must be **separate packages**. Merging "the App SDK" and "the Plugin SDK" because they feel similar is the trap.

---

## 9. Lifecycle, operations, distribution (the completeness layer)

What turns "a powerful runtime feature" into "a real app platform." This is the **#1 launch-relevant gap** for the package-distribution model (§1A): installing v2 of an app over v1's live data is exactly where things break, so it gets a full spec.

### 9.1 App states & versioning

- **States:** `draft → published → installed → (upgrading) → archived`. `published` snapshots an immutable manifest at a `version`.
- **Versioning:** the app `version` is **semver**. `manifestVersion` (schema) is separate and migrates independently. `agentisVersion` declares the min runtime.
- **Identity across instances:** `source.id` + `version` + `checksum` identify a specific published build so an installed app is traceable and updatable.

### 9.2 Install / upgrade / migrate (the data-safety core)

```ts
install(bundle: '.agentisapp'): { appId }          // create app + facets EMPTY (schema only)
upgrade(appId, nextManifest): UpgradePlan          // compute diff, run migrations, swap
rollback(appId, toVersion): void                   // restore prior manifest + reverse migration
fork(appId): { appId }                             // copy as a new editable app
```

- **Install** = create the app, its workflows, surfaces, and **empty** collections (decided default: empty-with-schema, §14.4). Resolve referenced components (§5) and required plugins/credentials → surface a **permission/consent prompt** (§14.2) before anything runs.
- **Upgrade** is a **manifest diff**, not a blind overwrite. Compute the delta between installed and next manifest:
  - *Additive* (new surface/collection/field, new action) → apply directly.
  - *Schema-changing* (collection field added/removed/retyped) → run the manifest's ordered **`CollectionMigration[]`** against live `app_records`, transactionally, with a pre-upgrade snapshot.
  - *Breaking* (removed collection/action still referenced) → block with a clear diff and require operator confirmation or a migration step.
- **`CollectionMigration`** mirrors the platform's own forward-only, idempotent migration discipline, but scoped to one app's collections:
  ```ts
  interface CollectionMigration {
    id: string; collection: string;
    op: 'add_field' | 'drop_field' | 'rename_field' | 'retype_field' | 'transform';
    spec: Record<string, unknown>;   // e.g. { field, type, default } or a safe transform expr
  }
  ```
  Transforms use the **safe expression engine** (no arbitrary JS), run row-by-row in a transaction, and are reversible-by-follow-up (no down-migrations, same as the core engine).
- **Rollback** restores the snapshot taken before upgrade (manifest + data) — bounded retention.
- **Compatibility guarantee:** an upgrade that would lose data without a declared migration **fails loudly** rather than silently dropping rows.

### 9.3 Operations (bind existing primitives to App scope)

Already-built engine primitives, scoped to the App and surfaced in one place: **runs, ledger, audit trail, cost meter, approvals inbox, failure recovery, kill switch, rate limits.** "What did this app do, to what data, on whose behalf, at what cost" must be answerable per app (§14.6).

### 9.4 Distribution without dependence

Export / import / fork / self-host all work with **zero Hub, zero account**. The Hub only *adds* discovery, sharing, selling, publishing, and fork-install over the **same** `.agentisapp` + manifest — never becomes mandatory (§10).

---

## 10. OSS-first, Hub-ready (what to build now, what to leave a seam for)

**Build now (the OSS product):** `@agentis/core` (IR), the capability packages, `@agentis/app`, `@agentis/runtime`, `@agentis/sdk`, `@agentis/cli`, `@agentis/plugin-sdk`. A user can **create, run, edit, export, install** apps with **zero account**. Export always produces a portable `.agentisapp`; import always works locally.

**Do NOT build AgentisHub now — but make it trivial to bolt on.** Leave these seams:
1. **Stable, versioned IR + `.agentisapp`** — the Hub is just publish/install/fork over this exact artifact. (Most important.)
2. **Provenance on the artifact and install:** manifest `source` carries `{kind,id,remoteId?,author?}`; the `.agentisapp` envelope carries its canonical sha256; the installed App and lifecycle snapshots preserve both. A Hub-installed app is therefore traceable and updatable without adding a Hub-specific schema.
3. **The Capability contract** (§3) — so Hub items are immediately callable by agents.
4. **An installer that is Hub-agnostic** — `import(.agentisapp)` today; `install(hubId)` later resolves to the same import path.
5. **Registry client seam** — you already have `registryClient` / `registryScanner`; keep the security scan on the import path so Hub content is scanned by the same code local imports use.

The rule that keeps OSS honest: **self-host first, Hub later, same artifact.**

---

## 11. The unified Agentic App experience (IA + migration)

This section operationalizes §0 and the "grave" correction.

**Target IA:**
- **Top-level nav: "Apps"**. It lists every App. A bare legacy workflow appears as an App-of-one and is promoted transactionally when opened. There is **no separate "Workflows" destination** — but the word "Workflow" remains as an App facet.
- **Inside an App**, `/apps/:id` is the single workflow-style editor with four always-visible facets:
  - **Workflow** — the real canvas and an App-scoped workflow switcher.
  - **Interface** — the AG-UI `ViewNode` editor with a live `AppRuntime` preview.
  - **Data** — collections/schema browser.
  - **Brain** — intelligence scoped to the selected workflow.
- `AppRuntime` remains the renderer for a surface (including public shares), not a competing App-level Run destination.

**Migration from the current split (what to change):**
1. Keep the backend as-is — it already models this (Apps own workflows; `app_id` nullable = App-of-one).
2. The former `/apps/:id/build` page is folded into `/apps/:id` as facets, so there is one App editor rather than a canvas page and a separate build page. The Interface facet is the AG-UI surface editor.
3. The **Apps list is the home for both**. "New App" atomically creates its entry workflow and opens Workflow; later visits open Interface.
4. Existing bare workflows appear as Apps-of-one and are promoted to a real App row without changing their graph when opened.
5. Retire "Workflows" as a separate nav entry once the Apps list reaches parity.

**Why this is right strategically:** one primitive = one mental model, one IR, one distribution unit, one Hub listing type. It removes the "is this a workflow or an app?" tax for users, and it means *every* automation a user builds is already a shareable, sellable, capability-exposing App — which is exactly the funnel into the Hub.

---

## 12. Current-state delta (honest)

| Target | Now | Gap |
|---|---|---|
| IR in `@agentis/core` | canonical `AppManifest`, envelope schema, deterministic serialization, and row projection exist | evolve only through explicit manifest migrations |
| `@agentis/{agents,workflows,datastore,ag-ui,brain,app,runtime}` | App domain is in `@agentis/app`; `@agentis/runtime` is a stable lifecycle seam | extract engine, agents, brain, and UI incrementally per §18 |
| `@agentis/sdk` (code authoring) | code helpers, client, starter App, and package output exist | grow ergonomic helpers without creating a parallel IR |
| Capability contract (app-as-tool) | native, app, and plugin capabilities share the registry/invoke chokepoint | deepen policy/ledger enforcement as capability sources expand |
| Unified App IA | Apps is the unified destination; workflows render as the Logic facet | continue convergence of legacy compatibility routes |
| `@agentis/plugin-sdk` | not started | separate track, shared contract |
| Harness (Agentis-native) | external adapters only (OpenClaw/Hermes/Codex/Claude Code/Cursor) | future launch on the same adapter seam |
| AgentisHub | provenance/checksum/install/upgrade seams are present; Hub product absent | **defer**; prove the artifact with real OSS Apps first (§10) |

---

## 13. Sequencing + the hard don'ts

**Order (each unblocks the next):**
1. **Freeze the IR** in `@agentis/core` (promote the `.agentisapp` schema). Make DB rows + agent tools project to/from it.
2. **Define the Capability contract**; route native tools/apps/plugins through it.
3. **Unify the App IA** (§11) — one primitive, facet tabs, Apps as home.
4. **Extract `@agentis/runtime` + capability packages** out of `apps/api` (Part B → framework).
5. **Ship `@agentis/sdk` + `@agentis/cli`** targeting the frozen IR; `npx agentis create` → running app. Guarantee round-trip.
6. **`@agentis/plugin-sdk`** (separate track).
7. **AgentisHub** — only once 1–5 exist and ≥5 real Apps have stressed the IR.

**Don'ts:**
- Don't ship the SDK before the IR is frozen — you'll bake divergence in.
- Don't let code-authoring and agent-authoring fork into different artifacts — one manifest, two frontends.
- Don't couple the OSS runtime to hosted services (Hub/CORA/hosting) — open core must run standalone.
- Don't merge the App SDK and the Plugin SDK.
- Don't keep "Workflows" and "Apps" as two primitives — one App, many facets.
- Don't build the Hub before its artifact (the IR/`.agentisapp`) is stable and battle-tested.
- Don't out-Mastra Mastra on code-first ergonomics alone — win on agent-authored + full-stack-with-UI + hosted + shareable.

---

## 14. Security & trust model (agentic-era, first-class)

In the agentic era the operator is an AI that can be manipulated (prompt injection), the UI can be authored by that AI, and apps are installed from strangers. Trust is the product. This section is a hard requirement, not a footnote.

### 14.1 The core principle: the contract is the trust boundary

Everything an app can do is **declared** (collections, actions, capabilities, plugins, audience) and **enforced server-side** against `app.policy` — never inferred from agent output and never trusted from the client. The declaration is visible to the user at all times (the Contract panel, §11). **The agent proposes; the policy disposes.**

### 14.2 Threat model (what we explicitly defend against)

| Threat | Vector | Control |
|---|---|---|
| **Prompt injection → harmful action** | Malicious content steers the operator agent to delete/exfiltrate/escalate | Agent actions are bounded by the *declared* action/capability set; **sensitive actions require human approval** (gates); agent can't grant itself scope beyond `app.policy`; manifest/policy changes are themselves gated mutations. |
| **Data exfiltration** | Agent or custom code ships data out | Datastore is per-app/per-workspace; cross-app reads need explicit grants; `CustomView` has **CSP `connect-src 'none'`** — the only egress is the server-authz'd bridge. |
| **Over-broad capability grants** | App requests more than it needs | Least-privilege by default; **install-time permission disclosure** (an "app permissions" prompt: "this app will read `customers`, send email via AgentMail, run workflow X"); user consents per scope. |
| **Credential theft** | Frontend/agent reads secrets | Secrets **never** enter the manifest, the frontend, or agent context. They live in the credential vault (`credentialVault`), referenced by handle, injected server-side only, scoped per app. |
| **Supply chain** | Installed app / `CustomView` ships malware | `registryScanner.scanArtifactBytes` on every import (local *and* Hub use the same path); sha256 `checksum` verify; `CustomView` runs only in the null-origin sandbox; workspaces can disable custom code entirely. |
| **Multi-tenant breach** | One workspace reads another's data | Every row/query/action is workspace-scoped at the store layer; this is asserted by tests (the back-compat/isolation invariants) and must stay covered. |
| **Confused-deputy (human seat vs agent identity)** | UI action runs with the *agent's* power, not the acting human's | Action dispatch authz's against the **acting operator seat's** session + role, never the operator agent's self-granted scope. (When the future end-customer seam lands, the same rule binds to the customer's identity.) |
| **Public-surface abuse** | Shared link leaks data / is hammered | Public routes are `shareable`-gated, token-opaque, **read-mostly**, rate-limited; public `data.query` is scoped to the shared surface's bound collections only. |
| **Runaway cost / loops** | Agent burns spend | Per-app + per-run budget ceilings (engine budget primitives), idle/turn deadlines, a **kill switch** (pause/stop) on every app and run. |

### 14.3 Identity & authz layers

Agentis is **operator-owned and package-distributed** (§1A): an app's consumer is *another operator* who installs the `.agentisapp` into *their own* instance and authenticates to *their own* Agentis. So the identity model is operator-first; external-customer identity is a deliberate future seam, not a V1 layer.

- **Operator (human)** — owns/signs into the instance; installs apps, grants capabilities, sets policy, sees audit. **The "user" of an app, today.** A company = multiple operator **seats** in one workspace (team-tier; already modeled by `users` + `workspaces`).
- **Operator agent** — runs the logic; bounded by the app's declared tools/capabilities + policy; actions authz against the **acting seat's** identity, never self-granted.
- **Public viewer (anonymous)** — opens a `shareable` read-mostly public surface via opaque token. No account. (Exists.)
- **End-customer (future seam, V2+)** — external people with their own accounts/data inside a customer-facing app. **Not built, not a V1 requirement.** `app.policy` (`private | workspace | public_link` → later `audience`) is the dormant hook that grows into it (§15 #6).
- **Hub author (future)** — declares the manifest's requested permissions; the installer surfaces them for consent at install.

### 14.4 Secrets, data, isolation

- **Secrets:** vault-only, per-app scope, handle-referenced, server-injected. Never serialized into `.agentisapp` (the packager already ships *credential slots*, not values).
- **Data isolation:** collections are per-app + per-workspace; cross-app access is an explicit policy grant; `json_extract` queries are parameterized (no injection).
- **Datastore packaging:** ship **schema always, rows never** by default (empty-with-schema install); any opt-in seed rows pass `registryScanner` for PII/secret findings.

### 14.5 Agent-authored UI/code is still constrained

A surface authored by an agent (or by a possibly-injected agent) **cannot exceed the app's declared contracts**. `ui_render` can only bind to collections the app owns; `ui_action_schema` can only target declared actions; a `CustomView` the agent writes runs in the same sandbox with the same allow-list. The blast radius of a hijacked agent is the app's *already-consented* scope — never more.

### 14.6 Observability & governance (trust requires receipts)

Bind the existing engine primitives to app scope: **runs, ledger, audit trail, cost meter, approvals inbox, failure recovery**. Every agent action, every datastore mutation, every capability call is logged with actor + provenance. A workspace owner can answer "what did this app/agent do, to what data, on whose behalf, at what cost" — and can pause/kill it.

### 14.7 Self-host = data sovereignty

OSS self-host means the user's data, secrets, and apps stay on their infra with **zero required call home**. This is itself a security feature and a major trust differentiator vs closed SaaS — and a hard constraint on the OSS/Hub split (§10).

---

## 15. Known gaps & likely user complaints (name them before users do)

Honesty list. For each: the complaint, the truth, the plan. Ship this section *in the docs* — users trust a project that names its own edges.

| # | Users will say… | Reality | Plan / mitigation |
|---|---|---|---|
| 1 | "I can't build *X* in your UI kit." | Real ceiling — owned-declarative trades some expressiveness. | Grow the component set (driven by real apps) + the sandboxed `CustomView` escape hatch (§3A.9). A missing component is never a hard wall. |
| 2 | "I ejected to code and now I can't go back to visual." | True: visual↔agent round-trips (one JSON); **code is a forward eject**. | State it plainly in-product; shared `@agentis/ui` kit means eject isn't a dead end. Never promise reverse-compiling arbitrary code. |
| 3 | "Postgres isn't really supported." | True — PG is an acknowledged stub; SQLite is the V1 default. | Documented honestly; new tables ship PG-portable; full PG parity is roadmapped, not pretended (per `POSTGRES-PORTABILITY.md`). |
| 4 | "Queries get slow with lots of records." | Indexed scalar equality / `in` filters use the `app_record_index` sidecar; complex JSON predicates still use `json_extract`. | Add query planning/measurement and broader index shapes only when real workloads justify them. |
| 5 | "I can't use my own React/npm packages." | By design — owned framework. | The trade buys portability/safety/render-anywhere; escape hatch covers the long tail; SDK gives a JSX-like DSL so it *feels* like code. |
| 6 | "How do external customers log in to an app?" | **Not a V1 gap — a future seam.** Agentis is operator-owned + package-distributed (§1A): an app's consumer is another *operator* on their *own* instance, not a customer logging into a hosted product. V1 = operator/seat auth (exists) + anonymous read-mostly public links. | Keep `app.policy` (`private`/`workspace`/`public_link`) as the dormant hook; design an end-customer identity model only when customer-facing/hosted apps become a goal (V2+). Don't build it now. |
| 7 | "How do I version/upgrade an installed app without losing data?" | Install, migration-aware upgrade, durable snapshot, and rollback are implemented. | Retention limits, migration UX, and operational observability are the next lifecycle hardening pass. |
| 8 | "No mobile/native app." | Web-only renderer today. | Render-anywhere is the strategic upside of owned-declarative (§3A.1); same tree → mobile/email/Slack later. Roadmap, not vapor. |
| 9 | "Dev / staging / prod environments?" | Named manifest snapshots and promotion now exist; only production can apply a snapshot to the live runtime, through lifecycle upgrade. | Add richer deployment policy, approvals, and environment-specific secret bindings when those workflows are proven. |
| 10 | "Realtime at scale / multi-user collaboration?" | Realtime exists (bus) but not proven at scale or for concurrent editing. | Document current limits; scale + presence/collab is post-OSS-launch. |
| 11 | "File uploads / media / large blobs?" | Datastore is for **structured** data; blobs belong in artifacts. | `FileUpload` → artifacts store (exists); clarify the structured-vs-blob split in docs so users don't stuff base64 into collections. |
| 12 | "Custom domain for my public app." | Not built. | Hub/hosting-era feature; note it. |
| 13 | "How do I test an app?" | `agentis app test` executes a package in an isolated transaction and asserts deterministic data actions/query results; workflow/tool behavior stays in engine integration tests. | Grow the declarative assertion vocabulary from real app needs; do not simulate engines in the App harness. |
| 14 | "Accessibility / i18n?" | The owned renderer makes these governable, but neither a full localized-string layer nor a formal accessibility guarantee is complete. | Establish component-level accessibility tests and string-token/i18n contracts before claiming either as a platform guarantee. |
| 15 | "Am I locked in?" | Strongest trust objection — answer it loudly. | **OSS + portable `.agentisapp` + self-host = no lock-in.** Export your app and data anytime; run it on your own infra with no Agentis cloud. This is a feature, not damage control. |
| 16 | "Rate limits / quotas / per-app billing?" | Budget primitives exist; per-app quotas/billing are Hub-era. | Note the seam; don't over-build before the Hub. |
| 17 | "Big UI trees feel heavy." | No virtualization yet for large lists/tables. | Virtualize `Table`/`List` in the kit; roadmap. |
| 18 | "Migrating off the old Studio surfaces." | Legacy fixed-block Studio retired; old surfaces carried no persistent data. | One surface system now (AG-UI). Documented in the masterplan. |

The discipline: **anything in this table that becomes load-bearing for a launch gets promoted into a real plan with an owner** — the table is the radar, not the graveyard.

---

## 16. The `@agentis/app-client` bridge API (versioned, forever-stable)

The single client every surface uses to reach the backend — declarative `bind`/`action`, the `CustomView` sandbox bridge, and dev-authored code all go through it. **It is a public API contract: minimal, semver'd, never broken.** Everything is authz'd server-side against `app.policy` + the acting seat (§14); the client holds no secrets and has no raw DB/escape.

```ts
interface AgentisAppClient {
  data: {
    query(collection, q): Promise<Record<string, unknown>[]>;
    get(collection, id): Promise<Record<string, unknown> | null>;
    insert(collection, record): Promise<{ id: string }>;
    update(collection, id, patch): Promise<void>;
    delete(collection, id): Promise<void>;
  };
  action: { invoke(name: string, args?: object): Promise<unknown> };          // declared actions only
  capability: { call(name: string, args?: object): Promise<unknown> };        // app-as-tool / plugins
  realtime: { subscribe(event: 'DATA_CHANGED' | 'SURFACE_RENDER' | 'SURFACE_PATCH', cb): () => void };
  auth: { currentUser(): Promise<{ id: string; role: string } | null> };       // the acting seat
  theme: { tokens(): ThemeTokens };
  files: { upload(file): Promise<{ artifactId: string; url: string }> };        // → artifacts, §15 #11
}
```

- Two transports, one surface: in-process (the AppRuntime React renderer calls it directly) and `postMessage` (the `CustomView` sandbox proxies to it — already built).
- Versioning: ship as `@agentis/app-client@1`. Additive only within a major. A removed/changed method is a major bump with a deprecation window.

---

## 17. Data model & persistence (manifest ↔ DB rows ↔ `.agentisapp`)

The three isomorphic representations (§2), concretely. **Already shipped** tables (per the masterplan): `apps`, `app_members`, `app_workflows` via `workflows.app_id`, `app_surfaces`, `app_collections`, `app_records`. Mirrored in SQLite + PG schema.

| Manifest field | Runtime rows (edit/run) | `.agentisapp` (serialize) |
|---|---|---|
| identity/policy | `apps` row | `manifest` block |
| `agents` | `agents` + `app_members` | embedded def or `{id,version}` ref |
| `workflows` | `workflows` (`app_id` set) | graph JSON |
| `surfaces` | `app_surfaces` (`view_json`) | ViewNode tree |
| `collections` | `app_collections` (schema) | schema only (rows never, §14.4) |
| `migrations` | lifecycle snapshots + migration application | ordered list |
| `source` + installed checksum | `apps.source_json` + `apps.installed_checksum` | manifest provenance + envelope checksum |
| indexed collection fields | `app_record_index` sidecar | collection field metadata only |
| named environment | `app_environments` manifest snapshot | not part of the portable package |

- **Projection is the contract:** `AppStore`/`AppDatastore`/`AppSurfaceStore` gain `toManifest(appId)` / `fromManifest(manifest)`; `AppPackager` becomes `serialize(manifest)`/`deserialize(bundle)`. These must round-trip (§2 invariant), asserted by a `manifest ↔ rows ↔ bundle` test.
- **Realtime events** (already in `@agentis/core`): `DATA_CHANGED { appId, collection, op, id }`, `SURFACE_RENDER`, `SURFACE_PATCH`, scoped to `REALTIME_ROOMS.app(appId)`. The bridge `realtime.subscribe` rides these.
- **Indexed query path:** `CollectionSpec.fields[].indexed` projects scalar values to `app_record_index`; equality and `in` filters use it as a prefilter while the canonical JSON predicate remains the correctness guard.

---

## 18. De-monolith map (`apps/api` → `@agentis/*`)

The extraction that turns the runtime into the package graph (§4). Move, don't rewrite; each step is tsc-gated and test-covered. Source → target:

| Today (`apps/api/src/…`) | Target package |
|---|---|
| `engine/` (graph, exec, runState, triggers) | `@agentis/workflows` |
| `services/app/*` (store, datastore, surfaces, packager) | `@agentis/app` |
| AG-UI types + `ViewRenderer` kit | `@agentis/ag-ui` + `@agentis/ui` (web) |
| `services/brain*`, memory, formation | `@agentis/brain` |
| `services/agentSession*`, specialists, tool runtime | `@agentis/agents` |
| `core/src/types|schemas|events` (manifest, capability) | `@agentis/core` (already) |
| HTTP host, realtime, channels, secrets wiring | `@agentis/runtime` ← `apps/api` becomes a thin host over it |

Rule: nothing in `@agentis/{agents,workflows,datastore,ag-ui,brain}` imports `@agentis/app`; only `@agentis/app` composes them (§4). `@agentis/core` imports nothing.

---

## 19. Non-goals (explicit scope boundaries)

- **Not** a deploy-anywhere framework: apps run **inside Agentis**, not as escaped standalone services (§6).
- **Not** arbitrary compiled frontend bundles as a first-class UI mode — owned declarative + narrow sandbox leaf only (§3A).
- **Not** multi-tenant customer-facing hosting in V1 — operator-owned, package-distributed (§1A). End-customer auth is deferred (§15 #6).
- **Not** building AgentisHub now — seams only (§10).
- **Not** merging Apps and Plugins, or the App SDK and Plugin SDK (§8).
- **Not** a Mastra-style code-only agent library — full-stack + agent-authored + hosted-optional is the wedge.
- **Not** blind-renaming "workflow" — it's the Logic facet's name (§0).

---

## 20. Glossary (canonical terms — prevent drift)

- **Agentic App / App** — the one primitive: `{identity, surfaces, logic, data, agents, memory, policy}`. The only buildable thing.
- **Facet** — a capability an App may use (Logic/workflow, Interface, Data, Memory, Team). Present only when used.
- **IR / Manifest** — the canonical, versioned, serializable `AppManifest` (§2.1). The source of truth.
- **`.agentisapp`** — the on-disk/Hub serialization of a manifest (+ assets).
- **Surface** — one UI view of an App (a `ViewNode` tree). **AG-UI / Agentis UI** — the owned declarative UI framework (§3A).
- **Capability** — a callable, contract-bound action exposed by a native tool, an App (app-as-tool), or a Plugin (§3).
- **Plugin / Agent Service** — an *external* capability provider (AgentMail-style). Distinct from an App (§8).
- **Harness** — the agent-execution backend (external providers today; Agentis-native later). Not an SDK (§7).
- **Runtime** — Agentis itself (`@agentis/runtime`); apps run inside it (§6).
- **Operator / seat** — the human user of an instance; a company = multiple seats (§1A). **End-customer** — deferred external audience.
- **Bridge / app-client** — `@agentis/app-client`, the versioned frontend↔backend API (§16).

---

## 21. Definition of done (acceptance per build phase)

Each phase ships only when its checks pass (typecheck + tests + the stated invariant):

1. **IR frozen** — `AppManifest` zod schema in `@agentis/core`; `AppStore/Datastore/Surface` `toManifest`/`fromManifest`; **round-trip test** `rows → manifest → rows` and `manifest → .agentisapp → manifest` are identity.
2. **Capability contract** — registry holds native + app + plugin; `invoke` is the sole authz/ledger chokepoint; an app's action is callable by another agent in a test.
3. **Unified IA** — one App editor with facet tabs; logic-only app appears in the Apps list; no separate Workflows destination; existing workflows render as Apps-of-one.
4. **Runtime extracted** — `@agentis/runtime` boots the same app `apps/api` does; a CLI `agentis up` runs it self-hosted.
5. **SDK + CLI** — `npx agentis create` → running app; `defineApp(...)` emits a manifest byte-identical to the agent-authored one for the same app (round-trip proof).
6. **Agentis UI** — `@agentis/app-client@1` frozen; `@agentis/ui` renders the kit; binding/state/nav work; `CustomView` gated by `policy.customCode`.
7. **Lifecycle** — install → upgrade-with-migration → rollback on a collection schema change preserves data; a data-losing upgrade without a declared migration is blocked.
8. **Security** — every action authz'd against acting seat; secrets never leave the vault; `registryScanner` on every import; permission-consent prompt on install.
9. **Hub-ready (Hub not built)** — install path is Hub-agnostic; manifest provenance, envelope checksum, installed checksum, and lifecycle snapshots preserve `source`/`remoteId`/`author`; flipping on a Hub requires no schema change.

---

## 22. Open decisions & risks (resolve before/while building)

| # | Decision / risk | Lean | Resolve by |
|---|---|---|---|
| D1 | Manifest format — embed vs reference components by default | Embed for portability; ref when installed from Hub | IR freeze (phase 1) |
| D2 | Expression engine reuse for UI binding — extend `safeExpression` or new | Extend the existing safe engine | Agentis UI (phase 6) |
| D3 | CustomView default — `allowed` or `disabled` out of the box | `disabled`; opt-in per workspace | Security pass |
| D4 | App `version` bump policy on agent edits (auto-patch?) | Auto-patch on publish; manual major/minor | Lifecycle (phase 7) |
| D5 | Snapshot retention for rollback (count/size) | last N + size cap | Lifecycle |
| D6 | Multi-surface routing inside an app — path-based vs name-based | name-based + optional path params | Agentis UI |
| R1 | UI framework scope creep (building "SwiftIN a quarter") | grow component *set* forever; freeze *contracts* early | continuous |
| R2 | PG parity debt vs SQLite-first | SQLite default; new tables PG-portable; PG roadmap | continuous |
| R3 | Round-trip fidelity for code authoring | one schema, no code-only fields; eject is forward-only | IR freeze |

---

## Impl log

_(append as pieces land; reconcile with real code — per `feedback_masterplan_log`)_

### Phase 1 — Freeze the IR (DoD gate 1) — DONE 2026-06-22

The canonical `AppManifest` IR now exists and the rows ↔ manifest ↔ `.agentisapp` projection round-trips.

- **Naming collision resolved:** the old small `AppManifest`/`appManifestSchema` (the App's identity/contract block stored in `apps.manifest_json`) was renamed → **`AppIdentity`/`appIdentitySchema`** (`packages/core/src/types/app.ts`). The canonical full IR name `AppManifest` is now free and correct. `AppRecord.manifest` field name kept (holds `AppIdentity`) so `appStore`/tests/web were untouched. Importers updated: `package.ts`, `services/app/appStore.ts`.
- **New IR:** `packages/core/src/types/manifest.ts` — `appManifestSchema` / `AppManifest` (§2.1): `manifestVersion`, `agentisVersion`, `identity`, `policy`, facets (`workflows`/`surfaces`/`collections`/`agents`/`memory`), contracts (`capabilities`/`requiredPlugins`/`dependencies`/`migrations`/`source`). Plus `AppManifestEnvelope` (the `.agentisapp` wrapper) and **`canonicalizeManifest()`** (sorted-key serialization → deterministic checksum + meaningful upgrade diffs). Exported from the core barrel.
- **Projection (the DoD contract):** `services/app/appPackager.ts` refactored from ad-hoc export/import into **`toManifest` / `fromManifest`** (rows ↔ IR) + **`serialize` / `deserialize`** (IR ↔ envelope, sha256 over canonical manifest, rejects tampering). `export`/`import` are now thin wrappers; the `/v1/apps/:id/export` + `/v1/apps/import` routes use the new envelope (`AppManifestEnvelope`).
- **Facets projected today:** identity, policy, workflows, surfaces, collections (SCHEMA only — rows never travel; empty-with-schema install). Agents/capabilities/migrations are in the schema but projection deferred (symmetric with `fromManifest`); noted for Phase 7 (lifecycle) + Phase 2 (capabilities).
- **Tests:** `tests/services/appPackager.test.ts` rewritten — **round-trip identity** (`rows → manifest → rows → manifest` equal modulo ids/slug), serialize/deserialize + tamper-reject, export→import e2e, and the privacy invariant (private rows do not travel; collections come back empty). 3/3 green.
- **Verified:** core/db/api/web typecheck clean; `appPackager` 3/3 + App suite (appStore/appDatastore/appChatTools/appAgentTools) + packages-route = 24/24 green.
- **Decision touched:** D1 (embed vs reference components) — V1 **embeds** facets; component-by-reference is a Phase-2/Hub follow-up.

### Phase 2 — Capability contract (DoD gate 2) — DONE 2026-06-22

The unified capability plane now exists: native tools, App actions, and plugin/Agent-Service operations share one registry and one invoke chokepoint.

- **Core contract:** `packages/core/src/types/capability.ts` defines `CapabilitySource`, `RegisteredCapability`, `InvokeCtx`, and `CapabilityInvocationRecord`. `CapabilityDecl` moved out of `manifest.ts` so the app-as-tool contract has one owner and the IR imports it.
- **Policy seam:** `AppPolicy` now carries stable `customCode` and `grants` fields. V1 remains operator-owned/permissive, but future tightening has a typed place to land.
- **Runtime registry:** `apps/api/src/services/capabilityRegistry.ts` projects:
  - `native.*` capabilities from the existing `AgentisToolRegistry` (no duplicated native tool table),
  - `app.<appId>.<action>` capabilities from installed App surface actions / manifest declarations,
  - `plugin.<service>.<name>` capabilities from explicit plugin registration.
- **Single invoke path:** `CapabilityRegistry.invoke(...)` validates JSON-schema-required inputs, blocks mutating capabilities in Plan mode, dispatches to the proper backend, and records every success/failure through `CapabilityInvocationRecord` plus the run ledger when a `runId` exists.
- **App-as-tool proof:** App data actions (`collection.insert/update/upsert/delete/query`) are callable by another agent through the registry. Workflow and tool actions are wired through the existing workflow runner / tool runtime when available.
- **Self-host API:** `/v1/capabilities` lists, resolves App projections on demand via `?appId=...`, and invokes capabilities over HTTP. Bootstrap mounts one process-wide `CapabilityRegistry` beside `AgentisToolRegistry`.
- **Tests:** `tests/services/capabilityRegistry.test.ts` covers native + plugin + App action invocation and invocation recording. `tests/routes/capabilities.test.ts` proves HTTP discovery + invoke for an App action.
- **Verified:** `pnpm --filter @agentis/core typecheck`; `pnpm --filter @agentis/api typecheck`; `pnpm --filter @agentis/api test -- tests/services/capabilityRegistry.test.ts tests/routes/capabilities.test.ts`.

### Phase 3 - Unified IA (DoD gate 3) - DONE 2026-06-22

The product IA now treats workflows as the Logic facet of Agentic Apps, not as a separate top-level destination.

- **Top-level navigation:** `Sidebar` now exposes Home, Apps, Agents, Brain, and Packages. Workflows and Issues are no longer primary nav entries; the sidebar RTL contract was updated accordingly.
- **Unified Apps index:** `/apps` loads installed Apps and existing bare workflows together, with one search field, Import, and New App. A bare workflow is promoted to an App-of-one only when opened; there is no facet-filter subheader.
- **One App editor:** `/apps/:id` is the sole App editor, using the workflow canvas chrome with Interface, Workflow, Data, and Brain facets. Workflow owns the App-scoped switcher plus real canvas; Interface owns AG-UI surfaces and preview; Data shows collections; Brain reflects the selected workflow scope. `/apps/:id/build` is redirect-only compatibility.
- **Workflow compatibility:** canonical workflow canvas links now use `/apps/workflows/:id`. Legacy `/workflows`, `/workflows/build`, and `/workflows/:id` routes remain redirect-only compatibility shims.
- **Garbage removed:** the old standalone `WorkflowsPage.tsx` was deleted after confirming it had no code imports. Primary UI links in chat, run modal, packages, knowledge, and the home ecosystem canvas now point to Apps-owned logic routes.

**Verified:** `pnpm --filter @agentis/web typecheck`; `pnpm --filter @agentis/web test -- tests/components/Sidebar.test.tsx`; `pnpm --filter @agentis/web build`.

### Phase 4 - Package/install surface (supporting install path) - DONE 2026-06-23

`.agentisapp` is now a first-class self-host install path in the Apps surface.

- **Preview contract:** `AppInstallPreview` / `appInstallPreviewSchema` lives in `@agentis/core` beside the manifest envelope, so web/API/SDK-era code share one typed install summary.
- **Non-mutating preview:** `AppPackager.preview(envelope)` validates checksum + manifest shape and returns identity, facet counts, facet names, required plugins, and review warnings without writing any rows.
- **Rollback-safe install:** `AppPackager.fromManifest(...)` now projects manifest rows inside a SQLite transaction. A failed install cannot leave a half-created App, workflow, surface, or collection behind.
- **Self-host API:** `/v1/apps/import/preview` validates a `.agentisapp` package before install; `/v1/apps/import` now parses the canonical envelope schema instead of accepting an unchecked cast.
- **Apps UX:** `/apps` has an Import control for `.agentisapp` files. The modal previews Logic / Interface / Data / Capabilities, warnings, checksum, slug, and version before the operator installs. Successful install opens the new App editor.
- **Export path:** the web client now types `/v1/apps/:id/export` as `AppManifestEnvelope`, keeping export/import symmetric.
- **Tests:** `tests/routes/apps.test.ts` covers preview without mutation, install of a fresh app, and tamper rejection before row creation. Existing `appPackager` round-trip tests still pass.

**Verified:** `pnpm --filter @agentis/core typecheck`; `pnpm --filter @agentis/api typecheck`; `pnpm --filter @agentis/web typecheck`; `pnpm --filter @agentis/api test -- tests/routes/apps.test.ts tests/services/appPackager.test.ts`; `pnpm --filter @agentis/web test -- tests/components/Sidebar.test.tsx`; `pnpm --filter @agentis/web build`.

### DoD gate 4 - Runtime/package extraction seam - DONE 2026-06-23

The first real de-monolith boundary is in place: the App domain is a package, and the runtime has a stable lifecycle contract.

- **`@agentis/app`:** moved the real App-domain implementation out of `apps/api/src/services/app/` into `packages/app/src/` with its own package metadata and typecheck/build scripts. This is a move, not a rewrite: `AppStore`, `AppDatastore`, `AppSurfaceStore`, `AppPackager`, and `buildAppStores` kept their behavior.
- **Clean bus seam:** `buildAppStores` no longer imports API `EventBus`; it accepts a minimal `publish(room, event, payload)` publisher. That keeps realtime wiring in the host while the App package owns App persistence, packaging, surfaces, and datastore behavior.
- **API as host:** `apps/api` now imports App services from `@agentis/app`; the old API-local `services/app` directory was removed after all imports moved.
- **`@agentis/runtime`:** added the runtime lifecycle contract package (`AgentisRuntimeHandle`, `AgentisRuntimeStartResult`, `AgentisRuntimeBootstrap`). `apps/api`'s `BootstrapResult` now implements that contract, creating the seam for moving the composition root later without changing CLI/test callers.
- **Workspace graph:** `apps/api` declares `@agentis/app` and `@agentis/runtime` as workspace dependencies; `pnpm install` refreshed workspace links and lockfile state.

**Verified:** `pnpm --filter @agentis/app typecheck`; `pnpm --filter @agentis/runtime typecheck`; `pnpm --filter @agentis/api typecheck`; `pnpm --filter @agentis/core typecheck`; `pnpm --filter @agentis/web typecheck`; `pnpm --filter @agentis/api test -- tests/services/appStore.test.ts tests/services/appDatastore.test.ts tests/services/appPackager.test.ts tests/services/appAgentTools.test.ts tests/routes/apps.test.ts tests/services/capabilityRegistry.test.ts tests/routes/capabilities.test.ts`; `pnpm --filter @agentis/app build`; `pnpm --filter @agentis/runtime build`; `pnpm --filter @agentis/api build`.

### DoD gate 5 - SDK + CLI authoring flow - DONE 2026-06-23

Code authoring now targets the same App IR used by the agent builder, runtime rows, and `.agentisapp` install path.

- **SDK targets the canonical IR:** `@agentis/sdk` now exposes `defineApp`, `buildAppManifest`, `buildAgentisApp`, `validateAppManifest`, and `validateAgentisApp` for `AppManifest` / `.agentisapp` authoring.
- **Facet helpers:** the SDK includes typed helpers for `defineWorkflow`, `defineSurface`, `defineCollection`, `field`, `defineAgent`, and `defineCapability`, all backed by the core zod schemas rather than a parallel DSL.
- **Symmetric package output:** `buildAgentisApp(...)` emits the `.agentisapp` envelope with the same sha256 over `canonicalizeManifest(...)` that the runtime packager expects.
- **Runtime client path:** `createAgentisClient(...)` now supports workspace headers and the App export / import-preview / import routes, so SDK consumers can install into a self-hosted runtime without depending on Hub.
- **CLI App commands:** `agentis app validate <file>`, `agentis app pack <manifest> --out <file>`, `agentis app install <file> --url ... --api-key ... --workspace-id ...`, and `agentis app export <app-id> ...` are wired through the SDK and runtime HTTP API.
- **Windows-friendly JSON:** CLI JSON reads tolerate UTF-8 BOM files produced by PowerShell, keeping local OSS authoring smooth on Windows.
- **Compatibility:** older SDK package-manifest helpers remain exported while App authoring moves to the canonical `AppManifest`.

**Verified:** `pnpm --filter @agentis/sdk typecheck`; `pnpm --filter @agentis-ai/cli typecheck`; `pnpm --filter @agentis/core typecheck`; `pnpm --filter @agentis/app typecheck`; `pnpm --filter @agentis/runtime typecheck`; `pnpm --filter @agentis/api typecheck`; `pnpm --filter @agentis/sdk test`; CLI smoke (`agentis app validate` -> `agentis app pack` -> `agentis app validate` on the envelope); `pnpm --filter @agentis/sdk build`; `pnpm --filter @agentis-ai/cli build`.

### DoD gate 6 - Agentis UI / app-client bridge - DONE 2026-06-23

The Agentis UI runtime now has a stable app-client bridge and a policy-gated CustomView path.

- **`@agentis/app-client`:** added a workspace package exposing the versioned V1 app-client contract: `data.query/insert/update/delete`, `actions.invoke`, `state.get/set/subscribe`, `realtime.subscribe`, `navigation.go`, and `files.upload`. It includes in-process and postMessage transports so normal AG-UI nodes and sandboxed CustomViews use one bridge shape.
- **Declarative UI bindings:** `ViewNode` bindables now support `$bind`, `$row`, and `$state`. The renderer resolves them in values, action args, and data filters, so local UI state can drive bound tables/lists/charts without inventing backend-only UI state.
- **Client-side action contract:** surface actions now recognize `navigate`, `setState`, and `capability` as first-class kinds. `navigate` and `setState` execute in the app-client; the API returns explicit errors if someone tries to POST client-only actions to the backend.
- **Runtime wiring:** `AppRuntime` now creates an in-process app-client, loads `app.policy`, keeps local UI state, and supports name-based in-app surface navigation. Public shared surfaces use the same provider shape but stay read-only.
- **CustomView bridge:** CustomView now speaks the V1 postMessage protocol (`agentis.app-client`) instead of a private ad-hoc bridge. It remains sandboxed with no network egress, collection allow-listing for reads, and no direct data mutation/file upload from the iframe.
- **Policy gate:** `AppSurfaceStore` rejects persisted `CustomView` trees unless `app.policy.customCode === "allowed"`, and the web renderer also blocks CustomView defensively when policy is not loaded/allowed.
- **Tests:** added `packages/app-client/tests/index.test.ts` for data/action/state/navigation transport behavior and `apps/api/tests/services/appSurfaceStore.test.ts` for CustomView policy enforcement.

**Verified:** `pnpm --filter @agentis/app-client typecheck`; `pnpm --filter @agentis/app-client test`; `pnpm --filter @agentis/core typecheck`; `pnpm --filter @agentis/app typecheck`; `pnpm --filter @agentis/api typecheck`; `pnpm --filter @agentis/web typecheck`; `pnpm --filter @agentis/api test -- tests/services/appSurfaceStore.test.ts tests/services/appPackager.test.ts tests/routes/apps.test.ts`; `pnpm --filter @agentis/app-client build`; `pnpm --filter @agentis/app build`; `pnpm --filter @agentis/api build`; `pnpm --filter @agentis/web build`.

### DoD gate 7 - Lifecycle / upgrade / migration / rollback - DONE 2026-06-23

Installed apps can now be upgraded over live app data with an explicit migration plan and rolled back from a durable pre-upgrade snapshot.

- **Durable snapshots:** added `app_lifecycle_snapshots` to SQLite + PG schema. Each upgrade stores the current manifest and live collection rows before mutation, so rollback survives process restarts.
- **Lifecycle service:** `@agentis/app` now exports `AppLifecycle` with `planUpgrade`, `upgrade`, and `rollback`. Upgrade is transactional: snapshot -> apply declared migrations -> validate records against the next schema -> swap manifest facets.
- **Data-loss guard:** upgrade planning blocks collection removal with live rows, field removal, type changes, and required-field additions unless a matching declared migration exists. Unsafe upgrade attempts fail before any mutation.
- **Collection migrations:** V1 supports deterministic `add_field`, `drop_field`, `rename_field`, `retype_field`, and `transform` specs. No arbitrary JS is executed.
- **Rollback:** restoring a snapshot recreates the prior app manifest facets and reinserts the captured collection rows, preserving live app data across a failed/bad upgrade.
- **Self-host API:** `/v1/apps/:id/upgrade/preview`, `/v1/apps/:id/upgrade`, and `/v1/apps/:id/rollback/:snapshotId` expose the same `.agentisapp` artifact path used by import/export.
- **Tests:** `tests/services/appLifecycle.test.ts` proves `install -> upgrade-with-migration -> rollback` preserves data and that data-losing upgrades without migration are blocked. `tests/routes/apps.test.ts` covers route-level unsafe-upgrade preview/blocking.

**Verified:** `pnpm --filter @agentis/app typecheck`; `pnpm --filter @agentis/db typecheck`; `pnpm --filter @agentis/api typecheck`; `pnpm --filter @agentis/api test -- tests/services/appLifecycle.test.ts`; `pnpm --filter @agentis/api test -- tests/routes/apps.test.ts`; `pnpm --filter @agentis/db test`; `pnpm --filter @agentis/db build`; `pnpm --filter @agentis/app build`; `pnpm --filter @agentis/api build`.

### DoD gate 8 - Security - DONE 2026-06-23

The App import and action paths now enforce the security invariant before an App package can enter or act inside a self-hosted workspace.

- **App import scanner:** `/v1/apps/import/preview` and `/v1/apps/import` both run `registryScanner.scanArtifactBytes` over the `.agentisapp` envelope. Block-severity findings fail with `APP_PACKAGE_SCAN_BLOCKED`; warn-severity findings are returned in `AppInstallPreview.scanWarnings` and folded into preview warnings.
- **Permission consent contract:** `AppInstallPreview` now includes a deterministic `permissions` summary derived from collections, surface actions, plugins, public-share/custom-code policy, grants, and declared capabilities. `/v1/apps/import` accepts only `{ envelope, permissionsAcknowledged }` and requires the acknowledged set to exactly match the previewed set.
- **Operator UX:** the Apps import dialog displays the permission summary and security-scan warnings, then requires an explicit checkbox before Install enables. The SDK import client and `agentis app install` CLI send the same acknowledged preview permission list.
- **Action app boundary:** workflow surface actions are now resolved by `workspaceId + appId + workflowId`, so a surface cannot run another App's workflow just because it can reference the workflow id.
- **Acting seat preservation:** datastore writes continue to stamp the authenticated user, workflow actions pass the authenticated user into `runPublishedWorkflow`, and tool actions execute through `AgentToolRuntime` with `{ appId, agentId: user.id }`.
- **Tests:** `tests/routes/apps.test.ts` covers install consent, scanner-blocked secrets, cross-App workflow denial, tamper rejection, non-mutating preview, fresh install, and lifecycle unsafe-upgrade blocking.

**Verified:** `pnpm --filter @agentis/core typecheck`; `pnpm --filter @agentis/app typecheck`; `pnpm --filter @agentis/sdk typecheck`; `pnpm --filter @agentis/api typecheck`; `pnpm --filter @agentis/web typecheck`; `pnpm --filter @agentis-ai/cli typecheck`; `pnpm --filter @agentis/api test -- tests/routes/apps.test.ts`; `pnpm --filter @agentis/api test -- tests/services/appPackager.test.ts`; `pnpm --filter @agentis/sdk test`; `pnpm --filter @agentis/core build`; `pnpm --filter @agentis/app build`; `pnpm --filter @agentis/sdk build`; `pnpm --filter @agentis-ai/cli build`; `pnpm --filter @agentis/api build`; `pnpm --filter @agentis/web build`.

### DoD gate 9 - Hub-ready seams (Hub not built) - DONE 2026-06-23

The self-hosted OSS runtime now retains enough portable provenance for a future AgentisHub to resolve into the existing install/upgrade path without adding a second app schema or a hosted dependency.

- **Typed provenance:** `AppManifest.source` is now a typed `{ kind: 'local' | 'hub', id, remoteId?, author? }` contract. It survives row projection, preview, import, export, install, and upgrade.
- **Artifact identity:** `.agentisapp` remains the canonical serialized artifact with a verified sha256 checksum. The installed App persists its original `installedChecksum` independently from a later local export, so a collision-safe local slug does not erase its remote artifact identity.
- **Rollback provenance:** lifecycle snapshots capture the installed checksum with the previous manifest. A rollback restores both the older manifest provenance and the original artifact checksum.
- **Hub-agnostic installer:** local file import, future Hub download, SDK installation, CLI installation, and package testing all enter through the same envelope validation, scanner, permission-consent, and `AppPackager` path. No Hub API, account, hosted runtime, or schema was added.
- **Tests:** package import/export provenance, upgrade/rollback provenance restoration, and DB migration coverage assert the seam.

### OSS readiness additions - DONE 2026-06-23

The supporting developer/operator workflows identified before Hub work are now present without turning Agentis into a deploy-anywhere framework.

- **Create flow:** `agentis create <dir>` creates a small code-authored App project. `src/app.mjs` is its only authoring source; `app.agentisapp` is the generated portable artifact; `agentis.test.json` declares its deterministic checks. `--install` uses the same self-host import/consent path.
- **App test harness:** `agentis app test <file> --spec <file>` and `POST /v1/apps/test` install a manifest into a transaction, run declared deterministic data actions, query assertions, and then roll every test row back. Workflow and tool execution remain engine integration tests instead of being simulated.
- **App environments:** named `dev`, `staging`, and `production` manifest snapshots can be stored and promoted. Only a production promotion can alter the live runtime, and it must use `AppLifecycle`, preserving migration and rollback behavior.
- **Indexed datastore path:** fields declared `indexed` populate a scalar `app_record_index` sidecar. Equality and `in` queries use the sidecar as a prefilter while retaining the original JSON predicate as the correctness guard.

**Deliberate follow-up work, not falsely marked complete:** `@agentis/runtime` is a stable lifecycle seam, but the broader engine/agents/brain/UI extraction in §18 remains an incremental package-extraction program. Mobile/native renderers are not implemented. The owned UI representation is portable enough to support them later, but there is no native renderer today. Likewise, i18n and accessibility are not yet platform guarantees; they require a string/token contract and component-level audit/test suite before that claim can be made.
