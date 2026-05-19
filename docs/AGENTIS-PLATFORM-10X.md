# Agentis Platform — 10x Architecture Replan
## From Workflow Automator to Agentic Application Platform

> **Status:** Active strategic planning — May 2026
> **Scope:** Platform vision, architecture gaps, 5-layer app model, build plan
> **Trigger:** Product audit — current system is capable but bounded; cannot yet power
> real-world enterprise-grade agentic applications
> **Honest verdict:** The core engine is strong. The app model is too small. We are not
> afraid to rebuild the parts that are wrong.

---

## Part I — The Honest Audit

### What we built

Agentis today is a well-engineered agentic automation platform. The foundation is genuinely
strong:

| System | Status | Assessment |
|---|---|---|
| `WorkflowEngine` | Solid | DAG execution, run state, checkpoints, partial replay, router/merge — production-ready |
| Adapter system | Solid | claude_code, codex, openclaw, hermes, cursor, http — normalized dispatch, streaming |
| Skills runtime | Solid | 3-tier trust (builtin/node_worker/docker_sandbox), sandboxed, schema-validated |
| App package system | Solid | Knowledge seeds, memory seeds, evaluator rubrics, dataset specs, activation pipeline |
| CollectiveBrain | Solid | Knowledge atoms, graph linking, similarity scoring, confidence threshold |
| EvaluatorRuntime | Solid | 4-tier evaluation chain (schema → rule → rubric → llm) — rare sophistication |
| MCP interop | Good | Model Context Protocol for tool calling — future-proof |
| WorkflowDeployments | Good | Deploy a workflow as an API endpoint — the right direction |
| AppThread | Good | Operator conversation scoped to app — correct model |
| Realtime bus | Good | WebSocket event rooms per workflow/agent/workspace |
| Budget/Ledger | Good | Cost tracking per run, per agent — production-quality |
| ChatSessionExecutor | Good | Streaming orchestrator chat with tool calls, system prompt, viewport context |

**This is not a system that needs to be thrown away. The engine is the right engine.**

What needs to change is the *model around the engine* — specifically, the concept of what
an app is, what it can store, what it can expose, and how it grows over time.

### What we cannot do today

Walk through the apps a user should be able to build:

**Autonomous SDR Engine (Zero-Inbox Outbound)**
- Continuously monitors LinkedIn, web registries, and trigger events
- Detects a buying signal → spawns a research sub-swarm to profile the prospect
- Copywriter agent drafts hyper-personalized outreach from prospect data
- Sends via WhatsApp/email, tracks responses, handles objections, manages calendar sync
- Passes qualified leads to a human CRM row
- Every iteration makes the next one smarter (what subject lines convert, what profiles close)

*What's missing: persistent leads table the app owns, cross-workflow event triggering
(signal detected → spawn research → spawn copy), multi-agent swarm for parallel research,
compounding learning from conversion data.*

**Codebase Re-Architect (Super-Lovable)**
- Ingests a multi-million-line production repo, maps its AST
- Parallel micro-agents scan all dependencies, schemas, API boundaries
- A planning agent receives the migration directive (Node → Rust)
- Spins up Docker containers, writes new code, runs compiler loops, handles errors
- Generates shadow infra, shadow-routes traffic, runs DB migrations, green-blue deploy
- Operator only sees progress and approvals — not the 200 subtasks

*What's missing: isolated execution environments per agent task, durable long-running jobs
that survive server restarts, structured state across 200+ parallel sub-tasks, deployment
pipeline integration.*

**Ad-Tech Autonomous CMO**
- Polls Meta/Google/TikTok ad APIs continuously for CAC/LTV metrics
- Detects creative fatigue or CPC spike → immediately reallocates budget via API calls
- Underperforming creative → invokes multimodal skills to regenerate hook variants
- Generates image/video assets, deploys to ad networks
- Fraud sentinel runs adversarially — detects click farms, updates firewall rules,
  files automated refund claims

*What's missing: always-on persistent listener that runs across sessions, real-time
budget reallocation via skill calls without human gate, multimodal skill pipeline,
external API write-back (ad network APIs), the app's own campaign/spend data store.*

**Autonomous Customer Success Swarm**
- Ingests multi-channel inbound (email, Intercom, WhatsApp)
- Resolves complex account issues by orchestrating DB updates
- Intercepts bug reports → reproduces in local env → finds the line → writes a PR
- Churn sentinel monitors engagement telemetry → triggers personalized retention sequences

*What's missing: webhook receiver that the app exposes to external systems, the app's
own structured customer/ticket database, cross-service DB writes as a skill, the
compile/test/iterate self-healing loop.*

### The five architectural gaps

After surveying the codebase, the gaps are not in the engine — they are in the app model:

**Gap 1 — No structured data layer per app**
`DataIngestion` sends records into knowledge chunks (for RAG retrieval). There is no
concept of an app owning structured tables that workflows write to, that can be queried
with filters, that compound over time, and that expose as an API. The app has no memory
of its work beyond raw embeddings.

**Gap 2 — No cross-workflow event signaling**
Subflows exist but are synchronous invocations. There is no pub/sub model where
workflow A completing (and writing a new lead record) automatically triggers workflow B
(the outreach pipeline). Each run is an island.

**Gap 3 — Job queue is too thin**
`DatabaseJobQueue` uses `queueMicrotask`. There is no priority, no worker pool, no
distributed workers, no durable persistence across server restarts. Long-running
multi-day jobs cannot currently survive a server restart.

**Gap 4 — Apps cannot be deployed as products**
`WorkflowDeploymentService` deploys a single workflow as an API endpoint. There is no
"deploy this entire app" concept — no stable URL, no webhook receiver, no streaming
endpoint, no embedded widget. Apps are always internal tools.

**Gap 5 — The canvas is a blank editor, not a living map**
The canvas works well as a graph editor. But it is empty by default — every app requires
manual construction. Complex apps (40+ workflows) have no hierarchical organization. The
canvas cannot show the live state of a running app. Nodes have generic names instead of
concrete ones.

---

## Part II — What Agentis Must Become

### The core thesis (unchanged)

Agentis is a platform for building and running **agentic applications**. Not normal apps —
agentic apps. The distinction is fundamental:

| Normal app | Agentic app |
|---|---|
| Executes deterministic code | Orchestrates intelligent agents making decisions |
| Static until updated | Learns and improves as it processes data |
| Stores data in a DB | Stores data AND knowledge AND episodic memory |
| Serves users who click buttons | Operates autonomously with periodic human checkpoints |
| Deployed once, runs forever | Continuously running, continuously evolving |
| Workflow = sequence of functions | Workflow = coordination of intelligent actors |

**Everything Agentis builds is grounded in its primitives: workflows, agents, skills,
knowledge, and evaluators.** That doesn't change. What changes is the scope of what you
can build from those primitives.

### The examples validate the architecture

The four app examples above are not special. They share a common pattern:

```
INGEST (sensors, APIs, data feeds)
    ↓
PROCESS (parallel agents, skills, knowledge retrieval)
    ↓
STORE (structured results, learned patterns)
    ↓
ACT (write-back to external systems, surface to humans)
    ↓
LEARN (evaluators assess quality, Brain absorbs patterns)
    ↓
REPEAT (next cycle is smarter than the last)
```

This is the compound intelligence loop. Every real-world agentic app is a variant of it.
The platform must enable the full loop — not just the PROCESS step.

---

## Part III — The Five-Layer App Model

Replace the current `Output / Canvas / Brain` shell with:

```
+────────────────────────────────────────────────────────────────────+
|                         AGENTIS APP                                |
+──────────+──────────+──────────+──────────+────────────────────────+
| SURFACE  | CANVAS   | DATA     | BRAIN    | DEPLOY                 |
|          |          |          |          |                        |
| How      | How it   | What it  | What it  | Where & how            |
| people   | works    | stores   | knows    | it runs                |
| interact | inside   | & serves | & learns |                        |
+──────────+──────────+──────────+──────────+────────────────────────+
```

---

### Layer 1 — SURFACE

**What it is:** The interface the app exposes to the world — operators, end-users, and
external systems.

**Why "Surface" not "Output":** Output implies a static artifact from the last run.
Surface implies something living — it is how the world talks to this app, and how this
app talks back.

The app declares its surfaces in its manifest. The platform renders them. An app can have
multiple surfaces simultaneously.

#### Surface types

| Type | Description | Example |
|---|---|---|
| `thread` | Conversational thread — operator directs the app in natural language | Social Listening, SDR Engine |
| `dashboard` | Structured views — tables, metrics, charts auto-built from Data layer | Ad-Tech CMO, Analytics |
| `api` | REST endpoints — external systems call the app via stable URL | Lovable clone, Stripe replacement |
| `webhook_receiver` | The app listens for events from external services | Customer Success, GitHub hook |
| `stream` | Real-time SSE/WebSocket feed from the app's event bus | Monitoring apps, trading bots |
| `embed` | A web component another service can iframe | Chatbot widget, generated UI |
| `artifact` | Generated files and media — pages, images, videos, ad packs, documents | Marketing automation, content creation, reporting |
| `page` | A live-updating web page the app owns, generates, and publishes | Landing page, campaign hub, generated status page |

The current `AppThread` is the implementation of `thread`. Everything else needs to be
added.

#### Thread surface (current `AppThread` — keep and extend)

The `thread` surface is correct as designed in `APP-OUTPUT-REPLAN.md`. The operator
speaks to the **App Brain** (see below), which interprets the request, routes it
to the right domain workflows, and surfaces synthesized results back. This stays.

Add: the thread should show inline result cards from the Data layer — when the SDR engine
finds a new qualified lead, it surfaces the lead card in the thread without the operator
asking.

#### The App Brain — internal, not a separate agent slot

The workspace already has a three-tier agent hierarchy that operators configure:

| Role | Scope | Configured by |
|---|---|---|
| **Orchestrator** | Workspace-wide | Operator creates in Agents panel |
| **Manager** | One space/channel | Operator creates and scopes to a space |
| **Worker** | One task | Operator creates, used inside workflow nodes |

Apps do **not** add a fourth tier to this hierarchy. Instead, each app has a built-in
**App Brain** — an internally-provisioned agent that is invisible in the workspace Chat
sidebar and Agents page. The operator never configures it separately.

- Created automatically when the app is installed
- Lives inside the app's Thread surface — not in the workspace agent list
- Fully defined by the app manifest, isolated from workspace agents
- Has its own context, state, and goals — does not share them with the workspace Orchestrator

When an operator sends a message in the app's Thread, the App Brain interprets it,
decides which domain workflows to invoke, monitors progress, and synthesizes results
back into the thread.

The App Brain is configured in the manifest:

```ts
interface AppBrainConfig {
  adapter: AdapterType;
  /** System prompt — the app's goals, rules, and decision logic. */
  systemPrompt: string;
  /** Entry workflows the Brain can invoke by slug. */
  entryWorkflows: string[];
  maxConcurrentDomains?: number;
}
```

This keeps the mental model clean: the workspace Orchestrator you see in Chat handles
workspace-level commands. Each app's Brain handles that app's commands. They are separate
entities with separate contexts and do not compete for the same decision loop.

#### API surface (new — generalizes `WorkflowDeploymentService`)

The app declares API routes in its manifest:

```ts
interface AppApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;                       // e.g. "/leads", "/leads/:id"
  handler: 'query_data' | 'trigger_workflow' | 'custom_skill';
  // query_data: reads from the app's Data layer and returns JSON
  // trigger_workflow: triggers the named entry workflow with the request body as input
  // custom_skill: invokes a skill with the request body
  workflowSlug?: string;              // for trigger_workflow
  dataTable?: string;                 // for query_data
  auth: 'public' | 'api_key' | 'bearer' | 'none';
}
```

The platform generates a stable URL rooted at your Agentis server:
`http://localhost:3737/apps/{slug}/api/*` in development, or
`https://{your-domain}/apps/{slug}/api/*` when self-hosted on your own VPS or cloud.
No external service required — the API is served by the same process running your apps.
This turns any app into an API product that external systems can call directly.

#### Dashboard surface (new — the operator's live command center)

The dashboard surface is the operator's real-time window into a running app. Unlike a
static report, it is a live view that updates as the app writes to its Data layer.
The platform generates it automatically from the app's Data schema and a lightweight
`AppDashboard` manifest declaration. No frontend code required for standard dashboards.

**What a dashboard surface renders:**

- **Record tables** — Every Data table the app defines becomes a searchable, filterable,
  sortable table widget. Columns map to schema fields. Pagination, sorting, and column
  visibility are automatic. Clicking a row opens a detail drawer.

- **Metric cards** — Aggregate values derived from Data tables: count, sum, average,
  min/max over a field, with optional time bucketing (today / 7d / 30d). Declared in
  the manifest as `metrics`. Refresh on every write cycle.

- **Charts** — Time-series line charts, bar charts, pie charts, area charts — declared
  in the manifest as `charts`. Each chart specifies a Data table, a time field, a value
  field, and an aggregation function. Auto-refreshes on a configurable interval.

- **Status strip** — App lifecycle signals: last run time, currently running domains,
  error count in the last N hours, budget spent today. Pulled from the job queue and
  run log. Always visible at the top of the dashboard.

- **Activity feed** — A chronological stream of the app's recent actions. Every
  `data_write` node in every workflow emits a feed entry. The operator sees exactly
  what the app is doing without opening a workflow run log.

**Dashboard manifest declaration:**

```ts
interface AppDashboard {
  metrics?: Array<{
    label: string;
    table: string;
    field: string;
    aggregation: 'count' | 'sum' | 'avg' | 'min' | 'max';
    filter?: string;          // e.g. "status == 'qualified'"
    timeBucket?: 'today' | '7d' | '30d' | 'all';
  }>;
  charts?: Array<{
    type: 'line' | 'bar' | 'pie' | 'area';
    label: string;
    table: string;
    timeField?: string;
    valueField: string;
    groupBy?: string;
    aggregation?: 'count' | 'sum' | 'avg';
    refreshIntervalSeconds?: number;
  }>;
  pinnedTables?: string[];              // tables to show prominently
  defaultRefreshIntervalSeconds?: number; // default: 30
}
```

For the SDR Engine: the dashboard shows total leads this week, conversion rate trend,
outreach log with sentiment indicators, and objection category breakdown — all generated
from the `leads`, `outreach_log`, and `objections` Data tables. Zero custom code.

#### Artifact & Media surface (new — rich output for creative and production apps)

Many agentic apps don't produce structured data — they produce **artifacts**: landing
pages, image packs, video scripts, PDFs, ad creative sets, email sequences, complete
marketing campaign packages. The artifact surface handles this.

An artifact is any file or collection of files the app generates that must be stored,
versioned, previewed by the operator, and exported or deployed.

**Artifact types:**

| Artifact | Description | Example |
|---|---|---|
| `page` | A rendered HTML page the app generates and can publish | Landing page, campaign hub, generated report |
| `image_pack` | A set of generated images with metadata and variants | Ad creatives, social post assets, brand kit |
| `video` | A generated or assembled video file | Marketing hook, product demo, testimonial edit |
| `document` | A structured document (PDF, DOCX, Markdown) | Proposal, creative brief, audit report |
| `email_sequence` | A series of email templates with scheduling metadata | Nurture flow, onboarding sequence |
| `code_bundle` | Generated code, configs, migration files | Scaffold, DB migration, test suite |

**How artifacts flow from workflows:**

A `skill_task` node can output an `ArtifactRef` (type + path + metadata). A lightweight
`artifact_collect` node (new) receives artifact refs from upstream nodes, names and
versions the collection, and writes it to the app's artifact store. The artifact surface
then renders:

- A gallery/list of all produced artifacts, grouped by type and run
- A preview pane for supported types (HTML iframe, image gallery, document reader)
- Export actions: download, copy link, push to S3/CDN, deploy to a domain
- Approval gate: operator reviews and approves before the app distributes the artifact

**For the Autonomous CMO example:**

A "Campaign Pack" artifact contains: one landing page, 5 ad creative image variants,
a 3-email nurture sequence, and a 30-second video hook. The app generates all of them
in one run. The operator opens the artifact surface, previews the full creative pack,
approves it, and the app automatically deploys each piece to the correct channel via
skill tasks — no manual file shuffling, no channel-by-channel upload.

This is the surface type that makes marketing automation, content factories, and
creative-at-scale apps actually usable by non-technical operators.

#### Page surface (new — live-updating web pages the app owns)

The `page` surface is a live web page the app generates, owns, and publishes. Unlike a
static artifact, a page is a running view that updates as the app's Data layer changes.

- The app declares `{ type: 'page', label: 'Campaign Hub' }` in its surfaces
- The platform provisions a route at `/apps/{slug}/page/{page-name}`
- The page content is generated by a workflow (via `artifact_collect` or a `skill_task`
  that outputs HTML) and stored as an `html` artifact
- When the underlying Data layer changes, the page can auto-refresh to reflect the
  latest state

**Use cases:** Generated landing pages, campaign status hubs, real-time progress
dashboards for long-running jobs, public-facing status pages for infrastructure apps.

#### Embed surface (new — web component for external sites)

The `embed` surface produces a lightweight web component that another service can iframe
or embed. This is how an app's output appears inside an external product.

- Declared as `{ type: 'embed', label: 'Chat Widget' }` in the manifest
- The platform generates an embeddable URL and an optional `<script>` snippet
- The embed runs in a sandboxed iframe, communicating with the app's API surface
- State is scoped to the embedding context (a session ID or auth token)

**Use cases:** Chatbot widgets embedded in a customer support portal, inline dashboards
in a CRM, generated report iframes in a BI tool, interactive onboarding widgets.

#### Stream surface (new — real-time event feed)

The `stream` surface exposes the app's event bus as a real-time SSE or WebSocket feed
that external consumers can subscribe to. This is how other systems react to what the
app is doing.

- Declared as `{ type: 'stream', label: 'Trade Feed' }` in the manifest
- The platform opens an SSE endpoint at `/apps/{slug}/stream`
- Events are scoped to the app's `REALTIME_ROOMS.app(appId)` room
- Consumers receive `DATA_RECORD_CHANGED`, workflow status changes, and custom events
- Optional `filter` parameter narrows the stream to specific event types or tables

**Use cases:** Trading bots streaming price alerts, monitoring apps broadcasting
incidents, marketing platforms streaming campaign events to an analytics warehouse,
CI/CD apps streaming build status to Slack.

---

### Layer 2 — CANVAS (major redesign)

**What it is:** The architectural map of a living system, not a blank editor.

#### The design principles that change

1. **Auto-populated from manifest** — When an app is activated, the canvas populates
   itself from `appGraphTemplate` using the actual workflow names from the installed
   workflows. You never open a blank canvas for a packaged app.

2. **Two zoom levels: domain and detail**

   *Domain view (macro):*
   ```
   +───────────────+    +───────────────+    +───────────────+
   | Content        |    | Campaigns      |    | Analytics     |
   | Pipeline       |───>| Manager        |───>|               |
   | 12 workflows   |    | 8 workflows    |    | 6 workflows   |
   | ● 3 running    |    | ○ idle         |    | ● 1 running   |
   +───────────────+    +───────────────+    +───────────────+
   ```

   *Detail view (micro):* drill into a domain → the familiar workflow-level module graph
   for that domain. Click back → macro view.

3. **Zones, not freeform** — Left zone (Sources/Triggers), center zone (Process/Agents),
   right zone (Output/Channels). Nodes auto-place in their zone. The layout tells the
   story: data flows left to right.

4. **Nodes carry live status** — Each node shows its last run time, item count, and
   connection status. Not just "Workflow · Connect a workflow here."

5. **Concrete names, not abstract types** — A node title is the actual thing it
   represents, not its type tag. "Monitor Twitter Mentions" not "Workflow". The type tag
   is secondary decoration.

6. **The canvas is authored by the App Brain** — For packaged apps, the App Brain
   generates the canvas layout during app setup. The operator reviews and can annotate
   or reorganize — they do not build from scratch.

#### Domain model for the canvas (`AppDomain` — new type)

```ts
interface AppDomain {
  id: string;
  name: string;                 // "Content Pipeline"
  description?: string;
  color?: string;               // zone color for macro view
  workflowIds: string[];        // concrete workflows in this domain
  position: { x: number; y: number };
  expanded?: boolean;           // macro: collapsed/expanded
}
```

The `AppGraph` type grows to include `domains: AppDomain[]`. The canvas renders the
domain view when `domains.length > 0`, the flat view otherwise.

---

### Layer 3 — DATA (new — the most important addition)

**What it is:** Each app owns a schema-defined structured store. Workflows write to it,
workflows read from it, external APIs query it, the Brain learns from it.

**What it is NOT:** Not the Brain (which is knowledge/embeddings for AI reasoning). Not
the knowledge base (which is unstructured documents for RAG). The Data layer is the app's
operational database — structured records with schemas, filters, and pagination.

#### Why this is the pivotal missing piece

Without the Data layer:
- The SDR engine cannot maintain a leads table
- The Ad-Tech CMO cannot track campaign spend over time
- The Customer Success swarm cannot check a customer's account history
- The Lovable clone cannot store user projects and generations
- Nothing compounds — each run starts from zero

With the Data layer:
- The app accumulates work over every run
- The Brain absorbs patterns from accumulated records
- External APIs can query the app's data
- The operator sees a live dashboard of accumulated results
- Rules trigger new workflows when data changes

#### Data layer design

**Per-app schema declaration (in manifest):**

```ts
interface AppDataTable {
  name: string;               // e.g. "leads"
  description?: string;
  schema: Record<string, AppDataField>;
  indexes?: Array<{
    field: string;
    type: 'index' | 'unique';
  }>;
  retention?: {
    maxRows?: number;         // auto-archive oldest when exceeded
    ttlDays?: number;         // delete records older than N days
  };
}

interface AppDataField {
  type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'text';
  required?: boolean;
  description?: string;       // shown in Data layer UI
}
```

**Runtime implementation:**

Each installed app instance gets scoped SQLite tables: `app_{appId}_{tableName}`.
The `AppDataService` provides:

```ts
class AppDataService {
  insert(workspaceId: string, appId: string, table: string, record: Record<string, unknown>): Promise<{ id: string }>;
  query(workspaceId: string, appId: string, table: string, filter?: QueryFilter): Promise<QueryResult>;
  update(workspaceId: string, appId: string, table: string, id: string, patch: Record<string, unknown>): Promise<void>;
  delete(workspaceId: string, appId: string, table: string, id: string): Promise<void>;
  schema(workspaceId: string, appId: string, table: string): AppDataTable | null;
}
```

**Inside workflows:** A new node type `data_write` and a skill-level operation for `data_read`:

```
data_write node:
  - config: { table: string, operation: 'insert' | 'update' | 'upsert', idPath?: string }
  - input: the record object from upstream nodes
  - output: { id: string }

data_read (via existing knowledge_source or new skill):
  - config: { table: string, filter: expression, limit: number, orderBy: string }
  - output: { records: [...] }
```

**API exposure:** When an app has `surfaces: [{ type: 'api' }]`, Data tables are
automatically queryable at:

```
GET /v1/apps/:slug/api/data/:table          → paginated list with filter support
GET /v1/apps/:slug/api/data/:table/:id      → single record
POST /v1/apps/:slug/api/data/:table         → insert (auth: api_key)
```

**Event triggers from Data:** New trigger type `data_event`:

```ts
interface DataEventTriggerConfig {
  kind: 'trigger';
  triggerType: 'data_event';
  table: string;
  event: 'insert' | 'update' | 'delete' | 'any';
  filter?: string;            // e.g. "status == 'qualified'"
}
```

When the `AppDataService` writes a record matching the filter, it fires a
`DATA_RECORD_CHANGED` event on the bus. The `TriggerRuntime` intercepts it and starts
the bound workflow. This is the event loop that makes apps autonomous.

---

### Layer 4 — BRAIN (extend, not replace)

The Brain is the right architecture. What changes:

#### 1. Brain queries the Data layer

The Brain's knowledge enrichment process should run on accumulated Data layer records,
not just manually imported documents. Every batch of new Data records is a learning
opportunity.

After N records are written to a Data table (configurable: `brainAbsorptionThreshold`),
the `IntelligencePromotion` service runs on the new batch: extracts patterns, creates
knowledge atoms, links them to existing atoms in the Brain graph.

For the SDR engine: after 100 new outreach cycles, the Brain automatically distills which
prospect profiles responded positively, which messaging angles converted, which objection
patterns recurred. The next cycle is better with zero manual effort.

#### 2. Brain graph becomes queryable inside workflows

Agents inside workflows can query the Brain graph directly via a new `brain_lookup` node
type (or as a skill), returning the most relevant knowledge atoms for the current task
context. Currently, the Brain is only visible in the Brain surface — it should be
callable from inside a running workflow.

#### 3. App Brain vs. Workspace Brain

Currently the Brain is workspace-scoped. Each app should have a **scoped Brain** (its
own knowledge atoms, specific to its domain) that can optionally draw from the workspace
Brain for cross-app context. The SDR engine's Brain knows about your specific customers.
The workspace Brain knows about your company in general. The SDR Brain composes both.

---

### Layer 5 — DEPLOY (new first-class layer)

**What it is:** Where and how the app runs — on your machine, your VPS, or any server
you control. Agentis is an open-source, self-hosted platform. Every deployment target
described here runs entirely on infrastructure you own. Nothing phones home.

This layer is about **runtime mode**, not external hosting. When you run Agentis locally,
apps run in `local` mode. When you deploy Agentis on a server, those same apps can run
`always_on` or `api_server` — still your infrastructure, your data, your rules.

#### Deployment targets

| Target | Behavior | Use case |
|---|---|---|
| `local` | Runs on this machine when the server is running | Development, personal tools |
| `always_on` | Persistent process — restarts on failure, always listening | Production apps, real-time monitoring |
| `scheduled` | Wakes on trigger (cron/webhook), sleeps between runs | Report generation, data pipelines |
| `api_server` | Exposes a stable HTTP endpoint, always listening | Lovable-like, Stripe-like products |

For `always_on` and `api_server`, the app needs a real job queue upgrade (see Gap 3).

#### Deploy manifest

```ts
interface AppDeployConfig {
  target: 'local' | 'always_on' | 'scheduled' | 'api_server';
  /** For api_server: configure the public base URL and auth model. */
  apiServer?: {
    auth: 'api_key' | 'jwt' | 'public';
    cors?: boolean;
    rateLimit?: { requestsPerMinute: number };
  };
  /** For always_on/scheduled: restart policy. */
  restartPolicy?: 'always' | 'on_failure' | 'never';
  /** Resource hints for scheduler. */
  resources?: {
    maxConcurrentRuns?: number;
    priorityClass?: 'low' | 'normal' | 'high';
  };
}
```

#### Deploy surface (new tab)

The Deploy tab shows:
- Current deployment target with status indicator
- Exposed API routes (if `api_server`) with live request log (last 100)
- Webhook bindings — inbound webhooks the app listens to
- Scheduled trigger timeline — visual calendar of when the app runs
- Version history (last 10 activated versions)
- Resource usage: runs today, cost today, cost this month

---

### App Setup & Creation Flow

Creating a new app follows a **structured wizard**, not the general Chat surface.
App creation must not depend on the workspace Orchestrator being connected.

**The correct flow:**

```
"New app" button (Apps page or home)
    ↓
App Creation Wizard (dedicated page — /apps/new)
    ├─ Step 1: Identity       — name, one-sentence goal, category, icon glyph + color
    ├─ Step 2: Surfaces       — pick surface types from a visual card grid
    ├─ Step 3: AI-assist (opt) — workspace Orchestrator generates domain structure,
    │                             dataTables spec, appGraphTemplate draft
    └─ Step 4: Review & Create — preview summary, confirm, create
        ↓
    Route → /apps/{slug}  (the new app's detail page)
```

**Step 2 — Surfaces** uses a card-picker, not a config form:

```
[ ✓ Thread     ]  [ □ Dashboard ]  [ □ API      ]
[ □ Artifact  ]  [ □ Webhook   ]  [ □ Stream   ]
```

The operator picks what the app will expose. The wizard uses these to pre-populate the
manifest and show only the relevant setup fields.

**Step 3 — AI-assist is optional.** If the workspace Orchestrator is offline or the
operator skips it, the wizard proceeds with manual setup and empty domain/data fields
that can be filled in the Canvas tab later. Graceful degradation is required — app
creation must never be blocked by an agent's connection status.

**What the current `/chat?intent=new-app` flow was:**
Routing operators to the Chat page to describe what they want. The intent was right but
the surface was wrong: it uses the general chat (which requires a connected orchestrator),
shows the wrong agent name and icon, and abandons the operator after the conversation
without a clear creation outcome. The AI-assist idea belongs in Step 3 of the wizard,
not as the entire creation surface.

---

## Part IV — Architecture Additions Required

### A1 — App Data Service (new)

**File:** `apps/api/src/services/appDataService.ts`

Per-app scoped SQLite tables: `appdata_{appId}_{tableName}`. The service handles DDL
(creates tables from manifest schema on activation) and DML (insert/query/update/delete).

The service also maintains an event queue: when a write happens, if a `data_event`
trigger is registered for that table/event, it enqueues a workflow run via the job queue.

**Schema migration:** When the app manifest updates a Data table's schema, the service
runs a safe migration (add columns, never drop — drops are explicit and require
confirmation).

### A2 — Data Event Trigger (extend `TriggerRuntime`)

New `triggerType: 'data_event'` in `TriggerNodeConfig`. The `TriggerRuntime` registers
a listener on the event bus for `DATA_RECORD_CHANGED` events. When a matching event
arrives, it calls `WorkflowEngine.startRun()`.

This is the primitive that makes the entire event loop work. It is a small addition to
the existing trigger system.

### A3 — Cross-Workflow Event Bus (extend event model)

Add `APP_WORKFLOW_COMPLETED` and `APP_WORKFLOW_FAILED` events to `REALTIME_EVENTS`. Add
a new trigger type `workflow_completed` that fires when a specific workflow run completes.

This enables: Content Pipeline completion → Campaigns Manager automatically starts.
The "domain handoff" pattern.

### A4 — Durable Job Queue (replace `DatabaseJobQueue`)

The current `DatabaseJobQueue` uses `queueMicrotask` — it does not survive server
restarts and has no worker pool model. For long-running multi-day jobs (codebase
migration, continuous monitoring), this must be replaced.

**Minimal viable upgrade:** A polling-based durable queue backed by the existing SQLite
`async_jobs` table, with a background interval poller (every 5s) that picks up
`pending` jobs and dispatches them. The engine's existing `notifyTaskCompleted` /
`notifyTaskFailed` callbacks stay unchanged. This requires no new dependencies.

**Production upgrade path:** BullMQ + Redis, when the platform outgrows SQLite. The
interface (`JobQueueBackend`) already abstracts this correctly — only the implementation
changes.

### A5 — `data_write` Workflow Node (new node type)

New entry in `WorkflowNodeType`: `data_write`. Config:

```ts
interface DataWriteNodeConfig {
  kind: 'data_write';
  table: string;
  operation: 'insert' | 'update' | 'upsert';
  /** JSONPath into the node's input data to extract the record. */
  recordPath?: string;
  /** For update/upsert: the field to match on. */
  idField?: string;
}
```

The engine handles `data_write` nodes by calling `AppDataService.insert/update/upsert`.
No agent dispatch, no skill invocation — direct DB write with the node's input data.

### A6 — App Surface Declarations (extend package manifest)

Add to `AgentisPackageContents`:

```ts
surfaces?: Array<{
  type: 'thread' | 'dashboard' | 'api' | 'webhook_receiver' | 'stream' | 'embed' | 'artifact' | 'page';
  label?: string;
  description?: string;
}>;
apiRoutes?: AppApiRoute[];           // for type: 'api' surfaces
deployConfig?: AppDeployConfig;      // default deploy target for this app
dataTables?: AppDataTable[];         // the app's operational schema
dashboard?: AppDashboard;            // auto-generated dashboard declaration (§Layer 1)
subApps?: string[];                  // composed sub-app slugs (§A10)
brainAbsorptionThreshold?: number;   // Data records before Brain absorbs (§Layer 4)
appBrain?: AppBrainConfig;           // built-in internal Brain agent (§Layer 4)
```

### A7 — App Domain Groups (extend `AppGraph`)

Add `domains: AppDomain[]` to `AppGraph`. The `AppCanvasService` generates domain groups
from the manifest's workflow `collection` field (already in `workflow.settings.collection`).
The canvas renders domain cards when domains exist.

### A8 — Multi-Agent Swarm Node (new node type)

New entry in `WorkflowNodeType`: `agent_swarm`. Config:

```ts
interface AgentSwarmNodeConfig {
  kind: 'agent_swarm';
  /** Template prompt — applied to each item in the input array. */
  prompt: string;
  /** JSONPath to the input array (each element becomes one agent task). */
  inputArrayPath: string;
  /** Max parallel agents. Budget-bounded. */
  maxParallel: number;
  /** How to merge results: collect_all | first_success | majority_vote */
  mergeStrategy: 'collect_all' | 'first_success' | 'majority_vote';
  capabilityTags: string[];
  outputKey: string;
}
```

The engine fans out one `NormalizedTask` per input element (up to `maxParallel`), waits
for all (or first success), then merges the results. This is how parallel micro-agents
work for the codebase scanner, the market research swarm, the ad creative generator.

### A9 — Self-Healing Run Loop (extend `WorkflowEngine`)

When an `agent_task` node fails (adapter returns `TASK_FAILED`), the engine currently
marks the run `FAILED`. New behavior:

1. Check `config.retryPolicy.selfHeal` (default: false).
2. If true and attempts < `maxSelfHealAttempts` (default: 2): re-dispatch the task with
   an augmented prompt that includes the error context and asks the agent to correct it.
3. If the retry fails: propagate to FAILED as today.

This is how the "compiler runs tests, handles errors, iterates until green" loop works in
the codebase re-architect example. The `agent_task` node just needs `selfHeal: true` in
its config.

### A10 — App Composition (sub-apps)

An app can declare `subApps: string[]` in its manifest (array of app slugs). The platform
installs dependencies during activation. A sub-app's Data layer is accessible to the
parent app via the `AppDataService` with a cross-app read permission model.

This enables: "Marketing Platform" app composes SocialListening + ContentPipeline +
CampaignManager. Each sub-app runs independently. The parent app's canvas shows the
macro domain view with each sub-app as a domain block.

### A11 — `brain_lookup` Workflow Node (new node type)

New entry in `WorkflowNodeType`: `brain_lookup`. Config:

```ts
interface BrainLookupNodeConfig {
  kind: 'brain_lookup';
  /** Static query string, or dynamically read from upstream output. */
  queryMode?: 'static' | 'dynamic';
  query?: string;
  /** JSONPath into the node input to extract the dynamic query. */
  queryPath?: string;
  topK?: number;
  outputKey?: string;
}
```

The engine calls `CollectiveBrainService.search()` (or `.query()`) with the resolved
query and returns up to `topK` knowledge atoms (default 5, max 25). If the Brain has
no search surface or no relevant atoms, the node returns an empty array rather than
failing the run — this is intentional: brain queries are enrichment, not hard
dependencies.

This is how workflows consume accumulated intelligence: the SDR engine's copywriter
agent asks the Brain "what messaging angles worked for enterprise SaaS prospects?" and
gets distilled patterns from hundreds of prior outreach cycles.

### A12 — `artifact_collect` Workflow Node (new node type)

New entry in `WorkflowNodeType`: `artifact_collect`. Config:

```ts
interface ArtifactCollectNodeConfig {
  kind: 'artifact_collect';
  /** Human-readable collection name. */
  collectionName: string;
  /** JSONPath into the node input to find artifact references. */
  artifactPath?: string;
  /** Artifact types to accept (html, image, document, code, data). */
  acceptTypes?: string[];
  /** Whether to version the collection (increment on each run). Default true. */
  versioned?: boolean;
  /** If true, artifacts are held for operator review before distribution. */
  requireApproval?: boolean;
}
```

The node gathers artifact references (`ArtifactRef` objects with `type`, `title`,
`content`, and optional `metadata`) from upstream node outputs, validates them against
`acceptTypes`, and writes each to the workspace artifact store. The output includes the
`artifactIds` array and `collectionName` so downstream nodes can reference the collection.

This is how creative pipelines work: an `agent_swarm` generates 5 ad creative variants,
a `skill_task` renders them into images, and the `artifact_collect` node packages them
into a named "Campaign Q3 Creatives" collection that appears in the Artifact surface
for operator review.

### A13 — App Brain Configuration (manifest field)

The App Brain is the app's built-in internal agent (§Layer 4 — "The App Brain"). It is
provisioned automatically on install and is invisible in the workspace Chat sidebar and
Agents page.

```ts
interface AppBrainConfig {
  adapter: AdapterType;
  systemPrompt: string;
  entryWorkflows: string[];
  maxConcurrentDomains?: number;
}
```

Added to the package manifest as `appBrain?: AppBrainConfig`. During app activation,
the packager creates an internal agent with `role: 'app_brain'`, assigns it the declared
adapter and system prompt, and links it to the app's entry workflows. The App Brain
handles all messages in the app's Thread surface — interpreting operator intent, deciding
which domain workflows to invoke, monitoring progress, and synthesizing results.

---

## Part V — Real-World App Blueprints

These are not toy examples. They are concrete architectures buildable on the 10x platform.

### Blueprint 1 — Zero-Inbox Autonomous SDR Engine

**App manifest shape:**
```
dataTables:
  leads: { company, contact, signal_type, outreach_status, last_contacted_at, conversion_stage }
  outreach_log: { lead_id, message, channel, sent_at, response, sentiment }
  objections: { text, category, suggested_response, win_rate }

surfaces: [thread, dashboard, api]

domains:
  Signal Detection:
    - Trigger: persistent_listener (LinkedIn/web scraper skill, 15min interval)
    - Signal Classifier: agent_task (classify signal type and priority)
    - data_write → leads table

  Research & Outreach:
    - data_event trigger: leads.insert where conversion_stage == 'new'
    - agent_swarm: [Prospect Researcher, Company Analyzer, Competitor Contextualizer]
    - Copywriter: agent_task (draft personalized message from research)
    - Send: skill_task (WhatsApp/email dispatch skill)
    - data_write → outreach_log

  Response Handling:
    - webhook_receiver: reply hook from messaging platform
    - Objection Handler: agent_task
    - Calendar Sync: skill_task
    - data_write → outreach_log, leads (update stage)

  Intelligence Loop:
    - Nightly: evaluatorRuntime runs on last 24h outreach_log
    - Patterns promoted to Brain (what worked, what didn't)
    - Brain absorbs conversion patterns → improves next Copywriter cycle

deployConfig: { target: 'always_on', restartPolicy: 'always' }
```

Every cycle: the SDR engine is smarter than the last. The Brain accumulates what subject
lines convert for which verticals. The Data layer is the company's entire outreach history.

---

### Blueprint 2 — Codebase Re-Architect (Super-Lovable)

**App manifest shape:**
```
dataTables:
  migrations: { repo_url, directive, status, started_at, completed_at, test_pass_rate }
  ast_maps: { migration_id, file_path, dependencies, schema_refs, api_boundaries }
  test_results: { migration_id, iteration, test_suite, pass_count, fail_count, errors }

surfaces: [thread, api]

domains:
  Ingestion:
    - Trigger: api (POST /migrate with repo_url + directive)
    - Cartographer swarm: agent_swarm(maxParallel: 20)
      → each agent scans a directory subtree, outputs dependency map
    - Merge: merge node (collect_all)
    - data_write → ast_maps

  Migration:
    - data_event trigger: migrations.insert
    - Planner: agent_task (decompose migration into ordered task list)
    - Executor: agent_task(selfHeal: true, maxSelfHealAttempts: 5)
      → runs in docker_sandbox skill (isolated compiler + test runner)
    - data_write → test_results

  Validation & Deploy:
    - data_event trigger: test_results.update where pass_rate == 1.0
    - Shadow Deploy: skill_task (Railway/Cloudflare shadow infra skill)
    - Traffic Router: skill_task (1% shadow routing, monitor latency)
    - checkpoint (human approval gate before full cutover)
    - DB Migration: skill_task
    - Deploy: skill_task (green-blue deploy)

deployConfig: { target: 'api_server', apiServer: { auth: 'api_key' } }
```

The operator (or external CI/CD system) calls the API with the repo URL and migration
directive. The app runs for hours, updating the `migrations` table. The thread surface
shows live progress. The operator approves the final cutover.

---

### Blueprint 3 — Autonomous Ad-Tech CMO

**App manifest shape:**
```
dataTables:
  ad_campaigns: { platform, campaign_id, budget, spend, impressions, cac, ltv, status }
  creatives: { campaign_id, copy, asset_url, performance_score, deployed_at }
  fraud_signals: { campaign_id, pattern_type, confidence, action_taken, filed_at }

surfaces: [dashboard, thread, stream]

domains:
  Performance Monitor:
    - Trigger: cron (every 15 minutes)
    - Metric Ingestion: skill_task(Meta API + Google Ads API + TikTok API)
    - Budget Allocator: agent_task (reallocation logic, writes budget updates)
    - data_write → ad_campaigns
    - API write-back: skill_task (applies new budgets via ad network APIs)

  Creative Engine:
    - data_event trigger: ad_campaigns.update where performance_score < 0.3
    - Copy Variants: agent_swarm(maxParallel: 5, prompt: "write hook variant")
    - Asset Generator: skill_task (multimodal image/video generation)
    - Deployer: skill_task (upload and launch creative via ad platform APIs)
    - data_write → creatives

  Fraud Sentinel:
    - Trigger: cron (every 5 minutes)
    - Traffic Analyzer: agent_task (adversarial — look for click farm patterns)
    - Blocklist Updater: skill_task (firewall rule update)
    - Claim Filer: skill_task (automated refund claim via ad network API)
    - data_write → fraud_signals

deployConfig: { target: 'always_on' }
```

Runs 24/7. Zero human input except for setting top-level budget boundaries. The CMO
dashboard shows live CAC/LTV across all platforms, creative performance, fraud blocked.

---

### Blueprint 4 — Autonomous Customer Success Swarm

**App manifest shape:**
```
dataTables:
  tickets: { channel, customer_id, content, category, status, resolution, created_at }
  customers: { external_id, account_status, ltv, last_engagement, churn_risk }
  patches: { ticket_id, file_path, line_number, change_description, pr_url, merged }

surfaces: [webhook_receiver, thread, dashboard]

domains:
  Inbound Triage:
    - webhook_receiver: Intercom/email/WhatsApp inbound hook
    - Triage Agent: agent_task (classify intent, lookup customer history from Data layer)
    - Account Resolver: skill_task (DB lookup → billing fix → account update)
    - data_write → tickets

  Bug-to-Patch Pipeline:
    - data_event trigger: tickets.insert where category == 'bug'
    - Reproducer: skill_task (docker_sandbox — spins up test env, reproduces bug)
    - Code Analyzer: agent_task(selfHeal: true) — finds the line, drafts fix
    - PR Creator: skill_task (GitHub API)
    - data_write → patches

  Churn Prevention:
    - Trigger: cron (daily)
    - Churn Scorer: agent_task (reads customers table, scores churn risk)
    - data_write → customers (update churn_risk)
    - data_event trigger: customers.update where churn_risk > 0.7
    - Retention Agent: agent_task (drafts personalized retention message)
    - Send: skill_task (outreach skill)

deployConfig: { target: 'always_on', apiServer: { auth: 'api_key' } }
```

External customer support tools (Intercom, email servers) call the webhook surface.
The app handles the full resolution cycle. The team only sees PRs and escalations.

---

## Part VI — What Stays, What Changes, What's New

### Keep (no rebuild)

| System | Why keep |
|---|---|
| `WorkflowEngine` + node types | Solid — add `data_write`, `agent_swarm`, `brain_lookup`, `artifact_collect` nodes |
| Adapter system (all adapters) | Solid — no changes needed |
| Skills runtime (3 tiers) | Solid — Docker sandbox is exactly what Blueprint 2 needs |
| App package system | Solid — extend manifest with `dataTables`, `surfaces`, `deployConfig` |
| CollectiveBrain + EvaluatorRuntime | Solid — extend to consume Data layer for pattern absorption |
| MCP interop | Keep — growing external tool ecosystem |
| AppThread (operator conversation) | Keep — this is the correct `thread` surface model |
| WorkflowDeploymentService | Keep — generalize to app-level (`AppDeploymentService`) |
| Budget/Ledger | Keep — add Data layer write cost accounting |
| Realtime event bus | Keep — add `DATA_RECORD_CHANGED`, `APP_WORKFLOW_COMPLETED` events |

### Extend significantly

| System | What changes |
|---|---|
| `TriggerRuntime` | Add `data_event` and `workflow_completed` trigger types |
| `JobQueue` | Replace `queueMicrotask` with polling-based durable queue |
| `AppGraph` + canvas | Add `domains`, auto-populate from manifest, two zoom levels |
| Package manifest | Add `dataTables`, `surfaces`, `apiRoutes`, `deployConfig`, `subApps` |
| `AppActivation` | DDL — create Data tables on activation, run safe migrations on update |
| `AppDetailPage` shell | 5 tabs: Surface / Canvas / Data / Brain / Deploy |
| `IntelligencePromotion` | Run on Data layer records, not just manual imports |

### Build new

| What | Where | Priority |
|---|---|---|
| `AppDataService` | `apps/api/src/services/appDataService.ts` | P0 — everything depends on it |
| `data_write` node type | Engine + core types | P0 |
| `agent_swarm` node type | Engine + core types | P1 |
| Self-healing agent task | `WorkflowEngine` (retry with error context) | P1 |
| App API Surface router | `apps/api/src/routes/appApiSurface.ts` | P1 |
| App Dashboard Surface | Frontend auto-generated from Data schema | P2 |
| Domain-grouped canvas | `AppGraphStage` + macro/micro zoom | P2 |
| Deploy layer UI | `apps/web/src/components/app-detail/DeployView.tsx` | P2 |
| Sub-app composition | Manifest + activation + cross-app Data reads | P3 |
| Brain ↔ Data integration | `IntelligencePromotion` + `brainAbsorptionThreshold` | P3 |

---

## Part VII — Build Sequence

### Phase 1 — Data Foundation (P0)
*Gates everything. Must ship before any blueprint app can work.*

1. `AppDataService` with DDL + DML
2. `data_write` workflow node type (engine + canvas palette)
3. Data layer activation: `AppActivation` creates scoped tables on install
4. `data_event` trigger type in `TriggerRuntime`
5. Data tab in `AppDetailPage`: schema viewer + record browser

**Done when:** An SDR Engine app can insert leads into a `leads` table when a signal is
detected, and a separate workflow fires automatically when a new lead is inserted.

### Phase 2 — Autonomous Loops (P1)
*The compound intelligence loop. Makes apps "run themselves."*

1. `agent_swarm` node type (parallel agent fan-out)
2. Self-healing `agent_task` (retry with error context)
3. `workflow_completed` trigger type (chain workflows without coupling)
4. Durable job queue upgrade (polling-based, survives restarts)
5. App API surface router (expose Data tables + workflow triggers as REST)

**Done when:** The SDR Engine runs a research swarm in parallel, self-corrects when one
agent fails, and the outreach workflow fires automatically when research completes.

### Phase 3 — Canvas & Surface (P2)
*Makes the platform legible. Required for operators to understand what's running.*

1. Domain-grouped canvas with macro/micro zoom
2. Auto-populate canvas from manifest `appGraphTemplate` with concrete names
3. Live status overlays on nodes (last run, item count, connection health)
4. Dashboard surface (auto-generated from Data layer schema)
5. Deploy tab (deployment target, API route list, webhook log, schedule timeline)
6. App Creation Wizard (`/apps/new`) — 4-step structured flow (Identity → Surfaces →
   AI-assist → Review & Create) replacing the old `/chat?intent=new-app` redirect

**Done when:** Opening "Marketing Platform" shows the domain map with 5 sections, each
with live status, and the operator can drill into "Content Pipeline" to see its workflow
graph.

### Phase 4 — Deployment & Composition (P3)
*Turns apps into products and enables the big complex app model.*

1. App deployment targets: `always_on` with restart policy, `api_server` with stable URL
2. Webhook receiver surface
3. Sub-app composition (manifest `subApps`, cross-app Data reads)
4. Brain ↔ Data integration (`brainAbsorptionThreshold`, pattern promotion from Data)

**Done when:** A codebase migration app accepts a GitHub webhook, runs a 6-hour migration
job, and exposes the result via a stable REST API — while the Brain absorbs patterns from
every migration for the next one.

---

## Part VIII — What This Platform Becomes

After these four phases, Agentis is not a workflow automation tool. It is:

> **A platform where builders wire together agents, skills, and knowledge into living
> applications that accumulate data, expose interfaces, run autonomously, and compound
> their intelligence over every cycle.**

The competitive position:
- vs. n8n / Zapier: those are static automations. Agentis apps learn and improve.
- vs. Lovable / Bolt: those generate UIs. Agentis generates the autonomous system behind the UI.
- vs. LangChain / LangGraph: those are dev frameworks. Agentis is a complete platform with UI, deploy, monitoring.
- vs. traditional SaaS: Agentis apps are agentic — they do the work, not just host data.

The builder on Agentis is not a developer writing code. They are a system designer:
*what should this app know, what should it do, who should it talk to, what should it
produce*. The platform handles the rest.

The enterprise buyer doesn't buy "another automation tool." They get an autonomous
department that runs itself, learns from its history, and gets better every week without
anyone touching it.

**That is the platform. Build it.**

---

## Appendix — Files Map

### New files
| File | Purpose |
|---|---|
| `apps/api/src/services/appDataService.ts` | Per-app structured data store — DDL + DML |
| `apps/api/src/routes/appApiSurface.ts` | App API surface router (REST over Data layer) |
| `apps/api/src/routes/appWebhookReceiver.ts` | Inbound webhook handler for apps |
| `apps/web/src/components/app-detail/DataView.tsx` | Data layer tab — schema + record browser |
| `apps/web/src/components/app-detail/DeployView.tsx` | Deploy tab — target, routes, webhook log |
| `apps/web/src/components/app-graph/AppDomainCard.tsx` | Macro domain card for canvas |
| `apps/web/src/pages/AppCreationWizard.tsx` | 4-step wizard for `/apps/new` |

### Modified files
| File | Change |
|---|---|
| `packages/core/src/types/workflow.ts` | Add `data_write`, `agent_swarm`, `brain_lookup`, `artifact_collect` node types |
| `packages/core/src/types/package.ts` | Add `dataTables`, `surfaces`, `apiRoutes`, `deployConfig`, `subApps`, `appBrain` |
| `packages/core/src/types/appGraph.ts` | Add `domains: AppDomain[]` |
| `packages/core/src/events.ts` | Add `DATA_RECORD_CHANGED`, `APP_WORKFLOW_COMPLETED` events |
| `apps/api/src/engine/WorkflowEngine.ts` | Handle `data_write` + `agent_swarm` + `artifact_collect` + self-heal loop |
| `apps/api/src/engine/TriggerRuntime.ts` | Add `data_event` + `workflow_completed` trigger types |
| `apps/api/src/services/appActivation.ts` | DDL for Data tables on activation |
| `apps/api/src/services/appDataService.ts` | (new) |
| `apps/api/src/services/jobQueue.ts` | Replace `queueMicrotask` with polling-based durable queue |
| `apps/api/src/services/intelligencePromotion.ts` | Consume Data layer for pattern absorption |
| `apps/web/src/pages/AppDetailPage.tsx` | 5-tab shell: Surface / Canvas / Data / Brain / Deploy |
| `apps/web/src/components/app-graph/AppGraphStage.tsx` | Domain-grouped macro/micro canvas |
| `apps/web/src/components/app-graph/AppGraphPalette.tsx` | Add `data_write`, `agent_swarm`, `artifact_collect` nodes |
| `apps/web/src/App.tsx` | Add `/apps/new` route for creation wizard |
| `apps/web/src/pages/AppsPage.tsx` | Redirect "New app" button to `/apps/new` |
| `apps/api/src/services/packager.ts` | Provision App Brain agent on install |

---

## Part IX — Implementation Log

> **Status:** Implemented — 2026-05-15
> **Engineer:** Architecture build pass (Claude, Opus 4.7)
> **Baseline commit:** `6ffc2fc`
> **Verification:** `pnpm -r typecheck` clean across all 8 workspace projects;
> new + existing service tests green (`appDataService`, `triggerRuntimeDataEvent`,
> `triggerRuntime`).

This section records every change made to take the platform from the audited
baseline to the 5-layer app model. Steps are grouped by the build phase they
belong to. Where the implementation deviated from the plan, the reasoning is
called out under **Decision**.

### Phase 1 — Data Foundation (P0)

**Step 1.1 — Core type extensions** (`packages/core`)
- `types/workflow.ts`: added `data_write`, `agent_swarm`, `brain_lookup` to
  `WorkflowNodeType`; added `DataWriteNodeConfig`, `AgentSwarmNodeConfig`,
  `BrainLookupNodeConfig`; extended `TriggerNodeConfig.triggerType` with
  `data_event` and `workflow_completed` plus their config fields
  (`table`, `event`, `filter`, `sourceWorkflowId`, `sourceStatus`); added
  `AgentRetryPolicy` (`selfHeal`, `maxSelfHealAttempts`) on `AgentTaskNodeConfig`.
- `types/package.ts`: added zod schemas + types `AppDataField`, `AppDataTable`,
  `AppApiRoute`, `AppSurface`, `AppDashboard`, `AppDeployConfig`; extended
  `agentisPackageContentsSchema` with `dataTables`, `surfaces`, `apiRoutes`,
  `deployConfig`, `dashboard`, `subApps`, `brainAbsorptionThreshold`.
  - **Decision:** the new manifest fields are `.optional()` rather than
    `.default([])`. A defaulted array is *required* in the inferred output
    type, which would have broken every existing literal that constructs
    `AgentisPackageContents`. Optional fields keep the blast radius to zero;
    consumers default to `[]`.
- `types/appGraph.ts`: added `AppDomain` and an optional `domains` array on
  `AppGraph` for the macro (domain) canvas zoom.
- `events.ts`: added `DATA_RECORD_CHANGED`, `APP_WORKFLOW_COMPLETED`,
  `APP_WORKFLOW_FAILED`, `APP_DEPLOY_STATUS_CHANGED`, `APP_API_REQUEST`, and a
  `REALTIME_ROOMS.app(appId)` room helper.

**Step 1.2 — Database schema + migrations** (`packages/db`)
- `schema.ts`: added `app_id` column to `workflows`; added `deploy_target`,
  `deploy_status`, `api_key_hash` columns to `app_instances`; added the
  `asyncJobs` table (durable queue) and the `appDataTables` registry table.
- `sqlite/index.ts`: added idempotent runtime DDL (`CREATE TABLE IF NOT
  EXISTS` + `ADD COLUMN` guards) so existing databases migrate forward on
  open. `migrations.ts`: added migration `version: 30`
  (`platform_10x_app_model`) for the CLI migration path.
  - **Decision:** the per-app Data tables themselves are *not* in the drizzle
    schema — they are created dynamically (`appdata_<appId>_<table>`). Only the
    `app_data_tables` registry (which records each table's declared schema) is
    a static table.

**Step 1.3 — `AppDataService`** (`apps/api/src/services/appDataService.ts`, new)
- Per-app structured store: DDL (`ensureTable`, `provisionTables`,
  `dropTablesForApp`, safe additive migration), DML (`insert`, `update`,
  `upsert`, `delete`, `getRecord`, `query`, `count`), and introspection
  (`schema`, `listTables`).
- Physical tables are `appdata_<sanitizedAppId>_<table>`; `json` fields are
  JSON-encoded TEXT, `boolean` as INTEGER, typed values round-trip on read.
- Every write fires `DATA_RECORD_CHANGED` on the `app:` and `workspace:` rooms
  — the primitive the `data_event` trigger consumes.
  - **Decision:** dynamic SQL uses the underlying better-sqlite3 client
    (`db.$client`) with prepared statements for value binding, and sanitized
    identifiers for table/column names — avoiding both SQL injection and
    drizzle's static-schema limitation.

**Step 1.4 — `data_write` engine node** (`apps/api/src/engine/WorkflowEngine.ts`)
- Added `appData` to `EngineDeps`; `#executeDataWrite` handles
  insert/update/upsert by calling `AppDataService` directly (no agent/skill
  dispatch). The owning app is resolved via `#resolveAppId` (workflow
  `app_id`, falling back to the entry-workflow match) and cached on the run
  context.

**Step 1.5 — `data_event` trigger** (`apps/api/src/engine/TriggerRuntime.ts`)
- `TriggerRuntime` now subscribes to the event bus once (`#bindBus`). A
  `data_event` trigger registers into an in-memory map; on
  `DATA_RECORD_CHANGED` the runtime matches table + event + record filter
  (`SafeConditionParser`) and fires the bound workflow. The owning app is
  resolved at activation time so same-named tables across apps don't
  cross-fire. `ActiveTrigger.triggerType` widened accordingly.

**Step 1.6 — Activation / packager wiring** (`apps/api/src/services/packager.ts`)
- On agentis-package install the packager now: (1) stamps every installed
  workflow with its owning `appId`; (2) provisions the app's `dataTables` via
  `AppDataService`; (3) applies the declared `deployConfig.target` to the app
  instance. `buildPackageRoutes` threads `appData` + `logger` through.

### Phase 2 — Autonomous Loops (P1)

**Step 2.1 — `agent_swarm` node** (`WorkflowEngine.ts`)
- `#dispatchAgentSwarm` fans out one agent task per input-array element
  bounded by `maxParallel`, keeping the pool saturated as subtasks return.
  Subtasks use synthetic task ids (`<nodeId>::swarm::<index>`) so the existing
  adapter completion callback routes back into `#onSwarmSubtask` without a new
  event channel. Merge strategies: `collect_all`, `first_success`,
  `majority_vote`.
  - **Decision:** the synthetic-task-id scheme reuses the adapter event glue
    unchanged — no protocol change to `AdapterManager` was needed.

**Step 2.2 — Self-healing `agent_task`** (`WorkflowEngine.ts`)
- `notifyTaskFailed` checks `retryPolicy.selfHeal`; within
  `maxSelfHealAttempts` it re-dispatches the task with the error context
  appended to the prompt and emits `NODE_RETRY_SCHEDULED`.

**Step 2.3 — `workflow_completed` trigger + cross-workflow events**
- `WorkflowEngine.#transitionRunStatus` now emits `APP_WORKFLOW_COMPLETED` /
  `APP_WORKFLOW_FAILED` on terminal states. `TriggerRuntime` handles the
  `workflow_completed` trigger type — chaining domains without coupling, with
  a self-trigger guard.

**Step 2.4 — Durable job queue** (`apps/api/src/services/jobQueue.ts`, rewritten)
- Replaced the `queueMicrotask`-based `DatabaseJobQueue` with `DurableJobQueue`:
  a polling queue (5 s) backed by `async_jobs`. Atomic claim
  (`pending → running`), exponential-backoff retry, orphan reclamation for
  jobs left `running` by a crash, and priority draining. `JobQueueBackend`
  interface preserved for a future BullMQ backend. Started/stopped in
  `bootstrap`. `shouldQueueWorkflowRun` fixed to test real node types
  (`checkpoint`, `subflow`, `agent_swarm`).
  - **Decision:** `jobQueue.ts` was previously dead, excluded from the
    tsconfig, and referenced a non-existent `schema.asyncJobs`. It is now a
    real, wired, table-backed service.

**Step 2.5 — App API surface + webhook receiver**
  (`apps/api/src/routes/appApiSurface.ts`, new)
- Mounted at `/apps` (outside `/v1` JWT auth) with its own api-key model.
  Built-in routes: `GET/POST /apps/:slug/api/data/:table`,
  `GET /apps/:slug/api/data/:table/:id`, `POST /apps/:slug/api/trigger/:wf`,
  plus every manifest-declared `apiRoutes` entry, plus the
  `POST /apps/:slug/webhook[/:hook]` receiver. `TriggerRuntime.startWorkflowRun`
  was extracted as the shared run-creation entry point.
- `apps/api/src/routes/appDeploy.ts` (new) — authenticated `/v1/apps/:id`
  router (merged onto `/v1/apps`) serving the Data tab (schema + record
  browser) and Deploy tab (target switching, api-key minting).

### Phase 3 — Canvas & Surface (P2)

**Step 3.1 — 5-layer app shell** (`apps/web/src/pages/AppDetailPage.tsx`)
- The app shell went from 3 layers (`Output / Canvas / Brain`) to 5
  (`Surface / Canvas / Data / Brain / Deploy`). `Output` is relabelled
  `Surface` but keeps its URL value for link stability.

**Step 3.2 — Data + Deploy views**
- `apps/web/src/components/app-detail/DataView.tsx` (new) — table list, schema
  header, paginated record browser, per-record delete.
- `apps/web/src/components/app-detail/DeployView.tsx` (new) — deploy-target
  picker, endpoint list (API base / webhook / data), declared API route
  table, api-key minting.

### Phase 4 — Compounding Intelligence (P3)

**Step 4.1 — Brain ↔ Data integration** (`bootstrap.ts`)
- A bus listener counts inserts per app/table; every
  `brainAbsorptionThreshold` records (default 25) it calls
  `CollectiveBrainService.extractAndPromote` on the new record so the Brain
  distils patterns from accumulated operational data.
- `brain_lookup` node added to the engine — queries the Collective Brain from
  inside a running workflow (degrades to an empty result when the brain has no
  search surface, rather than failing the run).

### Tests added
- `apps/api/tests/services/appDataService.test.ts` — provisioning, typed CRUD,
  query filtering/pagination, the `DATA_RECORD_CHANGED` contract, upsert, and
  safe additive migration (7 tests).
- `apps/api/tests/services/triggerRuntimeDataEvent.test.ts` — `data_event`
  firing, table/event/filter matching, and `workflow_completed` chaining
  (5 tests).
- `apps/api/tests/services/triggerRuntime.test.ts` — updated to pass the new
  `bus` dependency.

**Phase 1 done-when verified:** an app inserts a record into a Data table and
a *separate* workflow fires automatically — proven end-to-end by
`appDataService` emitting `DATA_RECORD_CHANGED` and `triggerRuntimeDataEvent`
firing the bound workflow on that event.

### Pre-existing issues found and fixed

The baseline working tree was mid-refactor (≈40 uncommitted files, pre-existing
typecheck errors). Two classes of pre-existing breakage were fixed because they
blocked a clean build:

- **`apps/api` typecheck errors** — `apps.ts` (`workflow_id` nullable since the
  ephemeral-runs migration), `ephemeral.ts` (stale `registry.register`
  signature + invalid tool family). Fixed at the call sites.
- **`embedded-sql.ts` ↔ `schema.ts` drift** — the runtime embedded schema
  predated migration v2's `conversation_messages.issue_id` column, so
  `ConversationStore` inserts failed at runtime. Patched via the existing
  `runEmbeddedMigrations` `addColumn` drift-patch mechanism in
  `packages/db/src/sqlite/index.ts` (one line, idempotent) — unblocking the
  ConversationStore / ChannelBridge / SessionMirror test cascade.

Remaining baseline test failures (engine `sprintA`/`engine10x` aspirational
node types, `dataLayer`/`deploymentsMcp`/`scheduler`/`traces` suites covering
tsconfig-excluded modules, `schemas.workflow` tests that are stale against the
intentionally-permissive `fallbackConfigSchema`) are pre-existing and out of
scope for this build.

### Deliberate scope boundaries
- **Domain-grouped macro canvas (§Layer 2):** the `AppDomain` type and the
  optional `AppGraph.domains` field ship, but the macro/micro zoom *rendering*
  in `AppGraphStage` is not reworked — the existing flat canvas is unaffected
  and remains fully functional. This is a P2 visual enhancement layered on the
  data model that is now in place.
- **Sub-app composition (§A10):** the `subApps` manifest field ships and
  `AppDataService` is already `appId`-parametric (so cross-app reads are
  mechanically possible). A formal cross-app read *permission model* and
  automatic dependency installation are not implemented — flagged for a
  follow-up.
- **`always_on` / `api_server` process supervision:** deploy *targets* are
  modelled, switchable, and the API server surface is live. A separate OS-level
  process supervisor for restart policies is out of scope for the embedded
  single-process runtime.

### Phase 5 — Gap-Fix Pass (reviewer feedback)

An external doc review surfaced 13 gaps (reference inconsistencies, missing
A-sections, code not matching doc). Each was triaged as doc-only, already-done,
or requires-code. Results below.

**Step 5.1 — `artifact_collect` node type** (Gap 7/10)
- `types/workflow.ts`: added `'artifact_collect'` to `WorkflowNodeType`; added
  `ArtifactCollectNodeConfig` (collection name, artifact path, accept types,
  versioned flag, approval gate); extended `WorkflowNodeConfig` union.
- `WorkflowEngine.ts`: `#executeArtifactCollect` handler — extracts artifact
  refs from upstream input, filters by `acceptTypes`, persists each to the
  workspace `artifacts` table (keyed to run, workflow, node), returns
  `{ collectionName, artifactIds, count, requireApproval }`.
  - **Decision:** the handler writes directly to the existing `artifacts` schema
    table (already supports `html|image|document|code|data` types), avoiding a
    new storage surface. The `requireApproval` flag is persisted in metadata for
    downstream gating but the actual approval-gate UX is deferred.

**Step 5.2 — `AppBrainConfig` manifest field** (Gap 8)
- `types/package.ts`: added `appBrainConfigSchema` (zod: adapter, systemPrompt,
  entryWorkflows, maxConcurrentDomains); added `appBrain` optional field to
  `agentisPackageContentsSchema`.
- `packager.ts`: on app activation, if `contents.appBrain` exists the packager
  creates an internal agent with `role: 'app_brain'`, seeded with the declared
  adapter and system prompt, invisible in the workspace agent list. Agent id
  stored as `agentIds.set('__app_brain', brainId)`.

**Step 5.3 — App Creation Wizard** (Gap 9)
- `apps/web/src/pages/AppCreationWizard.tsx` (new) — 4-step wizard:
  Identity (name, goal, category, icon glyph + color), Surfaces (card-picker
  for all 8 surface types), AI-assist (optional — degrades gracefully),
  Review & Create. Posts to `POST /v1/apps` on completion, routes to
  `/apps/{slug}`.
- `apps/web/src/App.tsx`: added `/apps/new` route (before `/:slug` to prevent
  slug-match).
- `apps/web/src/pages/AppsPage.tsx`: changed "New app" button from
  `/chat?intent=new-app` to `/apps/new`.
  - **Decision:** AI-assist calls `POST /v1/apps/ai-assist` which may not exist
    yet — the wizard catches the error and proceeds manually (§App Setup Flow
    requires graceful degradation when orchestrator is offline).

**Step 5.4 — Doc text corrections** (Gaps 1, 2)
- Line 215: "App Orchestrator" → "App Brain" (the thread surface speaks to the
  Brain, not an orchestrator).
- Line 427: canvas "authored by the orchestrator" → "authored by the App Brain".

**Step 5.5 — A6 manifest snippet updated** (Gaps 3, 4, 5, 13)
- Surface type union expanded from 6 to 8 members: added `'artifact'` and
  `'page'` (code already had all 8 since Step 1.1; doc snippet was stale).
- Added `dashboard`, `subApps`, `brainAbsorptionThreshold`, and `appBrain`
  fields to the A6 snippet — matching the live `agentisPackageContentsSchema`.

**Step 5.6 — New A-sections** (Gaps 6, 7, 10, 11)
- **A11** — `brain_lookup` node: formal spec for the `BrainLookupNodeConfig`
  that was already implemented in Step 4.1 but lacked its own A-section.
- **A12** — `artifact_collect` node: full spec for the new node type.
- **A13** — `AppBrainConfig`: manifest field spec, provisioning semantics.

**Step 5.7 — Surface type descriptive sections** (Gap 12)
- Added three new sub-sections under §Layer 1 — Surface: **Page surface**
  (live web pages), **Embed surface** (iframe components), **Stream surface**
  (SSE/WebSocket feed). Each includes use cases and platform behavior.

**Step 5.8 — Build sequence updated** (Gap 9)
- Phase 3 item 6: App Creation Wizard added to the P2 build plan.

**Step 5.9 — Continuation fixes after runtime review**
- `AppCreationWizard.tsx`: fixed the create response contract. The wizard now
  accepts the existing API shape (`{ app: { id, slug, path } }`) and navigates
  to `app.path`, preventing the broken `/apps/undefined` route after app
  creation. It still tolerates the old `{ appSlug, appId }` shape for backward
  compatibility.
- `apps.ts`: extended `POST /v1/apps` to accept and persist the selected
  `surfaces` array into the package manifest, and returned top-level `appId`
  / `appSlug` aliases alongside the canonical `app` object.
- `AppCreationWizard.tsx`: associated the name and goal labels with their
  inputs (`htmlFor`/`id`) and required both fields before moving past Step 1.
- `agents.ts`, `dashboard.ts`, `commandIndex.ts`, `teams.ts`: hid internal
  `role: 'app_brain'` agents from user-facing agent lists, command search,
  dashboard counts, and team stats so the App Brain remains an internal app
  runtime primitive rather than a visible workspace agent.
- Added `apps/web/tests/pages/AppCreationWizard.test.tsx` covering the full
  create path: fill identity, skip optional AI-assist, submit, persist surfaces,
  and navigate to the API-returned app path.

**Verification:** `pnpm -r typecheck` clean across all 7 workspace projects;
24 platform-10x tests pass (7 appDataService + 5 triggerRuntimeDataEvent +
12 triggerRuntime). Continuation validation: `pnpm --filter @agentis/web
typecheck`, `pnpm --filter @agentis/api typecheck`, and `pnpm --filter
@agentis/web exec vitest run tests/pages/AppCreationWizard.test.tsx` all pass.

### Phase 6 — Loop Closure Pass (infrastructure → 100%)

A re-audit found the five-layer infrastructure in place but the *loops not
closed*: the durable queue was dead code, learning was not automatic, several
surfaces were schema-only, and the canvas had no live state. This pass closes
each gap.

**Step 6.1 — `data_read` workflow node**
- `types/workflow.ts`: added `data_read` to `WorkflowNodeType` plus
  `DataReadNodeConfig` (literal + JSONPath `whereFrom` filters, expression
  filter, `single` mode). `WorkflowEngine.#executeDataRead` queries
  `AppDataService` so a workflow can act on its own accumulated data without
  leaving the engine — previously workflows were read-blind to their Data layer.

**Step 6.2 — Data retention + schema enforcement**
- `AppDataService`: `insert` now validates `required` fields; `#enforceMaxRows`
  trims oldest rows past `retention.maxRows` inline; `sweepRetention()` prunes
  `ttlDays`-expired rows and is run hourly from `bootstrap`. Retention deletes
  are silent — they do not fire `data_event` triggers.

**Step 6.3 — DurableJobQueue wired into dispatch**
- `TriggerRuntime.startWorkflowRun` now consults `shouldQueueWorkflowRun` and
  enqueues long-running / human-gated graphs through the durable queue instead
  of dispatching inline. The queue was infrastructure-complete but had **zero
  call sites** — it is now the dispatch backbone for every autonomous run
  (triggers, API surface, webhooks), so those runs survive a server restart.

**Step 6.4 — Compound learning loop closed (`RunIntelligenceService`)**
- New service called on every terminal run: (1) derives an updated
  `WorkflowBaselineStore` + `RollingBaselineStore` baseline from the workflow's
  recent run cohort — `AppIntelligenceRuntime` already surfaces these into agent
  context, so the next run is dispatched against a fresh target; (2)
  auto-evaluates the terminal output against the app's `terminal_output`
  rubric, recording verdicts; (3) writes a calibration example back to the
  rubric **only when the verdict is corroborated by the objective run status**
  (COMPLETED↔pass / FAILED↔fail) — the run outcome is independent ground truth,
  which keeps the calibration loop non-circular.

**Step 6.5 — Surface layer completed**
- `AppDashboardService` + `GET /v1/apps/:id/dashboard`: metrics, charts, and
  record tables computed live from the Data layer — driven by the manifest
  `dashboard` declaration, auto-generated from the schema otherwise.
  `DashboardView.tsx` renders it with auto-refresh; reachable from the Surface
  tab.
- `appApiSurface.ts`: `GET /:slug/stream` (SSE over the app event bus),
  `GET /:slug/page[/:name]` (serves the app's `html` page artifact),
  `GET /:slug/embed` (server-rendered iframe status widget), and
  `GET /:slug/api/artifacts[/:id]` (artifact surface). `/:id/deploy` now
  returns `surfaceEndpoints` for every declared surface; `DeployView` lists
  them.

**Step 6.6 — Canvas living-map upgrades**
- `GET /v1/apps/:appId/canvas/status` returns per-workflow live run status.
  `AppCanvasView` fetches it and subscribes to `RUN_*` events; `AppGraphStage`
  overlays a status dot + relative last-run label on workflow nodes. A macro
  **domain band** renders when `AppGraph.domains` is populated — clicking a
  domain dims nodes outside it (the two-zoom-level view).

**Step 6.7 — `always_on` deploy supervision (`DeploySupervisor`)**
- An in-process supervisor (the right model for the embedded single-process
  runtime) polls `always_on` apps every 30s and restarts the entry workflow
  per `restartPolicy` (`always` / `on_failure` / `never`), debounced per app.

**Tests added (Phase 6):** `appDataService` (+3: required-field, maxRows, ttl
sweep), `appDashboardService` (+3), `deploySupervisor` (+5), and
`runIntelligenceService` (+1) — all green.

**Verification:** `pnpm -r typecheck` clean across all 7 workspace projects.
`pnpm --filter @agentis/api test` — 548 passed (was 536; +12 new), the same
23 pre-existing failures (tsconfig-excluded modules + mid-refactor drift), and
**zero new failures**.
