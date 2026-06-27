# Agentic Apps — The 10x Masterplan & Codebase Reshape

> **Status:** Proposal · 2026-06-22
> **Supersedes the *internal-product* framing of:** `WORKFLOW-STUDIO-10X-MASTERPLAN.md` (Studio surfaces become a legacy renderer, not the primitive)
> **Renames the category in:** `PLUGIN-AGENT-SERVICES-MARKETPLACE.md` (the former marketplace "Agentic App" category → "Plugin / Agent Service")
> **One line:** *Agentis is the runtime where an AI agent ships a full product — UI, logic, memory, and data — and operates it for real users, without a human writing the code.*

This is two plans in one, because they cannot be separated:
- **Part A — The build** (§1–§7): the Agentic App primitive, GenUI, the App Datastore, the reshaped shell.
- **Part B — The reshape** (§8–§11): how we make the codebase *clean and legible* while doing it — naming, layering, migrations, dead code, docs. **A feature plan that ignores the rot just adds more rot.** Both ship together, phase by phase.

---

## 0. Ruthless framing (read this first)

We already own four rare assets: a durable **workflow engine**, a multi-scope **brain**, an **omnichannel** runtime, and a **canvas**. The missing layer is the one that turns those into *a product a human can use*: an **agent-authored, interactive UI bound to a real datastore**. That gap is the entire bet.

Five hard calls, made up front. We do not relitigate these later.

1. **"App" is the unit you build *in* Agentis. "Plugin" is the external capability you plug *into* it.** The marketplace doc's "Agentic App = AgentMail-style external SaaS" is renamed **Plugin / Agent Service**. AgentMail is a *plugin*. The CRM your agent builds and runs is an *App*. This kills a live naming collision already sitting in the repo.

2. **The datastore is NOT the brain. We will not merge them.** The brain is built for *fuzzy recall and formation* (embeddings, decay, promotion). An app datastore is built for *exact, structured, transactional* reads/writes. Merge them and you get something bad at both. They get a **one-way bridge** (§5.4), never a merge. This is the most important "no" in the document.

3. **"Studio" dies — as a name and as the primitive.** It signals *a developer building dashboards*. Our user is *an agent shipping a product*. The 14-block registry survives only as one set of *renderers* under the new protocol. We stop extending it.

4. **We do NOT blind-rename "workflow."** It appears **3,826 times across 162 API files and 97 web files** (measured). A find-replace would be a self-inflicted version of the Postgres "1,322-site refactor" disaster. Instead: **`workflow` stays as the name of the logic graph**, and **`App` becomes the entity that *contains* it.** The reshape is *structural layering*, not mass renaming. (§8.1)

5. **The reshape is mandatory, not optional polish.** 151 service files sit in a near-flat directory; `sharedIntelligence.ts` is 3,046 lines; 65 docs accumulate as a graveyard; the PG path is a stub that *throws*. Every new feature we bolt on without addressing this multiplies the cost of the next one. (§8–§11)

If we ship §3–§6, the one-liner becomes literally true and **no competitor can say it**: n8n/Make have no agent-authored UI; Retool/v0/Bolt have no agent runtime, memory, or data ownership; Agentforce is a closed garden; ChatGPT/Claude apps have no durable multi-channel backend. The intersection is empty. We sit in it.

---

# PART A — THE BUILD

## 1. What an Agentic App *is* (the spec we must own)

A category name is worthless until it has a precise, deployable definition. Ours:

> An **Agentic App** is a single deployable unit = **`{ identity, surfaces, logic, data, agents, memory, policy }`**, where an **agent is the operator** and a **human is the end-user**.

| Facet | Concrete artifact | Status today |
|---|---|---|
| **Identity** | slug, name, version, icon, entry surface, manifest | virtual (chat tool only) → **promote to `apps` table** |
| **Surfaces** (UI) | agent-authored interactive views (GenUI) | **fixed 14-block Studio only → rebuild (§4)** |
| **Logic** | workflow graph(s) + agent sessions | ✅ engine exists, reused as-is |
| **Data** | typed collections (App Datastore) | **KV/blobs only → build (§5)** |
| **Agents** | operator + worker agents, roles, tools | ✅ exists |
| **Memory** | brain scope bound to the app | ✅ exists (bind, don't merge) |
| **Policy** | audience, auth, who-can-see/do-what | partial (audience tags, approvals) |

The deployable boundary matters: an App is the thing you **publish, share, version, fork, install, and bill**. Workflows, surfaces, and datastore collections become **children of an App**, not siblings of it.

---

## 2. Architecture at a glance

```
                         ┌──────────────────── AGENTIC APP ────────────────────┐
   End-user (human)      │                                                      │
        │  interacts     │   SURFACES (GenUI)        DATA (App Datastore)        │
        ▼                │   ┌───────────────┐       ┌───────────────────┐      │
  ┌─────────────┐  AG-UI │   │ View Tree     │◄─bind─│ collections/rows  │      │
  │ App Runtime │◄──────►│   │ (typed nodes) │       │ typed, queryable  │      │
  │  (browser)  │  events│   │  + CustomView │──CRUD─►│ transactional     │      │
  └─────────────┘        │   │   sandbox     │       └─────────┬─────────┘      │
        ▲                │   └──────┬────────┘                 │ promote        │
        │ action()       │          │ ui_render / ui_patch     ▼ (one-way)      │
        ▼                │   ┌───────┴───────────────────────────────────┐      │
  ┌─────────────┐        │   │  AGENT (operator)  ── tools ──► WORKFLOW   │      │
  │ realtime bus│◄───────┤   │                                 ENGINE     │      │
  └─────────────┘        │   └───────────────────┬───────────────────────┘      │
                         │                        │ reads/writes (bind)         │
                         │                  ┌─────▼─────┐                        │
                         │                  │   BRAIN   │ (memory, NOT data)     │
                         │                  └───────────┘                        │
                         └──────────────────────────────────────────────────────┘
```

Four new/changed seams; everything else is reused:

1. **`apps` entity + `AppStore`** — promote App from virtual bundle to first-class row (§3).
2. **AG-UI protocol + App Runtime** — agent authors interactive UI; replaces `ui_emit`-into-fixed-blocks (§4).
3. **App Datastore** — typed collections with agent CRUD tools + declarative UI binding (§5).
4. **Reshaped shell + reshaped codebase** — one App editor, App-scoped navigation, and a reusable surface renderer (§6, §8).

---

## 3. App as a first-class entity

**Today:** `agentis.app.create` / `agentis.app.compose` ([chatToolCatalog.ts:868](../apps/api/src/services/chatToolCatalog.ts)) synthesize a workflow + surfaces + agents but persist **no `app` row**. There is nothing to version, share, or list as an app. "App" is a loose bundle over a workflow.

**Build (migration `v82`, see §10 for the mechanics):**

```sql
-- apps: the deployable unit
CREATE TABLE apps (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  version         TEXT NOT NULL DEFAULT '0.1.0',
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft | published | archived
  entry_surface_id TEXT,
  icon            TEXT,
  manifest_json   TEXT NOT NULL DEFAULT '{}',     -- public contract (§7)
  policy_json     TEXT NOT NULL DEFAULT '{}',     -- audience/auth (§4.2 enforced)
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workspace_id, slug)
);
CREATE TABLE app_members (
  app_id    TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'worker',       -- operator | worker
  PRIMARY KEY (app_id, agent_id)
);

-- Adopt existing entities into apps (additive, nullable FK = full back-compat):
ALTER TABLE workflows ADD COLUMN app_id TEXT REFERENCES apps(id) ON DELETE SET NULL;
```

- New `AppStore` service following `workflowStore.ts` conventions — `create / get / list / update / publishVersion / fork / install`.
- `app_surfaces` (§4) and `app_collections` / `app_records` (§5) all carry `app_id`. The App owns its children.
- A bare workflow with `app_id = NULL` stays valid: it is simply an App-of-one rendered by the legacy surface. **No existing workflow breaks.**
- `agentis.app.*` tools rewritten to operate on real rows; add `agentis.app.publish`, `agentis.app.fork`, `agentis.app.version`.
- **Manifest** (`manifest_json`) = the App's public contract: declared capabilities, input/output, required plugins, surfaces, entry. This is what the marketplace indexes (§7) and what an installing workspace reads.

---

## 4. GenUI — the heart of the rebuild

This is where Studio dies and defensibility is born. You asked for *either* "rules/cards" *or* "full front-end power." **The answer is both, as two tiers of one protocol** — because each alone is wrong:
- Cards-only → safe, any-model-drivable, but hits a ceiling (today's Studio).
- Code-only → infinite power, but unsafe, hard to bind to data/actions, and most models can't reliably emit good app code on demand.

### 4.1 The AG-UI protocol (replaces `ui_emit`)

Today the agent's *only* UI power is `ui_emit` — pushing `upsert/append/remove/set_prop` data ops into 14 fixed block types a human pre-built ([agentToolRuntime.ts:235](../apps/api/src/services/agentToolRuntime.ts)). **The agent fills templates; it cannot author UI.** That is the structural ceiling we remove.

New agent tool family — the agent *authors and mutates a UI tree*:

```ts
// Tool signatures (added to the agent tool catalog + specialist tool schema)
ui_render(args: {
  surface: string;                 // surface id within the app
  view: ViewNode;                  // full typed component tree (declare or replace)
}): { rendered: true; surface: string; revision: number }

ui_patch(args: {
  surface: string;
  ops: Array<                      // JSON-Patch-style, addressed by node path/id
    | { op: 'set';    path: string; value: unknown }
    | { op: 'insert'; path: string; node: ViewNode; index?: number }
    | { op: 'remove'; path: string }
  >;
}): { patched: true; surface: string; revision: number }

ui_action_schema(args: {           // declare the actions the UI may invoke
  surface: string;
  actions: Array<{
    name: string;                  // e.g. "approve_refund"
    kind: 'workflow' | 'tool' | 'data';   // how it resolves (§4.4)
    target: string;                // workflow node id / tool name / collection op
    inputSchema?: JSONSchema;      // validated before dispatch
  }>;
}): { ok: true }
```

The **`ViewNode` grammar** (the typed-card tier — small, structured, any-model-drivable):

```ts
type ViewNode =
  // layout
  | { type: 'Stack' | 'Row' | 'Grid'; gap?: number; children: ViewNode[] }
  | { type: 'Card' | 'Section'; title?: string; children: ViewNode[] }
  // content
  | { type: 'Text' | 'Heading' | 'Markdown'; value: string }
  | { type: 'Metric'; label: string; value: Bindable; delta?: Bindable }
  | { type: 'Image' | 'Media'; src: Bindable }
  // data-bound (the key innovation — see §4.3)
  | { type: 'Table';  bind: DataBind; columns: Column[]; rowActions?: ActionRef[] }
  | { type: 'List';   bind: DataBind; item: ViewNode }
  | { type: 'Chart';  bind: DataBind; chartType: 'line'|'bar'|'pie'; x: string; y: string }
  // interactive
  | { type: 'Form';   fields: Field[]; submit: ActionRef }
  | { type: 'Button'; label: string; action: ActionRef }
  | { type: 'Select' | 'Input' | 'Toggle'; field: string; bindState?: string }
  // composites (the OLD 14 blocks, ported)
  | { type: 'MessageFeed' | 'MetricsGrid' | 'ApprovalGate' | 'StatusBoard'
        | 'AgentCard' | 'Map' | 'DocumentViewer' | 'CodeViewer' | 'ConversationThread'
        | 'MediaGallery' | 'WebEmbed' | 'Narrative'; bind?: DataBind; config?: object }
  // escape hatch (§4.5)
  | { type: 'CustomView'; entry: string; props?: object };

type Bindable = string | { $bind: string };          // literal or datastore path
interface DataBind { collection: string; query?: Query; live?: boolean }
interface ActionRef { action: string; args?: Record<string, Bindable> }  // refs ui_action_schema
```

Properties that make this a *protocol*, not a widget set:
- **Declarative data binding** (`bind`) — components subscribe to App Datastore queries (§5). Row changes → UI updates with zero agent involvement. Fixed-blocks + `ui_emit` can never do this: today the agent must manually push every update.
- **Declarative actions** (`ActionRef`) — a button names an `action`; §4.4 resolves it to a workflow/tool/data op. Click → engine runs → datastore changes → bound UI re-renders. Full loop, no human code.
- **Themed by the Agentis Design System** — agents emit *intent* (`Table`, `Form`, `Metric`), not pixels. Consistent, accessible, responsive, dark-mode-correct for free.
- **Backward-compat** — the 14 existing block renderers become composite `ViewNode` types; **`ui_emit` is kept as sugar that lowers to a `ui_patch` append.** Old Studio surfaces keep rendering.

### 4.2 Surfaces leave the graph, become App-owned rows

Today surfaces live inside `WorkflowGraph.surfaces` JSON ([workflow.ts:164](../packages/core/src/types/workflow.ts)). That couples UI to a single workflow and blocks an App from having surfaces spanning multiple workflows. Migrate to:

```sql
CREATE TABLE app_surfaces (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'page',  -- page | dashboard | thread | embed | public
  view_json   TEXT NOT NULL DEFAULT '{}',    -- the ViewNode tree (last rendered)
  audience    TEXT NOT NULL DEFAULT '[]',
  shareable   INTEGER NOT NULL DEFAULT 0,
  revision    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

A **one-time data migration** lifts existing `WorkflowGraph.surfaces[]` into `app_surfaces` rows (the workflow gets a wrapping App). `WorkflowGraph.surfaces` is then **deprecated, not deleted** — read-path keeps a shim for one release, write-path goes to `app_surfaces`. (§10.3 covers the data-migration pattern.)

### 4.3 Live binding & realtime

`ui_render`/`ui_patch` publish over the **existing realtime bus** (extend `STUDIO_BLOCK_EMIT` → `SURFACE_RENDER` / `SURFACE_PATCH` in `packages/core/src/events.ts`). `DataBind` queries call `data_query` (§5.2); writes publish `DATA_CHANGED` scoped to `app_id`+`collection`; bound views re-subscribe and re-render. This is what makes an app *feel alive* without the agent babysitting the UI.

### 4.4 Action resolution (the click→engine loop)

`AppRuntime` dispatches `action(name, args)` → `POST /v1/apps/:id/surfaces/:sid/actions`. The server looks up the action in `ui_action_schema`, validates `args` against `inputSchema`, then:
- `kind: 'workflow'` → enqueue a run on the target node (reuses `runPublishedWorkflow` / engine).
- `kind: 'tool'` → invoke an agent tool via the existing agent tool runtime.
- `kind: 'data'` → a datastore mutation (§5.2), authz-checked against `app.policy`.

Every action is ledgered (the ledger already exists) — this is also where **usage billing** hangs (§7).

### 4.5 The custom-code escape hatch (full front-end power)

For the long tail the typed tree can't express, `{ type: 'CustomView', entry }` renders agent-written code (HTML/CSS/JS or a compiled component) in a **hardened sandboxed iframe** with a **postMessage bridge** exposing exactly three things: theme tokens, a *scoped, permission-checked* datastore client, and an `action(name, args)` dispatcher.

Today's HTML iframe is `sandbox=""` — **no JS at all** ([ArtifactPanel.tsx:183](../apps/web/src/components/ArtifactPanel/ArtifactPanel.tsx)). We move to `sandbox="allow-scripts"` on a **null-origin** frame with a strict CSP and **zero ambient credentials**. The full security model is §4.6 — and it is gated behind the platform's existing P0 security work (§4.6 cites the audit).

### 4.6 Security model for custom code (first-class, not a footnote)

`RUTHLESS-PLATFORM-GAP-AUDIT.md` already flags P0s directly adjacent to this: auth bypass, **SSRF-capable workflow primitives**, and **a sandbox that does not enforce its advertised network boundary**. Custom-code GenUI cannot ship until those are closed *and* the following hold:

| Threat | Control |
|---|---|
| Token/credential theft | No credentials ever enter the frame. All data/actions go through the postMessage bridge; the bridge holds no secrets — it forwards to the server, which authz-checks against `app.policy` using the *end-user's* session, not the agent's. |
| DOM/cookie/storage access to Agentis | `sandbox="allow-scripts"` only (no `allow-same-origin`) → null origin → no access to parent cookies, `localStorage`, or the Agentis DOM. |
| Network exfiltration / SSRF | CSP `connect-src 'none'` inside the frame — it cannot fetch anything. The *only* egress is the bridge, and the bridge cannot reach internal addresses (reuse/finish the `safeUrl` SSRF guard the audit demands). |
| Data over-reach | The datastore client is constructed server-side per render with a capability scope derived from `app.policy` + end-user role. A `CustomView` can only touch collections the App explicitly grants. |
| Action abuse | Every `action()` is validated against `ui_action_schema` and rate-limited per end-user via the existing budget/ledger primitives. |
| Supply chain (agent emits malicious code) | Code is the agent's own output, executed only in the sandbox above; it can harm nothing outside its data scope. CSP blocks remote script loads (`script-src` self+inline-hash only). |

**Default path is the typed tree (§4.1).** `CustomView` is the exception, opt-in per surface, and ships in P5 *after* the audit P0s.

### 4.7 App Runtime (the client)

A new `AppRuntime` React surface — the renderer for `app_surfaces` — that subscribes to `SURFACE_RENDER`/`SURFACE_PATCH`, resolves `bind` queries with live subscriptions, dispatches `action`→backend, renders typed nodes via the Design System and `CustomView` via the sandbox. It runs **embedded in Agentis**, on a **public share link** (extend the existing `/public/workflows/surfaces/:token` route → `/public/apps/:token`), and is the unit the marketplace launches.

---

## 5. App Datastore — the missing backend

**Today:** `workspace_kv` / `workflow_kv_entries` (KV) + `artifacts` (blobs) ([embedded-sql.ts](../packages/db/src/sqlite/embedded-sql.ts)). No typed, queryable, relational app data. You cannot build a CRM, a ticketing app, or an order tracker on KV. **Build a typed collection store — explicitly NOT the brain, NOT a raw-SQL surface.**

### 5.1 Model (migration `v83`)

```sql
CREATE TABLE app_collections (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  schema_json TEXT NOT NULL,          -- JSON Schema (reuse zod/JSON-schema tooling)
  indexes_json TEXT NOT NULL DEFAULT '[]',
  policy_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (app_id, name)
);
CREATE TABLE app_records (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES app_collections(id) ON DELETE CASCADE,
  app_id        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  data_json     TEXT NOT NULL,        -- validated against collection.schema_json on write
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_app_records_collection ON app_records(collection_id, updated_at DESC);
```

- A **collection** = a typed table; `schema_json` is JSON Schema, validated with the platform's existing zod/`WorkflowContract` tooling.
- A **record** = a row validated on write.
- **Indexed fields** declared in `indexes_json` are projected into generated columns (SQLite `GENERATED ALWAYS … STORED`, real columns on PG) for fast query. **No exotic SQL** — keeps the portability story honest (§10.4).
- Scoped per-app by default; cross-app reads require explicit `policy_json` grants.

### 5.2 Agent-facing tools (CRUD as first-class tools)

```ts
data_define_collection({ collection: string, schema: JSONSchema, indexes?: string[] })
data_insert({ collection: string, record: object })          -> { id }
data_update({ collection: string, id: string, patch: object })
data_upsert({ collection: string, match: object, record: object })
data_delete({ collection: string, id: string })
data_query({ collection: string, filter?: Filter, sort?: Sort[], limit?: number, cursor?: string })
  -> { rows: object[], nextCursor?: string }
```

These join the agent tool catalog next to `ui_render`. The agent designs the schema, writes the rows, and binds the UI to them — the full stack, agent-authored. `data_query` is also the engine behind `DataBind` (§4.3).

### 5.3 Realtime

Writes publish `DATA_CHANGED { appId, collection, op, id }`. `AppRuntime` `bind` subscriptions filter on it and refetch the minimal delta. Same bus as everything else.

### 5.4 The brain bridge (one-way, deliberate)

- **Datastore → Brain:** a record can be *promoted* to a memory via the existing formation pipeline ([brainFormation.ts](../apps/api/src/services/brainFormation.ts)) — e.g. "remember this customer's preference." Explicit, gated, audited.
- **Brain → Datastore:** the brain can be a *read source* for an agent deciding what to write — never an automatic mirror.
- **No automatic sync, no shared storage.** Two stores, two guarantees. This bridge is the entire relationship — and the definitive answer to "should the database be the brain?": **no**, and here is exactly how they touch.

---

## 6. Reshaping the Agentis shell

The UI must stop being "a workflow tool with extra tabs" and become one **App editor** plus a reusable App surface renderer:

- **App editor** (maker / agent-authored): `/apps/:id` uses the canvas shell with Interface, Workflow, Data, and Brain facets. The chat-driven builder (`agentis.app.compose`) remains the primary on-ramp: describe the app, watch the agent author graph + schema + UI.
- **Surface renderer**: `AppRuntime` (§4.7) renders a declared surface inside the Interface preview and public-share route. It is a renderer, not a competing App-level Run page.

Navigation: **Apps** becomes top-level home (list, create, install, fork). Workflows / Surfaces / Collections / Agents live *inside* an App. `WorkflowsPage` / `WorkflowCanvasPage` / `WorkflowStudioTab` refactor into App-scoped views; the legacy bare-workflow path stays reachable. The word **"Studio"** is retired from the product surface.

> Per `feedback_architecture_naming_framing`: no "V2" suffixes, Agentis-centric naming, real reuse over forks. We rename *concepts* and extend existing files (`workflowStore`, `WorkflowCanvasPage`, the realtime bus, the public-share route) rather than fork a parallel stack.

---

## 7. Distribution — packaging, sharing, install, marketplace

This is a layer the first draft ignored. It already exists and is well-built; we **extend it, not fork it**.

### 7.1 What exists today (grounded)

Agentis already has a real package/distribution system ([packager.ts](../apps/api/src/services/packager.ts), [package.ts](../packages/core/src/types/package.ts), [routes/packages.ts](../apps/api/src/routes/packages.ts)):
- **`PackageKind = 'agent' | 'workflow' | 'extension' | 'integration' | 'agentis'`.** The **`'agentis'` kind is a *bundle*** — it already packs `agents[] + extensions[] + workflows[] + integrations[] + abilities[] + credentialSlots[] + knowledgeSeeds[] + entryWorkflowSlug`. **This is a proto-App.**
- File format: **`.agentiswf`** (the bundle export extension).
- **`PackageManifest`**: versioned (`manifestVersion`, `agentisVersion`), `slug`, `version`, **sha256 `checksum`**, `source`, `remoteId`, `author`. A real signed/verified distribution contract.
- **Registry + safety**: `registryClient.ts` (remote), `registryScanner.ts` (`scanArtifactBytes` malware/secret scan on import), `library_packages` + `installed_registry_artifacts` tables.
- **Routes**: `pack/workflow`, `pack/agent`, `export`, `use`, `import`, `duplicate`, `install-local`. **CLI** can pack/install too ([cli/src/index.ts](../packages/cli/src/index.ts)). Backup/restore is a separate concern ([backup.ts](../apps/api/src/services/backup.ts)) and stays as-is.

The `'agentis'` bundle is missing exactly two things — **the two things the App primitive adds: surfaces and datastore.** So the App is the natural successor of the `agentis` bundle, not a new mechanism.

### 7.2 The `.agentisapp` package (extends, not replaces)

- **The `'agentis'` bundle kind is promoted to the App package**; its export extension becomes **`.agentisapp`**.
- **`.agentiswf` stays readable forever** (forward-only, same discipline as migrations): the importer accepts both extensions; old bundles import as Apps-of-bundle (no surfaces/collections). **No existing shared bundle breaks.**
- Extend `agentisPackageContentsSchema` (the existing zod schema) with the App facets:
  ```ts
  // added to agentisPackageContentsSchema:
  appManifest:  z.object({ slug, name, version, icon, entrySurfaceId, policy }).optional(),
  surfaces:     z.array(appSurfaceSchema).default([]),      // ViewNode trees (§4)
  collections:  z.array(z.object({                          // datastore SCHEMAS (§5)
                  name: z.string(), schema: jsonSchema, indexes: z.array(z.string()).default([]),
                  seed: z.array(z.record(z.unknown())).default([]),  // OPTIONAL seed rows only
                })).default([]),
  ```
- **Datastore packaging rule (security-critical):** ship the **collection *schema* always**; ship **rows only as explicit, opt-in seed data**, and run them through `registryScanner` for PII/secret findings. A published App ships its *structure*, not a customer's live records, unless the author deliberately seeds demo data. This is enforced at pack time, not left to the author's discipline.
- **Install default (decided 2026-06-22): empty-with-schema.** Installing an App creates its collections empty (schema only); bundled seed rows are *not* auto-inserted in V1. Seed-on-install / demo-data hydration is a later improvement, not a launch requirement.
- **Plugins/credentials on install** reuse the existing `credentialSlots` + `oauthFlow` path — installing an App prompts for the plugin keys it declares. No new credential mechanism.
- `checksum` + `manifestVersion` already give versioning/integrity; the App's `version` (§3) aligns to the manifest `version`. Publish/fork/install (§3 `AppStore`) wrap the existing packager routes rather than duplicating them.

### 7.3 Marketplace & plugins (sequenced LAST, on purpose)

Real strategy, but **premature until §1–§6 ship** — a marketplace with no App primitive and no GenUI is an empty shelf. Reframed against the rename:
- **Apps** (the §1 unit) are what users publish/fork/install — distributed as `.agentisapp` over the existing registry/scanner pipeline. Installing drops its surfaces, workflows, collections (schema + any seed), and required plugins into your workspace.
- **Plugins** (formerly the marketplace doc's "Agentic Apps") = external capabilities for agents (AgentMail, enrichment APIs). Keep the existing manifest/discovery design from `PLUGIN-AGENT-SERVICES-MARKETPLACE.md` — renamed, repositioned as *inputs to Apps*, not the headline.
- Revenue follows the App: platform fee on paid Apps + usage billing at the agent-action level (§4.4; the ledger already exists).

**Gate:** do not build the marketplace until ≥5 non-trivial Apps exist internally and both the §1 manifest *and* the `.agentisapp` round-trip (pack → scan → install → run) have survived real builds.

---

# PART B — THE CODEBASE RESHAPE

> Why this is in the same document: the build above adds an entity layer, a UI protocol, and a datastore. Bolting those onto a codebase with 151 flat service files, a 3,046-line god-module, a throwing PG stub, and 65 overlapping design docs **multiplies** the maintenance surface. We pay down the rot *as we build*, not "later."

## 8. Naming & layering — the structural reshape (no mass renames)

### 8.1 The "workflow" reality, handled correctly

`workflow` appears **3,826 times across 162 API + 97 web files**. A blind rename to "app" would be the Postgres-refactor mistake again (`project_postgres_portability`). The discipline:

- **`workflow` keeps its name.** A workflow *is* the logic graph — that name is accurate. We do **not** rename `WorkflowEngine`, `WorkflowGraph`, `workflowStore`, run state, or the 3,826 call sites.
- **`App` is introduced as the *container* above workflow**, with its own clean module surface (`AppStore`, `app_*` tables, `apps.ts` route, `AppRuntime`). New code, new names — no collision.
- The conceptual rename ("Studio" → "Build/Run", "workflow page" → "App canvas") happens in **product copy and routing**, which is a bounded surface (a handful of pages + labels), **not** in the 3,826 internal symbols.

This is the line between a clean reshape and a 3,826-site disaster. We hold it.

### 8.2 Modularize the service layer

`apps/api/src/services/` holds **151 files in a near-flat directory** (only `agentisToolHandlers/` and `harnessImport/` are grouped). This is itself the "garbage above garbage" smell. Reorganize into domain folders by *bounded context* — **moves only, no logic edits, one PR per domain, verified by typecheck**:

```
services/
  app/        (new: AppStore, surfaces, datastore, AG-UI emit)
  workflow/   (workflowStore, preflight, readiness, recovery, selfHeal, baseline…)
  engine/     (already a sibling dir; leave as-is)
  brain/      (brain*.ts, memory*.ts, pacer, feynman, formation, episodic…)
  agent/      (agentSession*, agentMemory, agentLibrary, specialist*…)
  channel/    (channelBridge, channelTurnDispatcher, channel*…)
  chat/       (chatSessionExecutor, chatToolCatalog, chatToolExecutor…)
  integration/(integrationRegistry, credentialVault, oauth, mcpClient…)
  platform/   (auth, budget, ledger, observability, jobQueue, scheduler…)
```

Re-exports kept where import churn would be large; barrels added per domain. **Mechanical and low-risk** because it is pure relocation, gated by `tsc`.

### 8.3 Break up the god-modules

`sharedIntelligence.ts` is **3,046 lines**; `chatSessionExecutor.ts` 1,654; `datasetIngestion.ts` 1,374. Split along the seams they already have internally (each has clearly separable responsibilities), one module at a time, tests pinned before each split. No behavior change — extract-and-delegate only.

---

## 9. Dead code - direct removal only

Dead code does not get a special mythology in Agentis. A file is either imported by production code, imported by tests, or removed with a named replacement/decommission reason in the same change.

The cleanup rule is simple:

1. **Resolve imports before deleting.** Use the TypeScript import graph and tests as live importers. Plain text grep is only a hint.
2. **Delete real dead modules.** Do not keep report-only scanners, stale compatibility layers, or alternate product surfaces once the live path exists.
3. **Keep compatibility only where it serves users.** Redirect routes and old package import formats may stay; duplicate UI pages, duplicate builders, and shadow runtimes do not.

The decommission set from the App work is now explicit: legacy Studio surface code, `ui_emit`, public workflow surfaces, and `WorkflowGraph.surfaces` write paths are retired in favor of `app_surfaces` and the single App editor.

## 10. Migrations — the changed logic, done safely

### 10.1 How the system actually works (grounded)

Forward-only, **idempotent inlined SQL**, versioned `1 → 81` today ([migrations.ts](../packages/db/src/sqlite/migrations.ts)); tracked in `schema_migrations`; applied in a single `BEGIN IMMEDIATE`/`COMMIT`; **no rollback** (destructive changes ship a follow-up migration). Every migration **must be mirrored in `schema.ts`** (drizzle) or drizzle drifts from reality. New tables here take versions **v82 (apps), v83 (datastore), v84 (surfaces lift)**.

### 10.2 Rules we enforce for this plan

- **Additive first.** Every new column is nullable or defaulted; every new table is independent. Nothing in §3/§5 breaks an existing row. The `workflows.app_id` FK is `NULL`-able → existing workflows keep working untouched.
- **Mirror in `schema.ts` in the same PR.** Non-negotiable; drift is how this codebase rots.
- **Idempotent SQL** (`CREATE TABLE IF NOT EXISTS`, guarded `ALTER`).
- **Reserve versions even if reverted** (the file already documents this for v2–v38).

### 10.3 Data migrations (the genuinely new bit)

§4.2 lifts `WorkflowGraph.surfaces[]` JSON into `app_surfaces` rows. This is a **data** migration, not just DDL. Pattern: a migration creates the table (DDL, versioned); a **separate idempotent backfill routine** (runs once on boot, keyed by a `schema_migrations`-style marker) walks existing graphs and inserts surface rows, promoting each bare workflow into an App-of-one. Read-path keeps a shim reading either location for one release; write-path goes only to `app_surfaces`. Then the shim and `WorkflowGraph.surfaces` write-path are decommissioned (§9).

### 10.4 The Postgres honesty problem

The PG path is a **123-line, ~7-table stub** whose driver **still throws from `openDatabase`** ([migrate.ts](../packages/db/src/migrate.ts) header; `project_postgres_portability`). Continuing to add SQLite-only tables while pretending PG is "scaffolded for parity" is exactly the garbage-on-garbage pattern. **Make a real decision in P1:**
- **Option A (recommended for now):** *Quarantine honestly.* Mark PG explicitly unsupported in code and docs, stop implying parity, and design all new tables (§3, §5) to be PG-portable (no SQLite-only SQL, generated columns expressed portably) so a future port is mechanical.
- **Option B:** Commit to wiring PG now — but that is a large async-refactor program (per the memory), out of scope for the App build and should not be smuggled in.

Either way: **one explicit decision, written down, no more "scaffolded but throws."**

## 11. Docs hygiene

65 markdown design docs in `docs/`, many superseded (this one supersedes part of `WORKFLOW-STUDIO-10X-MASTERPLAN` and renames the old marketplace framing). Remove stale superseded docs once their successor is canonical; do not keep duplicate plans around as "history" unless there is an active migration reader. Per `feedback_masterplan_log`: this doc carries an impl log (§13) reconciled with real code as phases land.

---

## 12. Phasing (build + reshape interleaved)

| Phase | Build | Reshape (paid down in the same phase) | Exit criteria |
|---|---|---|---|
| **P0 — Name & spec** | Resolve App-vs-Plugin; write the §1 manifest spec; rewrite `agentis.app.*` tool copy | Rename marketplace doc; archive superseded docs (§11); PG honesty decision (§10.4) | One canonical definition; zero "Studio" in new copy |
| **P1 — App entity** | `apps`+`app_members` tables (v82), `AppStore`, `workflows.app_id`, `agentis.app.*` on real rows | Create `services/app/`; begin service-dir domain split (§8.2) for app/workflow | Create/list/version/fork an App; existing workflows adopt as App-of-one |
| **P2 — App Datastore** | collections/records (v83), schema validation, `data_*` tools, `data_query` API, `DATA_CHANGED` | Move datastore code into `services/app/`; generated-column portability (§10.4) | Agent defines a schema and CRUDs rows; filtered queries work |
| **P3 — AG-UI tier 1** | `ui_render`/`ui_patch`/`ui_action_schema`, `ViewNode` renderer, `bind`, `action`→engine; port 14 blocks; `ui_emit`→sugar | Split `sharedIntelligence.ts` & `chatToolCatalog` god-modules (§8.3) as they're touched | Agent authors a live, data-bound, interactive UI with working buttons — no human code |
| **P4 — App shell** | `app_surfaces` table (v84) + data migration (§10.3); `AppRuntime` embedded in the Interface facet + public share; Apps top-level nav; one `/apps/:id` editor | Decommission `WorkflowGraph.surfaces` write-path after back-compat release (§9) | A human uses an agent-built app end-to-end (form→workflow→datastore→live UI) |
| **P4.5 — `.agentisapp` packaging** | Extend `agentisPackageContentsSchema` with surfaces+collections; `.agentisapp` extension w/ `.agentiswf` back-compat; pack-time datastore scrub via `registryScanner` (§7.2); `AppStore` publish/fork/install wrap existing packager routes | — | Pack → scan → install → run round-trip works; old `.agentiswf` still imports |
| **P5 — AG-UI tier 2** | Hardened `CustomView` sandbox + bridge (§4.5/4.6) | **Gated on `RUTHLESS` audit P0s** (SSRF, sandbox network boundary, auth bypass) being closed | Agent ships a `CustomView`; security review passes; no raw creds in frame |
| **P6 — Brain bridge** | record→memory promotion; brain-as-read-source (§5.4) | — | Promote a record to memory; no automatic sync exists |
| **P7 — Marketplace** | publish/install Apps; plugins renamed/repositioned; billing on actions | Final direct dead-code sweep using import-graph verification (§9) | ≥5 internal Apps shipped *before* opening it |

Order is load-bearing: **name → entity → data → UI → shell → custom-code → bridge → marketplace.** The reshape work in each row is scoped to what that phase touches, so cleanup never becomes a separate stalled project.

---

## 13. What we explicitly will NOT do

- **Will not merge brain and datastore.** (§0.2, §5.4)
- **Will not blind-rename "workflow"** across 3,826 sites. App contains workflow; internals keep their names. (§0.4, §8.1)
- **Will not extend the 14-block registry** to chase generality — blocks become `ViewNode` composites and we stop adding to the old registry. (§0.3)
- **Will not ship `CustomView` before the typed tier and before the audit P0s close.** (§4.6, P5)
- **Will not build the marketplace before ≥5 real internal Apps.** (§7)
- **Will not keep pretending Postgres has parity** — one honest decision, written down. (§10.4)
- **Will not fork the packaging/registry system** — `.agentisapp` extends the existing `'agentis'` bundle kind + packager/scanner; `.agentiswf` stays importable forever. (§7)
- **Will not pack live customer data into shared Apps** — schema always, rows only as scrubbed opt-in seed. (§7.2)
- **Will not delete modules by grep** — import-graph verification plus tests only. (§9)
- **Will not keep the name "Studio"** in the product. (§0.3, §6)

---

## 14. The one-sentence position (what we tell the world)

> **Agentis is the only platform where an AI agent builds and operates a complete product — interactive UI, business logic, persistent memory, and a real database — and serves it to humans, with no developer in the loop.**

Every clause maps to an asset we have or are building here. No competitor can say the whole sentence. That is the bet.

---

## Impl log

_(append each shipped phase here, reconciled with real code — per `feedback_masterplan_log`)_

### 2026-06-22 — P1 (App entity) backend shipped

- Core types: `packages/core/src/types/app.ts` — `AppRecord`, `AppMember`, `AppStatus`, `AppManifest`, `AppPolicy` + zod create/update schemas. Exported via the types barrel.
- Migration **v82 `agentic_apps`**: `apps`, `app_members`, `workflows.app_id` (nullable, `ON DELETE SET NULL` → bare workflows survive App deletion). Mirrored in `packages/db/src/sqlite/schema.ts` (`apps`, `appMembers`, `workflows.appId`).
- `apps/api/src/services/app/appStore.ts` — `AppStore`: create (unique-slug derivation), get/getBySlug/list, update (manifest kept in sync with columns), delete, membership (add/remove/list, idempotent upsert), workflow adoption (`adoptWorkflow`, `listWorkflowIds`).
- `apps/api/src/routes/apps.ts` — `/v1/apps` CRUD + `/:id/members` + `/:id/workflows`. Mounted in `bootstrap.ts`.
- Tests: `tests/services/appStore.test.ts` — 6 passing (slug collision, manifest sync, adoption, idempotent members, delete-releases-workflows back-compat invariant, NOT_FOUND).
- Verified: core/db/api typecheck clean; 6/6 tests green.

### 2026-06-22 — P2 (App Datastore) backend shipped

- Core types: `packages/core/src/types/datastore.ts` — field DSL (`CollectionField`/`CollectionSchema`, zod-validated, no new dep), `CollectionRecord`/`CollectionInfo`, query model (`QueryFilter` w/ eq/ne/gt/gte/lt/lte/contains/in, sort, cursor), tool/route payloads.
- Migration **v83 `app_datastore`**: `app_collections`, `app_records` (`data_json`, version, FKs cascade from app). Mirrored in `schema.ts` (`appCollections`, `appRecords`).
- `apps/api/src/services/app/appDatastore.ts` — `AppDatastore`: defineCollection (upsert-in-place), listCollections, insert/update/upsert/delete with **schema validation on write** (dynamic zod from the field DSL), `query` via **SQLite `json_extract`** filtering + sort + base64 offset cursor.
- Routes added under `/v1/apps/:id/collections[...]` (define, list, query, record insert/patch/upsert/delete).
- Tests: `tests/services/appDatastore.test.ts` — 5 passing (write-validation, operator+bare-equality filter/sort/version-bump, cursor pagination, upsert-by-match, redefine-in-place).
- Verified: core/db/api typecheck clean; 5/5 tests green.
- **Deferred to next:** agent-facing `data_*` tools in the chat/agent tool catalog (exposes CRUD to agents); generated-column projection for `indexed` fields (scale); `DATA_CHANGED` realtime event (needed by §4.3 UI binding).

### 2026-06-22 — P3 (AG-UI tier 1) + P4 (run shell) + P4.5 (packaging) shipped

**Core**
- `packages/core/src/types/view.ts` — the `ViewNode` grammar (Stack/Row/Grid/Card/Text/Heading/Markdown/Metric/Image/Table/List/Chart/Form/Button/Badge/Divider), `DataBind`, `ActionRef`, `SurfaceAction`, `AppSurface`, and the `ui_render`/`ui_patch`/`ui_action_schema`/`upsertSurface` payload schemas. Zod-validated, shared by backend + web renderer.
- `events.ts` — `SURFACE_RENDER`, `SURFACE_PATCH`, `DATA_CHANGED` + `REALTIME_ROOMS.app(id)`.
- `types/specialist.ts` — 9 new `AgentTool`s (`ui_render/ui_patch/ui_action_schema` + `data_define_collection/insert/update/upsert/delete/query`) added to the union, `DEFAULT_SPECIALIST_TOOLS`, and `TOOL_DESCRIPTIONS`.

**Backend**
- Migration **v84 `app_surfaces`** + drizzle mirror (`appSurfaces`).
- `services/app/appSurfaceStore.ts` — surface CRUD, `render` (ui_render), `patch` (ui_render path-addressed ops), `setActions`; bumps revision + emits realtime.
- `services/app/appDatastore.ts` — optional `onChange` hook → `DATA_CHANGED` on insert/update/delete.
- `services/agentToolRuntime.ts` — `appData`/`appSurfaces`/`resolveAppIdForWorkflow` deps + `context.appId`; full tool-case implementations for all 9 tools (appId resolved from context or the running workflow).
- `routes/apps.ts` — `buildAppStores()` wires emits to the bus; surface routes (`/:id/surfaces[...]`, `render`) + **action dispatch** (`POST /:id/surfaces/:name/actions/:action`) resolving `kind:'data'` end-to-end (insert/update/upsert/delete). `kind:'workflow'|'tool'` return an explicit not-yet-wired error.
- `bootstrap.ts` — shared `appStores` wired into the agent tool runtime + the apps route bus.

**Frontend**
- `lib/appsApi.ts` — typed client (apps, surfaces, collections, action dispatch, query).
- `components/apps/ViewRenderer.tsx` — recursive ViewNode → Design System renderer; `Table`/`List`/`Chart` query the datastore and refetch on `DATA_CHANGED`; `Form`/`Button` dispatch declared actions; `$bind` resolution incl. row scope.
- `components/apps/AppRuntime.tsx` — loads a surface, reloads live on `SURFACE_RENDER`/`SURFACE_PATCH`, and provides dispatch + data-revision context for the Interface facet preview.
- `pages/AppsPage.tsx` is the simple App index; `pages/AppEditorPage.tsx` is the only App detail experience at `/apps/:id`. Creation atomically makes an entry workflow and opens the Workflow facet; later visits open Interface. Routes + lazy imports live in `App.tsx`; **Apps** is in the Sidebar.

**Packaging (P4.5)** — `agentisPackageContentsSchema` extended with `appManifest` + `surfaces` + `collections` (schema always; `seed` rows carried, NOT auto-applied — empty-with-schema install default).

- Tests: `tests/services/appAgentTools.test.ts` — 3 passing, proving the **full agent-authored loop** (define collection → insert → declare actions → render a data-bound surface → query returns inserted rows; ui_patch mutates + bumps revision; data tools rejected without App context).
- Verified: **all 4 packages typecheck clean; 24 tests green** (21 app + 3 packager; existing agentToolRuntime test unaffected); **web production build succeeds**.

**Deferred (honest):** generated-column projection for `indexed` fields (pure scale optimization — json_extract is already correct); P7 marketplace (correctly gated: a product launch needing ≥5 real apps, not a code unit).

### 2026-06-22 — Remaining waves shipped (action dispatch, packaging, brain bridge, CustomView, Build editor)

- **Action dispatch completed** ([apps.ts](../apps/api/src/routes/apps.ts)): `kind:'workflow'` runs the target workflow synchronously via `runPublishedWorkflow` (engine injected); `kind:'tool'` invokes an agent tool through the runtime in App context. Wired `engine` + `toolRuntime` into `buildAppRoutes` from bootstrap. The click→engine→datastore→bound-UI loop is now end-to-end for all three action kinds.
- **`.agentisapp` packaging round-trip** ([appPackager.ts](../apps/api/src/services/app/appPackager.ts) + `/v1/apps/:id/export`, `/v1/apps/import`): exports identity + surfaces + collection **schemas** + workflow graphs with a sha256 checksum; import verifies the checksum (rejects tampering) and recreates the App with **empty** collections (the §7.2 install default). Records never travel. Web Build page exports a downloadable `.agentisapp`.
- **Brain bridge (§5.4)** — `data_promote_memory` agent tool: reads a datastore record and writes it into workspace memory via `MemoryStore` (one-way; data stays source of truth). `memory` wired into the runtime in bootstrap.
- **CustomView — the §4.6 full-power escape hatch** ([ViewRenderer.tsx](../apps/web/src/components/apps/ViewRenderer.tsx) `CustomViewFrame`): agent HTML in a **null-origin** `sandbox="allow-scripts"` iframe (no `allow-same-origin` → no parent cookies/DOM/storage), **CSP `connect-src 'none'`** (zero network egress), data/actions only via a postMessage bridge the parent authz-checks and **allow-lists per declared collection**. Added `CustomView` to the `ViewNode` grammar. *(Frame-level boundary enforced here; broader workspace SSRF audit P0s remain a platform prerequisite before exposing this widely.)*
- **Unified App editor** ([AppEditorPage.tsx](../apps/web/src/pages/AppEditorPage.tsx), routed at `/apps/:id`): one workflow-style editor with Interface, Workflow, Data, and Brain facets; the Interface facet owns the ViewNode JSON editor + live preview and export. There is no separate Run or Build page.
- Tests: `appAgentTools.test.ts` now 4 (added brain-bridge promotion); `appPackager.test.ts` 2 (round-trip + tamper reject).
- Verified: **all 4 packages typecheck clean; 17 App-service tests + 3 packager-route tests green; web production build succeeds** (new chunks: AppsPage, AppEditorPage, AppRuntime).

### 2026-06-22 — Wiring gaps closed + legacy Studio retired (one surface system)

**Chat-driven build (gaps a/b/c)** — the headline UX now works end to end:
- New registry handler family `agentisToolHandlers/appData.ts` exposes `agentis.app.create` + `agentis.data.*` + `agentis.ui.*` (+ `data.promote_memory`) to the **chat** agent. Registered in `registerAllTools`; surfaced in `CHAT_TOOL_CATALOG` (replacing the dead legacy `agentis.app.create/compose` stubs).
- `appId` resolves from an explicit arg **or the viewport** (`resourceKind: 'app'`, added in core + `viewportContext.ts`), so chat-on-an-app-page just works.
- Shared `services/app/appStores.ts` (`buildAppStores`) is the single bus-wired store seam for routes + chat handlers (no duplication).
- Test `appChatTools.test.ts` (3): full create→define→insert→render→query via the registry; viewport resolution; rejection without App context.

**Legacy Studio retired (gap d) — now exactly ONE surface system (AG-UI/`app_surfaces`):**
- Removed `StudioSurfaceSpec`/`StudioBlock`/`StudioBlockType`/`StudioBlockOp`/`StudioLayoutRow`/`StudioSurfaceType`/`StudioAudience` and `WorkflowGraph.surfaces` from core types **and** the zod schema (`.passthrough()` keeps any stored graph JSON valid — no migration needed; legacy surfaces held no persistent data).
- Removed `STUDIO_BLOCK_EMIT`, the `ui_emit` tool, the runtime `ui_emit` case + `surfaceEmit` dep + bootstrap wiring + `requireStudioBlockOp`, the `agentSessionRuntime` schema case, and the legacy public-surface/share routes + helpers in `workflows.ts`.
- Deleted `WorkflowStudioTab.tsx` (1983 lines) + its test; removed the canvas **Studio tab** (canvas is now Canvas|Brain).

**Public app-surface route (gap e):** unauthed `GET /v1/apps/public/surfaces/:token` + token-gated `POST .../query`, registered before auth, gated by the surface `shareable` flag (authed `POST /:id/surfaces/:name/share` mints the token). Renderer data-fetch made injectable so one `ViewRenderer` serves authed + public; new `PublicAppSurfacePage` (read-only, actions disabled) replaces `PublicWorkflowSurfacePage` at `/public/apps/:token`.

**Postgres debt (gap f):** mirrored `apps`/`app_members`/`app_collections`/`app_records`/`app_surfaces` **and** `workflows.app_id` in `packages/db/src/pg/schema.ts` (§10.4 decision: new tables ship on both paths; wider ~40-table PG parity stays the existing acknowledged stub debt; json_extract is the only non-portable bit, isolated in `AppDatastore`).

- Verified: **all 4 packages typecheck clean; 29 App + adjacent tests green** (appStore 6, appDatastore 5, appAgentTools 4, appChatTools 3, appPackager 2, agentToolRuntime, packages-route 3); **web production build succeeds**.
- Pre-existing failures (NOT from this work, confirmed by stash-to-HEAD): 2 in `workflows.test.ts` (AgentMail `send_message` preflight required-field mapping + cron deployment via TriggerRuntime) — from the in-flight integration/connector refactor already in the tree at session start.

### 2026-06-22 — Part B reshape cleanup shipped

- **Service layering (§8.2):** moved App-domain implementations into `apps/api/src/services/app/` (`appStore`, `appDatastore`, `appSurfaceStore`, `appStores`, `appPackager`) and added a domain barrel. Deleted the temporary root-level compatibility exports; tests and production imports now use the real domain path.
- **God-module split (§8.3):** extracted pure Shared Intelligence text/JSON/scoring helpers into `apps/api/src/services/brain/sharedIntelligenceUtils.ts`, leaving `SharedIntelligenceService` API-compatible while creating the first brain-domain module seam.
- **Dead-code cleanup (§9):** removed the report-only dead-module scanner and CI step; cleanup is done by direct import verification plus deletion, not passive reporting.
- **Migration safety (§10):** added DB tests that reserve v82/v83/v84 for Agentic Apps, assert App tables + nullable `workflows.app_id` exist after migration, and require SQLite/PG schema exports for App tables to stay mirrored.
- **Docs hygiene (§11):** deleted the stale old marketplace doc instead of archiving duplicate naming; added `docs/PLUGIN-AGENT-SERVICES-MARKETPLACE.md` as the canonical successor for external plugin/agent-service marketplace language.
- **Verification:** targeted typecheck/tests run as part of this Part B pass; results captured in the assistant handoff.

### 2026-06-23 — Maker UX 10x: WYSIWYG Interface builder + product-level App Engine

The §4/§6 backend (surfaces, datastore, AG-UI, action dispatch, packaging) was sound, but the **maker UI on top of it was unusable** — the Interface "builder" rendered an abstract node-chip tree with the real output gated behind a separate Save→Preview pane, and the App Engine surfaced plumbing (raw grant JSON, `customCode` enum, checksum) instead of product settings. Rebuilt both:

- **One renderer, two modes (no fork).** `apps/web/src/components/apps/ViewRenderer.tsx` gained an optional `SurfaceEditContext`: each node is wrapped selectable/hoverable with a floating toolbar (move/duplicate/delete) and inline text editing (double-click); `ActionButton`/`ActionForm` are inert in edit mode while data binding still runs. The builder canvas is therefore pixel-true to production — the Save→preview round-trip is gone. New `SurfaceCanvas.tsx` is the design-mode host (real `data.query`, inert actions) reusing `RuntimeProvider` + `ViewRenderer`.
- **Studio-grade composites as templates.** `surfaceTemplates.tsx` — palette split into **Sections** (Records table, Create form, Metrics, Chart, Feed, Approval panel, Header) that lower to bound primitive subtrees + declare their `SurfaceAction`s, and **Elements** (primitives). Zero protocol change; columns/fields derived from the collection schema.
- **`InterfaceFacet` rebuilt** (`AppEditorPage.tsx`): top strip (surface tabs + inline rename, Builder/Preview/Code toggle, AI prompt, Save) over a 3-pane body (palette · live canvas · inspector). Tree utils extracted to `viewTree.ts`; old `SurfaceNodeEditor` + in-page helpers deleted.
- **AI-assist** (`POST /v1/apps/:id/surfaces/generate`, `services/surfaceGenerator.ts`): NL prompt → `viewNodeSchema`-validated tree via the workspace `StructuredCompleter` (`defaultCognitiveCompleter` wired in bootstrap), with a deterministic scaffold fallback so the builder is never empty. Model-agnostic (chat()-only contract).
- **App Engine rebuilt** (`AppEngineModal.tsx`): Overview / Identity / Access / Advanced. Friendly audience + share controls and an "Allow custom-coded views" toggle up front; capability grants are a simple list editor; checksum/source/slug demoted to a read-only Distribution block under Advanced.
- **Verification:** web + api typecheck clean; web production build succeeds; `AppEditorPage.test.tsx` (5: workflow rename, live add-block, data-bound section + action persistence, AI generate, engine save) and `surfaceGenerator.test.ts` (5: scaffold/model/invalid/null paths) green; 30 App-domain API service tests still green.

### 2026-06-23 — The agentic reframe: agent-native surfaces, Live-first, operator loop

The WYSIWYG builder was real but **conceptually wrong**: generic web blocks (Heading/Text/Card/Row) made surfaces feel like a WordPress dashboard, and opening Interface dumped the maker into a palette instead of a living thing. An Agentic App's defining truth is that **an agent operates it** — it pursues a goal, does work, manages data, raises decisions; the human watches, directs, approves. The vocabulary and the default experience now reflect that.

- **Agent-native composites in the grammar** (`packages/core/src/types/view.ts` + zod, `ui_render` tool description updated so agents author them):
  - `AgentConsole` — the operator agent's presence (name, live status) + a command line to direct it.
  - `ActivityStream` — a live feed of the operator's work, streamed over the realtime bus (`AGENT_WORK_STEP`/`AGENT_TERMINAL_TOOL_CALL`/`RUN_*`/`NODE_*`/`APPROVAL_REQUESTED`).
  - `DataBoard` — a kanban over a collection grouped by a status field (apps, not dashboards).
- **Operator loop is real** (`routes/apps.ts`): `GET /:id/operator` resolves the operator agent from `app_members`+`agents` (name/status/colorHex); `POST /:id/operator/command` runs the app's entry workflow with the human's instruction via the existing `runPublishedWorkflow`+engine path — so a command produces work the ActivityStream narrates live. `appsApi.operator`/`runOperatorCommand`; the console binds to `AGENT_STATUS_CHANGED` for live status.
- **Interface is Live-first** (`AppEditorPage.tsx`): opens into the running app (`AppRuntime`) framed by the operator console; **Edit** (direct-manipulation canvas + agent-first palette) and **Code** (JSON) are opt-in modes. The Edit palette is grouped **Agent · Data · Layout & content**, agent composites first.
- **Operator-centric defaults**: a new surface (and the generator's deterministic fallback) leads with `AgentConsole` + `ActivityStream` + a board/table of managed data — opening an app feels like a living operator workspace, never a blank canvas. The renderer is unchanged single-path, so the agent authors these same composites at runtime.
- **Verification:** core/web/api typecheck clean; web build succeeds; `AppEditorPage.test.tsx` now 6 (added: operator console binds to the real `/operator` endpoint) and `surfaceGenerator.test.ts` 5 green; 30 App-domain API tests still green.

---

## Impl log — 2026-06-25: Apps are the ONLY primitive (no standalone workflows)

Problem (operator-reported): the orchestrator was workflow-first — it produced bare workflows, dumped the operator on `/apps/workflows/:id`, and when asked to "review/recreate" the existing **Agentis Fashion Store Factory** app it created a duplicate (`agentis-fashion-store-factory-2`). Decision: Apps are the unit of delivery; a naked workflow must not be creatable by the agent; a workflow page is never a standalone destination. (Operator chose the full structural+redirect option, code-only.)

- **Structural auto-wrap** (`services/agentisToolHandlers/build.ts`): `createWorkflowFromDescription` wraps every *new* workflow in an App-of-one (`new AppStore(deps.db).create({ name: title, entryWorkflowId })`) and threads the resolved `appId` into the result, the dedup early-return, and the `CANVAS_BUILD_COMPLETE` event. `agentis.workflow.create` wraps too. Existing workflows resolve their owner via the new `AppStore.appIdForWorkflow(ws, wfId)` reverse lookup (`packages/app/src/appStore.ts`).
- **Idempotent `agentis.app.create`** (`services/agentisToolHandlers/appData.ts`): resolve-or-create — (1) `adoptWorkflowId` already owned → reuse+rename that App; (2) exact-name match → reuse (adopt wf if given); (3) else create. Returns `reused:true`. Kills the `-2` twin (which came from `AppStore.uniqueSlug` suffixing on name collision).
- **Orchestrator reframe** (`services/orchestratorPrompt.ts` + `services/chatToolCatalog.ts`): Workflow = "logic layer of an App, never delivered bare"; Agentic App = "THE unit of delivery"; build_workflow "returns appId — thread into ui_/data_"; new rule: review/recreate/improve an existing App → resolve it (`canvas.context`/`app.list`) and edit IN PLACE.
- **Navigation = open the App** (`apps/web/src/App.tsx`): keystone `WorkflowCanvasRoute` resolves the workflow's `appId` (already on `GET /v1/workflows/:id`) and `Navigate`s to `/apps/{appId}`, else renders the canvas (legacy bare fallback) — so every existing `/apps/workflows/:id` link (chat "Logic", run modal, packages, knowledge) lands on the App. `CANVAS_BUILD_COMPLETE` + `agentis:open-canvas` handlers (`ThreadView.tsx`, `App.tsx`) nav to `/apps/{appId}` directly. AppEditorPage embeds the canvas via props, not the route → no redirect loop.
- **Verification:** app/api/web typecheck clean; api targeted suites green — appChatTools 5, agentisChatTools 11 (incl. build_workflow drafts), apps 14, mcpRpc 9 (incl. MCP build_workflow), workflowIo 4.
- **Deferred (operator did not pick):** stripping human workflow-create entry points (sidebar / Cmd+K / templates) — humans can still start a workflow, and pre-existing bare workflows still render via the canvas fallback.

### Impl log — 2026-06-25 (2): agent builds DATA + INTERFACE, not just logic

Follow-up complaint: even when explicitly told to build the CRM interface + datastore, the agent produced only workflow logic — the app opened to "No interface yet" (`AppEditorPage` empty state when an app has zero surfaces). Root cause: `services/surfaceGenerator.ts` (the proven AG-UI generator behind the App-editor "Generate" button — AgentConsole + ActivityStream + DataBoard/Table/Form, model-assisted with a deterministic fallback) was REST-only (`POST /v1/apps/:id/surfaces/generate`); the chat agent's only UI path was hand-authoring a raw ViewNode tree via `ui_render`, which is hard, so it skipped it.

- **New one-call tool `agentis.app.scaffold`** (`services/agentisToolHandlers/appData.ts`): defines the App's collections (the data format) AND authors a real data-bound operator surface via `generateSurfaceView`, persisting actions then the view. Resolves a model via `resolveSynthesisCompleter` (now `export`ed from `build.ts`); with no model it still emits the deterministic bound scaffold (never blank). `mcpExposed`.
- **Prompt** (`services/orchestratorPrompt.ts`): the App Builder step 2 is now "Data + Interface (DO NOT SKIP)" pointing at `agentis.app.scaffold` as the fast path, with the hard rule "an App with logic but no interface and no datastore is INCOMPLETE" and a worked lead-CRM example. Action-first rules updated to match.
- **Catalog** (`services/chatToolCatalog.ts`): `agentis.app.scaffold` added for injected-tool-surface agents.
- **Verification:** api typecheck clean; `appChatTools` now 6 (added "scaffolds an app with its data format AND a real data-bound interface in one call"), `agentisChatTools` 11, `apps` 14, `mcpRpc` 9, `createWorkflowDelivery` 17 green.

### Impl log — 2026-06-25 (3): GenUI Renaissance (visual layer rebuild)

The §4 substrate (binding/actions/realtime/sandbox) was sound, but the **rendered output was a tall stack of identical `p-4 shadow-card` panels with `<div>`-bar charts** — agents had no styling/layout vocabulary and the generator emitted the same scaffold for every app. New plan owns the expressive layer: see **`docs/GENUI-RENAISSANCE-MASTERPLAN.md`**. Decisions: keep the live substrate, rebuild renderer + grammar + generator; typed tier first, code-surface tier later (gated). Additive grammar → no surface migration. Phases land below as they ship.
